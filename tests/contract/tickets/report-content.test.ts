// Offline tests: only the adapter and local ledger run; no CRM writes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getApiClient, resetApiClient } from "../../../src/api/client.js";
import { CrmTicketBackend } from "../../../src/tickets/backend.js";
import { ContractRegistry } from "../../../src/tickets/contracts.js";
import { TicketActions } from "../../../src/tickets/actions.js";
import { OperationStore } from "../../../src/tickets/operation-store.js";
import { guardObjectWrite } from "../../../src/tickets/guard.js";
import type { TicketPlan } from "../../../src/tickets/types.js";

const mocks = vi.hoisted(() => ({ describe: vi.fn(), query: vi.fn(), refresh: vi.fn() }));
vi.mock("../../../src/auth/manager.js", () => ({ getAuthManager: () => ({
  getToken: async () => "synthetic-token", getApiBaseUrl: () => "https://api.example.test",
  getUsername: () => "synthetic-user", getStatus: () => ({ tenantId: "synthetic-tenant" }), refresh: mocks.refresh,
}) }));
vi.mock("../../../src/services/object.service.js", () => ({ describeObject: mocks.describe, queryObjects: mocks.query }));

const scope = { apiBaseUrl: "https://api.example.test", crmBaseUrl: "https://crm.xiaoshouyi.com", tenantId: "synthetic-tenant" };
const input = { problemReason__c: 1, reportText__c: "Synthetic internal lifecycle verification report" };
function contract(keys = Object.keys(input), overrides: Record<string, unknown> = {}) {
  const rules = { problemReason__c: { type: "number" }, reportText__c: { type: "string", min: 1, max: 500 } };
  return {
    action: "report", verification: "verified", authorization: "server", version: "synthetic-report-v1", fieldMode: "update",
    evidence: { source: "synthetic", reference: "read-only field metadata and content PATCH fixture, not live acceptance", verifiedAt: "2026-11-26T00:00:00+08:00" },
    fields: Object.fromEntries(keys.map(key => [key, rules[key as keyof typeof rules]])), required: keys,
    preconditionFields: ["status", "customItem62__c", "entityType", "ownerId", ...keys],
    request: { host: "api", method: "PATCH", path: "/rest/data/v2.0/xobjects/fieldJob/:id", encoding: "json",
      payload: { data: Object.fromEntries(keys.map(key => [key, { $ref: `input.${key}` }])) },
      successPath: "code", successValues: [200], rejectValues: [400, 403],
    },
    verify: { checks: keys.map(field => ({ field, expected: { $ref: `input.${field}` } })) },
    ...overrides,
  };
}
function metadata() {
  return { code: 200, data: { apiKey: "fieldJob", updateable: true, disabled: true, fields: [
    ...["id", "status", "customItem62__c", "entityType", "ownerId"].map(apiKey => ({ apiKey, type: "text", enabled: true, createable: false, updateable: false, selectitem: [] })),
    { apiKey: "problemReason__c", type: "picklist", enabled: true, createable: true, updateable: true,
      selectitem: [{ value: 1, isActive: true }, { value: 2, isActive: false }],
    },
    { apiKey: "reportText__c", type: "textarea", enabled: true, createable: true, updateable: true, selectitem: [] },
  ] } };
}
const directories: string[] = [];
let rawMetadata = metadata();
let record: Record<string, unknown>;
function setup(action = contract()) {
  const registry = new ContractRegistry({ version: 1, scope, actions: [action] }, { allowSynthetic: true });
  const backend = new CrmTicketBackend(registry);
  const directory = mkdtempSync(path.join(os.tmpdir(), "xsy-report-content-")); directories.push(directory);
  return { registry, backend, actions: new TicketActions(backend, registry, new OperationStore(directory)) };
}
async function prepare(actions: TicketActions, data: Record<string, unknown> = input) {
  const result = await actions.prepare({ action: "report", id: "1", input: data });
  if (result.status !== "ready") throw new Error("not ready");
  return result.plan;
}
const confirmation = (plan: TicketPlan) => ({ fingerprint: plan.fingerprint, source: "cli" as const, reference: "explicit offline report authorization" });
beforeEach(() => {
  for (const key of ["XSY_NEOCRM_PROJECT", "XSY_ACCESS_TOKEN", "XSY_API_BASE_URL"]) vi.stubEnv(key, "");
  resetApiClient(); mocks.refresh.mockReset(); rawMetadata = metadata();
  record = { id: "1", status: 3, customItem62__c: 3, entityType: "2", ownerId: "3", problemReason__c: null, reportText__c: "old report" };
  mocks.describe.mockImplementation(async () => rawMetadata);
  mocks.query.mockImplementation(async () => ({ code: 200, result: { count: 1, totalSize: 1, records: [{ ...record }] } }));
});
afterEach(() => { resetApiClient(); vi.unstubAllEnvs(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("strict server-authorized report content update", () => {
  it("requires scope, evidence, verification, field-matched input and old-value preconditions", () => {
    expect(setup().registry.get("report").fieldMode).toBe("update");
    expect(() => new ContractRegistry({ version: 1, actions: [contract()] }, { allowSynthetic: true })).toThrow();
    for (const overrides of [
      { evidence: undefined }, { verify: undefined }, { preconditionFields: ["status"] },
      { verify: { checks: [{ field: "id", expected: "1" }] } },
      { fields: { ...contract().fields, status: { type: "number" } } },
    ]) expect(() => setup(contract(undefined, overrides))).toThrow();
  });
  it.each(["status", "customItem62__c", "ownerId", "entityType", "name", "description"])("rejects payload field %s", key => {
    const action = contract();
    action.request.payload = { data: { [key]: { $ref: `input.${key}` } } };
    expect(() => setup(action)).toThrow();
  });
  it("rejects whole-input templates, fixed values, mismatched refs, extra envelopes and empty updates", () => {
    for (const payload of [
      { data: { $ref: "input" } }, { data: { reportText__c: "fixed content" } },
      { data: { reportText__c: { $ref: "input.problemReason__c" } } },
      { data: { reportText__c: { $ref: "input.reportText__c", $type: "integer" } } },
      { data: {}, extra: true }, { data: {} },
    ]) expect(() => setup(contract(undefined, { request: { ...contract().request, payload } }))).toThrow();
  });
  it("cannot masquerade as a lifecycle action or use a different host, method, mode or path", () => {
    for (const overrides of [
      { action: "close" }, { fieldMode: "action" },
      { request: { ...contract().request, method: "POST" } },
      { request: { ...contract().request, host: "crm" } },
      { request: { ...contract().request, path: "/rest/data/v2.0/xobjects/fieldJob/1" } },
      { request: { ...contract().request, path: "/rest/data/v2.0/xobjects/fieldJob/:id/close" } },
    ]) expect(() => setup(contract(undefined, overrides))).toThrow();
  });
  it("keeps permission and allowed unknown and requires a readable parent", async () => {
    const s = setup(); const inspection = await s.backend.inspect(s.registry.get("report"), "1", input);
    expect(inspection.permission).toBe("unknown"); expect(inspection.allowed).toBe("unknown");
    expect((await prepare(s.actions)).payload).toEqual({ data: input });
    mocks.query.mockResolvedValue({ code: 200, result: { records: [], totalSize: 0, count: 0 } });
    await expect(prepare(s.actions)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("updates only content through confirmed execution, verifies it, and does not require a new record ID", async () => {
    const s = setup(); const send = vi.fn(async config => {
      const data = JSON.parse(config.data).data; Object.assign(record, data);
      return { config, status: 200, statusText: "OK", headers: {}, data: { code: 200, data: {} } };
    }); getApiClient().defaults.adapter = send;
    const plan = await prepare(s.actions);
    expect((await s.actions.execute(plan.planId, confirmation(plan))).state).toBe("verified");
    expect(record).toMatchObject({ ...input, status: 3, customItem62__c: 3, ownerId: "3", entityType: "2" });
    expect(send.mock.calls[0][0]).toMatchObject({ method: "patch", url: "/rest/data/v2.0/xobjects/fieldJob/1", xsyReplay: "never", maxRedirects: 0 });
    expect((await s.actions.execute(plan.planId, confirmation(plan))).state).toBe("verified");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("supports a single allowed field when its precondition and readback are declared", async () => {
    const s = setup(contract(["reportText__c"]));
    const plan = await prepare(s.actions, { reportText__c: "new report" });
    expect(plan.payload).toEqual({ data: { reportText__c: "new report" } });
  });
  it("rejects explicit object or field update denial", async () => {
    const s = setup(); rawMetadata.data.updateable = false;
    await expect(prepare(s.actions)).rejects.toMatchObject({ code: "FORBIDDEN" });
    rawMetadata.data.updateable = true; rawMetadata.data.fields.find(field => field.apiKey === "reportText__c")!.updateable = false;
    await expect(prepare(s.actions)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("rejects inactive problem reasons and undeclared status input", async () => {
    const s = setup();
    await expect(prepare(s.actions, { ...input, problemReason__c: 2 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(prepare(s.actions, { ...input, status: 11 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("does not overwrite a report changed after prepare", async () => {
    const s = setup(); const send = vi.fn(); getApiClient().defaults.adapter = send;
    const plan = await prepare(s.actions); record.reportText__c = "someone else's newer report";
    await expect(s.actions.execute(plan.planId, confirmation(plan))).rejects.toMatchObject({ code: "PLAN_STALE" });
    expect(send).not.toHaveBeenCalled();
  });
  it("retains uncertain diagnostics and does not replay a failed response", async () => {
    const s = setup(); const send = vi.fn(async config => ({ config, status: 200, statusText: "OK", headers: {}, data: { code: 1607103, msg: "synthetic report content rejected" } }));
    getApiClient().defaults.adapter = send; const plan = await prepare(s.actions);
    const result = await s.actions.execute(plan.planId, confirmation(plan));
    expect(result.state).toBe("outcome_unknown"); expect(result.remoteError?.serverCode).toBe(1607103);
    await s.actions.execute(plan.planId, confirmation(plan)); expect(send).toHaveBeenCalledTimes(1);
  });
  it("leaves generic fieldJob CRUD protection in force", () => {
    expect(() => guardObjectWrite("fieldJob")).toThrow(/prepare\/execute/);
  });
});
