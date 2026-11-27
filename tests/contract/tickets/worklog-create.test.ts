// Offline production-adapter tests: no CRM network or real records.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getApiClient, resetApiClient } from "../../../src/api/client.js";
import { CrmTicketBackend } from "../../../src/tickets/backend.js";
import { ContractRegistry } from "../../../src/tickets/contracts.js";
import { TicketActions } from "../../../src/tickets/actions.js";
import { OperationStore } from "../../../src/tickets/operation-store.js";
import { operationSummary } from "../../../src/services/ticket.service.js";
import { TicketError } from "../../../src/tickets/types.js";
import type { TicketPlan } from "../../../src/tickets/types.js";

const mocks = vi.hoisted(() => ({ describe: vi.fn(), query: vi.fn(), refresh: vi.fn() }));
vi.mock("../../../src/auth/manager.js", () => ({ getAuthManager: () => ({
  getToken: async () => "synthetic-token", getApiBaseUrl: () => "https://api.example.test",
  getUsername: () => "synthetic-user", getStatus: () => ({ tenantId: "synthetic-tenant" }), refresh: mocks.refresh,
}) }));
vi.mock("../../../src/services/object.service.js", () => ({ describeObject: mocks.describe, queryObjects: mocks.query }));

const fields = {
  entityType: { type: "string" }, dimDepart: { type: "string" },
  remoteWorkOrders__c: { type: "string" }, engineer__c: { type: "string" },
  timeSheet__c: { type: "number", min: 0.01 }, remark__c: { type: "string" },
  openDate__c: { type: "number" }, endDate__c: { type: "number" },
};
function contract(overrides: Record<string, unknown> = {}) {
  return {
    action: "worklog", verification: "verified", authorization: "server", version: "synthetic-worklog-v1", fieldMode: "action",
    evidence: { source: "synthetic", reference: "worklog metadata/HTTP fixture, not live write evidence", verifiedAt: "2026-11-26T00:00:00+08:00" },
    fields, required: ["timeSheet__c"],
    request: {
      host: "api", method: "POST", path: "/rest/data/v2.0/xobjects/timeSheetDetatils__c", encoding: "json",
      payload: { data: Object.fromEntries(Object.keys(fields).map(key => [key,
        { $ref: `input.${key}`, ...(["entityType", "dimDepart", "remoteWorkOrders__c", "engineer__c"].includes(key) ? { $type: "integer" } : {}) },
      ])) }, successPath: "code", successValues: [200], rejectValues: [400, 403], resultIdPath: "data.id",
    },
    verify: {
      query: { apiKey: "timeSheetDetatils__c", fields: ["remoteWorkOrders__c", "timeSheet__c"], linkField: "id", bind: "result" },
      checks: [{ field: "remoteWorkOrders__c", expected: { $ref: "target.id" } }, { field: "timeSheet__c", expected: { $ref: "input.timeSheet__c" } }],
    }, ...overrides,
  };
}
function metadata() {
  return { code: 200, data: {
    apiKey: "timeSheetDetatils__c", createable: true, disabled: true,
    fields: [
      { apiKey: "name", type: "autonumber", required: true, createable: false, enabled: true, selectitem: [] },
      ...Object.entries(fields).map(([apiKey]) => ({ apiKey,
        type: apiKey === "remoteWorkOrders__c" ? "detail" : apiKey === "entityType" ? "entitytype" : apiKey === "dimDepart" ? "dimension" : apiKey === "engineer__c" ? "reference" : apiKey === "timeSheet__c" ? "float" : apiKey.endsWith("Date__c") ? "date" : "text",
        required: ["entityType", "dimDepart", "remoteWorkOrders__c"].includes(apiKey), createable: true, enabled: true,
        selectitem: [], ...(apiKey === "remark__c" ? { maxLength: 300 } : {}), ...(apiKey === "timeSheet__c" ? { maxLength: 14 } : {}),
      })),
    ],
  } };
}
const input = { entityType: "2", dimDepart: "3", engineer__c: "4", timeSheet__c: 0.25, remark__c: "Synthetic bounded lifecycle test", openDate__c: 1795622400000, endDate__c: 1795622400000 };
const directories: string[] = [];
let childMetadata = metadata();
function setup(overrides: Record<string, unknown> = {}) {
  const registry = new ContractRegistry({ version: 1, actions: [contract(overrides)] }, { allowSynthetic: true });
  const backend = new CrmTicketBackend(registry);
  const directory = mkdtempSync(path.join(os.tmpdir(), "xsy-worklog-create-")); directories.push(directory);
  return { registry, backend, actions: new TicketActions(backend, registry, new OperationStore(directory)) };
}
const confirmation = (plan: TicketPlan) => ({ fingerprint: plan.fingerprint, source: "cli" as const, reference: "explicit offline worklog test authorization" });
async function prepare(actions: TicketActions, data: Record<string, unknown> = input) {
  const result = await actions.prepare({ action: "worklog", id: "1", input: data });
  if (result.status !== "ready") throw new Error("not ready");
  return result.plan;
}
beforeEach(() => {
  for (const key of ["XSY_NEOCRM_PROJECT", "XSY_ACCESS_TOKEN", "XSY_API_BASE_URL"]) vi.stubEnv(key, "");
  resetApiClient(); mocks.refresh.mockReset(); childMetadata = metadata();
  mocks.describe.mockImplementation(async apiKey => apiKey === "timeSheetDetatils__c" ? childMetadata : { code: 200, data: {
    apiKey: "fieldJob", fields: ["id", "status", "customItem62__c", "entityType"].map(apiKey => ({ apiKey, type: "text", enabled: true })),
  } });
  mocks.query.mockImplementation(async (sql: string) => ({ code: 200, result: { count: 1, totalSize: 1, records: sql.includes("timeSheetDetatils__c")
    ? [{ id: "99", remoteWorkOrders__c: "1", timeSheet__c: 0.25 }]
    : [{ id: "1", status: 9, customItem62__c: 3, entityType: "2" }],
  } }));
});
afterEach(() => { resetApiClient(); vi.unstubAllEnvs(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("narrow server-authorized worklog creation", () => {
  it.each([0.16, 0.25, 0.69])("a scoped contract can enforce the observed half-hour rule before dispatch: %s", async (hours) => {
    // Business rules need not be present in object metadata. The current live
    // profile declares its allowed half-hour values; other profiles stay free
    // to use different rules instead of inheriting this tenant's constraint.
    const s = setup({ fields: { ...fields, timeSheet__c: { type: "number", enum: [0.5, 1, 1.5] } } });
    const send = vi.fn(); getApiClient().defaults.adapter = send;
    await expect(prepare(s.actions, { ...input, timeSheet__c: hours })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(send).not.toHaveBeenCalled();
  });
  it("prepares a valid half-hour value under that scoped business rule", async () => {
    const s = setup({ fields: { ...fields, timeSheet__c: { type: "number", enum: [0.5, 1, 1.5] } } });
    expect((await prepare(s.actions, { ...input, timeSheet__c: 0.5 })).input.timeSheet__c).toBe(0.5);
  });
  it("accepts exactly the worklog API and rejects other actions, paths, methods, hosts and encodings", () => {
    expect(setup().registry.get("worklog").authorization).toBe("server");
    for (const override of [
      { action: "close" }, { fieldMode: "create" },
      { request: { ...contract().request, host: "crm" } }, { request: { ...contract().request, method: "PATCH" } },
      { request: { ...contract().request, encoding: "form" } }, { request: { ...contract().request, path: "/rest/data/v2.0/xobjects/other" } },
      { request: { ...contract().request, resultIdPath: undefined } },
      { request: { ...contract().request, payload: { data: { remoteWorkOrders__c: "different-parent" } } } },
    ]) expect(() => setup(override)).toThrow();
  });
  it("preserves unknown permissions, binds the parent, and excludes server-generated required name", async () => {
    const s = setup(); const inspection = await s.backend.inspect(s.registry.get("worklog"), "1", input);
    expect(inspection.permission).toBe("unknown"); expect(inspection.allowed).toBe("unknown");
    expect(inspection.required).toEqual(["dimDepart", "entityType", "remoteWorkOrders__c"]);
    expect(inspection.required).not.toContain("name"); expect(inspection.defaults.remoteWorkOrders__c).toBe("1");
    const plan = await prepare(s.actions);
    expect(plan.payload).toMatchObject({ data: { remoteWorkOrders__c: 1, timeSheet__c: 0.25 } });
    expect(plan.input).not.toHaveProperty("name");
  });
  it("submits once, verifies the created child and parent, and never replays duplicate execution", async () => {
    const s = setup(); const send = vi.fn(async config => ({ config, status: 200, statusText: "OK", headers: {}, data: { code: 200, data: { id: 99 } } }));
    getApiClient().defaults.adapter = send;
    const plan = await prepare(s.actions);
    expect((await s.actions.execute(plan.planId, confirmation(plan))).state).toBe("verified");
    expect((await s.actions.execute(plan.planId, confirmation(plan))).state).toBe("verified");
    expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0][0]).toMatchObject({ xsyReplay: "never", maxRedirects: 0 });
  });
  it("requires the parent record to be readable", async () => {
    mocks.query.mockResolvedValue({ code: 200, result: { records: [], totalSize: 0, count: 0 } });
    const s = setup(); await expect(prepare(s.actions)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("rejects a different parent before any write", async () => {
    const s = setup(); await expect(prepare(s.actions, { ...input, remoteWorkOrders__c: "7" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("does not treat a numeric maxLength as a maximum number of hours", async () => {
    const s = setup(); await expect(prepare(s.actions, { ...input, timeSheet__c: 20 })).resolves.toHaveProperty("fingerprint");
  });
  it("enforces current text length", async () => {
    const s = setup(); await expect(prepare(s.actions, { ...input, remark__c: "x".repeat(301) })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it.each([
    { timeSheet__c: "0.25" }, { timeSheet__c: NaN }, { openDate__c: "2026-11-26" },
    { openDate__c: 1.5 }, { engineer__c: "bad-id" }, { entityType: "2.2" }, { dimDepart: undefined },
  ])("validates field types, IDs and client-required values %j", async change => {
    const s = setup(); await expect(prepare(s.actions, { ...input, ...change })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("blocks object createable=false even when disabled remains ambiguous", async () => {
    childMetadata.data.createable = false;
    const s = setup(); await expect(prepare(s.actions)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("blocks a metadata-denied field", async () => {
    childMetadata.data.fields.find(f => f.apiKey === "remark__c")!.createable = false;
    const s = setup(); await expect(prepare(s.actions)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("prevents execution if worklog constraints changed after prepare", async () => {
    const s = setup(); const send = vi.fn(); getApiClient().defaults.adapter = send;
    const plan = await prepare(s.actions);
    childMetadata.data.fields.find(f => f.apiKey === "remark__c")!.maxLength = 200;
    await expect(s.actions.execute(plan.planId, confirmation(plan))).rejects.toMatchObject({ code: "PLAN_STALE" });
    expect(send).not.toHaveBeenCalled();
  });
  it("treats metadata order as a set, preserving the same stable form hash", async () => {
    const s = setup(); const first = await s.backend.inspect(s.registry.get("worklog"), "1", input);
    childMetadata.data.fields.reverse(); const second = await s.backend.inspect(s.registry.get("worklog"), "1", input);
    expect(second.formVersion).toBe(first.formVersion);
  });
  it("keeps a lost result uncertain and never retries the write", async () => {
    const s = setup(); const send = vi.fn(async () => { throw new Error("synthetic timeout"); }); getApiClient().defaults.adapter = send;
    const plan = await prepare(s.actions);
    expect((await s.actions.execute(plan.planId, confirmation(plan))).state).toBe("outcome_unknown");
    expect((await s.actions.execute(plan.planId, confirmation(plan))).state).toBe("outcome_unknown");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("a successful envelope without the new child ID remains uncertain", async () => {
    const s = setup(); const send = vi.fn(async config => ({ config, status: 200, statusText: "OK", headers: {}, data: { code: 200, data: {} } }));
    getApiClient().defaults.adapter = send;
    const plan = await prepare(s.actions);
    const result = await s.actions.execute(plan.planId, confirmation(plan));
    expect(result.state).toBe("outcome_unknown"); expect(result.submission).toBeUndefined();
    expect(result.errorMessage).toBe("创建已响应但未取得记录 ID");
    expect(result.remoteError).toMatchObject({ httpStatus: 200, serverCode: 200 });
    expect(result.remoteError?.serverMessage).toMatch(/缺少契约要求/);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("filters inactive options without rejecting the currently active value", async () => {
    childMetadata.data.fields.push({ apiKey: "category__c", type: "picklist", required: false, createable: true, enabled: true,
      selectitem: [{ value: 3, isActive: false }, { value: 8, isActive: true }],
    } as never);
    const s = setup({ fields: { ...fields, category__c: { type: "number" } } });
    await expect(prepare(s.actions, { ...input, category__c: 3 })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(prepare(s.actions, { ...input, category__c: 8 })).resolves.toHaveProperty("fingerprint");
  });
  it("keeps unrecognized business codes uncertain while retaining only bounded diagnostics", async () => {
    const s = setup(); const send = vi.fn(async config => ({ config, status: 200, statusText: "OK", headers: {}, data: {
      code: 987654, msg: "synthetic worklog validation failed", Authorization: "Bearer RAW-SECRET", raw: { customer: "RAW-CUSTOMER", cookie: "RAW-COOKIE" },
    } })); getApiClient().defaults.adapter = send;
    const plan = await prepare(s.actions);
    const result = await s.actions.execute(plan.planId, confirmation(plan));
    expect(result.state).toBe("outcome_unknown");
    expect(result.remoteError).toEqual({ httpStatus: 200, serverCode: 987654, serverMessage: "synthetic worklog validation failed" });
    expect(result.errorMessage).toBe("写请求未取得可判定结果，请回查操作状态");
    expect(operationSummary(result)).toMatchObject({ errorMessage: result.errorMessage, remoteError: result.remoteError });
    expect(JSON.stringify(result)).not.toContain("RAW-");
    expect((await s.actions.execute(plan.planId, confirmation(plan))).state).toBe("outcome_unknown");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("redacts authentication text in server messages and rejects object-valued business codes", async () => {
    const s = setup(); getApiClient().defaults.adapter = async config => ({ config, status: 502, statusText: "error", headers: {}, data: {
      code: { accessToken: "RAW-TOKEN" }, msg: "Authorization: Bearer RAW-AUTH cookie=RAW-COOKIE",
    } });
    const plan = await prepare(s.actions); const result = await s.actions.execute(plan.planId, confirmation(plan));
    expect(result.state).toBe("outcome_unknown");
    expect(result.remoteError).toEqual({ httpStatus: 502, serverMessage: "[已隐藏包含认证信息的诊断文本]" });
    expect(JSON.stringify(operationSummary(result))).not.toMatch(/RAW-|Authorization|accessToken/);
  });
  it("whitelists TicketError details rather than persisting arbitrary error fields", async () => {
    const s = setup(); const plan = await prepare(s.actions);
    vi.spyOn(s.backend, "submit").mockRejectedValue(new TicketError("OUTCOME_UNKNOWN", "synthetic diagnostic " + "x".repeat(1000), {
      httpStatus: 200, serverCode: "INVALID_WORKLOG", serverMessage: "reference rejected\n" + "y".repeat(1000),
      rawResponse: { password: "RAW-PASSWORD" }, Authorization: "RAW-AUTH",
    }));
    const result = await s.actions.execute(plan.planId, confirmation(plan));
    expect(result.errorMessage!.length).toBeLessThanOrEqual(512);
    expect(result.remoteError?.serverMessage!.length).toBeLessThanOrEqual(512);
    expect(Object.keys(result.remoteError!)).toEqual(["httpStatus", "serverCode", "serverMessage"]);
    expect(JSON.stringify(operationSummary(result))).not.toMatch(/RAW-|rawResponse|Authorization/);
  });
});
