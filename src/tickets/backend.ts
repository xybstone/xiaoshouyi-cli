import axios from "axios";
import { z } from "zod";
import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { getApiClient } from "../api/client.js";
import { getCrmCookie } from "../api/crm-client.js";
import { getAuthManager } from "../auth/manager.js";
import { CRM_BASE_URL, DEFAULT_TIMEOUT } from "../config.js";
import { describeObject, queryObjects } from "../services/object.service.js";
import { escapeSql, buildListQuery } from "../utils/index.js";
import {
  ContractRegistry,
  canonical,
  digest,
  inputField,
  isServerReportUpdate,
  projectProbeOutput,
  recordPreconditionsMatch,
  template,
  type RequestSpec,
  type IdentitySpec,
  type ResourceQuery,
} from "./contracts.js";
import { decodeResponse, normalizeMetadata } from "./metadata.js";
import { recoverByCorrelation } from "./recovery.js";
import { OperationStore } from "./operation-store.js";
import { fieldJobServerAction } from "./fieldjob-server-actions.js";
import { decodeFieldJobDispatchResponse } from "./fieldjob-dispatch.js";
import { inspectActivityRecordMetadata } from "./fieldjob-history.js";
import {
  FIELDJOB_ATTACHMENT_FIELD,
  fieldJobAttachmentLinkMatches,
  inspectFieldJobAttachmentLink,
  parseFieldJobAttachmentUpload,
} from "./fieldjob-attachments.js";
import {
  guardFieldJobWorkflowInspection,
  trustedPreprocessingFromOperation,
  validateFieldJobWorkflowSubmission,
} from "./fieldjob-workflow.js";
import {
  DEFAULT_FIELDS,
  KNOWN_FIELDS,
  at,
  fail,
  fieldSchema,
  idSchema,
  object,
  parseInput,
  safeRemoteError,
  type ActionContract,
  type Decision,
  type FileBinding,
  type Inspection,
  type InputField,
  type RecordData,
  type Submission,
  type TicketBackend,
  type TicketContext,
  type TicketMetadata,
  type TicketPlan,
  type TicketOperation,
  type VerificationResult,
} from "./types.js";

const formSchema = z
  .object({
    required: z.array(fieldSchema).default([]),
    defaults: z.record(z.string(), z.unknown()).default({}),
    fields: z.record(fieldSchema, inputField).default({}),
    version: z.string().optional(),
  })
  .strict();
function decision(value: unknown): Decision {
  return value === true ? "allowed" : value === false ? "denied" : "unknown";
}
function protocolValueMatches(expected: string | number | boolean, actual: unknown): boolean {
  return expected === actual || (typeof expected === "number" && typeof actual === "string" && String(expected) === actual) ||
    (typeof expected === "string" && typeof actual === "number" && expected === String(actual));
}
function baseUrl(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    fail("INVALID_CONFIG", "CRM/API 地址必须为无路径和凭据的 HTTPS 地址");
  return url.origin;
}
export function normalizeRecord(raw: unknown): RecordData {
  const record = object(raw);
  if (!Object.keys(record).length) fail("INVALID_RESPONSE", "CRM 记录格式不符");
  const result = { ...record };
  if (typeof result.id === "number") {
    if (!Number.isSafeInteger(result.id) || result.id <= 0)
      fail("INVALID_RESPONSE", "CRM ID 超出安全数值范围，请使用无损字符串响应");
    result.id = String(result.id);
  }
  return result;
}
export class CrmTicketBackend implements TicketBackend {
  private readonly metadataReads = new AsyncLocalStorage<Map<string, Promise<TicketMetadata>>>();
  constructor(
    readonly registry: ContractRegistry,
    readonly timeout = DEFAULT_TIMEOUT,
    readonly operationStore?: OperationStore,
  ) {
    if (!Number.isFinite(timeout) || timeout < 1000 || timeout > 300000)
      fail("VALIDATION_FAILED", "HTTP 超时范围为1至300秒");
  }
  withReadScope<T>(operation: () => Promise<T>): Promise<T> {
    return this.metadataReads.run(new Map(), operation);
  }
  async context(): Promise<TicketContext> {
    return (await this.contextSnapshot()).context;
  }
  private async contextSnapshot(): Promise<{ context: TicketContext; credentialKey: string }> {
    const manager = getAuthManager();
    const session = typeof manager.getRequestSession === "function" ? await manager.getRequestSession() : undefined;
    const token = session ? session.token : await manager.getToken();
    if (!token)
      fail("AUTH_REQUIRED", "请先配置 XSY_ACCESS_TOKEN 或执行 xsy auth login");
    const status = manager.getStatus();
    const supplied = session ? session.identity : manager.getSessionIdentity
      ? await manager.getSessionIdentity()
      : undefined;
    const external = !!process.env.XSY_ACCESS_TOKEN;
    const context: TicketContext = {
      key: "",
      apiBaseUrl: baseUrl(
        process.env.XSY_API_BASE_URL || manager.getApiBaseUrl(),
      ),
      crmBaseUrl: baseUrl(CRM_BASE_URL),
      tenantId: supplied?.tenantId ?? (external ? undefined : status.tenantId),
      subjectId: supplied?.subjectId ?? (external ? undefined : manager.getUsername()),
      identityVerified:
        supplied?.identityVerified === true || (!external && !!status.tenantId && !!manager.getUsername()),
      crmIdentityVerified: false,
    };
    const scope = this.registry.config.scope;
    if (supplied && (supplied.apiBaseUrl !== context.apiBaseUrl || supplied.crmBaseUrl !== context.crmBaseUrl))
      fail("CONTEXT_MISMATCH", "NeoCRM 会话与当前 API/CRM 环境不一致");
    if (
      scope &&
      (baseUrl(scope.apiBaseUrl) !== context.apiBaseUrl ||
        baseUrl(scope.crmBaseUrl) !== context.crmBaseUrl)
    )
      fail("CONTEXT_MISMATCH", "工单契约属于其他环境");
    const identity = this.registry.config.identity;
    if (identity) {
      const api = await this.identity(identity.api, context);
      if (supplied && (api.tenantId !== supplied.tenantId || api.subjectId !== supplied.subjectId))
        fail("CONTEXT_MISMATCH", "NeoCRM 与 API 身份核验结果不一致");
      context.tenantId = api.tenantId;
      context.subjectId = api.subjectId;
      context.identityVerified = true;
      if (identity.crm) {
        const crm = await this.identity(identity.crm, context);
        if (crm.tenantId !== api.tenantId || crm.subjectId !== api.subjectId)
          fail("CONTEXT_MISMATCH", "OAuth 与 CRM Cookie 身份不一致");
        context.crmIdentityVerified = true;
      }
    }
    if (
      scope &&
      (scope.tenantId !== context.tenantId ||
        (scope.subjectId && scope.subjectId !== context.subjectId))
    )
      fail("IDENTITY_UNVERIFIED", "当前身份与工单契约范围不符或尚未核验");
    context.key = digest({
      api: context.apiBaseUrl,
      crm: context.crmBaseUrl,
      tenant: context.tenantId,
      subject: context.subjectId,
      source: supplied?.source ?? (external ? "env" : "stored"),
      credential: context.identityVerified
        ? undefined
        : createHash("sha256").update(token).digest("hex"),
    });
    return { context, credentialKey: createHash("sha256").update(token).digest("hex") };
  }
  private async identity(
    spec: IdentitySpec,
    context: TicketContext,
  ): Promise<{ tenantId: string; subjectId: string }> {
    const raw = await this.send(
      spec.request,
      { context, input: {}, target: {} },
      "read",
    );
    const tenant = at(raw, spec.tenantPath),
      subject = at(raw, spec.subjectPath);
    if (
      !["string", "number"].includes(typeof tenant) ||
      !["string", "number"].includes(typeof subject)
    )
      fail("IDENTITY_UNVERIFIED", "身份响应未提供租户或用户");
    if (
      [tenant, subject].some(
        (v) => typeof v === "number" && !Number.isSafeInteger(v),
      )
    )
      fail("IDENTITY_UNVERIFIED", "身份 ID 数值不安全");
    return { tenantId: String(tenant), subjectId: String(subject) };
  }
  async metadata() {
    const { context, credentialKey } = await this.contextSnapshot();
    const reads = this.metadataReads.getStore();
    const key = `${context.key}:${credentialKey}`;
    const cached = reads?.get(key);
    if (cached) return cached;
    const pending = describeObject("fieldJob", { timeout: this.timeout }).then(normalizeMetadata);
    reads?.set(key, pending);
    try { return await pending; }
    catch (error) {
      if (reads?.get(key) === pending) reads.delete(key);
      throw error;
    }
  }
  async query(sql: string) {
    await this.context();
    const result = object(
      decodeResponse(
        await queryObjects(sql, { timeout: this.timeout }),
        "result",
      ),
    );
    if (
      !Array.isArray(result.records) ||
      typeof result.totalSize !== "number" ||
      !Number.isSafeInteger(result.totalSize) ||
      result.totalSize < 0
    )
      fail("INVALID_RESPONSE", "工单查询未返回可靠记录与总数");
    const records = result.records.map(normalizeRecord);
    if (result.totalSize < records.length)
      fail("INVALID_RESPONSE", "查询总数不能小于返回记录数");
    return { records, totalSize: result.totalSize, count: records.length };
  }
  async get(id: string, fields?: string[]): Promise<RecordData> {
    parseInput(idSchema, id);
    const meta = await this.metadata();
    return this.getUsingMetadata(id, fields, meta);
  }
  private async getUsingMetadata(id: string, fields: string[] | undefined, meta: TicketMetadata): Promise<RecordData> {
    parseInput(idSchema, id);
    const selected =
      fields ??
      KNOWN_FIELDS.filter((k) =>
        meta.fields.some((f) => f.apiKey === k && f.enabled !== false),
      );
    const available = new Set(
      meta.fields.filter((f) => f.enabled !== false).map((f) => f.apiKey),
    );
    available.add("id");
    for (const f of selected)
      if (!available.has(f)) fail("UNVERIFIED", `工单字段未核验: ${f}`);
    const page = await this.query(
      buildListQuery("fieldJob", [...new Set(["id", ...selected])], {
        where: `id = '${escapeSql(id)}'`,
        offset: 0,
        size: 1,
      }),
    );
    if (page.records.length > 1 || page.totalSize > 1 ||
        (page.records[0] && page.records[0].id !== id))
      fail("INVALID_RESPONSE", "工单详情查询未唯一匹配请求目标");
    if (!page.records[0]) fail("NOT_FOUND", "未找到该工单或当前账号无权读取");
    return page.records[0];
  }
  async inspect(
    contract: ActionContract,
    id: string | undefined,
    input: RecordData,
  ): Promise<Inspection> {
    const context = await this.context();
    const meta = await this.metadata();
    const available = new Set(meta.fields.map((f) => f.apiKey));
    available.add("id");
    const conditionFields = (contract.recordPreconditions ?? []).map((condition) => condition.field);
    for (const field of conditionFields)
      if (field !== "id" && !meta.fields.some((candidate) => candidate.apiKey === field && candidate.enabled !== false))
        fail("UNVERIFIED", `记录状态条件字段尚未核验或不可用: ${field}`);
    const fields = [
      ...new Set([
        ...DEFAULT_FIELDS,
        ...contract.preconditionFields,
        ...conditionFields,
        "entityType",
      ]),
    ].filter((f) => available.has(f));
    const record = id ? await this.getUsingMetadata(id, fields, meta) : null;
    if (contract.action !== "create" && record && contract.entityTypes &&
      !contract.entityTypes.includes(String(record.entityType)))
      fail("UNVERIFIED", "该业务类型尚未核验此动作");
    const identityVerified =
      context.identityVerified &&
      (contract.request?.host === "crm" || contract.probe?.request.host === "crm" ||
        contract.probe?.reads?.some((read) => read.request.host === "crm")
        ? context.crmIdentityVerified === true
        : true);
    if (!recordPreconditionsMatch(contract, record))
      return {
        record, permission: "unknown", allowed: "denied", identityVerified,
        required: [], defaults: {}, fields: {}, formVersion: "record-preconditions-not-matched",
      };
    const serverAction = fieldJobServerAction(contract, context.subjectId);
    if (serverAction === "assign") {
      if (!id || !record || String(contract.defaults.engineerId) !== context.subjectId)
        fail("CONTEXT_MISMATCH", "本人派工必须绑定当前已核验身份与工单");
      const team = await this.resource({ apiKey: "serviceTeam", fields: ["id", "fieldJobId", "engineerId", "teamRole"], linkField: "fieldJobId" }, id, 1, 1);
      if (team.totalSize !== 0) fail("PLAN_STALE", "服务团队已变化，不能覆盖已有成员");
      return { record, permission: "unknown", allowed: "unknown", identityVerified: context.identityVerified,
        required: [], defaults: {}, fields: {}, formVersion: "fieldjob-empty-team-self-assign-v1", output: { initialTeamCount: team.totalSize } };
    }
    if (serverAction === "activity_record") {
      if (!id || !record) fail("VALIDATION_FAILED", "活动记录必须绑定可读取的父工单");
      const child = inspectActivityRecordMetadata(await describeObject("activityrecord", { timeout: this.timeout }));
      if (input.startTime !== undefined && (!Number.isSafeInteger(input.startTime) || Number(input.startTime) < 0))
        fail("VALIDATION_FAILED", "活动记录发布时间必须为有效整数毫秒时间戳");
      return { record, permission: "unknown", allowed: "unknown", identityVerified: context.identityVerified,
        required: child.required, defaults: {}, fields: child.fields,
        formVersion: `fieldjob-activity-record-v1:${digest(child)}` };
    }
    if (serverAction === "attachment_upload" || serverAction === "attachment_link") {
      if (!id || !record) fail("VALIDATION_FAILED", "附件动作必须绑定可读取的明确工单");
      const field = meta.fields.find((item) => item.apiKey === FIELDJOB_ATTACHMENT_FIELD);
      if (!field || field.type.toLowerCase() !== "doc" || field.enabled === false)
        fail("UNVERIFIED", "工单附件字段尚未核验");
      let output: RecordData = {}, formVersion = "fieldjob-files-batch-page-v1";
      if (serverAction === "attachment_link") {
        if (!this.operationStore) fail("UNVERIFIED", "附件关联需要当前私有操作账本");
        const linked = inspectFieldJobAttachmentLink({ store: this.operationStore,
          uploadOperationId: String(input.uploadOperationId ?? ""), targetId: id, context,
          currentValue: record[FIELDJOB_ATTACHMENT_FIELD], field });
        output = { attachmentValue: linked.attachmentValue }; formVersion = linked.formVersion;
      }
      return { record, permission: serverAction === "attachment_link" && meta.flags.updateable === false ? "denied" : "unknown",
        allowed: "unknown", identityVerified: context.identityVerified, required: [], defaults: {}, fields: {}, formVersion, output };
    }
    if (contract.authorization === "server" && contract.action === "create") {
      // Unknown is preserved honestly. Execute sends once and the create API
      // either authorizes or rejects it; no read response is forged into true.
      return {
        record: null, permission: meta.flags.createable === false ? "denied" : "unknown", allowed: "unknown",
        identityVerified: context.identityVerified,
        required: [], defaults: {}, fields: {},
        formVersion: "server-validates-create-v1",
      };
    }
    if (contract.authorization === "server" && contract.action === "report") {
      if (!isServerReportUpdate(contract)) fail("INVALID_CONTRACT", "报告更新不符合受限字段契约");
      if (!id || !record) fail("VALIDATION_FAILED", "报告更新必须绑定可读取的明确工单");
      return {
        record, permission: meta.flags.updateable === false ? "denied" : "unknown", allowed: "unknown",
        identityVerified: context.identityVerified,
        required: [], defaults: {}, fields: {},
        formVersion: "server-validates-report-content-v1",
      };
    }
    if (contract.authorization === "server" && contract.action === "worklog") {
      if (!id || !record) fail("VALIDATION_FAILED", "工时创建必须绑定可读取的父工单");
      const response = await describeObject("timeSheetDetatils__c", { timeout: this.timeout });
      const envelope = object(response);
      const data = object(decodeResponse(response, "data" in envelope ? "data" : "result"));
      if (data.apiKey !== "timeSheetDetatils__c" || !Array.isArray(data.fields))
        fail("INVALID_METADATA", "工时对象元数据格式不符");
      const availableFields = new Map(data.fields.map((raw) => {
        const field = object(raw);
        const apiKey = field.apiKey ?? field.propertyname;
        if (typeof apiKey !== "string" || !fieldSchema.safeParse(apiKey).success)
          fail("INVALID_METADATA", "工时字段 API Key 无效");
        return [apiKey, field] as const;
      }));
      const required = [...availableFields].filter(([, field]) =>
        field.required === true && (field.createable ?? field.creatable) === true && field.enabled !== false,
      ).map(([apiKey]) => apiKey).sort();
      for (const key of required)
        if (!contract.fields[key]) fail("UNVERIFIED", `工时创建契约缺少当前必填字段: ${key}`);
      const fields: Record<string, InputField> = {};
      const values = { ...contract.defaults, ...input };
      const parentRule = contract.fields.remoteWorkOrders__c;
      if (!parentRule || !["string", "number"].includes(parentRule.type))
        fail("INVALID_CONTRACT", "工时父工单字段必须为明确引用类型");
      const parent = parentRule.type === "number" ? Number(id) : id;
      if (typeof parent === "number" && !Number.isSafeInteger(parent))
        fail("VALIDATION_FAILED", "父工单ID不能无损编码为数值");
      if (values.remoteWorkOrders__c !== undefined && String(values.remoteWorkOrders__c) !== id)
        fail("VALIDATION_FAILED", "工时不能关联到不同的父工单");
      const defaults: RecordData = { remoteWorkOrders__c: parent };
      for (const [apiKey, declared] of Object.entries(contract.fields)) {
        const field = availableFields.get(apiKey);
        if (!field || field.enabled === false || (field.createable ?? field.creatable) !== true)
          fail("FORBIDDEN", `工时字段不存在或不可创建: ${apiKey}`);
        const type = String(field.type ?? "").toLowerCase();
        const rawOptions = field.options ?? field.selectitem;
        const options = Array.isArray(rawOptions) ? rawOptions.filter((option) => {
          const value = object(option);
          return value.enabled !== false && value.active !== false && value.isActive !== false;
        }).map((option) => object(option).value ?? object(option).id) : undefined;
        let actualType: InputField["type"];
        if (["reference", "entitytype", "dimension", "detail"].includes(type)) {
          if (!["string", "number"].includes(declared.type))
            fail("UNVERIFIED", `工时引用字段类型尚未匹配: ${apiKey}`);
          actualType = declared.type;
        } else if (["number", "numeric", "integer", "int", "long", "double", "float", "decimal", "currency", "money", "percent", "date", "datetime", "timestamp"].includes(type)) {
          actualType = "number";
        } else if (["boolean", "checkbox"].includes(type)) {
          actualType = "boolean";
        } else if (["picklist", "select", "selectone"].includes(type)) {
          if (!options || !["string", "number", "boolean"].includes(declared.type))
            fail("UNVERIFIED", `工时选项字段缺少可验证选项: ${apiKey}`);
          actualType = declared.type;
        } else if (["text", "string", "textarea", "longtext", "richtext", "email", "phone", "url"].includes(type)) {
          actualType = "string";
        } else {
          fail("UNVERIFIED", `工时字段类型尚未核验: ${apiKey}`);
        }
        if (declared.type !== actualType) fail("VALIDATION_FAILED", `工时字段类型与当前元数据不符: ${apiKey}`);
        const picklist = ["picklist", "select", "selectone"].includes(type);
        fields[apiKey] = {
          type: actualType, required: required.includes(apiKey),
          ...(options?.length || picklist ? { enum: options ?? [] } : {}),
          ...(actualType === "string" && typeof field.maxLength === "number" && Number.isSafeInteger(field.maxLength) && field.maxLength > 0
            ? { max: field.maxLength } : {}),
          ...(actualType === "string" && typeof field.minLength === "number" && Number.isSafeInteger(field.minLength) && field.minLength >= 0
            ? { min: field.minLength } : {}),
        };
        const value = values[apiKey] ?? defaults[apiKey];
        if (value !== undefined && value !== null) {
          if (["reference", "entitytype", "dimension", "detail"].includes(type)) {
            if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0))
              fail("VALIDATION_FAILED", `工时引用ID必须为安全正整数: ${apiKey}`);
            parseInput(idSchema, String(value));
          }
          if (["number", "numeric", "integer", "int", "long", "double", "float", "decimal", "currency", "money", "percent", "date", "datetime", "timestamp"].includes(type) &&
            (typeof value !== "number" || !Number.isFinite(value)))
            fail("VALIDATION_FAILED", `工时数字或日期字段必须为有限数值: ${apiKey}`);
          if (["integer", "int", "long", "date", "datetime", "timestamp"].includes(type) &&
            (typeof value !== "number" || !Number.isSafeInteger(value)))
            fail("VALIDATION_FAILED", `工时整数或日期字段必须为安全整数: ${apiKey}`);
          if (["date", "datetime", "timestamp"].includes(type) &&
            (typeof value !== "number" || value < 0 || !Number.isFinite(new Date(value).getTime())))
            fail("VALIDATION_FAILED", `工时日期必须为有效毫秒时间戳: ${apiKey}`);
        }
      }
      const rules = [...availableFields].map(([apiKey, field]) => ({
        apiKey, type: field.type, required: field.required === true,
        createable: field.createable ?? field.creatable, enabled: field.enabled,
        maxLength: field.maxLength, minLength: field.minLength,
        options: Array.isArray(field.options ?? field.selectitem)
          ? [...(field.options ?? field.selectitem) as unknown[]].map((option) => object(option))
            .filter((option) => option.enabled !== false && option.active !== false && option.isActive !== false)
            .map((option) => option.value ?? option.id).sort((a, b) => canonical(a).localeCompare(canonical(b)))
          : [],
      })).sort((a, b) => a.apiKey.localeCompare(b.apiKey));
      return {
        record, permission: (data.createable ?? data.creatable) === false ? "denied" : "unknown", allowed: "unknown",
        identityVerified: context.identityVerified, required, defaults, fields,
        formVersion: `server-validates-worklog-v1:${digest({ createable: data.createable ?? data.creatable, fields: rules })}`,
      };
    }
    if (!contract.probe) fail("UNVERIFIED", "缺少当前动作/权限探测协议");
    if (!identityVerified)
      return {
        record,
        permission: "unknown",
        allowed: "unknown",
        identityVerified: false,
        required: [],
        defaults: {},
        fields: {},
        formVersion: "identity-unverified",
      };
    const raw = await this.send(
      contract.probe.request,
      {
        context,
        input: { ...contract.defaults, ...input },
        target: { id },
        record,
      },
      "read",
    );
    const form = contract.probe.formPath
      ? parseInput(formSchema, at(raw, contract.probe.formPath))
      : parseInput(formSchema, {});
    const output = projectProbeOutput(raw, contract.probe.outputPaths);
    for (const read of contract.probe.reads ?? []) {
      const additional = await this.send(read.request, {
        context,
        input: { ...contract.defaults, ...input },
        target: { id },
        record,
        probe: output,
      }, "read");
      const projected = projectProbeOutput(additional, read.outputPaths);
      for (const [key, value] of Object.entries(projected)) {
        if (Object.hasOwn(output, key)) fail("INVALID_CONTRACT", "动作探测输出键重复");
        output[key] = value;
      }
    }
    const inspection: Inspection = {
      record,
      permission: decision(at(raw, contract.probe.permissionPath)),
      allowed: decision(at(raw, contract.probe.allowedPath)),
      identityVerified,
      required: form.required,
      defaults: form.defaults,
      fields: form.fields,
      formVersion: form.version ?? digest(form),
      output,
    };
    const preprocessingId = input.preprocessingOperationId;
    const trustedPreprocessing = typeof contract.version === "string" && contract.version.startsWith("fieldjob-workflow-v1:") &&
      ["advance", "close"].includes(contract.action) && typeof preprocessingId === "string" && this.operationStore && id
      ? trustedPreprocessingFromOperation(this.operationStore.read(preprocessingId), context, id)
      : undefined;
    return guardFieldJobWorkflowInspection(contract, inspection, input, { trustedPreprocessing });
  }
  async submit(
    contract: ActionContract,
    plan: TicketPlan,
  ): Promise<Submission> {
    if (!contract.request || contract.verification !== "verified")
      fail("UNVERIFIED", "缺少已核验写入协议");
    const context = await this.context();
    if (context.key !== plan.contextKey)
      fail("CONTEXT_MISMATCH", "发送前身份已变化");
    let responseDiagnostic: TicketOperation["remoteError"];
    const raw = await this.send(
      contract.request,
      {
        context, input: plan.input, target: { id: plan.targetId },
        operation: { operationId: plan.operationId, planId: plan.planId },
      },
      "write",
      plan.payload,
      plan.file,
      plan.requestHeaders,
      (diagnostic) => { responseDiagnostic = diagnostic; },
      (response) => { this.operationStore?.writeResponseEvidence(plan.planId, response); },
    );
    const serverAction = fieldJobServerAction(contract, context.subjectId);
    if (serverAction === "assign") {
      const result = decodeFieldJobDispatchResponse({ httpStatus: 200, body: raw });
      if (result.status === "rejected") fail("REMOTE_REJECTED", "服务器明确拒绝本次专用派工", responseDiagnostic);
      if (result.status !== "accepted") fail("OUTCOME_UNKNOWN", "派工响应缺少可判定的逐条结果，不重发", responseDiagnostic);
    }
    if (serverAction === "attachment_upload") {
      if (!plan.file || !context.tenantId) fail("OUTCOME_UNKNOWN", "上传响应缺少已绑定的文件或身份范围");
      return parseFieldJobAttachmentUpload(raw, plan.file, { ...context, tenantId: context.tenantId });
    }
    const id = contract.request.resultIdPath
      ? at(raw, contract.request.resultIdPath)
      : undefined;
    if (
      id !== undefined &&
      ((typeof id !== "string" &&
        (typeof id !== "number" || !Number.isSafeInteger(id))) ||
        !idSchema.safeParse(String(id)).success)
    )
      fail("OUTCOME_UNKNOWN", "写入返回 ID 无法可靠解析", {
        ...responseDiagnostic, serverMessage: responseDiagnostic?.serverMessage ?? "服务器响应未提供可可靠解析的新记录ID",
      });
    if ((contract.action === "create" || serverAction === "activity_record" || (contract.action === "worklog" && contract.authorization === "server")) && !id)
      fail("OUTCOME_UNKNOWN", "创建已响应但未取得记录 ID", {
        ...responseDiagnostic, serverMessage: responseDiagnostic?.serverMessage ?? "服务器成功响应中缺少契约要求的新记录ID；创建结果需回查",
      });
    const output = Object.fromEntries(
      Object.entries(contract.request.outputPaths ?? {}).map(([key, p]) => [
        key,
        at(raw, p) ?? null,
      ]),
    );
    return validateFieldJobWorkflowSubmission(contract, { id: id === undefined ? undefined : String(id), output });
  }
  async verify(
    contract: ActionContract,
    plan: TicketPlan,
    submission: Submission,
  ): Promise<VerificationResult> {
    if (!contract.verify) return { status: "partial", checks: [] };
    const context = await this.context();
    if (context.key !== plan.contextKey) fail("CONTEXT_MISMATCH", "回读验证身份与已确认操作不一致");
    const targetId = plan.targetId ?? submission.id;
    if (!targetId) return { status: "pending", checks: [] };
    const serverAction = fieldJobServerAction(contract, context.subjectId);
    if (serverAction === "attachment_upload") {
      const parent = await this.get(targetId, ["id"]);
      const acknowledged = submission.output.uploadAcknowledged === true && parent.id === targetId &&
        !!plan.file && canonical(submission.output.uploadedFile) === canonical({ name: plan.file.name, size: plan.file.size, sha256: plan.file.sha256 });
      return { status: acknowledged ? "verified" : "pending", checks: [{ field: "uploadAcknowledged", matched: acknowledged }] };
    }
    const bindings = {
      context,
      input: plan.input,
      probe: plan.probeOutput ?? {},
      operation: { operationId: plan.operationId, planId: plan.planId },
      target: { id: targetId },
      result: { ...submission.output, id: submission.id },
    };
    const records = contract.verify.query
      ? (
          await this.resource(
            contract.verify.query,
            contract.verify.query.bind === "result"
              ? (submission.id ?? "")
              : targetId,
            1,
            100,
          )
        ).records
      : [
          await this.get(
            targetId,
            contract.verify.checks.map((c) => c.field),
          ),
        ];
    const matches = (record: RecordData, check: { field: string; expected: unknown }): boolean => {
      if (record[check.field] === undefined) return false;
      const expected = template(check.expected, bindings);
      if (serverAction === "attachment_link" && check.field === FIELDJOB_ATTACHMENT_FIELD)
        return typeof expected === "string" && fieldJobAttachmentLinkMatches(record[check.field], expected);
      return canonical(record[check.field]) === canonical(expected);
    };
    const checks = contract.verify.checks.map((c) => ({
      field: c.field,
      matched: records.some((record) => matches(record, c)),
    }));
    // 多个检查必须在同一条关联记录上成立，不能跨行拼凑一个成功结果。
    let matched = records.some((r) =>
      contract.verify!.checks.every((check) => matches(r, check)),
    );
    for (const group of contract.verify.additional ?? []) {
      const related = (
        await this.resource(
          group.query,
          group.query.bind === "result" ? (submission.id ?? "") : targetId,
          1,
          100,
        )
      ).records;
      const complete = related.some((r) =>
        group.checks.every(
          (c) =>
            r[c.field] !== undefined &&
            canonical(r[c.field]) === canonical(template(c.expected, bindings)),
        ),
      );
      matched = matched && complete;
      checks.push(
        ...group.checks.map((c) => ({
          field: `${group.name}.${c.field}`,
          matched: related.some(
            (r) =>
              r[c.field] !== undefined &&
              canonical(r[c.field]) ===
                canonical(template(c.expected, bindings)),
          ),
        })),
      );
    }
    return { status: matched ? "verified" : "pending", checks };
  }
  async recover(contract: ActionContract, plan: TicketPlan) {
    const context = await this.context();
    if (context.key !== plan.contextKey) fail("CONTEXT_MISMATCH", "恢复身份与原操作不一致");
    if (fieldJobServerAction(contract, context.subjectId) === "attachment_upload" && this.operationStore) {
      const evidence = this.operationStore.readResponseEvidence(plan.planId);
      if (!evidence || evidence.redactedPaths.length || !plan.file || !context.tenantId)
        return { status: "unavailable" as const };
      const envelope = object(evidence.raw);
      if (typeof envelope.httpStatus !== "number" || envelope.httpStatus < 200 || envelope.httpStatus >= 300 ||
        !Object.hasOwn(envelope, "body")) return { status: "unavailable" as const };
      try {
        const submission = parseFieldJobAttachmentUpload(envelope.body, plan.file, { ...context, tenantId: context.tenantId });
        return { status: "matched" as const, matchedCount: 1, submission };
      } catch { return { status: "unavailable" as const }; }
    }
    if (fieldJobServerAction(contract, context.subjectId) === "attachment_link" && this.operationStore) {
      const operation = this.operationStore.read(plan.planId);
      const receipt = this.operationStore.readResponseEvidence(plan.planId);
      const diagnostic = operation.remoteError;
      const envelope = object(receipt?.raw);
      const httpStatus = typeof envelope.httpStatus === "number" ? envelope.httpStatus : diagnostic?.httpStatus;
      const rawCode = receipt && Object.hasOwn(envelope, "body") ? at(envelope.body, contract.request!.successPath) : diagnostic?.serverCode;
      const acknowledged = httpStatus === 200 &&
        contract.request!.successValues.some((value) => protocolValueMatches(value, rawCode));
      if (acknowledged) return { status: "matched" as const, matchedCount: 1, submission: { output: {} } };
      return { status: "unavailable" as const };
    }
    return recoverByCorrelation(this, contract, plan);
  }
  async resource(spec: ResourceQuery, id: string, page: number, size: number) {
    parseInput(idSchema, id);
    return this.query(
      buildListQuery(spec.apiKey, [...new Set(["id", ...spec.fields])], {
        where: `${spec.linkField} = '${escapeSql(id)}'`,
        order: "id desc",
        offset: (page - 1) * size,
        size,
      }),
    );
  }
  async readRequest(spec: RequestSpec, bindings: RecordData) {
    return this.send(spec, bindings, "read");
  }
  async downloadRequest(
    spec: RequestSpec,
    bindings: RecordData,
    maxBytes: number,
  ): Promise<Buffer> {
    if (spec.method !== "GET")
      fail("INVALID_CONTRACT", "附件下载必须是读取协议");
    const context = object(bindings.context) as unknown as TicketContext;
    const url = this.route(spec, bindings);
    const cookie = spec.host === "crm" ? getCrmCookie() : undefined;
    if (spec.host === "crm" && !cookie)
      fail("AUTH_REQUIRED", "CRM Cookie 未配置");
    const headers = object(template(spec.headers ?? {}, bindings));
    if (cookie) headers.Cookie = cookie;
    const config = {
      method: "GET" as const,
      url,
      params: object(template(spec.payload ?? {}, bindings)),
      baseURL: spec.host === "api" ? context.apiBaseUrl : context.crmBaseUrl,
      headers: headers as Record<string, string>,
      responseType: "arraybuffer" as const,
      timeout: this.timeout,
      maxRedirects: 0,
      maxContentLength: maxBytes,
      xsyReplay: "read" as const,
      validateStatus: () => true,
    };
    const response = await (
      spec.host === "api" ? getApiClient() : axios
    ).request(config);
    if (
      response.status !== 200 ||
      (/text\/html|application\/json/i.test(
        String(response.headers["content-type"]),
      ) &&
        !/attachment/i.test(String(response.headers["content-disposition"])))
    )
      fail("DOWNLOAD_FAILED", "附件下载未返回已核验二进制响应");
    return Buffer.from(response.data);
  }
  private route(spec: RequestSpec, bindings: RecordData): string {
    const route = spec.path.replace(
      /:([A-Za-z][A-Za-z0-9_]*)/g,
      (_, key: string) =>
        encodeURIComponent(parseInput(idSchema, object(bindings.target)[key])),
    );
    if (route.includes(":")) fail("INVALID_CONTRACT", "接口路径占位符未解析");
    return route;
  }
  private async send(
    spec: RequestSpec,
    bindings: RecordData,
    kind: "read" | "write",
    prepared?: unknown,
    file?: FileBinding,
    preparedHeaders?: Record<string, string>,
    onResponseDiagnostic?: (diagnostic: TicketOperation["remoteError"]) => void,
    onResponseEvidence?: (body: unknown) => void,
  ): Promise<unknown> {
    const context = object(bindings.context) as unknown as TicketContext;
    const payload =
      prepared === undefined
        ? template(spec.payload ?? {}, bindings)
        : prepared;
    const cookie = spec.host === "crm" ? getCrmCookie() : undefined;
    if (spec.host === "crm" && !cookie)
      fail("AUTH_REQUIRED", "CRM Cookie 未配置");
    let data: unknown = payload;
    if (spec.encoding === "form") {
      data = new URLSearchParams(
        Object.entries(object(payload)).map(([k, v]) => {
          if (spec.jsonFields?.includes(k)) return [k, JSON.stringify(v)];
          if (v !== null && typeof v === "object")
            fail("INVALID_CONTRACT", "表单嵌套字段需明确声明 jsonFields");
          return [k, String(v ?? "")];
        }),
      ).toString();
    }
    if (spec.encoding === "multipart") {
      if (kind !== "write" || !file || !spec.fileField)
        fail("INVALID_CONTRACT", "上传动作缺少绑定文件");
      const bytes = readFileSync(file.path);
      if (
        bytes.length !== file.size ||
        createHash("sha256").update(bytes).digest("hex") !== file.sha256
      )
        fail("PLAN_STALE", "发送前附件内容已变化");
      const form = new FormData();
      for (const [k, v] of Object.entries(object(payload)))
        form.append(k, typeof v === "string" ? v : JSON.stringify(v));
      form.append(spec.fileField, new Blob([new Uint8Array(bytes)]), file.name);
      data = form;
    }
    const headers = { ...object(preparedHeaders ?? template(spec.headers ?? {}, bindings)) } as Record<
      string,
      string
    >;
    if (cookie) headers.Cookie = cookie;
    for (const value of Object.values(headers))
      if (typeof value !== "string" || /[\r\n]/.test(value))
        fail("INVALID_CONTRACT", "接口头部值必须为无换行字符串");
    headers["Content-Type"] =
      spec.encoding === "multipart"
        ? "multipart/form-data"
        : spec.encoding === "json"
          ? "application/json"
          : "application/x-www-form-urlencoded";
    const response = await (
      spec.host === "api" ? getApiClient() : axios
    ).request({
      url: this.route(spec, bindings),
      baseURL: spec.host === "api" ? context.apiBaseUrl : context.crmBaseUrl,
      method: spec.method,
      headers,
      params: spec.method === "GET" ? object(payload) : undefined,
      data: spec.method === "GET" ? undefined : data,
      timeout: this.timeout,
      maxRedirects: 0,
      maxContentLength: 20 * 1024 * 1024,
      maxBodyLength: 21 * 1024 * 1024,
      xsyReplay: kind === "write" ? "never" : "read",
      validateStatus: () => true,
    });
    const code = at(response.data, spec.successPath);
    const diagnostic = safeRemoteError({
      httpStatus: response.status, serverCode: code,
      serverMessage: object(response.data).msg ?? object(response.data).message ?? object(response.data).statusText,
    });
    if (kind === "write") onResponseDiagnostic?.(diagnostic);
    // Store the response before interpreting success codes or adapter fields.
    if (kind === "write") onResponseEvidence?.({ httpStatus: response.status, body: response.data });
    if (
      response.status >= 200 &&
      response.status < 300 &&
      spec.successValues.some((v) => protocolValueMatches(v, code))
    )
      return response.data;
    if (spec.rejectValues?.some((v) => protocolValueMatches(v, code)))
      fail("REMOTE_REJECTED", "服务器明确拒绝该操作", kind === "write" ? diagnostic : undefined);
    if (kind === "write" && spec.path === "/rest/data/v2.0/xobjects/fieldJob" &&
      spec.method === "POST" && spec.host === "api" &&
      ([400, 401, 403, 404, 405, 413, 415, 422, 429].includes(response.status) ||
        ((response.status >= 200 && response.status < 300) &&
          [400, 401, 403, 404, 405, 413, 415, 422, 429].includes(Number(code)))))
      fail("REMOTE_REJECTED", `创建请求被服务器拒绝 (HTTP ${response.status}, code ${String(code)})`, {
        ...diagnostic,
      });
    fail(
      kind === "write" ? "OUTCOME_UNKNOWN" : "INVALID_RESPONSE",
      kind === "write"
        ? "写请求未取得可判定结果，请回查操作状态"
        : "读取响应与已核验契约不符",
      kind === "write" ? diagnostic : undefined,
    );
  }
}
