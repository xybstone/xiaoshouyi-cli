import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { referenceSchema } from "./references.js";
import { FIELDJOB_CREATE } from "./fieldjob-create.js";
import { fieldJobServerAction } from "./fieldjob-server-actions.js";
import {
  ACTIONS,
  actionSchema,
  idSchema,
  fieldSchema,
  fail,
  object,
  at,
  parseInput,
  type ActionContract,
  type RecordData,
  type Evidence,
  type ProbeSpec,
  type RequestSpec,
  type ResourceQuery,
} from "./types.js";

export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean")
    return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (
    value &&
    typeof value === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  fail("VALIDATION_FAILED", "计划仅支持有限数值与 JSON 数据");
}
export function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
/** Conditions describe JSON record values, never templates or inferred defaults. */
export function recordPreconditionsMatch(
  contract: Pick<ActionContract, "recordPreconditions">,
  record: RecordData | null | undefined,
): boolean {
  return (contract.recordPreconditions ?? []).every(({ field, expected }) => {
    if (!record || !Object.hasOwn(record, field) || record[field] === undefined) return false;
    try {
      return canonical(record[field]) === canonical(expected);
    } catch {
      return false;
    }
  });
}
export function template(value: unknown, bindings: RecordData): unknown {
  if (Array.isArray(value)) return value.map((v) => template(v, bindings));
  if (value && typeof value === "object") {
    const obj = object(value);
    if (Object.hasOwn(obj, "$ref")) {
      const keys = Object.keys(obj);
      if (
        typeof obj.$ref !== "string" ||
        keys.some((key) => key !== "$ref" && key !== "$type") ||
        (Object.hasOwn(obj, "$type") && obj.$type !== "integer")
      ) fail("INVALID_CONTRACT", "非法模板引用或类型转换");
      if (
        !/^(input|target|context|record|result|operation|probe)(\.[A-Za-z0-9_]+)*$/.test(
          obj.$ref,
        )
      )
        fail("INVALID_CONTRACT", "非法模板引用");
      const result = at(bindings, obj.$ref);
      if (result === undefined || (obj.$ref.startsWith("probe.") && result === null))
        fail("VALIDATION_FAILED", `模板引用未解析: ${obj.$ref}`);
      if (obj.$type === "integer") {
        const numeric = typeof result === "number"
          ? result
          : typeof result === "string" && /^[1-9]\d*$/.test(result)
            ? Number(result)
            : NaN;
        if (!Number.isSafeInteger(numeric) || numeric <= 0 ||
          (typeof result === "string" && String(numeric) !== result))
          fail("VALIDATION_FAILED", `模板引用不是无损安全正整数: ${obj.$ref}`);
        return numeric;
      }
      return result;
    }
    return Object.fromEntries(
      Object.entries(obj).map(([k, v]) => {
        if (["__proto__", "constructor", "prototype"].includes(k))
          fail("INVALID_CONTRACT", "非法模板键");
        return [k, template(v, bindings)];
      }),
    );
  }
  return value;
}
const path = z.string().regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/);
const requestSchema = z
  .object({
    host: z.enum(["api", "crm"]),
    method: z.enum(["GET", "POST", "PATCH"]),
    path: z
      .string()
      .min(1)
      .refine(
        (v) =>
          /^\/[A-Za-z0-9_./:-]+$/.test(v) &&
          !v.startsWith("//") &&
          !v.split("/").some((s) => s === ".." || s === "."),
        "接口必须为本站绝对路径，不支持 URL/路径回退",
      ),
    encoding: z.enum(["json", "form", "multipart"]).default("json"),
    payload: z.unknown().optional(),
    successPath: path,
    successValues: z
      .array(z.union([z.string(), z.number(), z.boolean()]))
      .min(1),
    rejectValues: z
      .array(z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
    jsonFields: z.array(fieldSchema).optional(),
    headers: z
      .record(z.string().regex(/^(?:x-[a-z0-9-]+|accept)$/), z.unknown())
      .optional(),
    fileField: fieldSchema.optional(),
    resultIdPath: path.optional(),
    outputPaths: z.record(fieldSchema, path).optional(),
  })
  .strict();
const probeCredentialKey = /token|cookie|password|secret|authorization|credential|oauth/i;
const probeOutputPathsSchema = z.record(fieldSchema, path).refine(
  (paths) => Object.entries(paths).every(([key, value]) =>
    !["constructor", "prototype"].includes(key) &&
    !probeCredentialKey.test(key + "." + value)),
  "动作探测输出不能投影认证凭据或保留键",
);
const probeSchema = z
  .object({
    request: requestSchema,
    permissionPath: path,
    allowedPath: path,
    formPath: path.optional(),
    outputPaths: probeOutputPathsSchema.optional(),
    reads: z.array(z.object({
      request: requestSchema,
      outputPaths: probeOutputPathsSchema,
    }).strict()).max(5).optional(),
  })
  .strict()
  .superRefine((probe, ctx) => {
    const requests = [probe.request, ...(probe.reads ?? []).map((read) => read.request)];
    for (const request of requests)
      if (request.method === "PATCH" || request.encoding === "multipart")
        ctx.addIssue({ code: "custom", message: "能力探测必须为已核验读取协议，禁止 PATCH/multipart" });
    const keys = new Set<string>();
    for (const paths of [probe.outputPaths ?? {}, ...(probe.reads ?? []).map((read) => read.outputPaths)])
      for (const key of Object.keys(paths)) {
        if (keys.has(key))
          ctx.addIssue({ code: "custom", message: `动作探测输出键重复: ${key}` });
        keys.add(key);
      }
  });

/** Project declared business values only; whole subtrees must not carry auth keys. */
export function projectProbeOutput(
  raw: unknown,
  outputPaths: Record<string, string> = {},
): RecordData {
  const paths = parseInput(probeOutputPathsSchema, outputPaths);
  const active = new Set<object>();
  const check = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (active.has(value)) fail("INVALID_RESPONSE", "动作探测输出不能包含循环数据");
    active.add(value);
    for (const [key, entry] of Object.entries(value)) {
      if (probeCredentialKey.test(key) || ["__proto__", "constructor", "prototype"].includes(key))
        fail("INVALID_RESPONSE", "动作探测业务输出包含认证或保留字段");
      check(entry);
    }
    active.delete(value);
  };
  return Object.fromEntries(Object.entries(paths).map(([key, valuePath]) => {
    const value = at(raw, valuePath);
    check(value);
    return [key, value];
  }));
}
const evidenceSchema = z
  .object({
    source: z.enum(["official", "page", "implementation", "synthetic"]),
    reference: z.string().min(1).max(2000),
    verifiedAt: z.iso.datetime({ offset: true }),
  })
  .strict();
export const inputField = z
  .object({
    type: z.enum(["string", "number", "boolean", "object", "array"]),
    required: z.boolean().optional(),
    enum: z.array(z.unknown()).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .strict();
const resourceSchema = z
  .object({
    apiKey: fieldSchema,
    fields: z.array(fieldSchema).min(1).max(50),
    linkField: fieldSchema,
    timeField: fieldSchema.optional(),
    dateEncoding: z.enum(["unix-ms", "iso"]).optional(),
    bind: z.enum(["target", "result"]).optional(),
  })
  .strict();
const recoverySchema = z
  .object({
    evidence: evidenceSchema,
    apiKey: fieldSchema,
    correlationField: fieldSchema,
    resultIdField: fieldSchema,
    targetField: fieldSchema.optional(),
    checks: z.array(z.object({ field: fieldSchema, expected: z.unknown() }).strict()).min(1).max(40),
    outputFields: z.record(fieldSchema, fieldSchema).optional(),
  })
  .strict();

function containsOperationId(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsOperationId);
  if (!value || typeof value !== "object") return false;
  const entry = object(value);
  return (Object.keys(entry).length === 1 && entry.$ref === "operation.operationId") ||
    Object.values(entry).some(containsOperationId);
}

/** This exception updates report content only; it is never a lifecycle action. */
export function isServerReportUpdate(c: ActionContract): boolean {
  if (c.authorization !== "server" || c.action !== "report" || c.fieldMode !== "update" ||
    c.request?.host !== "api" || c.request.method !== "PATCH" ||
    c.request.path !== "/rest/data/v2.0/xobjects/fieldJob/:id" || c.request.encoding !== "json" || c.probe)
    return false;
  const payload = object(c.request.payload), data = object(payload.data);
  const keys = Object.keys(data);
  if (Object.keys(payload).length !== 1 || !Object.hasOwn(payload, "data") || keys.length < 1 || keys.length > 2 ||
    keys.some((key) => !["problemReason__c", "reportText__c"].includes(key)) ||
    Object.keys(c.fields).length !== keys.length || Object.keys(c.fields).some((key) => !keys.includes(key))) return false;
  return keys.every((key) => {
    const binding = object(data[key]);
    const check = c.verify?.checks.find((item) => item.field === key);
    const expected = object(check?.expected);
    return Object.keys(binding).length === 1 && binding.$ref === `input.${key}` &&
      c.preconditionFields.includes(key) &&
      Object.keys(expected).length === 1 && expected.$ref === `input.${key}` &&
      (key !== "reportText__c" || c.fields[key].type === "string") &&
      (key !== "problemReason__c" || ["string", "number"].includes(c.fields[key].type));
  });
}
const contractSchema = z
  .object({
    action: actionSchema,
    verification: z.enum(["verified", "unverified", "unsupported"]),
    version: z.string().min(1),
    evidence: evidenceSchema.optional(),
    authorization: z.enum(["probe", "server"]).optional(),
    entityTypes: z.array(z.string()).optional(),
    fields: z.record(fieldSchema, inputField).default({}),
    fieldMode: z.enum(["create", "update", "action"]).default("action"),
    required: z.array(fieldSchema).default([]),
    defaults: z.record(z.string(), z.unknown()).default({}),
    request: requestSchema.optional(),
    probe: probeSchema.optional(),
    preconditionFields: z
      .array(fieldSchema)
      .default([
        "status",
        "customItem62__c",
        "entityType",
        "responsibleTE__c",
        "ownerId",
        "fieldJobPoolGroup",
      ]),
    recordPreconditions: z.array(z.object({ field: fieldSchema, expected: z.json() }).strict()).max(50).optional(),
    effects: z.array(z.string()).default([]),
    recovery: recoverySchema.optional(),
    verify: z
      .object({
        query: resourceSchema.optional(),
        checks: z
          .array(
            z.object({ field: fieldSchema, expected: z.unknown() }).strict(),
          )
          .min(1),
        additional: z
          .array(
            z
              .object({
                name: z.string().min(1),
                query: resourceSchema,
                checks: z
                  .array(
                    z
                      .object({ field: fieldSchema, expected: z.unknown() })
                      .strict(),
                  )
                  .min(1),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
const identitySchema = z
  .object({ request: requestSchema, tenantPath: path, subjectPath: path })
  .strict();
const configSchema = z
  .object({
    version: z.literal(1),
    scope: z
      .object({
        apiBaseUrl: z.url(),
        crmBaseUrl: z.url(),
        tenantId: z.string().min(1),
        subjectId: z.string().optional(),
      })
      .strict()
      .optional(),
    identity: z
      .object({ api: identitySchema, crm: identitySchema.optional() })
      .strict()
      .optional(),
    read: z
      .object({
        numberField: fieldSchema.optional(),
        createdTimeField: fieldSchema.optional(),
        dateEncoding: z.literal("unix-ms").optional(),
        evidence: evidenceSchema,
      })
      .strict()
      .optional(),
    actions: z.array(contractSchema).default([]),
    references: z.array(referenceSchema).default([]),
    fieldJobHistory: z.object({ parentObjectId: idSchema, evidence: evidenceSchema }).strict().optional(),
    timeline: z
      .array(
        z
          .object({
            name: z.string().min(1),
            verification: z.enum(["verified", "unverified"]),
            evidence: evidenceSchema.optional(),
            query: resourceSchema.optional(),
          })
          .strict(),
      )
      .default([]),
    download: z
      .object({
        verification: z.enum(["verified", "unverified"]),
        evidence: evidenceSchema.optional(),
        probe: probeSchema.optional(),
        request: requestSchema.optional(),
        maxBytes: z
          .number()
          .int()
          .min(1)
          .max(100 * 1024 * 1024)
          .default(20 * 1024 * 1024),
      })
      .strict()
      .optional(),
  })
  .strict();
export type TicketConfig = z.infer<typeof configSchema>;
export type IdentitySpec = NonNullable<TicketConfig["identity"]>["api"];
export class ContractRegistry {
  readonly config: TicketConfig;
  constructor(
    raw: unknown = { version: 1 },
    options: { allowSynthetic?: boolean } = {},
  ) {
    this.config = parseInput(configSchema, raw);
    if (
      this.config.identity &&
      (this.config.identity.api.request.host !== "api" ||
        (this.config.identity.crm &&
          this.config.identity.crm.request.host !== "crm"))
    )
      fail("INVALID_CONTRACT", "API/Cookie 身份核验必须读取各自所属域");
    const seen = new Set<string>();
    for (const c of this.config.actions) {
      if (seen.has(c.action)) fail("INVALID_CONTRACT", "动作重复登记");
      seen.add(c.action);
      if (c.action === "create" && c.recordPreconditions !== undefined)
        fail("INVALID_CONTRACT", "创建动作没有已有记录，不能声明记录状态条件");
      // Ordinary creation is authorized by the object API itself. There is no
      // universal read-only permission probe for this protocol. Keep this narrow:
      // lifecycle transitions must still use their actual action probes.
      const serverCreate = c.authorization === "server";
      const serverReport = isServerReportUpdate(c);
      const serverExtension = fieldJobServerAction(c, this.config.scope?.subjectId);
      const serverWorklog = c.action === "worklog" && c.fieldMode === "action" &&
        c.request?.path === "/rest/data/v2.0/xobjects/timeSheetDetatils__c";
      const serverFieldJob = c.action === "create" && c.fieldMode === "create" &&
        c.request?.path === "/rest/data/v2.0/xobjects/fieldJob";
      if (serverCreate && !serverExtension && ((!serverFieldJob && !serverWorklog && !serverReport) ||
        c.request?.host !== "api" || c.request.method !== (serverReport ? "PATCH" : "POST") ||
        c.request.encoding !== "json" || c.probe))
        fail("INVALID_CONTRACT", "服务器授权仅适用于标准创建接口或严格限定的报告内容更新");
      if (serverExtension && (!this.config.scope || !c.evidence || !c.verify))
        fail("INVALID_CONTRACT", "专用服务器鉴权动作必须绑定账号范围、真实协议证据与回读规则");
      if (serverReport && (!this.config.scope || !c.evidence || !c.verify))
        fail("INVALID_CONTRACT", "报告内容更新必须具有身份范围、接口证据与逐字段回读规则");
      if (serverCreate && serverWorklog) {
        if (!c.request?.resultIdPath)
          fail("INVALID_CONTRACT", "工时创建协议必须映射新记录 ID，缺少回执不能确认创建结果");
        const binding = object(object(c.request?.payload).data).remoteWorkOrders__c;
        const ref = object(binding);
        if (!c.fields.remoteWorkOrders__c ||
          !["target.id", "input.remoteWorkOrders__c"].includes(String(ref.$ref)) ||
          Object.keys(ref).some((key) => !["$ref", "$type"].includes(key)) ||
          (ref.$type !== undefined && ref.$type !== "integer"))
          fail("INVALID_CONTRACT", "工时创建必须绑定明确父工单，不能提交固定或任意引用");
      }
      if (
        c.verification === "unsupported" &&
        (!c.evidence || !this.config.scope)
      )
        fail("INVALID_CONTRACT", "unsupported 必须有当前范围的明确证据");
      if (c.verification === "verified") {
        if (
          !c.evidence ||
          !c.request ||
          (!serverCreate && !c.probe) ||
          !c.verify ||
          ((!serverCreate || serverReport) && !this.config.scope)
        )
          fail(
            "INVALID_CONTRACT",
            `${c.action} 缺少请求、探测、回读、范围或证据`,
          );
        if (
          c.probe?.request.method === "PATCH" ||
          c.probe?.request.encoding === "multipart"
        )
          fail("INVALID_CONTRACT", "能力探测必须为已核验读取协议");
        if (c.request.method === "GET")
          fail("INVALID_CONTRACT", "写动作不能使用 GET");
        if (c.action === "create" && c.fieldMode !== "create")
          fail("INVALID_CONTRACT", "创建动作必须检查 fieldJob 对象级字段约束");
        if (
          c.action === "create" &&
          [c.request.path, c.probe?.request.path ?? ""].some((p) => p.includes(":id"))
        )
          fail("INVALID_CONTRACT", "创建动作不能依赖已有工单 ID");
        if (
          !serverReport && serverExtension !== "attachment_link" && /\/(?:objects|xobjects)\/fieldJob\/(?::id|\d+|masterdetails)\/?$/i.test(
            c.request.path,
          )
        )
          fail("INVALID_CONTRACT", "生命周期动作不能伪装为通用 fieldJob 更新");
        if (c.request.encoding === "multipart" && !c.request.fileField)
          fail("INVALID_CONTRACT", "上传协议缺少 fileField");
        if (c.action === "create" && !c.request.resultIdPath)
          fail("INVALID_CONTRACT", "创建协议缺少返回记录 ID 的映射");
      }
      if (c.recovery) {
        if (c.verification !== "verified" || !c.request)
          fail("INVALID_CONTRACT", "恢复协议只能附于已核验动作");
        if (["id", "name", "status", "customItem62__c"].includes(c.recovery.correlationField))
          fail("INVALID_CONTRACT", "恢复必须使用操作关联字段，不能以标题或主表状态归因");
        if (!containsOperationId(c.request.payload) && !containsOperationId(c.request.headers))
          fail("INVALID_CONTRACT", "恢复协议要求写请求携带本计划的 operation.operationId");
        if (c.action !== "create" && !c.recovery.targetField)
          fail("INVALID_CONTRACT", "已有工单动作的恢复需核对目标关联字段");
        const fields = new Set([
          "id", c.recovery.correlationField, c.recovery.resultIdField,
          ...(c.recovery.targetField ? [c.recovery.targetField] : []),
          ...c.recovery.checks.map((check) => check.field),
          ...Object.values(c.recovery.outputFields ?? {}),
        ]);
        if (fields.size > 50) fail("INVALID_CONTRACT", "恢复读取字段不得超过50个");
      }
    }
    const evidence: Array<Evidence | undefined> = [
      this.config.read?.evidence,
      this.config.fieldJobHistory?.evidence,
      ...this.config.actions.map((c) => c.evidence),
      ...this.config.actions.map((c) => c.recovery?.evidence),
      ...this.config.references.map((reference) => reference.evidence),
      ...this.config.timeline.map((t) => t.evidence),
      this.config.download?.evidence,
    ];
    if (this.config.fieldJobHistory && !this.config.scope)
      fail("INVALID_CONTRACT", "工单历史读取必须绑定已核验身份范围与父对象类型");
    if (
      !options.allowSynthetic &&
      evidence.some((e) => e?.source === "synthetic")
    )
      fail("UNVERIFIED", "合成契约仅用于测试，不能加载到真实 CRM 运行时");
    if (
      this.config.identity &&
      [this.config.identity.api, this.config.identity.crm].some(
        (s) =>
          s &&
          (s.request.method === "PATCH" || s.request.encoding === "multipart"),
      )
    )
      fail("INVALID_CONTRACT", "身份核验必须为读取协议");
    for (const t of this.config.timeline)
      if (
        t.verification === "verified" &&
        (!t.evidence || !this.config.scope || !t.query)
      )
        fail("INVALID_CONTRACT", "时间线缺少证据、查询或身份范围");
    const referenceKinds = new Set<string>();
    for (const reference of this.config.references) {
      if (referenceKinds.has(reference.kind))
        fail("INVALID_CONTRACT", "同一引用类型不能重复登记");
      referenceKinds.add(reference.kind);
      if (reference.verification === "verified" && (!this.config.scope || !reference.evidence))
        fail("INVALID_CONTRACT", "引用解析缺少证据或身份范围");
    }
    const d = this.config.download;
    if (
      d?.verification === "verified" &&
      (!d.evidence ||
        !this.config.scope ||
        !d.request ||
        !d.probe ||
        d.request.method !== "GET" ||
        d.probe.request.method === "PATCH" ||
        d.probe.request.encoding === "multipart")
    )
      fail("INVALID_CONTRACT", "下载协议缺少证据/范围或不是读取协议");
  }
  get(action: string): ActionContract {
    if (!(ACTIONS as readonly string[]).includes(action))
      fail("UNSUPPORTED", "未知工单动作");
    return (
      this.config.actions.find((c) => c.action === action) ?? {
        action: action as ActionContract["action"],
        verification: "unverified",
        version: "unverified",
        fields: {},
        fieldMode: "action",
        required: [],
        defaults: {},
        preconditionFields: [],
        effects: [],
      }
    );
  }
  static load(file = process.env.XSY_TICKET_CONTRACTS): ContractRegistry {
    if (!file) return new ContractRegistry({ version: 1, actions: [FIELDJOB_CREATE] });
    try {
      const config = parseInput(configSchema, JSON.parse(readFileSync(file, "utf8")));
      // A configured create entry can deliberately disable/replace the builtin.
      if (!config.actions.some((action) => action.action === "create"))
        config.actions.push(FIELDJOB_CREATE);
      return new ContractRegistry(config);
    } catch (error) {
      if (error instanceof Error && error.name === "TicketError") throw error;
      fail("INVALID_CONTRACT", "无法读取工单契约文件");
    }
  }
}
export function ticketContractSchema(): Record<string, unknown> {
  return z.toJSONSchema(configSchema);
}
export type { ProbeSpec, RequestSpec, ResourceQuery };
