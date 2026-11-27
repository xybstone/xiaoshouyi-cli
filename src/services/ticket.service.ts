import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { buildListQuery, escapeSql } from "../utils/index.js";
import { TicketActions, type Confirmation } from "../tickets/actions.js";
import { CrmTicketBackend } from "../tickets/backend.js";
import { ContractRegistry } from "../tickets/contracts.js";
import { OperationStore } from "../tickets/operation-store.js";
import { withFreshReads } from "../tickets/read-scope.js";
import { discoverFieldJobWorkflow } from "../tickets/fieldjob-workflow.js";
import { downloadFieldJobAttachmentFromUpload } from "../tickets/fieldjob-attachment-download.js";
import { fieldJobBranchProtocolEvidence } from "../tickets/fieldjob-branches.js";
import {
  fieldJobHistoryReadRequest, decodeFieldJobHistoryPage,
  fieldJobWorkflowHistoryReadRequest, decodeFieldJobWorkflowHistory,
} from "../tickets/fieldjob-history.js";
import {
  serviceReportTemplateListReadRequest, serviceReportFormsReadRequest, serviceReportRulesReadRequest,
  selectServiceReportTemplate, inspectServiceReportPreflight, type ServiceReportTemplateChoice,
} from "../tickets/fieldjob-service-report.js";
import {
  TicketReferences,
  eventTime,
  prepareWithReferencesSchema,
  referenceSummary,
  type ReferenceInput,
} from "../tickets/references.js";
import {
  ACTIONS,
  DEFAULT_FIELDS,
  at,
  fail,
  idSchema,
  object,
  parseInput,
  safeDiagnosticMessage,
  safeRemoteError,
  searchSchema,
  type RecordData,
  type SearchInput,
  type TicketBackend,
  type TicketOperation,
  type OperationReview,
} from "../tickets/types.js";

export class TicketService {
  readonly actions: TicketActions;
  readonly references: TicketReferences;
  constructor(
    readonly backend: TicketBackend,
    readonly registry: ContractRegistry,
    readonly store: OperationStore = new OperationStore(),
  ) {
    this.actions = new TicketActions(backend, registry, store);
    this.references = new TicketReferences(backend, registry.config.references, registry.config.scope);
  }
  async search(raw: SearchInput = {}) {
    const args = parseInput(searchSchema, raw);
    const metadata = await this.backend.metadata();
    const available = new Set(
      metadata.fields.filter((f) => f.enabled !== false).map((f) => f.apiKey),
    );
    available.add("id");
    const selected =
      args.fields ?? DEFAULT_FIELDS.filter((f) => available.has(f));
    for (const field of selected)
      if (!available.has(field)) fail("UNVERIFIED", `字段尚未核验: ${field}`);
    const where: string[] = [];
    const eq = (field: string, value: string | undefined) => {
      if (value !== undefined) {
        if (!available.has(field))
          fail("UNVERIFIED", `筛选字段尚未核验: ${field}`);
        where.push(`${field} = '${escapeSql(value)}'`);
      }
    };
    eq("id", args.id);
    eq("fieldJobAccountId", args.customerId);
    eq("responsibleTE__c", args.responsibleId);
    eq("entityType", args.entityType);
    if (args.keyword) {
      if (/[%_]/.test(args.keyword))
        fail("VALIDATION_FAILED", "关键词不接受 SQL 通配符");
      if (!available.has("name")) fail("UNVERIFIED", "标题字段未核验");
      where.push(`name like '${escapeSql(args.keyword)}%'`);
    }
    for (const [field, values] of [
      ["status", args.status],
      ["priority", args.priority],
    ] as const)
      if (values) {
        if (!available.has(field))
          fail("UNVERIFIED", `筛选字段尚未核验: ${field}`);
        // 历史记录可引用已停用选项；读取保留调用方给出的原始值，
        // 只有创建/更新才按当前有效表单选项限制写入。
        where.push(
          `${field} in (${values.map((v) => `'${escapeSql(v)}'`).join(",")})`,
        );
      }
    if (args.number) {
      const field = this.registry.config.read?.numberField;
      if (!field)
        fail("UNVERIFIED", "业务编号字段尚未核验，不能用标题或 ID 替代");
      eq(field, args.number);
    }
    if (args.since || args.until) {
      const read = this.registry.config.read;
      const field = read?.createdTimeField;
      if (!field || read?.dateEncoding !== "unix-ms" || !available.has(field))
        fail("UNVERIFIED", "日期筛选字段及毫秒编码尚未核验");
      if (
        args.since &&
        args.until &&
        Date.parse(args.since) >= Date.parse(args.until)
      )
        fail("VALIDATION_FAILED", "开始时间必须早于结束时间，区间为左闭右开");
      if (args.since) where.push(`${field} >= ${Date.parse(args.since)}`);
      if (args.until) where.push(`${field} < ${Date.parse(args.until)}`);
    }
    const page = await this.backend.query(
      buildListQuery("fieldJob", selected, {
        where: where.join(" and ") || undefined,
        order: `id ${args.order}`,
        offset: (args.page - 1) * args.size,
        size: args.size,
      }),
    );
    if (!Number.isSafeInteger(page.totalSize) || page.totalSize < page.records.length ||
      page.records.length > args.size || page.count !== page.records.length)
      fail("INVALID_RESPONSE", "工单分页返回数量超过限制或计数不一致");
    return {
      records: page.records.map((row) =>
        Object.fromEntries(selected.map((f) => [f, row[f] ?? null])),
      ),
      totalSize: page.totalSize,
      count: page.records.length,
      page: args.page,
      size: args.size,
      nextPage: args.page * args.size < page.totalSize ? args.page + 1 : null,
      consistency: "best_effort",
      scope: "当前账号可见范围",
    };
  }
  async get(id: string, fields?: string[], includeContext = false) {
    return withFreshReads(this.backend, () => this.getInScope(id, fields, includeContext));
  }
  private async getInScope(id: string, fields?: string[], includeContext = false) {
    parseInput(idSchema, id);
    if (fields) parseInput(searchSchema, { fields });
    if (!includeContext) return this.backend.get(id, fields);
    const meta = await this.backend.metadata();
    const available = new Set(
      meta.fields.filter((f) => f.enabled !== false).map((f) => f.apiKey),
    );
    available.add("id");
    if (fields?.some((f) => !available.has(f)))
      fail("UNVERIFIED", "请求字段尚未核验");
    const relatedFields = ["fieldJobAccountId", "fieldJobAssetId"].filter((f) =>
      available.has(f),
    );
    const raw = await this.backend.get(
      id,
      fields ? [...new Set([...fields, ...relatedFields])] : undefined,
    );
    const record = fields
      ? Object.fromEntries(fields.map((f) => [f, raw[f] ?? null]))
      : raw;
    const context: RecordData = {};
    const ref = (value: unknown) => {
      const v = object(value).id ?? value;
      if (typeof v === "number" && !Number.isSafeInteger(v))
        fail("INVALID_RESPONSE", "关联 ID 数值不安全");
      return typeof v === "string" || typeof v === "number"
        ? String(v)
        : undefined;
    };
    const account = ref(raw.fieldJobAccountId),
      asset = ref(raw.fieldJobAssetId);
    if (account && this.backend instanceof CrmTicketBackend &&
      !this.registry.config.references.some((r) => r.kind === "customer" && r.verification === "verified")) {
      try {
        const response = await this.backend.resource(
          { apiKey: "account", fields: ["accountName"], linkField: "id" },
          account,
          1,
          1,
        );
        context.account = {
          coverage: response.records.length ? "verified" : "unavailable",
          records: response.records,
        };
      } catch {
        context.account = { coverage: "unavailable" };
      }
    } else
      context.account = {
        coverage: raw.fieldJobAccountId === null ? "not_linked" : "unverified",
      };
    context.asset = {
      referenceId: asset,
      coverage: raw.fieldJobAssetId === null ? "not_linked" : "unverified",
      reason: "资产对象及关联读取契约尚未核验",
    };
    for (const linked of [
      { key: "account", kind: "customer" as const, id: account },
      { key: "asset", kind: "asset" as const, id: asset },
    ]) {
      if (!linked.id || !this.registry.config.references.some((r) => r.kind === linked.kind && r.verification === "verified"))
        continue;
      try {
        const resolved = await this.references.resolve({ kind: linked.kind, id: linked.id, limit: 1 });
        context[linked.key] = resolved.status === "resolved"
          ? { coverage: "verified", records: resolved.candidates }
          : { coverage: "unavailable", reason: resolved.code };
      } catch {
        context[linked.key] = { coverage: "unavailable" };
      }
    }
    return {
      record,
      context,
      coverage: Object.values(context).every((v) =>
        ["verified", "not_linked"].includes(String(object(v).coverage)),
      )
        ? "complete"
        : "partial",
    };
  }
  async capabilities(options: { id?: string; refresh?: boolean } = {}) {
    return withFreshReads(this.backend, () => this.capabilitiesInScope(options));
  }
  async workflow(id: string, includeSubmitChooser = false) {
    parseInput(idSchema, id);
    if (!(this.backend instanceof CrmTicketBackend))
      fail("UNSUPPORTED", "当前适配器未提供工单流程发现");
    const backend = this.backend;
    return withFreshReads(backend, () => discoverFieldJobWorkflow(backend, id, { includeSubmitChooser }));
  }
  async serviceReportPreflight(id: string, choice: ServiceReportTemplateChoice = {}) {
    parseInput(idSchema, id);
    const mapping = this.registry.config.fieldJobHistory;
    if (!mapping || !(this.backend instanceof CrmTicketBackend))
      fail("UNVERIFIED", "独立服务报告预检需要已核验的父对象映射及适配器");
    const backend = this.backend;
    return withFreshReads(backend, async () => {
      const context = await backend.context(), record = await backend.get(id, ["id", "entityType"]);
      const selection = { targetId: id, parentObjectId: mapping.parentObjectId,
        parentEntityType: parseInput(idSchema, String(record.entityType)) };
      const bindings = { context, input: {}, target: { id }, record };
      const templateList = await backend.readRequest(serviceReportTemplateListReadRequest(selection), bindings);
      const selected = selectServiceReportTemplate(templateList, choice);
      if (selected.status !== "selected") return { ...selected, targetId: id, crmWrite: false };
      const [forms, parsedRules] = await Promise.all([
        backend.readRequest(serviceReportFormsReadRequest(selection, selected.template.id), bindings),
        backend.readRequest(serviceReportRulesReadRequest(selection, selected.template.id), bindings),
      ]);
      const result = inspectServiceReportPreflight({ context: selection, templateList, choice, forms, parsedRules });
      if ((await backend.context()).key !== context.key) fail("CONTEXT_MISMATCH", "服务报告预检期间身份发生变化");
      return { ...result, crmWrite: false, generationExecuted: false };
    });
  }
  private async capabilitiesInScope(options: { id?: string; refresh?: boolean } = {}) {
    if (options.id) parseInput(idSchema, options.id);
    const metadata = options.refresh ? await this.backend.metadata() : null;
    if (options.id) await this.backend.get(options.id);
    const actions = [];
    for (const action of ACTIONS) {
      const contract = this.registry.get(action);
      let permission = "unknown",
        allowed = "unknown",
        identityVerified = false;
      let reason: string | undefined;
      if (
        options.id &&
        contract.verification === "verified" &&
        action !== "create"
      ) {
        try {
          const inspection = await this.backend.inspect(
            contract,
            options.id,
            {},
          );
          permission = inspection.permission;
          allowed = inspection.allowed;
          identityVerified = inspection.identityVerified;
        } catch (error) {
          reason =
            typeof object(error).code === "string"
              ? String(object(error).code)
              : "CAPABILITY_UNAVAILABLE";
        }
      }
      actions.push({
        action,
        contract: contract.verification,
        authorization: contract.authorization ?? "probe",
        permission,
        recordAction: allowed,
        executable:
          contract.verification === "verified" &&
          permission === "allowed" &&
          allowed === "allowed" &&
          identityVerified &&
          process.env.XSY_TICKET_WRITES === "1",
        requiresConfirmation: true,
        reason,
        version: contract.version,
      });
    }
    return {
      objectApiKey: "fieldJob",
      read: {
        evidence: "user_report_2026-11-24",
        runtime: options.id ? "verified" : "unverified",
        permission: options.id ? "allowed" : "unknown",
        metadataRead: metadata ? "verified" : "unverified",
      },
      metadata,
      references: referenceSummary(this.registry.config.references),
      actions,
      branchEvidence: fieldJobBranchProtocolEvidence(),
      writePolicy:
        process.env.XSY_TICKET_WRITES === "1" ? "enabled" : "disabled",
      note: "对象标记和枚举不能证明用户写权限或允许迁移；无目标时动作执行条件保持 unknown。doc查询为空或省略不证明没有附件，关联需要独立回读。",
    };
  }
  async prepare(raw: unknown) {
    const { references, ...args } = parseInput(prepareWithReferencesSchema, raw);
    if (!references?.length || this.registry.get(args.action).verification !== "verified")
      return this.actions.prepare(args);
    const seen = new Set<string>();
    const input = { ...args.input };
    for (const binding of references) {
      if (seen.has(binding.field))
        fail("VALIDATION_FAILED", `引用字段重复: ${binding.field}`);
      seen.add(binding.field);
      const result = await this.references.resolve(binding.reference);
      if (result.status !== "resolved")
        return { status: "blocked" as const, code: result.code!, action: args.action, reason: result.reason!, reference: result };
      if (input[binding.field] !== undefined && input[binding.field] !== result.id)
        fail("VALIDATION_FAILED", `引用解析不能覆盖已提供字段: ${binding.field}`);
      input[binding.field] = result.id;
    }
    return this.actions.prepare({ ...args, input });
  }
  resolveReference(raw: ReferenceInput) {
    return this.references.resolve(raw);
  }
  execute(id: string, confirmation: Confirmation) {
    if (process.env.XSY_TICKET_WRITES !== "1")
      fail("WRITES_DISABLED", "工单写入未启用；请明确配置 XSY_TICKET_WRITES=1");
    return this.actions.execute(id, confirmation);
  }
  async operation(id: string, reconcile = false) {
    const operation = this.store.read(id);
    const context = await this.backend.context();
    if (context.key !== operation.plan.contextKey)
      fail("CONTEXT_MISMATCH", "操作属于其他账号或环境");
    return reconcile ? this.actions.reconcile(id) : operation;
  }
  review(id: string, confirmation: Confirmation, review: OperationReview) {
    return this.actions.review(id, confirmation, review);
  }
  async timeline(id: string, page = 1, size = 20) {
    parseInput(idSchema, id);
    parseInput(searchSchema, { page, size });
    if (this.registry.config.fieldJobHistory) return this.fieldJobTimeline(id, page, size);
    const sources = this.registry.config.timeline;
    if (!sources.some((s) => s.verification === "verified"))
      fail("UNVERIFIED", "工单历史/动态的读取契约尚未核验");
    if (!(this.backend instanceof CrmTicketBackend))
      fail("UNSUPPORTED", "当前适配器未提供时间线读取");
    await this.backend.get(id, ["id"]);
    const records: Array<{ source: string; record: RecordData; occurredAt?: string }> = [],
      coverage: Array<{
        source: string;
        status: string;
        nextPage?: number | null;
      }> = [];
    for (const source of sources) {
      if (source.verification !== "verified" || !source.query) {
        coverage.push({ source: source.name, status: "unverified" });
        continue;
      }
      try {
        const query = source.query;
        const result = await this.backend.resource(
          { ...query, fields: [...new Set([...query.fields, ...(query.timeField ? [query.timeField] : [])])] },
          id,
          page,
          size,
        );
        records.push(
          ...result.records.map((record) => {
            const time = query.timeField ? eventTime(record[query.timeField], query.dateEncoding) : undefined;
            return { source: source.name, record, ...(time === undefined ? {} : { occurredAt: new Date(time).toISOString() }) };
          }),
        );
        coverage.push({
          source: source.name,
          status: "verified",
          nextPage: page * size < result.totalSize ? page + 1 : null,
        });
      } catch {
        coverage.push({ source: source.name, status: "unavailable" });
      }
    }
    const ordered = records.length > 0 && records.every((r) => r.occurredAt !== undefined);
    if (ordered) records.sort((a, b) =>
      Date.parse(b.occurredAt!) - Date.parse(a.occurredAt!) ||
      `${a.source}:${a.record.id}`.localeCompare(`${b.source}:${b.record.id}`),
    );
    return {
      records,
      coverageScope: "configured_sources",
      historyCompleteness: "unknown",
      coverage: coverage.every((c) => c.status === "verified" && c.nextPage === null)
        ? "complete"
        : "partial",
      sources: coverage,
      page,
      size,
      ordering: { mode: ordered ? "event_time" : "source", scope: "returned_page", complete: ordered },
      note: ordered
        ? "仅对本次各来源返回的有界记录按已核验事件时间降序合并；跨来源分页不承诺全局时间顺序"
        : "未全部核验事件时间或存在无效时间，保持来源内 id 顺序，不猜测全局时间线",
    };
  }
  private async fieldJobTimeline(id: string, page: number, size: number) {
    const mapping = this.registry.config.fieldJobHistory;
    if (!mapping || !(this.backend instanceof CrmTicketBackend))
      fail("UNSUPPORTED", "当前适配器未提供原生工单历史读取");
    const backend = this.backend;
    return withFreshReads(backend, async () => {
      const context = await backend.context();
      await backend.get(id, ["id"]);
      const bindings = { context, input: {}, target: { id } };
      const selection = { targetId: id, parentObjectId: mapping.parentObjectId, page, size };
      const results = await Promise.allSettled([
        ...(["activity", "reports"] as const).map(async (kind) => {
          const raw = await backend.readRequest(fieldJobHistoryReadRequest(kind, selection), bindings);
          const result = decodeFieldJobHistoryPage(kind, raw, selection);
          return { records: result.records as RecordData[], source: kind, nextPage: result.nextPage,
            parentEvidence: result.parentEvidence, paginationScope: "source" };
        }),
        (async () => {
          const raw = await backend.readRequest(fieldJobWorkflowHistoryReadRequest(id), bindings);
          const result = decodeFieldJobWorkflowHistory(raw, id);
          return { records: result.records.slice((page - 1) * size, page * size), source: "workflow_tasks",
            nextPage: page * size < result.count ? page + 1 : null, parentEvidence: result.parentEvidence,
            taskCount: result.taskCount, paginationScope: "bounded_response" };
        })(),
      ]);
      const records: RecordData[] = [], sources: RecordData[] = [];
      const names = ["activity", "reports", "workflow_tasks"];
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === "fulfilled") {
          records.push(...result.value.records);
          sources.push({ ...result.value, records: undefined, status: "verified", count: result.value.records.length });
        } else sources.push({ source: names[i], status: "unavailable",
          reason: typeof object(result.reason).code === "string" ? object(result.reason).code : "READ_FAILED" });
      }
      if ((await backend.context()).key !== context.key) fail("CONTEXT_MISMATCH", "读取历史期间身份已变化");
      const ordered = records.length > 0 && records.every((row) => typeof row.occurredAt === "string");
      if (ordered) records.sort((a, b) => Date.parse(String(b.occurredAt)) - Date.parse(String(a.occurredAt)));
      return { records, sources, page, size, coverage: "partial", coverageScope: "activity_reports_workflow_tasks",
        historyCompleteness: "unknown", consistency: "best_effort",
        ordering: { mode: ordered ? "event_time" : "source", scope: "returned_page", complete: ordered },
        note: "活动和报告验证父类型及工单ID；流程历史按请求目标绑定。仅覆盖已列来源，未核验客户回复、可见性及主表状态前后值。" };
    });
  }
  async downloadUploadedAttachment(uploadOperationId: string, destination?: string, verifyAssociation = true) {
    if (!(this.backend instanceof CrmTicketBackend)) fail("UNSUPPORTED", "当前适配器未提供附件下载");
    return downloadFieldJobAttachmentFromUpload({ backend: this.backend, store: this.store, uploadOperationId, destination, verifyAssociation });
  }
  async download(id: string, attachmentId: string, destination?: string) {
    parseInput(idSchema, id);
    parseInput(idSchema, attachmentId);
    const contract = this.registry.config.download;
    if (
      !contract ||
      contract.verification !== "verified" ||
      !contract.request ||
      !contract.probe
    )
      fail("UNVERIFIED", "附件下载协议尚未核验");
    if (!(this.backend instanceof CrmTicketBackend))
      fail("UNSUPPORTED", "当前适配器未提供附件下载");
    const context = await this.backend.context();
    if (
      !context.identityVerified ||
      ((contract.request.host === "crm" ||
        contract.probe.request.host === "crm") &&
        !context.crmIdentityVerified)
    )
      fail("IDENTITY_UNVERIFIED", "附件下载身份未核验");
    await this.backend.get(id, ["id"]);
    const bindings = { context, target: { id, attachmentId }, input: {} };
    const probe = await this.backend.readRequest(
      contract.probe.request,
      bindings,
    );
    if (
      at(probe, contract.probe.permissionPath) !== true ||
      at(probe, contract.probe.allowedPath) !== true
    )
      fail("FORBIDDEN", "附件不可读取或权限未核验");
    const bytes = await this.backend.downloadRequest(
      contract.request,
      bindings,
      contract.maxBytes,
    );
    const output = path.resolve(
      destination ??
        path.join(this.store.directory, "attachments", `${randomUUID()}.bin`),
    );
    mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    writeFileSync(output, bytes, { flag: "wx", mode: 0o600 });
    return { path: output, bytes: bytes.length };
  }
}
export function createTicketService(
  options: { timeout?: number } = {},
): TicketService {
  const registry = ContractRegistry.load();
  const store = new OperationStore();
  return new TicketService(
    new CrmTicketBackend(registry, options.timeout, store),
    registry,
    store,
  );
}
export function operationSummary(operation: TicketOperation) {
  return {
    operationId: operation.plan.operationId,
    planId: operation.plan.planId,
    action: operation.plan.action,
    targetId: operation.plan.targetId,
    resultId: operation.submission?.id,
    state: operation.state,
    fingerprint: operation.plan.fingerprint,
    createdAt: operation.plan.createdAt,
    updatedAt: operation.updatedAt,
    confirmation: operation.confirmation,
    recoveryHistory: operation.recoveryHistory,
    verification: operation.verification,
    errorCode: operation.errorCode,
    errorMessage: safeDiagnosticMessage(operation.errorMessage),
    remoteError: operation.remoteError ? safeRemoteError(operation.remoteError) : undefined,
    concurrency: operation.plan.concurrency,
  };
}
