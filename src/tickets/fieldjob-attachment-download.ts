import { mkdirSync, lstatSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { canonical, digest } from "./contracts.js";
import { OperationStore } from "./operation-store.js";
import {
  FIELDJOB_ATTACHMENT_FIELD, attachmentContentMatches,
  parseFieldJobAttachmentUpload, readFieldJobAttachmentReceipt, sameOriginAttachmentDownload,
} from "./fieldjob-attachments.js";
import { fail, idSchema, parseInput } from "./types.js";
import type { CrmTicketBackend } from "./backend.js";
import { downloadFieldJobStorage, fieldJobAnonymousStorageUrl } from "./fieldjob-storage.js";

type DownloadBackend = Pick<CrmTicketBackend, "context" | "get" | "downloadRequest">;

/** Download a verified upload; association verification is required by default. */
export async function downloadFieldJobAttachmentFromUpload(options: {
  backend: DownloadBackend;
  store: OperationStore;
  uploadOperationId: string;
  targetId?: string;
  destination?: string;
  verifyAssociation?: boolean;
}) {
  if (options.verifyAssociation !== undefined && typeof options.verifyAssociation !== "boolean")
    fail("INVALID_CONFIG", "附件关联核验模式必须为布尔值");
  const verifyAssociation = options.verifyAssociation ?? true;
  if (!(options.store instanceof OperationStore))
    fail("INVALID_CONFIG", "附件下载必须使用当前本地私有操作账本");
  const operation = options.store.read(options.uploadOperationId);
  const { fingerprint, ...unsigned } = operation.plan;
  if (fingerprint !== `sha256:${digest(unsigned)}` || operation.state !== "verified" ||
    operation.plan.action !== "attachment_upload" || !operation.plan.file ||
    !operation.confirmation || !operation.submission)
    fail("UNVERIFIED", "附件下载来源必须为本地已确认且已核验的上传操作");
  const targetId = parseInput(idSchema, operation.plan.targetId);
  if (options.targetId !== undefined && parseInput(idSchema, options.targetId) !== targetId)
    fail("CONTEXT_MISMATCH", "附件上传操作属于不同工单");
  const context = await options.backend.context();
  if (!context.identityVerified || !context.tenantId)
    fail("IDENTITY_UNVERIFIED", "附件下载身份尚未核验");
  if (operation.plan.contextKey !== context.key)
    fail("CONTEXT_MISMATCH", "附件上传操作属于其他账号或环境");
  const file = operation.plan.file, output = operation.submission.output;
  if (output.uploadAcknowledged !== true || canonical(output.uploadedFile) !== canonical({
    name: file.name, size: file.size, sha256: file.sha256,
  })) fail("INVALID_PLAN", "上传回执与原确认文件哈希或大小不一致");
  const scope = { apiBaseUrl: context.apiBaseUrl, crmBaseUrl: context.crmBaseUrl,
    tenantId: context.tenantId, subjectId: context.subjectId };
  const attachment = readFieldJobAttachmentReceipt(options.store, operation, scope);
  const storageUrl = fieldJobAnonymousStorageUrl(attachment);
  const route = storageUrl ? undefined : sameOriginAttachmentDownload(attachment, scope);
  if (route?.host === "crm" && context.crmIdentityVerified !== true)
    fail("IDENTITY_UNVERIFIED", "CRM域附件下载需要独立验证会话身份");

  // An acknowledged upload does not establish that this record owns the file.
  const parent = await options.backend.get(targetId, verifyAssociation ? ["id", FIELDJOB_ATTACHMENT_FIELD] : ["id"]);
  if (String(parent.id) !== targetId) fail("INVALID_RESPONSE", "父工单回读未匹配目标");
  if (verifyAssociation) {
      let values: unknown = parent[FIELDJOB_ATTACHMENT_FIELD];
      if (typeof values === "string") {
        if (values.length > 256 * 1024) fail("INVALID_RESPONSE", "父工单附件字段超出受控读取上限");
        try { values = JSON.parse(values); } catch { fail("INVALID_RESPONSE", "父工单附件字段不是合法JSON"); }
      }
      if (!Array.isArray(values) || values.length > 100)
        fail("UNVERIFIED", "该上传文件尚未确认关联到父工单");
      const linked = values.some(value => {
        try {
          const candidate = parseFieldJobAttachmentUpload({ code: 200, result: [value] }, file, scope);
          return canonical(candidate.output.attachment) === canonical(attachment);
        } catch { return false; }
      });
      if (!linked) fail("UNVERIFIED", "父工单未包含该已核验上传回执，不能下载");
  }
  if ((await options.backend.context()).key !== context.key)
    fail("CONTEXT_MISMATCH", "父工单读取期间账号或环境变化，未下载文件");

  const bytes = storageUrl ? await downloadFieldJobStorage(attachment, file) : await options.backend.downloadRequest({
    // A non-storage descriptor must have passed the same-origin route validator.
    host: route!.host, method: "GET", path: route!.path, encoding: "json", payload: route!.params,
    successPath: "code", successValues: [200],
  }, { context, target: { id: targetId }, input: {} }, file.size);
  if (!attachmentContentMatches(bytes, file))
    fail("DOWNLOAD_FAILED", "下载内容的大小或SHA-256与原确认文件不一致，未保存文件");
  if ((await options.backend.context()).key !== context.key)
    fail("CONTEXT_MISMATCH", "下载期间账号或环境变化，未保存文件");

  const outputFile = path.resolve(options.destination ??
    path.join(options.store.directory, "attachments", `${randomUUID()}.bin`));
  const directory = path.dirname(outputFile);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("INVALID_CONFIG", "附件输出目录必须为真实目录");
  writeFileSync(outputFile, bytes, { flag: "wx", mode: 0o600 });
  return {
    path: outputFile, bytes: bytes.length, sha256: file.sha256, verified: true, contentVerified: true,
    associationVerified: verifyAssociation,
    uploadOperationId: operation.plan.operationId, targetId,
  };
}
