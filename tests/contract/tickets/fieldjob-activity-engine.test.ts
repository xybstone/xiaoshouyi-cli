// Production backend/Actions/Store with an offline stateful HTTP adapter. No CRM calls.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getApiClient, resetApiClient } from "../../../src/api/client.js";
import { CrmTicketBackend } from "../../../src/tickets/backend.js";
import { ContractRegistry } from "../../../src/tickets/contracts.js";
import { TicketActions } from "../../../src/tickets/actions.js";
import { OperationStore } from "../../../src/tickets/operation-store.js";
import { fieldJobActivityRecordContract } from "../../../src/tickets/fieldjob-history.js";
import type { RecordData, TicketPlan } from "../../../src/tickets/types.js";

const mocks = vi.hoisted(() => ({ describe: vi.fn(), query: vi.fn(), refresh: vi.fn() }));
vi.mock("../../../src/auth/manager.js", () => ({ getAuthManager: () => ({
  getToken: async () => "synthetic-token", getApiBaseUrl: () => "https://api.example.test",
  getUsername: () => "3", getStatus: () => ({ tenantId: "synthetic-tenant" }), refresh: mocks.refresh,
}) }));
vi.mock("../../../src/services/object.service.js", () => ({ describeObject: mocks.describe, queryObjects: mocks.query }));
const scope = { apiBaseUrl: "https://api.example.test", crmBaseUrl: "https://crm.xiaoshouyi.com", tenantId: "synthetic-tenant", subjectId: "3" };
const input = { content: "Synthetic independent CRM activity", dimDepart: "6", startTime: 1795737600000 };
const evidence = { source: "synthetic" as const, reference: "offline real-adapter activity fixture, not live CRM acceptance", verifiedAt: "2026-11-27T00:00:00+08:00" };
function contract() { return fieldJobActivityRecordContract({ parentObjectId: "10", entityType: "4", activeEntityTypes: ["4"], evidence }); }
function metadata() {
  const fields = [
    { apiKey: "content", type: "textarea", minLength: 0, maxLength: 131070, required: true },
    { apiKey: "dimDepart", type: "dimension", referTo: { apiKey: "department" }, required: true },
    { apiKey: "entityType", type: "entitytype", required: true }, { apiKey: "startTime", type: "datetime", required: true },
    { apiKey: "ownerId", type: "owner", referTo: { apiKey: "user" } },
    { apiKey: "activityRecordFrom", type: "reference", referTo: { apiKey: "xobject" } },
    { apiKey: "activityRecordFrom_data", type: "reference" },
  ].map((f) => ({ enabled: true, createable: true, ...f }));
  return { code: 200, data: { apiKey: "activityrecord", createable: true, disabled: true,
    fields: [...fields, { apiKey: "createdAt", type: "datetime", required: true, enabled: true, createable: false }] } };
}
const directories: string[] = [];
let childMetadata = metadata();
let created: RecordData | undefined;
function setup() {
  const registry = new ContractRegistry({ version: 1, scope, actions: [contract()] }, { allowSynthetic: true });
  const directory = mkdtempSync(path.join(os.tmpdir(), "xsy-activity-engine-")); directories.push(directory);
  const store = new OperationStore(directory), backend = new CrmTicketBackend(registry);
  return { registry, backend, store, actions: new TicketActions(backend, registry, store) };
}
async function prepare(actions: TicketActions, data: RecordData = input) {
  const result = await actions.prepare({ action: "activity_record", id: "1", input: data });
  if (result.status !== "ready") throw new Error("expected ready activity plan");
  return result.plan;
}
const confirmation = (plan: TicketPlan) => ({ fingerprint: plan.fingerprint, source: "cli" as const, reference: "explicit offline synthetic activity authorization" });
function adapter(mutate?: (row: RecordData) => void) {
  const send = vi.fn(async config => {
    expect(config.url).toBe("/rest/data/v2.0/xobjects/activityrecord");
    expect(config.method).toBe("post");
    created = { id: 99, ...JSON.parse(config.data).data, createdAt: input.startTime };
    mutate?.(created);
    return { config, status: 200, statusText: "OK", headers: {}, data: { code: "200", data: { id: 99 } } };
  });
  getApiClient().defaults.adapter = send;
  return send;
}
beforeEach(() => {
  for (const key of ["XSY_NEOCRM_PROJECT", "XSY_ACCESS_TOKEN", "XSY_API_BASE_URL"]) vi.stubEnv(key, "");
  resetApiClient(); mocks.refresh.mockReset(); childMetadata = metadata(); created = undefined;
  mocks.describe.mockImplementation(async (key: string) => key === "activityrecord" ? childMetadata : { code: 200, data: {
    apiKey: "fieldJob", fields: ["id", "status", "customItem62__c", "entityType", "ownerId"].map(apiKey => ({ apiKey, type: "text", enabled: true })),
  } });
  mocks.query.mockImplementation(async (sql: string) => {
    const rows = sql.includes(" from activityrecord ")
      ? created && sql.includes("id = '99'") ? [{ ...created }] : []
      : [{ id: "1", status: 1, customItem62__c: 1, entityType: 7, ownerId: 3 }];
    return { code: 200, result: { records: rows, totalSize: rows.length, count: rows.length } };
  });
});
afterEach(() => { resetApiClient(); vi.unstubAllEnvs(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("independent CRM activity through production execution engine", () => {
  it("keeps permission unknown, pins own user and polymorphic parent, and omits generated fields", async () => {
    const s = setup();
    const inspection = await s.backend.inspect(s.registry.get("activity_record"), "1", input);
    expect(inspection).toMatchObject({ permission: "unknown", allowed: "unknown", identityVerified: true });
    expect(inspection.required).toEqual(["content", "dimDepart", "entityType", "startTime"]);
    const plan = await prepare(s.actions);
    expect(plan.payload).toEqual({ data: { ...input, dimDepart: 6, entityType: 4, ownerId: 3, activityRecordFrom: 10, activityRecordFrom_data: 1 } });
    expect(plan.payload).not.toHaveProperty("data.createdAt");
    expect(plan.payload).not.toHaveProperty("data.name");
  });
  it("creates exactly once and verifies ID, content, own publisher, timestamps and both parent fields", async () => {
    const s = setup(), send = adapter(); const plan = await prepare(s.actions);
    const result = await s.actions.execute(plan.planId, confirmation(plan));
    expect(result.state).toBe("verified");
    expect(result.verification?.checks.every(c => c.matched)).toBe(true);
    expect(s.store.read(plan.planId).state).toBe("verified");
    expect((await s.actions.execute(plan.planId, confirmation(plan))).state).toBe("verified");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ xsyReplay: "never", maxRedirects: 0 });
  });
  it.each([
    { content: undefined }, { dimDepart: undefined }, { startTime: undefined },
    { startTime: 1.5 }, { startTime: -1 }, { startTime: "2026-11-27" },
    { dimDepart: "wrong-department" }, { entityType: "5" },
    { ownerId: "9" }, { name: "forbidden-generated-title" }, { createdAt: input.startTime }, { visibility: "public" },
  ])("rejects required/type/binding/unknown input errors before dispatch %#", async change => {
    const s = setup(), send = adapter();
    await expect(prepare(s.actions, { ...input, ...change })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects dynamically readonly metadata or a new mandatory field before sending", async () => {
    const s = setup(), send = adapter();
    childMetadata.data.fields.find(f => f.apiKey === "content")!.createable = false;
    await expect(prepare(s.actions)).rejects.toMatchObject({ code: "UNVERIFIED" });
    childMetadata = metadata();
    childMetadata.data.fields.push({ apiKey: "unexpected", type: "text", enabled: true, createable: true, required: true });
    await expect(prepare(s.actions)).rejects.toMatchObject({ code: "UNVERIFIED" });
    expect(send).not.toHaveBeenCalled();
  });
  it("checks current text limits and rejects changes after confirmation", async () => {
    const s = setup(), send = adapter();
    const plan = await prepare(s.actions);
    childMetadata.data.fields.find(f => f.apiKey === "content")!.maxLength = 10;
    await expect(s.actions.execute(plan.planId, confirmation(plan))).rejects.toMatchObject({ code: "PLAN_STALE" });
    await expect(prepare(s.actions)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(send).not.toHaveBeenCalled();
  });
  it("metadata array order alone does not invalidate the plan", async () => {
    const s = setup(), send = adapter(); const plan = await prepare(s.actions);
    childMetadata.data.fields.reverse();
    expect((await s.actions.execute(plan.planId, confirmation(plan))).state).toBe("verified");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it.each([
    { activityRecordFrom: 11 }, { activityRecordFrom_data: 9 }, { ownerId: 9 }, { content: "wrong activity" },
  ])("keeps verification pending when an acknowledged row has a foreign parent/publisher/content %#", async changed => {
    const s = setup(), send = adapter(row => Object.assign(row, changed)); const plan = await prepare(s.actions);
    const result = await s.actions.execute(plan.planId, confirmation(plan));
    expect(result.state).toBe("applied_pending_verification");
    expect(result.verification?.checks.some(c => !c.matched)).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("requires a readable parent record before preparing a child", async () => {
    const s = setup(), send = adapter(); mocks.query.mockResolvedValue({ code: 200, result: { records: [], totalSize: 0, count: 0 } });
    await expect(prepare(s.actions)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(send).not.toHaveBeenCalled();
  });
  it("lost response and 401 never refresh or resend this write", async () => {
    const s = setup(); const send = vi.fn(async config => { throw Object.assign(new Error("synthetic lost response"), { config, response: { status: 401 } }); });
    getApiClient().defaults.adapter = send;
    const plan = await prepare(s.actions);
    expect((await s.actions.execute(plan.planId, confirmation(plan))).state).toBe("outcome_unknown");
    expect((await s.actions.execute(plan.planId, confirmation(plan))).state).toBe("outcome_unknown");
    expect(send).toHaveBeenCalledTimes(1); expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("a success envelope without the new activity ID stays uncertain", async () => {
    const s = setup(); const send = vi.fn(async config => ({ config, status: 200, statusText: "OK", headers: {}, data: { code: 200, data: {} } }));
    getApiClient().defaults.adapter = send; const plan = await prepare(s.actions);
    const result = await s.actions.execute(plan.planId, confirmation(plan));
    expect(result.state).toBe("outcome_unknown"); expect(result.submission).toBeUndefined();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
