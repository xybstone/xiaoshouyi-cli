// Exercise the actual adapter, multipart encoder, ledger and download verifier.
// Axios is synthetic and all files are temporary; no CRM network is reachable.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getApiClient, resetApiClient } from "../../../src/api/client.js";
import { CrmTicketBackend } from "../../../src/tickets/backend.js";
import { ContractRegistry } from "../../../src/tickets/contracts.js";
import { TicketActions } from "../../../src/tickets/actions.js";
import { OperationStore } from "../../../src/tickets/operation-store.js";
import { createFieldJobAttachmentLinkContract, createFieldJobAttachmentUploadContract } from "../../../src/tickets/fieldjob-attachments.js";
import { downloadFieldJobAttachmentFromUpload } from "../../../src/tickets/fieldjob-attachment-download.js";
import { FIELDJOB_STORAGE_ORIGIN } from "../../../src/tickets/fieldjob-storage.js";
import { TicketError, type TicketPlan } from "../../../src/tickets/types.js";

const mocks = vi.hoisted(() => ({ describe: vi.fn(), query: vi.fn(), username: "synthetic-user", refresh: vi.fn() }));
vi.mock("../../../src/auth/manager.js", () => ({ getAuthManager: () => ({
  getToken: async () => "synthetic-not-real-token", getApiBaseUrl: () => "https://api.example.test",
  getUsername: () => mocks.username, getStatus: () => ({ tenantId: "synthetic-tenant" }), refresh: mocks.refresh,
}) }));
vi.mock("../../../src/services/object.service.js", () => ({ describeObject: mocks.describe, queryObjects: mocks.query }));

const scope = { apiBaseUrl: "https://api.example.test", crmBaseUrl: "https://crm.xiaoshouyi.com", tenantId: "synthetic-tenant" };
const content = Buffer.from("Synthetic internal attachment test. No customer data.\n");
const directories: string[] = [];
let parent: Record<string, unknown>;
const confirmation = (plan: TicketPlan) => ({ fingerprint: plan.fingerprint, source: "cli" as const, reference: "explicit synthetic attachment approval" });
async function prepared(actions: TicketActions, action: "attachment_upload" | "attachment_link", input: Record<string, unknown>) {
  const result = await actions.prepare({ action, id: "1", input });
  if (result.status !== "ready") throw new Error("not ready");
  return result.plan;
}
async function setup(options: { link?: boolean; external?: boolean; storage?: boolean } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "xsy-attachment-download-")); directories.push(directory);
  const store = new OperationStore(path.join(directory, "operations"));
  const registry = new ContractRegistry({ version: 1, scope, actions: [
    createFieldJobAttachmentUploadContract(scope), createFieldJobAttachmentLinkContract(scope),
  ] });
  const backend = new CrmTicketBackend(registry, 30000, store), actions = new TicketActions(backend, registry, store);
  const file = path.join(directory, "internal-test.txt"); writeFileSync(file, content, { mode: 0o600 });
  const receipt = {
    fileName: "internal-test.txt", fileLength: content.length,
    fileUrl: options.storage ? `${FIELDJOB_STORAGE_ORIGIN}/synthetic-upload-object` : "https://api.example.test/fixture/preview/opaque",
    ...(options.storage ? { ext: "txt" } : {
      url: options.external ? "https://unverified-cdn.example.test/private/object?signature=opaque" : "https://api.example.test/fixture/download/opaque?name=internal-test.txt",
    }),
    // Deliberately no numeric fileId/id: the operation number is the API handle.
  };
  const requests: Array<{ method?: string; url?: string; replay?: string; maxRedirects?: number; maxBytes?: number }> = [];
  const adapter = vi.fn(async config => {
    requests.push({ method: config.method, url: config.url, replay: config.xsyReplay, maxRedirects: config.maxRedirects, maxBytes: config.maxContentLength });
    if (config.method === "post" && config.url === "/rest/file/v2.0/file/batch") {
      expect(config.data).toBeInstanceOf(FormData);
      expect((config.data as FormData).get("files")).toBeInstanceOf(Blob);
      expect((config.data as FormData).get("filePath")).toBeNull();
      return { config, status: 200, statusText: "OK", headers: {}, data: { code: 200, result: [receipt] } };
    }
    if (config.method === "patch" && config.url === "/rest/data/v2.0/xobjects/fieldJob/masterdetails") {
      const body = JSON.parse(config.data), data = body.master;
      expect(Object.keys(body)).toEqual(["master"]);
      expect(Object.keys(data).sort()).toEqual(["customItem69__c", "id"]); expect(data.id).toBe(1);
      parent.customItem69__c = data.customItem69__c;
      return { config, status: 200, statusText: "OK", headers: {}, data: { code: 200, data: {} } };
    }
    if (config.method === "get" && config.url === "/fixture/download/opaque")
      return { config, status: 200, statusText: "OK", headers: { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="internal-test.txt"' }, data: content };
    throw new Error("Unregistered synthetic request");
  });
  getApiClient().defaults.adapter = adapter;
  const uploadPlan = await prepared(actions, "attachment_upload", { filePath: file });
  const upload = await actions.execute(uploadPlan.planId, confirmation(uploadPlan));
  expect(upload.state).toBe("verified");
  if (options.link !== false) {
    const link = await prepared(actions, "attachment_link", { uploadOperationId: uploadPlan.planId });
    expect((await actions.execute(link.planId, confirmation(link))).state).toBe("verified");
  }
  return { backend, actions, store, directory, upload, adapter, requests, receipt,
    download: { backend, store, uploadOperationId: uploadPlan.planId } };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unmocked network is forbidden in attachment tests"); }));
  for (const key of ["XSY_NEOCRM_PROJECT", "XSY_ACCESS_TOKEN", "XSY_API_BASE_URL"]) vi.stubEnv(key, "");
  resetApiClient(); mocks.username = "synthetic-user"; mocks.refresh.mockReset();
  parent = { id: "1", entityType: "2", status: 3, customItem62__c: 3, customItem69__c: null };
  mocks.describe.mockResolvedValue({ code: 200, data: { apiKey: "fieldJob", updateable: true, disabled: true, fields: [
    ...["id", "entityType", "status", "customItem62__c"].map(apiKey => ({ apiKey, type: "text", enabled: true, updateable: false })),
    { apiKey: "customItem69__c", type: "doc", enabled: true, updateable: true },
  ] } });
  mocks.query.mockImplementation(async () => ({ code: 200, result: { records: [{ ...parent }], totalSize: 1, count: 1 } }));
});
afterEach(() => { resetApiClient(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("verified upload operation → parent association → private hash-checked download", () => {
  it("uses the production adapter for upload/link/download without a numeric attachment ID", async () => {
    const s = await setup(); expect(s.upload.submission?.id).toBeUndefined();
    const result = await downloadFieldJobAttachmentFromUpload(s.download);
    expect(result.verified).toBe(true); expect(result.associationVerified).toBe(true); expect(result.bytes).toBe(content.length);
    expect(readFileSync(result.path)).toEqual(content);
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(result.path)).mode & 0o777).toBe(0o700);
    expect(s.requests.map(request => request.method)).toEqual(["post", "patch", "get"]);
    expect(s.requests.filter(request => request.method !== "get").every(request => request.replay === "never")).toBe(true);
    expect(s.requests[2]).toMatchObject({ replay: "read", maxRedirects: 0, maxBytes: content.length });
  });
  it("does not download an acknowledged file that is not linked to its parent", async () => {
    const s = await setup({ link: false }); const before = s.adapter.mock.calls.length;
    await expect(downloadFieldJobAttachmentFromUpload(s.download)).rejects.toMatchObject({ code: "UNVERIFIED" });
    expect(s.adapter).toHaveBeenCalledTimes(before);
  });
  it("downloads a verified upload anonymously while explicitly leaving its association unverified", async () => {
    const s = await setup({ storage: true, link: false }), get = vi.spyOn(s.backend, "get");
    const fetch = vi.fn(async () => new Response(content, { status: 200, headers: { "content-length": String(content.length) } }));
    vi.stubGlobal("fetch", fetch);
    const result = await downloadFieldJobAttachmentFromUpload({ ...s.download, verifyAssociation: false });
    expect(result).toMatchObject({ verified: true, contentVerified: true, associationVerified: false, bytes: content.length });
    expect(get).toHaveBeenCalledWith("1", ["id"]);
    expect(readFileSync(result.path)).toEqual(content);
    expect(fetch).toHaveBeenCalledExactlyOnceWith(`${FIELDJOB_STORAGE_ORIGIN}/synthetic-upload-object`, {
      method: "GET", credentials: "omit", redirect: "manual", signal: expect.any(AbortSignal),
    });
    expect(s.requests.map(request => request.method)).toEqual(["post"]);
  });
  it("still requires the parent doc association by default for anonymous storage", async () => {
    const s = await setup({ storage: true, link: false });
    await expect(downloadFieldJobAttachmentFromUpload(s.download)).rejects.toMatchObject({ code: "UNVERIFIED" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("checks association before anonymously downloading a linked storage file", async () => {
    const s = await setup({ storage: true }); vi.stubGlobal("fetch", vi.fn(async () => new Response(content)));
    const result = await downloadFieldJobAttachmentFromUpload(s.download);
    expect(result.associationVerified).toBe(true); expect(readFileSync(result.path)).toEqual(content);
  });
  it("keeps the existing same-origin route available in upload-only mode", async () => {
    const s = await setup({ link: false });
    const result = await downloadFieldJobAttachmentFromUpload({ ...s.download, verifyAssociation: false });
    expect(result.associationVerified).toBe(false); expect(readFileSync(result.path)).toEqual(content);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(s.requests.map(request => request.method)).toEqual(["post", "get"]);
  });
  it("checks parent read permission before any anonymous file request in upload-only mode", async () => {
    const s = await setup({ storage: true, link: false });
    vi.spyOn(s.backend, "get").mockRejectedValue(new TicketError("FORBIDDEN", "Synthetic read denial"));
    await expect(downloadFieldJobAttachmentFromUpload({ ...s.download, verifyAssociation: false })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("rejects a changed identity during the parent read before anonymous storage access", async () => {
    const s = await setup({ storage: true, link: false });
    vi.spyOn(s.backend, "get").mockImplementation(async () => { mocks.username = "changed-during-parent-read"; return { id: "1" }; });
    await expect(downloadFieldJobAttachmentFromUpload({ ...s.download, verifyAssociation: false })).rejects.toMatchObject({ code: "CONTEXT_MISMATCH" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("does not save anonymous bytes after the identity changes during download", async () => {
    const s = await setup({ storage: true, link: false }), destination = path.join(s.directory, "changed-storage-context.bin");
    vi.stubGlobal("fetch", vi.fn(async () => { mocks.username = "changed-during-storage-read"; return new Response(content); }));
    await expect(downloadFieldJobAttachmentFromUpload({ ...s.download, destination, verifyAssociation: false })).rejects.toMatchObject({ code: "CONTEXT_MISMATCH" });
    expect(existsSync(destination)).toBe(false);
  });
  it.each(["outcome_unknown", "applied_pending_verification", "rejected"] as const)("upload-only mode still rejects an upload in %s state", async state => {
    const s = await setup({ storage: true, link: false }); s.upload.state = state; s.store.save(s.upload);
    await expect(downloadFieldJobAttachmentFromUpload({ ...s.download, verifyAssociation: false })).rejects.toMatchObject({ code: "UNVERIFIED" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("upload-only mode preserves matching identity and target requirements", async () => {
    const s = await setup({ storage: true, link: false });
    await expect(downloadFieldJobAttachmentFromUpload({ ...s.download, verifyAssociation: false, targetId: "2" })).rejects.toMatchObject({ code: "CONTEXT_MISMATCH" });
    mocks.username = "different-upload-user";
    await expect(downloadFieldJobAttachmentFromUpload({ ...s.download, verifyAssociation: false })).rejects.toMatchObject({ code: "CONTEXT_MISMATCH" });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it.each(["outcome_unknown", "applied_pending_verification", "rejected"] as const)("rejects an upload in %s state before a binary request", async state => {
    const s = await setup(); s.upload.state = state; s.store.save(s.upload); const before = s.adapter.mock.calls.length;
    await expect(downloadFieldJobAttachmentFromUpload(s.download)).rejects.toMatchObject({ code: "UNVERIFIED" });
    expect(s.adapter).toHaveBeenCalledTimes(before);
  });
  it("requires matching identity, target and untouched confirmed plan", async () => {
    const s = await setup();
    await expect(downloadFieldJobAttachmentFromUpload({ ...s.download, targetId: "2" })).rejects.toMatchObject({ code: "CONTEXT_MISMATCH" });
    mocks.username = "different-user";
    await expect(downloadFieldJobAttachmentFromUpload(s.download)).rejects.toMatchObject({ code: "CONTEXT_MISMATCH" });
    mocks.username = "synthetic-user"; s.upload.plan.payload = { changed: true }; s.store.save(s.upload);
    await expect(downloadFieldJobAttachmentFromUpload(s.download)).rejects.toMatchObject({ code: "UNVERIFIED" });
  });
  it("rejects third-party signed URLs without issuing a request to them", async () => {
    const s = await setup({ external: true }); const before = s.adapter.mock.calls.length;
    await expect(downloadFieldJobAttachmentFromUpload(s.download)).rejects.toMatchObject({ code: "UNVERIFIED" });
    expect(s.adapter).toHaveBeenCalledTimes(before);
  });
  it("rejects changed parent descriptors even if the filename is unchanged", async () => {
    const s = await setup(); const values = JSON.parse(String(parent.customItem69__c)); values[0].url = "https://api.example.test/different";
    parent.customItem69__c = JSON.stringify(values); const before = s.adapter.mock.calls.length;
    await expect(downloadFieldJobAttachmentFromUpload(s.download)).rejects.toMatchObject({ code: "UNVERIFIED" });
    expect(s.adapter).toHaveBeenCalledTimes(before);
  });
  it("hash mismatch does not save bytes or repeat upload/link", async () => {
    const s = await setup(); const destination = path.join(s.directory, "bad-download.bin");
    getApiClient().defaults.adapter = async config => ({ config, status: 200, statusText: "OK", headers: { "content-type": "application/octet-stream" }, data: Buffer.from("bad bytes") });
    await expect(downloadFieldJobAttachmentFromUpload({ ...s.download, destination })).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
    expect(existsSync(destination)).toBe(false); expect(s.requests.filter(request => request.method === "post")).toHaveLength(1);
  });
  it("does not save a redirected or HTML login response", async () => {
    const s = await setup(); const destination = path.join(s.directory, "login.bin");
    getApiClient().defaults.adapter = async config => ({ config, status: 302, statusText: "Found", headers: { location: "https://outside.example.test" }, data: Buffer.from("login") });
    await expect(downloadFieldJobAttachmentFromUpload({ ...s.download, destination })).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
    expect(existsSync(destination)).toBe(false);
  });
  it("does not overwrite an existing output file", async () => {
    const s = await setup(); const destination = path.join(s.directory, "existing.bin"); writeFileSync(destination, "original", { mode: 0o600 });
    await expect(downloadFieldJobAttachmentFromUpload({ ...s.download, destination })).rejects.toMatchObject({ code: "EEXIST" });
    expect(readFileSync(destination, "utf8")).toBe("original");
  });
  it("does not save bytes when identity changes during the download", async () => {
    const s = await setup(); const destination = path.join(s.directory, "changed-context.bin");
    getApiClient().defaults.adapter = async config => {
      mocks.username = "different-after-download";
      return { config, status: 200, statusText: "OK", headers: { "content-type": "application/octet-stream" }, data: content };
    };
    await expect(downloadFieldJobAttachmentFromUpload({ ...s.download, destination })).rejects.toMatchObject({ code: "CONTEXT_MISMATCH" });
    expect(existsSync(destination)).toBe(false);
  });
});
