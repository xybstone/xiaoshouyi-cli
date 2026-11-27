import { z } from "zod";
import { XsyError } from "../api/errors.js";

export const ACTIONS = [
  "create",
  "submit",
  "advance",
  "workflow_preprocess",
  "assign",
  "reassign",
  "accept",
  "reply",
  "activity_record",
  "pause",
  "resume",
  "escalate",
  "resolve",
  "complete",
  "close",
  "reopen",
  "return",
  "void",
  "attachment_upload",
  "attachment_link",
  "worklog",
  "report",
  "service_report",
] as const;
export type TicketAction = (typeof ACTIONS)[number];
export type RecordData = Record<string, unknown>;
export type Decision = "allowed" | "denied" | "unknown";
export class TicketError extends XsyError {
  constructor(
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = "TicketError";
  }
}
export function fail(code: string, message: string, details?: unknown): never {
  throw new TicketError(code, message, details);
}

/** Keep only short diagnostic prose; never retain auth text, URLs or raw data. */
export function safeDiagnosticMessage(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const text = value.slice(0, 4096);
  if (/authorization|cookie|bearer|token|secret|password|oauth|session|凭据|密码/i.test(text))
    return "[已隐藏包含认证信息的诊断文本]";
  return text.replace(/https?:\/\/[^\s<>"']+/gi, "[已隐藏URL]")
    .replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 512);
}
export function safeRemoteError(value: unknown): { httpStatus?: number; serverCode?: number | string | boolean; serverMessage?: string } {
  const raw = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
  const result: { httpStatus?: number; serverCode?: number | string | boolean; serverMessage?: string } = {};
  if (typeof raw.httpStatus === "number" && Number.isInteger(raw.httpStatus) && raw.httpStatus >= 100 && raw.httpStatus <= 599)
    result.httpStatus = raw.httpStatus;
  const code = raw.serverCode;
  if ((typeof code === "number" && Number.isFinite(code)) || typeof code === "boolean" ||
    (typeof code === "string" && /^[A-Za-z0-9_.:-]{1,80}$/.test(code) &&
      !/authorization|cookie|bearer|token|secret|password|oauth/i.test(code))) result.serverCode = code;
  const message = safeDiagnosticMessage(raw.serverMessage);
  if (message) result.serverMessage = message;
  return result;
}
export const idSchema = z.string().regex(/^[1-9]\d*$/, "ID 必须为正整数字符串");
export const fieldSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/);
export const actionSchema = z.enum(ACTIONS);
export const searchSchema = z
  .object({
    id: idSchema.optional(),
    number: z.string().min(1).max(200).optional(),
    keyword: z.string().min(1).max(200).optional(),
    customerId: idSchema.optional(),
    responsibleId: idSchema.optional(),
    entityType: idSchema.optional(),
    status: z.array(z.string().min(1).max(100)).min(1).max(30).optional(),
    priority: z.array(z.string().min(1).max(100)).min(1).max(10).optional(),
    since: z.iso.datetime({ offset: true }).optional(),
    until: z.iso.datetime({ offset: true }).optional(),
    page: z.number().int().min(1).max(100000).default(1),
    size: z.number().int().min(1).max(100).default(20),
    fields: z.array(fieldSchema).min(1).max(50).optional(),
    order: z.enum(["asc", "desc"]).default("desc"),
  })
  .strict();
export type SearchInput = z.input<typeof searchSchema>;
export const prepareSchema = z
  .object({
    action: actionSchema,
    id: idSchema.optional(),
    input: z.record(z.string(), z.unknown()).default({}),
    ttlSeconds: z.number().int().min(30).max(3600).default(300),
  })
  .strict();
export type PrepareInput = z.input<typeof prepareSchema>;

export interface TicketContext {
  key: string;
  apiBaseUrl: string;
  crmBaseUrl: string;
  tenantId?: string;
  subjectId?: string;
  identityVerified: boolean;
  crmIdentityVerified?: boolean;
}
export interface TicketField {
  apiKey: string;
  label: string;
  type: string;
  required: boolean;
  createable?: boolean;
  updateable?: boolean;
  enabled?: boolean;
  options: Array<{ value: unknown; label: string }>;
}
export interface TicketMetadata {
  apiKey: "fieldJob";
  fields: TicketField[];
  flags: RecordData;
}
export interface InputField {
  type: "string" | "number" | "boolean" | "object" | "array";
  required?: boolean;
  enum?: unknown[];
  min?: number;
  max?: number;
}
export interface RequestSpec {
  host: "api" | "crm";
  method: "GET" | "POST" | "PATCH";
  path: string;
  encoding: "json" | "form" | "multipart";
  payload?: unknown;
  successPath: string;
  successValues: Array<string | number | boolean>;
  rejectValues?: Array<string | number | boolean>;
  jsonFields?: string[];
  headers?: Record<string, unknown>;
  fileField?: string;
  resultIdPath?: string;
  outputPaths?: Record<string, string>;
}
export interface ProbeSpec {
  request: RequestSpec;
  permissionPath: string;
  allowedPath: string;
  formPath?: string;
  outputPaths?: Record<string, string>;
  reads?: Array<{
    request: RequestSpec;
    outputPaths: Record<string, string>;
  }>;
}
export interface ResourceQuery {
  apiKey: string;
  fields: string[];
  linkField: string;
  timeField?: string;
  dateEncoding?: "unix-ms" | "iso";
  bind?: "target" | "result";
}
export interface Evidence {
  source: "official" | "page" | "implementation" | "synthetic";
  reference: string;
  verifiedAt: string;
}
export interface RecoveryContract {
  evidence: Evidence;
  apiKey: string;
  correlationField: string;
  resultIdField: string;
  targetField?: string;
  checks: Array<{ field: string; expected: unknown }>;
  outputFields?: Record<string, string>;
}
export type JsonLiteral = null | boolean | number | string | JsonLiteral[] | { [key: string]: JsonLiteral };
export interface RecordPrecondition {
  field: string;
  expected: JsonLiteral;
}
export interface ActionContract {
  action: TicketAction;
  verification: "verified" | "unverified" | "unsupported";
  version: string;
  evidence?: Evidence;
  authorization?: "probe" | "server";
  entityTypes?: string[];
  fields: Record<string, InputField>;
  fieldMode: "create" | "update" | "action";
  required: string[];
  defaults: RecordData;
  request?: RequestSpec;
  probe?: ProbeSpec;
  preconditionFields: string[];
  recordPreconditions?: RecordPrecondition[];
  effects: string[];
  recovery?: RecoveryContract;
  verify?: {
    query?: ResourceQuery;
    checks: Array<{ field: string; expected: unknown }>;
    additional?: Array<{
      name: string;
      query: ResourceQuery;
      checks: Array<{ field: string; expected: unknown }>;
    }>;
  };
}
export interface Inspection {
  record: RecordData | null;
  permission: Decision;
  allowed: Decision;
  identityVerified: boolean;
  required: string[];
  defaults: RecordData;
  fields: Record<string, InputField>;
  formVersion: string;
  output?: RecordData;
}
export interface FileBinding {
  path: string;
  sha256: string;
  size: number;
  name: string;
}
export interface TicketPlan {
  planId: string;
  operationId: string;
  contextKey: string;
  action: TicketAction;
  targetId?: string;
  contractVersion: string;
  contractHash: string;
  snapshotHash: string;
  metadataHash?: string;
  input: RecordData;
  payload: unknown;
  requestHeaders?: Record<string, string>;
  probeOutput?: RecordData;
  file?: FileBinding;
  effects: string[];
  createdAt: string;
  expiresAt: string;
  fingerprint: string;
  concurrency: "best_effort";
}
export interface Submission {
  id?: string;
  output: RecordData;
}
export interface VerificationResult {
  status: "verified" | "partial" | "pending";
  checks: Array<{ field: string; matched: boolean }>;
}
export interface RecoveryResult {
  status: "matched" | "not_found" | "ambiguous" | "unavailable";
  matchedCount?: number;
  submission?: Submission;
}
export interface OperationReview {
  outcome: "applied" | "not_applied" | "inconclusive";
  reviewedBy: string;
  evidenceReferences: string[];
  resultId?: string;
}
export interface RecoveryAudit {
  source: "contract" | "manual";
  status: RecoveryResult["status"] | OperationReview["outcome"];
  checkedAt: string;
  matchedCount?: number;
  reviewedBy?: string;
  evidenceReferences?: string[];
  confirmationReference?: string;
}
export type OperationState =
  | "prepared"
  | "dispatching"
  | "rejected"
  | "outcome_unknown"
  | "applied_pending_verification"
  | "verified"
  | "not_applied";
export interface TicketOperation {
  plan: TicketPlan;
  state: OperationState;
  updatedAt: string;
  submission?: Submission;
  verification?: VerificationResult;
  errorCode?: string;
  errorMessage?: string;
  remoteError?: { httpStatus?: number; serverCode?: unknown; serverMessage?: string };
  recoveryHistory?: RecoveryAudit[];
  confirmation?: {
    source: "cli" | "host";
    reference: string;
    confirmedAt: string;
  };
}
export interface TicketBackend {
  withReadScope?<T>(operation: () => Promise<T>): Promise<T>;
  context(): Promise<TicketContext>;
  metadata(): Promise<TicketMetadata>;
  query(
    sql: string,
  ): Promise<{ records: RecordData[]; totalSize: number; count: number }>;
  get(id: string, fields?: string[]): Promise<RecordData>;
  inspect(
    contract: ActionContract,
    id: string | undefined,
    input: RecordData,
  ): Promise<Inspection>;
  submit(contract: ActionContract, plan: TicketPlan): Promise<Submission>;
  verify(
    contract: ActionContract,
    plan: TicketPlan,
    submission: Submission,
  ): Promise<VerificationResult>;
  recover?(
    contract: ActionContract,
    plan: TicketPlan,
  ): Promise<RecoveryResult>;
}
export const KNOWN_FIELDS = [
  "id",
  "name",
  "status",
  "customItem62__c",
  "priority",
  "responsibleTE__c",
  "ownerId",
  "assigner",
  "dispatchMethod",
  "fieldJobPoolGroup",
  "entityType",
  "dimDepart",
  "address",
  "description",
  "problemDescription__c",
  "customItem69__c",
  "fieldJobAccountId",
  "fieldJobAssetId",
  "actualStartTime",
  "actualEndTime",
];
export const DEFAULT_FIELDS = [
  "id",
  "status",
  "customItem62__c",
  "priority",
  "responsibleTE__c",
];
export function object(value: unknown): RecordData {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordData)
    : {};
}
export function at(value: unknown, path: string): unknown {
  if (!path) return value;
  return path
    .split(".")
    .reduce<unknown>(
      (v, key) =>
        ["__proto__", "prototype", "constructor"].includes(key) ||
        v === null ||
        typeof v !== "object" ||
        !Object.hasOwn(v, key)
          ? undefined
          : (v as RecordData)[key],
      value,
    );
}
export function parseInput<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success)
    fail(
      "VALIDATION_FAILED",
      "参数校验失败",
      parsed.error.issues.map((i) => ({ path: i.path, message: i.message })),
    );
  return parsed.data;
}
