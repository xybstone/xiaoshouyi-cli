// Synthetic metadata and local operations only. No network or upload is performed.
import { afterEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fingerprint } from "../../../src/tickets/actions.js";
import { OperationStore } from "../../../src/tickets/operation-store.js";
import {
  attachmentContentMatches, createFieldJobAttachmentLinkContract, createFieldJobAttachmentUploadContract,
  fieldJobAttachmentLinkMatches, inspectFieldJobAttachmentLink, parseFieldJobAttachmentUpload,
  sameOriginAttachmentDownload,
} from "../../../src/tickets/fieldjob-attachments.js";
import type { FileBinding, TicketContext, TicketField, TicketOperation, TicketPlan } from "../../../src/tickets/types.js";

const scope = { apiBaseUrl: "https://api.example.test", crmBaseUrl: "https://crm.example.test", tenantId: "tenant-one", subjectId: "subject-one" };
const context: TicketContext = { ...scope, key: "synthetic-scope-key", identityVerified: true };
const bytes = Buffer.from("Synthetic internal attachment verification only.\n");
const file: FileBinding = { path: "/tmp/synthetic-attachment.txt", name: "synthetic-attachment.txt", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
const attachment = { fileName: file.name, fileUrl: "https://api.example.test/file/preview/9", url: "https://api.example.test/file/download/9?name=synthetic-attachment.txt", fileId: "9", fileLength: file.size };
const field: TicketField = { apiKey: "customItem69__c", label: "附件", type: "doc", required: false, updateable: true, enabled: true, options: [] };
const directories: string[] = [];
function setup() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "xsy-attachment-receipt-")); directories.push(directory);
  const store = new OperationStore(directory), id = randomUUID();
  const unsigned = { planId: id, operationId: id, contextKey: context.key, action: "attachment_upload" as const,
    targetId: "1", contractVersion: "synthetic", contractHash: "synthetic", snapshotHash: "synthetic",
    input: { filePath: file.path }, payload: {}, file, effects: ["one acknowledged upload"],
    createdAt: "2026-11-27T00:00:00+08:00", expiresAt: "2026-11-27T01:00:00+08:00", concurrency: "best_effort" as const,
  };
  const plan: TicketPlan = { ...unsigned, fingerprint: fingerprint(unsigned) };
  const operation: TicketOperation = { plan, state: "verified", updatedAt: plan.createdAt,
    confirmation: { source: "cli", reference: "synthetic explicit approval", confirmedAt: plan.createdAt },
    submission: parseFieldJobAttachmentUpload({ code: 200, result: [attachment] }, file, scope),
  };
  store.create(operation);
  return { store, operation, options: { store, uploadOperationId: id, targetId: "1", context, currentValue: null, field } };
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("page-proven attachment wire adaptation", () => {
  it("fixes the batch multipart field and exposes no file path in the HTTP payload", () => {
    const contract = createFieldJobAttachmentUploadContract(scope);
    expect(contract.request).toMatchObject({ host: "api", method: "POST", path: "/rest/file/v2.0/file/batch", encoding: "multipart", fileField: "files", payload: {} });
    expect(contract.authorization).toBe("server"); expect(contract.evidence?.source).toBe("page");
    expect(contract.request?.resultIdPath).toBeUndefined(); // fileId/id must come from the actual receipt.
  });
  it("the association contract accepts only a local upload operation, never raw URLs or descriptors", () => {
    const contract = createFieldJobAttachmentLinkContract(scope);
    expect(Object.keys(contract.fields)).toEqual(["uploadOperationId"]);
    expect(contract.version).toBe("fieldjob-doc-append-masterdetails-page-v2");
    expect(contract.request).toMatchObject({ method: "PATCH", path: "/rest/data/v2.0/xobjects/fieldJob/masterdetails", payload: {
      master: { id: { $ref: "target.id", $type: "integer" }, customItem69__c: { $ref: "probe.attachmentValue" } },
    } });
    expect(contract.preconditionFields).toContain("customItem69__c");
    expect(contract.verify?.checks).toEqual([{ field: "customItem69__c", expected: { $ref: "probe.attachmentValue" } }]);
  });
  it("decodes the single-file receipt and strips unselected auth/raw response fields", () => {
    const result = parseFieldJobAttachmentUpload({ code: 200, result: [{ ...attachment, Authorization: "RAW-AUTH", cookie: "RAW-COOKIE", arbitrary: { secret: "RAW-SECRET" } }] }, file, scope);
    expect(result.id).toBe("9"); expect(result.output.attachment).toEqual(attachment);
    expect(result.output).toMatchObject({ uploadAcknowledged: true, uploadedFile: { sha256: file.sha256, size: file.size } });
    expect(JSON.stringify(result)).not.toMatch(/RAW-|Authorization|cookie|arbitrary/);
  });
  it.each([200, "200"])("accepts the page-proven numeric or string success code %j", code => {
    const result = parseFieldJobAttachmentUpload({ code, result: [attachment] }, file, scope);
    expect(result.output.attachment).toEqual(attachment);
    expect(result.output.uploadAcknowledged).toBe(true);
    expect(createFieldJobAttachmentUploadContract(scope).request?.successValues).toContain(code);
    expect(createFieldJobAttachmentLinkContract(scope).request?.successValues).toContain(code);
  });
  it("follows the page's local filename enrichment without requiring a preview URL", () => {
    const result = parseFieldJobAttachmentUpload({ code: 200, result: [{ url: attachment.url, fileLength: file.size }] }, file, scope);
    expect(result.output.attachment).toEqual({ fileName: file.name, url: attachment.url, fileLength: file.size });
    expect(sameOriginAttachmentDownload(result.output.attachment, scope).path).toBe("/file/download/9");
  });
  it("uses the confirmed local filename as the page does instead of trusting a server display label", () => {
    const result = parseFieldJobAttachmentUpload({ code: 200, result: [{ ...attachment, fileName: "server-display-name.txt" }] }, file, scope);
    expect(result.output.attachment).toMatchObject({ fileName: file.name });
  });
  it("does not invent a download URL when only an opaque ID or preview was returned", () => {
    const result = parseFieldJobAttachmentUpload({ code: 200, result: [{ fileId: "opaque-file", fileUrl: attachment.fileUrl }] }, file, scope);
    expect(result.output.attachment).toEqual({ fileName: file.name, fileId: "opaque-file", fileUrl: attachment.fileUrl });
    expect(() => sameOriginAttachmentDownload(result.output.attachment, scope)).toThrow(/未提供下载URL/);
  });
  it("preserves the actual batch descriptor extension when only fileUrl was returned", () => {
    const value = { ext: "txt", fileName: file.name, fileUrl: "https://storage.example.test/opaque-file", fileLength: file.size };
    const result = parseFieldJobAttachmentUpload({ code: "200", result: [value] }, file, scope);
    expect(result.output.attachment).toEqual(value);
    expect(result.id).toBeUndefined();
  });
  it.each([
    { code: 403, result: [] }, { code: 200, result: [] }, { code: "0200", result: [attachment] },
    { code: 200, result: [attachment, attachment] }, { code: 200, result: [{}] },
    { code: 200, result: [{ ...attachment, fileLength: 1 }] },
  ])("unconfirmed or mismatched upload receipts remain uncertain: %j", raw => {
    expect(() => parseFieldJobAttachmentUpload(raw, file, scope)).toThrow();
  });
  it.each([
    { ...attachment, fileUrl: "javascript:alert(1)" }, { ...attachment, url: "http://api.example.test/file/9" },
    { ...attachment, url: "https://user:pass@api.example.test/file/9" },
    { ...attachment, fileId: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects unsafe metadata URLs or lossy IDs %j", value => {
    expect(() => parseFieldJobAttachmentUpload({ code: 200, result: [value] }, file, scope)).toThrow();
  });
  it("appends a verified same-target upload and preserves existing file metadata", () => {
    const s = setup(); const existing = [{ fileName: "old.txt", fileUrl: "https://api.example.test/old/preview", url: "https://api.example.test/old/download", customServerFlag: true }];
    const result = inspectFieldJobAttachmentLink({ ...s.options, currentValue: JSON.stringify(existing) });
    expect(JSON.parse(result.attachmentValue)).toEqual([...existing, attachment]); expect(result.attachmentCount).toBe(2);
    expect(fieldJobAttachmentLinkMatches(JSON.parse(result.attachmentValue), result.attachmentValue)).toBe(true);
    expect(fieldJobAttachmentLinkMatches(existing, result.attachmentValue)).toBe(false);
  });
  it.each([false, true])("enriches an old verified receipt from bound immutable response evidence, wrapped=%j", wrapped => {
    const s = setup(), body = { code: "200", result: [{ ...attachment, ext: "txt" }] };
    const original = JSON.stringify(s.store.read(s.operation.plan.planId));
    s.store.writeResponseEvidence(s.operation.plan.planId, wrapped ? { httpStatus: 200, body } : body);
    const result = inspectFieldJobAttachmentLink(s.options);
    expect(JSON.parse(result.attachmentValue)).toEqual([{ ...attachment, ext: "txt" }]);
    expect(JSON.stringify(s.store.read(s.operation.plan.planId))).toBe(original);
  });
  it("rejects an upload response that disagrees with an existing verified descriptor", () => {
    const s = setup();
    s.store.writeResponseEvidence(s.operation.plan.planId, { httpStatus: 200,
      body: { code: 200, result: [{ ...attachment, fileUrl: "https://api.example.test/different", ext: "txt" }] } });
    expect(() => inspectFieldJobAttachmentLink(s.options)).toThrow(/已保存的附件描述不一致/);
  });
  it("cannot enrich a descriptor from an HTTP failure even with a success body", () => {
    const s = setup();
    s.store.writeResponseEvidence(s.operation.plan.planId, { httpStatus: 500,
      body: { code: 200, result: [{ ...attachment, ext: "txt" }] } });
    expect(() => inspectFieldJobAttachmentLink(s.options)).toThrow(/HTTP成功状态/);
  });
  it("keeps the existing verified descriptor without enrichment when the raw receipt was redacted", () => {
    const s = setup();
    s.store.writeResponseEvidence(s.operation.plan.planId, { httpStatus: 200,
      body: { code: 200, result: [{ ...attachment, ext: "txt" }], authorization: "REDACTED-AUTH" } });
    expect(JSON.parse(inspectFieldJobAttachmentLink(s.options).attachmentValue)).toEqual([attachment]);
  });
  it.each(["prepared", "dispatching", "outcome_unknown", "applied_pending_verification", "rejected"] as const)("does not link an unverified %s upload", state => {
    const s = setup(); s.operation.state = state; s.store.save(s.operation);
    expect(() => inspectFieldJobAttachmentLink(s.options)).toThrow(/已确认且已核验/);
  });
  it("requires the same target and identity context", () => {
    const s = setup();
    expect(() => inspectFieldJobAttachmentLink({ ...s.options, targetId: "2" })).toThrow(/不同/);
    expect(() => inspectFieldJobAttachmentLink({ ...s.options, context: { ...context, key: "different" } })).toThrow(/不同/);
    expect(() => inspectFieldJobAttachmentLink({ ...s.options, context: { ...context, identityVerified: false } })).toThrow(/身份/);
  });
  it("rejects a tampered plan, missing confirmation or modified receipt hash", () => {
    const a = setup(); a.operation.plan.targetId = "2"; a.store.save(a.operation);
    expect(() => inspectFieldJobAttachmentLink(a.options)).toThrow();
    const b = setup(); delete b.operation.confirmation; b.store.save(b.operation);
    expect(() => inspectFieldJobAttachmentLink(b.options)).toThrow();
    const c = setup(); c.operation.submission!.output.uploadedFile = { sha256: "bad" }; c.store.save(c.operation);
    expect(() => inspectFieldJobAttachmentLink(c.options)).toThrow(/哈希或大小/);
  });
  it("requires the actual writable doc field and rejects a duplicate append", () => {
    const s = setup();
    expect(() => inspectFieldJobAttachmentLink({ ...s.options, field: { ...field, type: "text" } })).toThrow();
    expect(() => inspectFieldJobAttachmentLink({ ...s.options, field: { ...field, updateable: false } })).toThrow();
    expect(() => inspectFieldJobAttachmentLink({ ...s.options, currentValue: [attachment] })).toThrow(/已关联/);
  });
  it("ties the association form version to old attachments for execution-time stale detection", () => {
    const s = setup(); const first = inspectFieldJobAttachmentLink(s.options);
    const second = inspectFieldJobAttachmentLink({ ...s.options, currentValue: [{ fileName: "other.txt", fileUrl: "https://api.example.test/another" }] });
    expect(second.formVersion).not.toBe(first.formVersion);
  });
  it("uses a same-origin GET without redirects and preserves ordinary query parameters", () => {
    expect(sameOriginAttachmentDownload(attachment, scope)).toEqual({ host: "api", method: "GET", path: "/file/download/9", params: { name: file.name }, maxRedirects: 0 });
    expect(sameOriginAttachmentDownload({ url: "https://crm.example.test/file/download/9" }, scope).host).toBe("crm");
  });
  it.each([
    "https://cdn.example.test/private/file?signature=opaque", "https://api.example.test/../private/file",
    "https://api.example.test/file/%2fprivate", "https://api.example.test/file/9?access_token=secret",
    "https://api.example.test/file/9?key=one&key=two", "https://api.example.test/file/9?__proto__=bad",
  ])("does not permit unverified third-party/signed or ambiguous download routing: %s", url => {
    expect(() => sameOriginAttachmentDownload({ url }, scope)).toThrow();
  });
  it("checks final downloaded bytes against the original file binding", () => {
    expect(attachmentContentMatches(bytes, file)).toBe(true);
    expect(attachmentContentMatches(Buffer.from("different bytes"), file)).toBe(false);
  });
});
