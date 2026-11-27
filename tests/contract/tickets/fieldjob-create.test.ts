// Offline contract tests exercise the production adapter and execution ledger.
// Axios intercepts all writes; these are not live CRM acceptance tests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getApiClient, resetApiClient } from "../../../src/api/client.js";
import { CrmTicketBackend } from "../../../src/tickets/backend.js";
import { ContractRegistry } from "../../../src/tickets/contracts.js";
import { FIELDJOB_CREATE } from "../../../src/tickets/fieldjob-create.js";
import { TicketActions } from "../../../src/tickets/actions.js";
import { OperationStore } from "../../../src/tickets/operation-store.js";
import type { TicketPlan } from "../../../src/tickets/types.js";

const mocks = vi.hoisted(() => ({ describe: vi.fn(), query: vi.fn(), refresh: vi.fn() }));
vi.mock("../../../src/auth/manager.js", () => ({
  getAuthManager: () => ({
    getToken: async () => "synthetic-token",
    getApiBaseUrl: () => "https://api.example.test",
    getUsername: () => "synthetic-user",
    getStatus: () => ({ tenantId: "synthetic-tenant" }),
    refresh: mocks.refresh,
  }),
}));
vi.mock("../../../src/services/object.service.js", () => ({ describeObject: mocks.describe, queryObjects: mocks.query }));

const input = {
  name: "[CLI-LIFECYCLE-TEST] synthetic", entityType: "2",
  fieldJobPoolGroup: "3", dimDepart: "4", address: "内部测试，无需现场服务",
  status: 1, priority: 8, fieldJobAccountId: "5", responsibleTE__c: "6",
  products__c: 1, productVersion__c: "测试联调", isBug__c: 2,
};
const directories: string[] = [];
function metadata() {
  return {
    code: 200, data: {
      apiKey: "fieldJob", disabled: true, createable: true,
      fields: Object.entries(input).map(([apiKey, value]) => ({
        apiKey, type: ["entityType", "fieldJobPoolGroup", "dimDepart", "fieldJobAccountId", "responsibleTE__c"].includes(apiKey)
          ? "reference" : typeof value === "number" ? "picklist" : "text",
        createable: true, required: FIELDJOB_CREATE.required.includes(apiKey),
        selectitem: apiKey === "priority" ? [{ value: 3, isActive: false }, { value: 8, isActive: true }] : [],
      })).concat([{ apiKey: "id", type: "id", createable: false, required: false, selectitem: [] }]),
    },
  };
}
function setup() {
  const registry = new ContractRegistry({ version: 1, actions: [FIELDJOB_CREATE] });
  const backend = new CrmTicketBackend(registry);
  const dir = mkdtempSync(path.join(os.tmpdir(), "xsy-rest-create-"));
  directories.push(dir);
  return { registry, backend, actions: new TicketActions(backend, registry, new OperationStore(dir)) };
}
async function prepare(actions: TicketActions) {
  const prepared = await actions.prepare({ action: "create", input });
  if (prepared.status !== "ready") throw new Error("not ready");
  return prepared.plan;
}
const confirmation = (plan: TicketPlan) => ({ fingerprint: plan.fingerprint, source: "cli" as const, reference: "explicit synthetic test approval" });
beforeEach(() => {
  vi.stubEnv("XSY_NEOCRM_PROJECT", ""); vi.stubEnv("XSY_ACCESS_TOKEN", "");
  vi.stubEnv("XSY_API_BASE_URL", ""); vi.stubEnv("XSY_TICKET_CONTRACTS", "");
  resetApiClient(); mocks.refresh.mockReset();
  mocks.describe.mockResolvedValue(metadata());
  mocks.query.mockResolvedValue({ code: 200, result: { records: [{ ...input, id: "99" }], count: 1, totalSize: 1 } });
});
afterEach(() => {
  resetApiClient(); vi.unstubAllEnvs();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("fieldJob direct REST creation", () => {
  it("ships creation while leaving lifecycle actions unverified", () => {
    const registry = ContractRegistry.load();
    expect(registry.get("create").authorization).toBe("server");
    expect(registry.get("close").verification).toBe("unverified");
  });
  it("does not let server authorization bypass action probes for transitions", () => {
    for (const change of [{ action: "close" }, { request: { ...FIELDJOB_CREATE.request, host: "crm" } },
      { request: { ...FIELDJOB_CREATE.request, path: "/another/create" } }]) {
      expect(() => new ContractRegistry({ version: 1, actions: [{ ...FIELDJOB_CREATE, ...change }] })).toThrow();
    }
  });
  it("prepares without sending a write or fabricating a permission grant", async () => {
    const { backend, actions } = setup();
    const send = vi.fn(); getApiClient().defaults.adapter = send;
    const inspection = await backend.inspect(FIELDJOB_CREATE, undefined, input);
    expect(inspection.permission).toBe("unknown");
    expect(inspection.allowed).toBe("unknown");
    const plan = await prepare(actions);
    expect(plan.payload).toEqual({ data: input });
    expect(send).not.toHaveBeenCalled();
  });
  it("sends the confirmed request once through API auth, reads back, and deduplicates execution", async () => {
    const { actions } = setup(); const send = vi.fn(async (config) => ({
      config, status: 200, statusText: "OK", headers: {}, data: { code: 200, data: { id: 99 } },
    }));
    getApiClient().defaults.adapter = send;
    mocks.describe.mockClear(); mocks.query.mockClear();
    const plan = await prepare(actions);
    expect(mocks.describe).toHaveBeenCalledTimes(1);
    expect(mocks.query).not.toHaveBeenCalled();
    const result = await actions.execute(plan.planId, confirmation(plan));
    expect(result.state).toBe("verified");
    expect(result.submission?.id).toBe("99");
    const config = send.mock.calls[0][0];
    expect(config.url).toBe("/rest/data/v2.0/xobjects/fieldJob");
    expect(config.baseURL).toBe("https://api.example.test");
    expect(config.xsyReplay).toBe("never"); expect(config.maxRedirects).toBe(0);
    expect(JSON.parse(config.data)).toEqual({ data: input });
    expect(mocks.describe).toHaveBeenCalledTimes(2);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    expect((await actions.execute(plan.planId, confirmation(plan))).state).toBe("verified");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("keeps a lost write response uncertain and never replays it", async () => {
    const { actions } = setup(); const send = vi.fn(async () => { throw new Error("synthetic timeout"); });
    getApiClient().defaults.adapter = send;
    const plan = await prepare(actions);
    expect((await actions.execute(plan.planId, confirmation(plan))).state).toBe("outcome_unknown");
    expect((await actions.execute(plan.planId, confirmation(plan))).state).toBe("outcome_unknown");
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("ignores field/option order changes while preserving the same write constraints", async () => {
    let calls = 0;
    mocks.describe.mockImplementation(async () => {
      const value = metadata();
      const priority = value.data.fields.find((f) => f.apiKey === "priority")!;
      priority.selectitem.push({ value: 7, isActive: true });
      if (++calls % 2 === 0) {
        value.data.fields.reverse(); priority.selectitem.reverse();
      }
      return value;
    });
    const { actions } = setup();
    getApiClient().defaults.adapter = async (config) => ({
      config, status: 200, statusText: "OK", headers: {}, data: { code: 200, data: { id: 99 } },
    });
    const plan = await prepare(actions);
    expect((await actions.execute(plan.planId, confirmation(plan))).state).toBe("verified");
  });
  it("still blocks a genuine option permission change after preparation", async () => {
    const { actions } = setup(); const send = vi.fn(); getApiClient().defaults.adapter = send;
    mocks.describe.mockClear();
    const plan = await prepare(actions);
    expect(mocks.describe).toHaveBeenCalledTimes(1);
    const changed = metadata();
    changed.data.fields.find((f) => f.apiKey === "priority")!.selectitem[1].isActive = false;
    mocks.describe.mockResolvedValue(changed);
    await expect(actions.execute(plan.planId, confirmation(plan))).rejects.toMatchObject({ code: "PLAN_STALE" });
    expect(mocks.describe).toHaveBeenCalledTimes(2);
    expect(send).not.toHaveBeenCalled();
  });
  it("records explicit API rejections and their actionable message without claiming a create", async () => {
    const { actions } = setup(); const send = vi.fn(async (config) => ({
      config, status: 200, statusText: "OK", headers: {}, data: { code: 403, msg: "synthetic create permission denied" },
    })); getApiClient().defaults.adapter = send;
    const plan = await prepare(actions);
    const result = await actions.execute(plan.planId, confirmation(plan));
    expect(result.state).toBe("rejected");
    expect(result.remoteError?.serverMessage).toBe("synthetic create permission denied");
    expect(result.submission).toBeUndefined(); expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("does not call a 500 response a definite rejection", async () => {
    const { actions } = setup(); getApiClient().defaults.adapter = async (config) => ({
      config, status: 500, statusText: "error", headers: {}, data: { code: 500 },
    }); const plan = await prepare(actions);
    expect((await actions.execute(plan.planId, confirmation(plan))).state).toBe("outcome_unknown");
  });
  it("blocks an explicit metadata denial before submitting", async () => {
    const denied = metadata(); denied.data.createable = false; mocks.describe.mockResolvedValue(denied);
    const { actions } = setup();
    await expect(prepare(actions)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it.each([
    { ...input, address: undefined }, { ...input, priority: 3 },
    { ...input, entityType: "invented-id" }, { ...input, status: 11 },
  ])("rejects invalid or incomplete input before any create: %j", async (data) => {
    const { actions } = setup(); const send = vi.fn(); getApiClient().defaults.adapter = send;
    await expect(actions.prepare({ action: "create", input: data })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(send).not.toHaveBeenCalled();
  });
});
