// Real Backend/Actions/Store with synthetic Axios responses. No CRM calls.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getApiClient, resetApiClient } from "../../../src/api/client.js";
import { CrmTicketBackend } from "../../../src/tickets/backend.js";
import { TicketActions } from "../../../src/tickets/actions.js";
import { ContractRegistry } from "../../../src/tickets/contracts.js";
import { OperationStore } from "../../../src/tickets/operation-store.js";
import * as attachments from "../../../src/tickets/fieldjob-attachments.js";
import { KNOWN_FIELDS, TicketError, type TicketPlan } from "../../../src/tickets/types.js";

const mocks = vi.hoisted(() => ({ query: vi.fn(), describe: vi.fn() }));
vi.mock("../../../src/auth/manager.js", () => ({
  getAuthManager: () => ({
    getToken: async () => "synthetic-not-a-live-token", getApiBaseUrl: () => "https://api.example.test",
    getUsername: () => "synthetic-user", getStatus: () => ({ tenantId: "synthetic-tenant" }),
  }),
}));
vi.mock("../../../src/services/object.service.js", () => ({ queryObjects: mocks.query, describeObject: mocks.describe }));

const scope = {
  apiBaseUrl: "https://api.example.test", crmBaseUrl: "https://crm.xiaoshouyi.com",
  tenantId: "synthetic-tenant", subjectId: "synthetic-user",
};
const directories: string[] = [];
beforeEach(() => {
  vi.stubEnv("XSY_ACCESS_TOKEN", ""); vi.stubEnv("XSY_API_BASE_URL", ""); vi.stubEnv("XSY_NEOCRM_PROJECT", "");
  resetApiClient(); mocks.query.mockReset(); mocks.describe.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); resetApiClient();
  directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});
function fixture(options: { uploadCode?: number | string; uploadHttp?: number; linkCode?: number | string; linkHttp?: number; legacyLink?: boolean } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "xsy-attachment-response-recovery-")); directories.push(directory);
  const file = path.join(directory, "synthetic.txt"), bytes = Buffer.from("Synthetic response recovery fixture only.\n");
  writeFileSync(file, bytes, { mode: 0o600 });
  const uploadContract = attachments.createFieldJobAttachmentUploadContract(scope);
  const linkContract = attachments.createFieldJobAttachmentLinkContract(scope);
  if (options.legacyLink) {
    // An explicit historical contract, never the current production factory.
    // This fixture tests acknowledgement recovery, not live v1 write support.
    linkContract.version = "fieldjob-doc-append-page-v1";
    linkContract.evidence = { source: "synthetic", reference: "historical v1 acknowledgement fixture; not masterdetails live evidence", verifiedAt: "2026-11-27T00:00:00+08:00" };
    linkContract.request!.path = "/rest/data/v2.0/xobjects/fieldJob/:id";
    linkContract.request!.payload = { data: { customItem69__c: { $ref: "probe.attachmentValue" } } };
    linkContract.request!.successValues = [200];
  }
  const registry = new ContractRegistry({ version: 1, scope, actions: [uploadContract, linkContract] }, { allowSynthetic: options.legacyLink === true });
  const store = new OperationStore(path.join(directory, "operations"));
  const backend = new CrmTicketBackend(registry, 30000, store), actions = new TicketActions(backend, registry, store);
  const state = { parentValue: null as unknown, posts: 0, patches: 0, requests: [] as string[] };
  const descriptor = { fileName: "synthetic.txt", fileLength: bytes.length, url: "https://api.example.test/file/download/9", fileId: "9" };
  const body = { code: options.uploadCode ?? 200, result: [descriptor] };
  mocks.describe.mockResolvedValue({ code: 200, data: {
    apiKey: "fieldJob", updateable: true,
    fields: KNOWN_FIELDS.map((apiKey) => ({ apiKey, label: apiKey, type: apiKey === "customItem69__c" ? "doc" : "String", enabled: true, createable: true, updateable: true })),
  } });
  mocks.query.mockImplementation(async () => ({ code: 200, result: { records: [{ id: "1", entityType: "2", status: 1, customItem62__c: 1, customItem69__c: state.parentValue }], totalSize: 1, count: 1 } }));
  getApiClient().defaults.adapter = async (config) => {
    state.requests.push(`${config.method} ${config.url}`);
    if (config.method === "post" && config.url === "/rest/file/v2.0/file/batch") {
      state.posts++;
      return { data: body, status: options.uploadHttp ?? 200, statusText: "synthetic", headers: {}, config };
    }
    if (config.method === "patch" && config.url === "/rest/data/v2.0/xobjects/fieldJob/masterdetails" && !options.legacyLink) {
      const payload = JSON.parse(String(config.data));
      expect(String(payload.master.id)).toBe("1");
      expect(typeof payload.master.customItem69__c).toBe("string");
      state.patches++;
      state.parentValue = payload.master.customItem69__c;
      return { data: { code: options.linkCode ?? 200, data: {} }, status: options.linkHttp ?? 200, statusText: "synthetic", headers: {}, config };
    }
    if (config.method === "patch" && config.url === "/rest/data/v2.0/xobjects/fieldJob/1" && options.legacyLink) {
      state.patches++;
      state.parentValue = JSON.parse(String(config.data)).data.customItem69__c;
      return { data: { code: options.linkCode ?? 200, data: {} }, status: options.linkHttp ?? 200, statusText: "synthetic", headers: {}, config };
    }
    throw new Error("Unexpected request: synthetic fixture must not use a real transport");
  };
  return { directory, file, bytes, registry, store, backend, actions, state, body };
}
type Fixture = ReturnType<typeof fixture>;
async function prepare(s: Fixture, action: "attachment_upload" | "attachment_link", uploadOperationId?: string) {
  const prepared = await s.actions.prepare({ action, id: "1", input: action === "attachment_upload" ? { filePath: s.file } : { uploadOperationId } });
  if (prepared.status !== "ready") throw new Error("Expected ready scoped attachment fixture");
  return prepared.plan;
}
const confirm = (plan: TicketPlan) => ({ fingerprint: plan.fingerprint, source: "cli" as const, reference: "explicit synthetic attachment test authorization" });
async function uploaded(s: Fixture) {
  const plan = await prepare(s, "attachment_upload");
  expect((await s.actions.execute(plan.planId, confirm(plan))).state).toBe("verified");
  return plan;
}
function historicalUnknown(s: Fixture, plan: TicketPlan, diagnostic?: { httpStatus: number; serverCode: number | string }) {
  const operation = s.store.read(plan.planId);
  operation.state = "outcome_unknown"; operation.errorCode = "OUTCOME_UNKNOWN";
  delete operation.submission; delete operation.verification;
  if (diagnostic) operation.remoteError = diagnostic;
  else delete operation.remoteError;
  s.store.save(operation);
}

describe("附件上传回执在解析前持久化并只读恢复", () => {
  it.each([["number", 200], ["string", "200"]] as const)("解析器失败后从%s型200业务回执恢复，不再发送POST", async (_kind, code) => {
    const s = fixture({ uploadCode: code }); const plan = await prepare(s, "attachment_upload");
    const parser = vi.spyOn(attachments, "parseFieldJobAttachmentUpload");
    parser.mockImplementationOnce(() => {
      expect(s.store.readResponseEvidence(plan.planId)?.raw).toEqual({ httpStatus: 200, body: s.body });
      throw new TicketError("INVALID_RESPONSE", "Synthetic old decoder rejected a valid server acknowledgement");
    });
    expect((await s.actions.execute(plan.planId, confirm(plan))).state).toBe("outcome_unknown");
    expect(s.state.posts).toBe(1); expect(s.store.read(plan.planId).submission).toBeUndefined();
    parser.mockRestore();
    const recovered = await s.actions.reconcile(plan.planId);
    expect(recovered.state).toBe("verified"); expect(recovered.submission?.output.uploadAcknowledged).toBe(true);
    expect(recovered.submission?.output.attachment).toMatchObject({ fileId: "9", fileName: "synthetic.txt" });
    expect(recovered.recoveryHistory?.at(-1)).toMatchObject({ source: "contract", status: "matched" });
    expect(s.state.posts).toBe(1); expect(s.state.patches).toBe(0);
  });
  it.each([["number", 200], ["string", "200"]] as const)("新的%s型200成功回执可直接完成上传验证", async (_kind, code) => {
    const s = fixture({ uploadCode: code }); const plan = await uploaded(s);
    expect(s.store.readResponseEvidence(plan.planId)?.raw).toEqual({ httpStatus: 200, body: s.body });
    expect(s.state.posts).toBe(1);
  });
  it("旧未知上传即使有HTTP200诊断但没有文件回执也保持unknown，不能补造或重传", async () => {
    const s = fixture(), plan = await prepare(s, "attachment_upload");
    historicalUnknown(s, plan, { httpStatus: 200, serverCode: 200 });
    expect(s.store.readResponseEvidence(plan.planId)).toBeUndefined();
    expect((await s.actions.reconcile(plan.planId)).state).toBe("outcome_unknown");
    expect(s.store.readResponseEvidence(plan.planId)).toBeUndefined(); expect(s.state.posts).toBe(0);
  });
  it("HTTP500的body.code=200不能被恢复成成功，已保存错误回执也不重发", async () => {
    const s = fixture({ uploadHttp: 500, uploadCode: 200 }), plan = await prepare(s, "attachment_upload");
    expect((await s.actions.execute(plan.planId, confirm(plan))).state).toBe("outcome_unknown");
    expect(s.store.readResponseEvidence(plan.planId)?.raw).toEqual({ httpStatus: 500, body: s.body });
    expect((await s.actions.reconcile(plan.planId)).state).toBe("outcome_unknown"); expect(s.state.posts).toBe(1);
  });
});

describe("附件关联确认回执与父字段回读必须分别成立", () => {
  it.each([["number", 200], ["string", "200"]] as const)("关联%s型200成功码不误判unknown，仍回读父字段", async (_kind, code) => {
    const s = fixture({ linkCode: code }), upload = await uploaded(s), link = await prepare(s, "attachment_link", upload.planId);
    const result = await s.actions.execute(link.planId, confirm(link));
    expect(result.state).toBe("verified"); expect(result.verification?.checks).toEqual([{ field: "customItem69__c", matched: true }]);
    expect(s.state.posts).toBe(1); expect(s.state.patches).toBe(1);
    expect(link.contractVersion).toBe("fieldjob-doc-append-masterdetails-page-v2");
    expect(s.state.requests).toContain("patch /rest/data/v2.0/xobjects/fieldJob/masterdetails");
    expect(s.state.requests).not.toContain("patch /rest/data/v2.0/xobjects/fieldJob/1");
    expect(s.store.readResponseEvidence(link.planId)?.raw).toMatchObject({ httpStatus: 200, body: { code } });
  });
  it("同一关联操作已有HTTP ACK证据时可只读恢复，再检查父附件字段", async () => {
    const s = fixture({ linkCode: "200" }), upload = await uploaded(s), link = await prepare(s, "attachment_link", upload.planId);
    await s.actions.execute(link.planId, confirm(link));
    historicalUnknown(s, link);
    const result = await s.actions.reconcile(link.planId);
    expect(result.state).toBe("verified"); expect(s.state.patches).toBe(1); expect(s.state.posts).toBe(1);
  });
  it("明确的历史v1合同账本保留HTTP200/业务ACK，可只读恢复而不冒充当前v2协议", async () => {
    const s = fixture({ legacyLink: true }), upload = await uploaded(s), link = await prepare(s, "attachment_link", upload.planId);
    expect(link.contractVersion).toBe("fieldjob-doc-append-page-v1");
    await s.actions.execute(link.planId, confirm(link));
    unlinkSync(path.join(s.store.directory, `${link.planId}.response.json`));
    historicalUnknown(s, link, { httpStatus: 200, serverCode: "200" });
    const before = readFileSync(path.join(s.store.directory, `${link.planId}.json`), "utf8");
    expect((await s.actions.reconcile(link.planId)).state).toBe("verified");
    expect(s.store.readResponseEvidence(link.planId)).toBeUndefined();
    expect(before).toContain('"serverCode":"200"'); expect(s.state.patches).toBe(1);
  });
  it("只有当前父字段相同，缺少本次HTTP ACK，不能归因或确认关联成功", async () => {
    const s = fixture(), upload = await uploaded(s), link = await prepare(s, "attachment_link", upload.planId);
    s.state.parentValue = link.probeOutput!.attachmentValue;
    historicalUnknown(s, link);
    const result = await s.actions.reconcile(link.planId);
    expect(result.state).toBe("outcome_unknown"); expect(result.submission).toBeUndefined(); expect(s.state.patches).toBe(0);
  });
  it("保存了HTTP200 ACK也不能掩盖父字段缺失或被其他客户端改变", async () => {
    const s = fixture(), upload = await uploaded(s), link = await prepare(s, "attachment_link", upload.planId);
    await s.actions.execute(link.planId, confirm(link)); historicalUnknown(s, link);
    s.state.parentValue = null;
    expect((await s.actions.reconcile(link.planId)).state).toBe("applied_pending_verification"); expect(s.state.patches).toBe(1);
    s.state.parentValue = link.probeOutput!.attachmentValue;
    expect((await s.actions.reconcile(link.planId)).state).toBe("verified"); expect(s.state.patches).toBe(1);
  });
  it("HTTP500即使业务码和当前字段看似成功，关联归因仍保持unknown", async () => {
    const s = fixture({ linkHttp: 500, linkCode: 200 }), upload = await uploaded(s), link = await prepare(s, "attachment_link", upload.planId);
    expect((await s.actions.execute(link.planId, confirm(link))).state).toBe("outcome_unknown");
    expect(s.state.parentValue).toBe(link.probeOutput!.attachmentValue);
    expect((await s.actions.reconcile(link.planId)).state).toBe("outcome_unknown"); expect(s.state.patches).toBe(1);
  });
});
