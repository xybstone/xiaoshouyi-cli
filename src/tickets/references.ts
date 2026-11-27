import { z } from "zod";
import { buildListQuery, escapeSql } from "../utils/index.js";
import {
  at,
  fail,
  fieldSchema,
  idSchema,
  parseInput,
  prepareSchema,
  type RecordData,
  type RequestSpec,
  type TicketBackend,
} from "./types.js";

const valuePath = z.string().regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/);
const kinds = [
  "customer", "responsible", "pool", "department", "entityType", "asset",
] as const;
const evidence = z.object({
  source: z.enum(["official", "page", "synthetic"]),
  reference: z.string().min(1).max(2000),
  verifiedAt: z.iso.datetime({ offset: true }),
}).strict();
const readRequest = z.object({
  host: z.enum(["api", "crm"]),
  method: z.enum(["GET", "POST"]),
  path: z.string().regex(/^\/[A-Za-z0-9_./:-]+$/).refine(
    (p) => !p.startsWith("//") && !p.split("/").some((s) => s === "." || s === ".."),
    "引用读取必须使用本站绝对路径",
  ),
  encoding: z.enum(["json", "form"]).default("json"),
  payload: z.unknown().optional(),
  successPath: valuePath,
  successValues: z.array(z.union([z.string(), z.number(), z.boolean()])).min(1),
  rejectValues: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  jsonFields: z.array(fieldSchema).optional(),
  headers: z.record(z.string().regex(/^(?:x-[a-z0-9-]+|accept)$/), z.unknown()).optional(),
}).strict();
const candidateSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(1000),
}).strict();
const referenceField = z.string().refine(
  (v) => v.split(".").length <= 3 && v.split(".").every((s) => fieldSchema.safeParse(s).success),
  "引用字段需为最多三级已核验 API 字段路径",
);
export const referenceQuerySchema = z.object({
  apiKey: fieldSchema,
  idField: referenceField.default("id"),
  nameField: referenceField,
  filters: z.array(z.object({
    field: referenceField,
    value: z.union([z.string(), z.number(), z.boolean()]).optional(),
    input: z.enum(["poolId", "departmentId"]).optional(),
  }).strict().refine(
    (f) => (f.value !== undefined) !== (f.input !== undefined),
    "引用约束必须提供固定值或明确的输入绑定",
  )).max(20).default([]),
}).strict();

export const referenceSchema = z.object({
  kind: z.enum(kinds),
  verification: z.enum(["verified", "unverified"]),
  evidence: evidence.optional(),
  query: referenceQuerySchema.optional(),
  scopedQueries: z.array(z.object({
    input: z.enum(["poolId", "departmentId"]),
    query: referenceQuerySchema,
  }).strict()).max(2).default([]),
  membership: z.object({
    apiKey: fieldSchema,
    candidateField: fieldSchema,
    poolField: fieldSchema,
    departmentField: fieldSchema.optional(),
  }).strict().optional(),
  request: readRequest.optional(),
  recordsPath: valuePath.optional(),
  totalPath: valuePath.optional(),
  hasMorePath: valuePath.optional(),
  completeList: z.literal(true).optional(),
  idPath: valuePath.default("id"),
  namePath: valuePath.default("name"),
  options: z.array(candidateSchema).max(100).optional(),
}).strict().superRefine((s, ctx) => {
  if (s.verification !== "verified") return;
  if (!s.evidence)
    ctx.addIssue({ code: "custom", message: "已核验引用需来源证据" });
  if ([s.query, s.request, s.options].filter((v) => v !== undefined).length !== 1)
    ctx.addIssue({ code: "custom", message: "已核验引用必须且只能登记一种读取来源" });
  if (s.request && !s.recordsPath)
    ctx.addIssue({ code: "custom", message: "引用接口需明确数组路径" });
  if (s.request && !s.completeList && (!s.totalPath || !s.hasMorePath))
    ctx.addIssue({ code: "custom", message: "引用接口需有完整列表契约或明确总数及hasMore映射" });
  if (s.scopedQueries.length && !s.query)
    ctx.addIssue({ code: "custom", message: "引用约束查询需有普通对象查询作为基础" });
  if (s.membership && !s.query)
    ctx.addIssue({ code: "custom", message: "池成员核验需先有明确候选对象查询" });
  if (new Set(s.scopedQueries.map((q) => q.input)).size !== s.scopedQueries.length)
    ctx.addIssue({ code: "custom", message: "引用约束查询重复登记" });
  for (const q of s.scopedQueries)
    if (!q.query.filters.some((f) => f.input === q.input))
      ctx.addIssue({ code: "custom", message: "引用约束查询必须绑定声明的输入" });
  if (s.options && new Set(s.options.map((o) => o.id)).size !== s.options.length)
    ctx.addIssue({ code: "custom", message: "引用选项包含重复ID" });
});
export type ReferenceContract = z.infer<typeof referenceSchema>;
export const referenceInputSchema = z.object({
  kind: z.enum(kinds),
  id: idSchema.optional(),
  name: z.string().min(1).max(200).refine(
    (v) => !/[\\\u0000-\u001f\u007f]/.test(v),
    "引用名称不能包含未经核验转义的反斜杠或控制字符",
  ).optional(),
  poolId: idSchema.optional(),
  departmentId: idSchema.optional(),
  limit: z.number().int().min(1).max(20).default(10),
}).strict().refine((i) => (i.id !== undefined) !== (i.name !== undefined), {
  message: "引用必须明确提供一个 ID 或名称",
});
export type ReferenceInput = z.input<typeof referenceInputSchema>;
export const prepareWithReferencesSchema = prepareSchema.extend({
  references: z.array(z.object({
    field: fieldSchema,
    reference: referenceInputSchema,
  }).strict()).max(20).optional(),
});
export interface ReferenceResult {
  status: "resolved" | "blocked";
  kind: (typeof kinds)[number];
  id?: string;
  code?: string;
  reason?: string;
  candidates: Array<{ id: string; name: string }>;
  totalCount: number | null;
  truncated: boolean;
  eligibility: "unknown";
  note: string;
}
type ReferenceBackend = TicketBackend & {
  readRequest?: (request: RequestSpec, bindings: RecordData) => Promise<unknown>;
};
export class TicketReferences {
  constructor(
    readonly backend: ReferenceBackend,
    readonly contracts: ReferenceContract[],
    readonly scope?: {
      apiBaseUrl: string; crmBaseUrl: string; tenantId: string; subjectId?: string;
    },
  ) {}

  async resolve(raw: ReferenceInput): Promise<ReferenceResult> {
    const input = parseInput(referenceInputSchema, raw);
    const contract = this.contracts.find((c) => c.kind === input.kind);
    const base = {
      kind: input.kind,
      eligibility: "unknown" as const,
      note: "仅解析当前账号可见的引用；动作权限、角色和当前允许动作仍由 prepare 实时检查",
    };
    const blocked = (code: string, reason: string): ReferenceResult => ({
      ...base, status: "blocked", code, reason, candidates: [],
      totalCount: null, truncated: false,
    });
    if (!contract || contract.verification !== "verified")
      return blocked("UNVERIFIED", "该引用对象、名称字段或读取协议尚未核验");
    const context = await this.backend.context();
    if (!this.scope || !context.identityVerified)
      fail("IDENTITY_UNVERIFIED", "引用读取的当前租户与账号范围尚未核验");
    if (
      context.apiBaseUrl !== this.scope.apiBaseUrl ||
      context.crmBaseUrl !== this.scope.crmBaseUrl ||
      context.tenantId !== this.scope.tenantId ||
      (this.scope.subjectId && context.subjectId !== this.scope.subjectId)
    ) fail("CONTEXT_MISMATCH", "引用契约范围与当前身份不符或尚未核验");
    if (!contract.query && (input.poolId || input.departmentId))
      return blocked("REFERENCE_CONSTRAINT_UNVERIFIED", "当前选项契约没有可核验的池或部门约束读取");

    let candidates: Array<{ id: string; name: string }>;
    let totalCount: number;
    const membership = input.poolId ? contract.membership : undefined;
    if (contract.query) {
      const requested = (["poolId", "departmentId"] as const).filter((k) =>
        input[k] !== undefined && !(membership && (k === "poolId" || membership.departmentField)),
      );
      const q = [
        ...contract.scopedQueries.filter((s) => input[s.input] !== undefined).map((s) => s.query),
        contract.query,
      ].find((q) => requested.every((k) => q.filters.some((f) => f.input === k)));
      if (!q)
        return blocked("REFERENCE_CONSTRAINT_UNVERIFIED", "尚无能同时验证指定池和部门约束的引用查询契约");
      const clauses: string[] = [];
      for (const f of q.filters) {
        const value = f.input ? input[f.input] : f.value;
        if (value === undefined)
          return blocked("REFERENCE_CONTEXT_REQUIRED", `引用解析缺少约束: ${f.input}`);
        clauses.push(`${f.field} = '${escapeSql(String(value))}'`);
      }
      clauses.push(`${input.id ? q.idField : q.nameField} = '${escapeSql(input.id ?? input.name!)}'`);
      const page = await this.backend.query(buildListQuery(
        q.apiKey, [...new Set([q.idField, q.nameField])],
        { where: clauses.join(" and "), order: `${q.idField} asc`, size: input.limit, offset: 0 },
      ));
      if (!Number.isSafeInteger(page.totalSize) || page.totalSize < 0 ||
        page.records.length > input.limit || page.records.length > page.totalSize)
        fail("INVALID_RESPONSE", "引用查询返回数量与限制或总数不符");
      const value = (r: RecordData, key: string) => Object.hasOwn(r, key) ? r[key] : at(r, key);
      candidates = page.records.map((r) => this.candidate(value(r, q.idField), value(r, q.nameField)));
      totalCount = page.totalSize;
    } else if (contract.request) {
      if (!this.backend.readRequest)
        return blocked("UNSUPPORTED", "当前后端未提供引用协议读取");
      if (contract.request.host === "crm" && !context.crmIdentityVerified)
        fail("IDENTITY_UNVERIFIED", "引用读取的 CRM Cookie 身份尚未核验");
      const response = await this.backend.readRequest(contract.request, {
        context, input, target: { id: input.id },
      });
      const rows = at(response, contract.recordsPath!);
      if (!Array.isArray(rows) || rows.length > 100)
        fail("INVALID_RESPONSE", "引用选项需为已核验且不超过100项的数组");
      if (!contract.completeList && (
        at(response, contract.totalPath!) !== rows.length ||
        at(response, contract.hasMorePath!) !== false
      )) return blocked("REFERENCE_RESULTS_INCOMPLETE", "引用选项列表不完整，不能判断名称唯一性");
      candidates = rows.map((r) => this.candidate(at(r, contract.idPath), at(r, contract.namePath)));
      candidates = candidates.filter((r) => input.id ? r.id === input.id : r.name === input.name);
      totalCount = candidates.length;
      candidates = candidates.slice(0, input.limit);
    } else {
      candidates = (contract.options ?? []).filter((r) => input.id ? r.id === input.id : r.name === input.name);
      totalCount = candidates.length;
      candidates = candidates.slice(0, input.limit);
    }
    if (new Set(candidates.map((r) => r.id)).size !== candidates.length)
      fail("INVALID_RESPONSE", "引用读取返回重复 ID");
    if (candidates.some((r) => input.id ? r.id !== input.id : r.name !== input.name))
      fail("INVALID_RESPONSE", "引用读取未遵守明确 ID 或精确名称条件");
    if (totalCount > 0 && candidates.length === 0)
      fail("INVALID_RESPONSE", "引用读取声称有候选但没有返回可核验记录");
    if (membership && totalCount > 0) {
      if (totalCount > candidates.length)
        return { ...base, status: "blocked", code: "REFERENCE_CANDIDATES_INCOMPLETE",
          reason: "同名候选尚未全部返回，不能只在本页判断池内唯一处理人；请缩小范围或指定ID",
          candidates, totalCount, truncated: true };
      const eligible: typeof candidates = [];
      for (const candidate of candidates) {
        const conditions = [
          `${membership.candidateField} = '${escapeSql(candidate.id)}'`,
          `${membership.poolField} = '${escapeSql(input.poolId!)}'`,
        ];
        if (input.departmentId && membership.departmentField)
          conditions.push(`${membership.departmentField} = '${escapeSql(input.departmentId)}'`);
        const fields = ["id", membership.candidateField, membership.poolField,
          ...(input.departmentId && membership.departmentField ? [membership.departmentField] : [])];
        const page = await this.backend.query(buildListQuery(membership.apiKey, [...new Set(fields)], {
          where: conditions.join(" and "), order: "id asc", offset: 0, size: 2,
        }));
        if (!Number.isSafeInteger(page.totalSize) || page.totalSize < 0 || page.records.length > 2 ||
          page.records.length > page.totalSize || (page.totalSize > 0 && page.records.length === 0))
          fail("INVALID_RESPONSE", "池成员查询返回计数不可靠");
        const ref = (value: unknown) => {
          const raw = value !== null && typeof value === "object" ? at(value, "id") : value;
          if (typeof raw === "number" && !Number.isSafeInteger(raw))
            fail("INVALID_RESPONSE", "池成员引用ID数值不安全");
          return parseInput(idSchema, String(raw));
        };
        if (page.records.some((r) => ref(r[membership.candidateField]) !== candidate.id ||
          ref(r[membership.poolField]) !== input.poolId ||
          (input.departmentId && membership.departmentField && ref(r[membership.departmentField]) !== input.departmentId)))
          fail("INVALID_RESPONSE", "池成员读取未遵守候选、池或部门约束");
        if (page.records.length) eligible.push(candidate);
      }
      candidates = eligible;
      totalCount = eligible.length;
      if (!totalCount)
        return { ...base, status: "blocked", code: "POOL_MEMBERSHIP_UNVERIFIED",
          reason: "未读到候选与指定池或部门的可见关联，无法确认成员资格，不自动分派", candidates, totalCount, truncated: false };
    }
    if (totalCount === 1 && candidates.length === 1)
      return { ...base, status: "resolved", id: candidates[0].id, candidates, totalCount, truncated: false };
    return {
      ...base, status: "blocked",
      code: totalCount ? "AMBIGUOUS_REFERENCE" : "REFERENCE_NOT_FOUND",
      reason: totalCount ? "存在多个同名候选，请明确选择 ID" : "未找到该引用或当前账号无权读取",
      candidates, totalCount, truncated: totalCount > candidates.length,
    };
  }

  private candidate(id: unknown, name: unknown) {
    if (typeof id === "number" && !Number.isSafeInteger(id))
      fail("INVALID_RESPONSE", "引用 ID 超出安全数值范围");
    if (typeof name !== "string" || !name || name.length > 1000)
      fail("INVALID_RESPONSE", "引用名称格式不符");
    return { id: parseInput(idSchema, String(id)), name };
  }
}

export function referenceSummary(contracts: ReferenceContract[]) {
  return kinds.map((kind) => ({
    kind,
    verification: contracts.find((c) => c.kind === kind)?.verification ?? "unverified",
  }));
}

/** A timestamp is sortable only when the source declares its representation. */
export function eventTime(value: unknown, encoding: "unix-ms" | "iso" | undefined): number | undefined {
  if (encoding === "unix-ms")
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000
      ? value : undefined;
  if (encoding === "iso" && typeof value === "string" && z.iso.datetime({ offset: true }).safeParse(value).success) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
