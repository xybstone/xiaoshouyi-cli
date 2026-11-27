// Page-proven attachment wire protocol. Network writes stay in the shared engine.
import { createHash } from "node:crypto";
import { canonical, digest } from "./contracts.js";
import { OperationStore } from "./operation-store.js";
import {
  fail, idSchema, object, parseInput,
  type ActionContract, type FileBinding,
  type TicketContext, type TicketField, type TicketOperation, type Submission,
} from "./types.js";

export const FIELDJOB_ATTACHMENT_FIELD = "customItem69__c";
export const FIELDJOB_ATTACHMENT_UPLOAD_PATH = "/rest/file/v2.0/file/batch";
export const FIELDJOB_ATTACHMENT_LINK_PATH = "/rest/data/v2.0/xobjects/fieldJob/masterdetails";
export const FIELDJOB_ATTACHMENT_EVIDENCE = {
  source: "page" as const,
  reference: "https://neors.ingageapp.com/projects/neo-ui-web-static/2023/build/dayonemf/static/js/vendors-node_modules_xsy-breeze-ui-sfa_es_index_js-node_modules_xsy-breeze-ui-sfa_es_autoDept-42b81f.e15ba8dc.js; sha256=450b3ddf4f3d72cf160708ea3a4d00a418a394f2b2f80283d6e8f5a5bbb0d148; FormFilePicker offsets 2039247,2058700,2063300",
  verifiedAt: "2026-11-27T00:00:00+08:00",
};
export const FIELDJOB_ATTACHMENT_LINK_EVIDENCE = {
  source: "page" as const,
  reference: "https://neors.ingageapp.com/projects/neo-ui-component-web/2023/build/static/js/src_components_EntityForm_utils_tsx.23f11ed4.js; sha256=40b7491a2c92958736917505f5c847f5a79918e2e5088fc81303504306bca07c; offset 9585, inline field save PATCH masterdetails with only master; FormFilePicker JSON string evidence: " + FIELDJOB_ATTACHMENT_EVIDENCE.reference,
  verifiedAt: "2026-11-27T00:00:00+08:00",
};
export interface AttachmentScope {
  apiBaseUrl: string;
  crmBaseUrl: string;
  tenantId: string;
  subjectId?: string;
}
export interface AttachmentDescriptor {
  fileName: string;
  ext?: string;
  fileUrl?: string;
  url?: string;
  fileLength?: number;
  fileId?: string;
  id?: string;
  fileSUrl?: string;
  type?: string;
  timeStamp?: number;
}
function checkedOrigin(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
      throw new Error();
    return url.origin;
  } catch { fail("INVALID_CONFIG", "附件API/CRM必须为无凭据的HTTPS origin"); }
}
function checkedScope(scope: AttachmentScope): AttachmentScope {
  if (!scope.tenantId || !/^[A-Za-z0-9_-]{1,128}$/.test(scope.tenantId))
    fail("INVALID_CONFIG", "附件契约必须绑定已核验租户");
  return { apiBaseUrl: checkedOrigin(scope.apiBaseUrl), crmBaseUrl: checkedOrigin(scope.crmBaseUrl),
    tenantId: scope.tenantId, ...(scope.subjectId ? { subjectId: scope.subjectId } : {}) };
}
function resourceUrl(value: unknown, base: string): string {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(value))
    fail("INVALID_RESPONSE", "附件回执URL无效");
  try {
    const url = new URL(value, base);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error();
    return url.href;
  } catch { fail("INVALID_RESPONSE", "附件回执必须提供无用户凭据的HTTPS URL"); }
}
function resourceId(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0))
    fail("INVALID_RESPONSE", "附件ID无法无损读取");
  if (!["string", "number"].includes(typeof value) || !/^[A-Za-z0-9_-]{1,128}$/.test(String(value)))
    fail("INVALID_RESPONSE", "附件ID格式无效");
  return String(value);
}
function descriptor(raw: unknown, base: string, boundFileName?: string): AttachmentDescriptor {
  const value = object(raw);
  // FormFilePicker adds fileName from the chosen File. It does not synthesize
  // either URL, and does not require both the preview and download URLs.
  const fileName = boundFileName ?? value.fileName;
  if (typeof fileName !== "string" || !fileName || fileName.length > 512 || /[\u0000-\u001f\u007f\/\\]/.test(fileName))
    fail("INVALID_RESPONSE", "附件回执没有有效文件名");
  const result: AttachmentDescriptor = { fileName };
  // The page spreads the upload descriptor unchanged before enriching the name.
  // Preserve its bounded file extension for subsequent doc-field association.
  if (value.ext !== undefined && value.ext !== null && value.ext !== "") {
    if (typeof value.ext !== "string" || value.ext.length > 100 || /[\u0000-\u0020\u007f\/\\]/.test(value.ext))
      fail("INVALID_RESPONSE", "附件回执扩展名无效");
    result.ext = value.ext;
  }
  if (value.fileUrl !== undefined && value.fileUrl !== null && value.fileUrl !== "") result.fileUrl = resourceUrl(value.fileUrl, base);
  if (value.url !== undefined && value.url !== null && value.url !== "") result.url = resourceUrl(value.url, base);
  const fileId = resourceId(value.fileId), id = resourceId(value.id);
  if (fileId) result.fileId = fileId;
  if (id) result.id = id;
  if (!result.fileUrl && !result.url && !result.fileId && !result.id)
    fail("OUTCOME_UNKNOWN", "附件回执缺少可核验资源标识，不能重传或猜测文件路由");
  if (value.fileLength !== undefined) {
    const size = typeof value.fileLength === "string" && /^\d+$/.test(value.fileLength) ? Number(value.fileLength) : value.fileLength;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1) fail("INVALID_RESPONSE", "附件回执大小无效");
    result.fileLength = size;
  }
  if (value.fileSUrl) result.fileSUrl = resourceUrl(value.fileSUrl, base);
  if (typeof value.type === "string" && value.type.length <= 200 && !/[\r\n]/.test(value.type)) result.type = value.type;
  if (typeof value.timeStamp === "number" && Number.isSafeInteger(value.timeStamp) && value.timeStamp >= 0) result.timeStamp = value.timeStamp;
  return result;
}

/** Runtime registration still requires the exact scoped server-authorization gate. */
export function createFieldJobAttachmentUploadContract(scope: AttachmentScope): ActionContract {
  checkedScope(scope);
  return {
    action: "attachment_upload", verification: "verified", authorization: "server", version: "fieldjob-files-batch-page-v1",
    evidence: FIELDJOB_ATTACHMENT_EVIDENCE, fieldMode: "action",
    fields: { filePath: { type: "string", required: true } }, required: ["filePath"], defaults: {},
    preconditionFields: ["status", "customItem62__c"], effects: ["上传一个已绑定内容哈希的文件；此步骤不关联工单"],
    request: { host: "api", method: "POST", path: FIELDJOB_ATTACHMENT_UPLOAD_PATH, encoding: "multipart", fileField: "files",
      payload: {}, successPath: "code", successValues: [200, "200"], outputPaths: { attachment: "result.0" } },
    // The adapter checks the acknowledged single-file receipt. Final downloaded
    // bytes are checked separately; this is not a claim of remote hash support.
    verify: { checks: [{ field: "uploadAcknowledged", expected: true }] },
  };
}

export function createFieldJobAttachmentLinkContract(scope: AttachmentScope): ActionContract {
  checkedScope(scope);
  return {
    action: "attachment_link", verification: "verified", authorization: "server", version: "fieldjob-doc-append-masterdetails-page-v2",
    evidence: FIELDJOB_ATTACHMENT_LINK_EVIDENCE, fieldMode: "action",
    fields: { uploadOperationId: { type: "string", required: true } }, required: ["uploadOperationId"], defaults: {},
    preconditionFields: ["status", "customItem62__c", FIELDJOB_ATTACHMENT_FIELD],
    effects: ["仅向工单附件字段追加本地已核验上传操作的文件，保留既有附件"],
    request: { host: "api", method: "PATCH", path: FIELDJOB_ATTACHMENT_LINK_PATH, encoding: "json",
      payload: { master: { id: { $ref: "target.id", $type: "integer" }, [FIELDJOB_ATTACHMENT_FIELD]: { $ref: "probe.attachmentValue" } } },
      successPath: "code", successValues: [200, "200"] },
    verify: { checks: [{ field: FIELDJOB_ATTACHMENT_FIELD, expected: { $ref: "probe.attachmentValue" } }] },
  };
}

/** Decode only the page-observed envelope. Never retain unselected response keys. */
export function parseFieldJobAttachmentUpload(raw: unknown, file: FileBinding, scope: AttachmentScope): Submission {
  const origins = checkedScope(scope), response = object(raw);
  if (![200, "200"].includes(response.code as string | number) || !Array.isArray(response.result) || response.result.length !== 1)
    fail("OUTCOME_UNKNOWN", "附件上传没有返回已确认的单文件回执，不能重新上传");
  const attachment = descriptor(response.result[0], origins.apiBaseUrl, file.name);
  if (attachment.fileName !== file.name || (attachment.fileLength !== undefined && attachment.fileLength !== file.size))
    fail("OUTCOME_UNKNOWN", "附件回执文件名或大小与已确认文件不符，不能重新上传");
  if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 20 * 1024 * 1024)
    fail("INVALID_PLAN", "缺少已绑定的有效文件哈希和大小");
  return { id: attachment.fileId ?? attachment.id, output: { attachment, uploadAcknowledged: true,
    uploadedFile: { name: file.name, size: file.size, sha256: file.sha256 } } };
}

function documentFiles(value: unknown): unknown[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value === "string") {
    if (value.length > 256 * 1024) fail("INVALID_RESPONSE", "工单附件字段超过受控解析上限");
    try { value = JSON.parse(value); } catch { fail("INVALID_RESPONSE", "工单附件字段不是合法JSON"); }
  }
  if (!Array.isArray(value) || value.length > 100 || value.some(item => !item || typeof item !== "object" || Array.isArray(item)))
    fail("INVALID_RESPONSE", "工单附件字段不是受控附件数组");
  return value;
}

/** Recover newly supported descriptor fields from the same immutable upload receipt. */
export function readFieldJobAttachmentReceipt(store: OperationStore, operation: TicketOperation, scope: AttachmentScope): AttachmentDescriptor {
  const file = operation.plan.file, original = operation.submission?.output.attachment;
  if (operation.state !== "verified" || operation.plan.action !== "attachment_upload" || !file || !operation.confirmation)
    fail("UNVERIFIED", "附件回执只能来自本地已确认且已核验的上传操作");
  const attachment = descriptor(original, scope.apiBaseUrl);
  const evidence = store.readResponseEvidence(operation.plan.planId);
  if (!evidence) return attachment;
  if (evidence.binding.fingerprint !== operation.plan.fingerprint ||
    evidence.binding.contextKey !== operation.plan.contextKey || evidence.binding.targetId !== operation.plan.targetId)
    fail("INVALID_RESPONSE_EVIDENCE", "上传原始回执与已确认操作不匹配");
  // A redacted original cannot prove equality of every descriptor field. Keep
  // the already verified descriptor, but do not enrich it from partial evidence.
  if (evidence.redactedPaths.length) return attachment;
  const envelope = object(evidence.raw);
  let body: unknown = envelope;
  if (Object.hasOwn(envelope, "body") || Object.hasOwn(envelope, "httpStatus")) {
    if (typeof envelope.httpStatus !== "number" || envelope.httpStatus < 200 || envelope.httpStatus >= 300 || !Object.hasOwn(envelope, "body"))
      fail("INVALID_RESPONSE_EVIDENCE", "上传原始回执没有已确认的HTTP成功状态");
    body = envelope.body;
  }
  const recovered = object(parseFieldJobAttachmentUpload(body, file, scope).output.attachment);
  for (const [key, value] of Object.entries(object(original))) {
    if (!Object.hasOwn(recovered, key) || canonical(recovered[key]) !== canonical(value))
      fail("INVALID_RESPONSE_EVIDENCE", "上传原始回执与已保存的附件描述不一致");
  }
  return descriptor(recovered, scope.apiBaseUrl);
}

export interface AttachmentLinkInspection {
  attachmentValue: string;
  uploadOperationId: string;
  attachmentCount: number;
  formVersion: string;
}
export function inspectFieldJobAttachmentLink(options: {
  store: OperationStore; uploadOperationId: string; targetId: string; context: TicketContext;
  currentValue: unknown; field: TicketField;
}): AttachmentLinkInspection {
  parseInput(idSchema, options.targetId);
  const field = options.field;
  if (field.apiKey !== FIELDJOB_ATTACHMENT_FIELD || field.type.toLowerCase() !== "doc" || field.enabled === false || field.updateable !== true)
    fail("FORBIDDEN", "已核验工单附件字段不存在或不可更新");
  if (!options.context.identityVerified) fail("IDENTITY_UNVERIFIED", "附件关联身份尚未核验");
  if (!(options.store instanceof OperationStore)) fail("INVALID_CONFIG", "附件关联必须从本地私有操作账本读取上传回执");
  const operation = options.store.read(options.uploadOperationId);
  const { fingerprint, ...unsigned } = operation.plan;
  if (fingerprint !== `sha256:${digest(unsigned)}` || operation.plan.action !== "attachment_upload" || operation.state !== "verified" ||
    !operation.confirmation || !operation.submission || !operation.plan.file)
    fail("UNVERIFIED", "附件来源不是本地已确认且已核验的上传操作");
  if (operation.plan.contextKey !== options.context.key || operation.plan.targetId !== options.targetId)
    fail("CONTEXT_MISMATCH", "上传操作属于不同的账号、环境或工单");
  const output = operation.submission.output;
  if (output.uploadAcknowledged !== true || canonical(output.uploadedFile) !== canonical({
    name: operation.plan.file.name, size: operation.plan.file.size, sha256: operation.plan.file.sha256,
  })) fail("INVALID_PLAN", "上传回执与已确认文件哈希或大小不一致");
  if (!options.context.tenantId) fail("IDENTITY_UNVERIFIED", "附件关联租户尚未核验");
  const attachment = readFieldJobAttachmentReceipt(options.store, operation, { ...options.context, tenantId: options.context.tenantId });
  if (attachment.fileName !== operation.plan.file.name ||
    (attachment.fileLength !== undefined && attachment.fileLength !== operation.plan.file.size))
    fail("INVALID_PLAN", "上传回执与确认文件不匹配");
  const existing = documentFiles(options.currentValue);
  if (existing.length >= 100) fail("VALIDATION_FAILED", "附件数量已达到受控关联上限");
  if (existing.some(item => {
    const value = object(item);
    return (attachment.fileUrl && value.fileUrl === attachment.fileUrl) || (attachment.url && value.url === attachment.url) ||
      (attachment.fileId && String(value.fileId) === attachment.fileId) || (attachment.id && String(value.id) === attachment.id);
  })) fail("ALREADY_LINKED", "该已上传文件已关联，不能重复追加");
  const attachmentValue = JSON.stringify([...existing, attachment]);
  return { attachmentValue, uploadOperationId: options.uploadOperationId, attachmentCount: existing.length + 1,
    formVersion: `attachment-append-v1:${digest({ before: existing, source: fingerprint, field })}` };
}

export function fieldJobAttachmentLinkMatches(actual: unknown, preparedValue: string): boolean {
  return canonical(documentFiles(actual)) === canonical(documentFiles(preparedValue));
}

/** No network: return a constrained GET descriptor, never a cross-origin bearer. */
export function sameOriginAttachmentDownload(value: unknown, scope: AttachmentScope): {
  host: "api" | "crm"; method: "GET"; path: string; params: Record<string, string>; maxRedirects: 0;
} {
  const origins = checkedScope(scope), raw = object(value);
  if (raw.url === undefined || raw.url === null || raw.url === "")
    fail("UNVERIFIED", "附件回执未提供下载URL；预览地址或文件ID不能替代未核验下载协议");
  const href = resourceUrl(raw.url, origins.apiBaseUrl), url = new URL(href);
  const host = url.origin === origins.apiBaseUrl ? "api" : url.origin === origins.crmBaseUrl ? "crm" : undefined;
  if (!host) fail("UNVERIFIED", "第三方或预签名附件下载协议尚未核验，不能转发认证信息");
  if (typeof raw.url !== "string" || /(?:^|\/)(?:\.{1,2}|%2e|%2e%2e)(?:\/|%2f|$)|%2f|%5c/i.test(raw.url))
    fail("INVALID_RESPONSE", "附件下载地址含不允许的路径编码");
  const params: Record<string, string> = {};
  for (const [key, param] of url.searchParams) {
    if (Object.hasOwn(params, key) || Object.keys(params).length >= 20 || key.length > 100 || param.length > 4096 ||
      ["__proto__", "constructor", "prototype"].includes(key) ||
      /authorization|cookie|access[_-]?token|refresh[_-]?token|password|secret/i.test(key))
      fail("UNVERIFIED", "附件下载查询参数不符合受控读取契约");
    params[key] = param;
  }
  return { host, method: "GET", path: url.pathname, params, maxRedirects: 0 };
}

export function attachmentContentMatches(bytes: Uint8Array, file: Pick<FileBinding, "size" | "sha256">): boolean {
  return bytes.byteLength === file.size && createHash("sha256").update(bytes).digest("hex") === file.sha256;
}
