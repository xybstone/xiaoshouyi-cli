// Offline production-backend contracts: synthetic HTTP and records only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getApiClient, resetApiClient } from "../../../src/api/client.js";
import { CrmTicketBackend } from "../../../src/tickets/backend.js";
import { ContractRegistry } from "../../../src/tickets/contracts.js";
import { TicketActions } from "../../../src/tickets/actions.js";
import { OperationStore } from "../../../src/tickets/operation-store.js";
import { createScopedFieldJobSelfAssignment, FIELDJOB_DISPATCH_PATHS } from "../../../src/tickets/fieldjob-dispatch.js";
import type { RecordData, TicketPlan } from "../../../src/tickets/types.js";

const mocks = vi.hoisted(() => ({ describe: vi.fn(), query: vi.fn(), refresh: vi.fn() }));
vi.mock("../../../src/auth/manager.js", () => ({ getAuthManager: () => ({
  getToken: async () => "synthetic-not-real", getApiBaseUrl: () => "https://crm.xiaoshouyi.com",
  getUsername: () => "4", getStatus: () => ({ tenantId: "synthetic-tenant" }), refresh: mocks.refresh,
}) }));
vi.mock("../../../src/services/object.service.js", () => ({ describeObject: mocks.describe, queryObjects: mocks.query }));

const directories: string[] = [];
let record: RecordData;
let team: RecordData[];
let teamTotal: number | undefined;
const assignedTeam = () => [{ id: "90", fieldJobId: 1, engineerId: 4, teamRole: 1, executionStatus: 1 }];
const accepted = () => ({ status: 0, data: { total: 1, succeed: 1, failedObjects: [] } });
function configuration() {
  return createScopedFieldJobSelfAssignment({
    scope: { apiBaseUrl: "https://crm.xiaoshouyi.com", crmBaseUrl: "https://crm.xiaoshouyi.com", tenantId: "synthetic-tenant", subjectId: "4" },
    fieldJobId: "1", entityType: "2", entityTypeValue: 2, poolId: "3", poolValue: 3,
    actorId: "4", candidateId: "4", candidateIsOnlyReturnedActor: true,
    initialTeamCount: 0, initialTeamComplete: true,
    evidence: { source: "synthetic", reference: "offline self-assignment fixture; no live write evidence", verifiedAt: "2026-11-27T00:00:00+08:00" },
  });
}
function setup() {
  const registry = new ContractRegistry(configuration(), { allowSynthetic: true });
  const directory = mkdtempSync(path.join(os.tmpdir(), "xsy-fieldjob-dispatch-"));
  directories.push(directory);
  const store = new OperationStore(directory);
  const backend = new CrmTicketBackend(registry, 1000, store);
  return { registry, backend, store, actions: new TicketActions(backend, registry, store) };
}
const confirmation = (plan: TicketPlan) => ({ fingerprint: plan.fingerprint, source: "cli" as const, reference: "explicit synthetic dispatch test authorization" });
async function prepare(actions: TicketActions, input: RecordData = {}) {
  const result = await actions.prepare({ action: "assign", id: "1", input });
  if (result.status !== "ready") throw new Error("Synthetic assignment did not prepare");
  return result.plan;
}
function respond(body: unknown = accepted(), apply: () => void = () => {
  record.assigner = 4;
  team = assignedTeam();
}) {
  const send = vi.fn(async (config) => {
    apply();
    return { config, status: 200, statusText: "OK", headers: {}, data: body };
  });
  getApiClient().defaults.adapter = send;
  return send;
}

beforeEach(() => {
  for (const key of ["XSY_NEOCRM_PROJECT", "XSY_ACCESS_TOKEN", "XSY_API_BASE_URL"]) vi.stubEnv(key, "");
  resetApiClient();
  mocks.describe.mockReset(); mocks.query.mockReset(); mocks.refresh.mockReset();
  record = { id: "1", status: 1, customItem62__c: 1, entityType: 2, fieldJobPoolGroup: 3, ownerId: 4, responsibleTE__c: 4, assigner: null, dispatchMethod: 1 };
  team = []; teamTotal = undefined;
  // Real descriptions can omit the implicit system id. Explicit id conditions
  // must still bind the plan to its target rather than fail as an unknown field.
  mocks.describe.mockResolvedValue({ code: 200, data: { apiKey: "fieldJob", disabled: true,
    fields: Object.keys(record).filter(key => key !== "id").map(apiKey => ({ apiKey, type: "int", enabled: true })),
  } });
  mocks.query.mockImplementation(async (sql: string) => {
    const rows = sql.includes("serviceTeam") ? team : [record];
    return { code: 200, result: { records: rows.map(row => ({ ...row })), count: rows.length,
      totalSize: sql.includes("serviceTeam") ? (teamTotal ?? rows.length) : rows.length,
    } };
  });
});
afterEach(() => {
  resetApiClient(); vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("fieldJob self-assignment through the production execution engine", () => {
  it("prepares with implicit id metadata and preserves unknown server permissions", async () => {
    const s = setup(); const send = vi.fn(); getApiClient().defaults.adapter = send;
    const inspection = await s.backend.inspect(s.registry.get("assign"), "1", {});
    expect(inspection).toMatchObject({ permission: "unknown", allowed: "unknown", identityVerified: true,
      formVersion: "fieldjob-empty-team-self-assign-v1", output: { initialTeamCount: 0 } });
    const plan = await prepare(s.actions);
    expect(plan.input).toEqual({ engineerId: "4", keepGroupMember: false });
    expect(plan.targetId).toBe("1");
    expect(plan.payload).toEqual({ fieldJobIdList: [1], serviceTeamList: [{ userId: 4, teamRole: 1, plannedStartTime: null, plannedEndTime: null }], keepGroupMember: false });
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("fieldJobPoolGroup"))).toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it("sends the exact dedicated REST action once and verifies all eight readbacks", async () => {
    const s = setup(); const send = respond(); const plan = await prepare(s.actions);
    const result = await s.actions.execute(plan.planId, confirmation(plan));
    expect(result.state).toBe("verified");
    expect(result.verification?.checks).toHaveLength(8);
    expect(result.verification?.checks.every(check => check.matched)).toBe(true);
    expect((await s.actions.execute(plan.planId, confirmation(plan))).state).toBe("verified");
    expect(send).toHaveBeenCalledTimes(1);
    const request = send.mock.calls[0][0];
    expect(request).toMatchObject({ method: "post", url: FIELDJOB_DISPATCH_PATHS.team, xsyReplay: "never", maxRedirects: 0 });
    expect(JSON.parse(String(request.data))).toEqual(plan.payload);
    expect(s.store.readResponseEvidence(plan.planId)?.raw).toEqual({ httpStatus: 200, body: accepted() });
  });

  it.each(["assigner", "ownerId", "responsibleTE__c", "fieldJobPoolGroup"])("requires the acknowledged parent %s to match before verification", async (field) => {
    const s = setup(); const send = respond(accepted(), () => {
      record.assigner = 4; team = assignedTeam(); record[field] = 8;
    });
    const plan = await prepare(s.actions);
    const result = await s.actions.execute(plan.planId, confirmation(plan));
    expect(result.state).toBe("applied_pending_verification");
    expect(result.verification?.checks.find(check => check.field === field)?.matched).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(["fieldJobId", "engineerId", "teamRole"])("requires the serviceTeam %s to match the submitted assignment", async (field) => {
    const s = setup(); const send = respond(accepted(), () => {
      record.assigner = 4; team = assignedTeam(); team[0][field] = 8;
    });
    const plan = await prepare(s.actions);
    const result = await s.actions.execute(plan.planId, confirmation(plan));
    expect(result.state).toBe("applied_pending_verification");
    expect(result.verification?.checks.find(check => check.field === `serviceTeam.${field}`)?.matched).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not combine different serviceTeam rows into a fabricated match", async () => {
    const s = setup(); const send = respond(accepted(), () => {
      record.assigner = 4;
      team = [{ id: "90", fieldJobId: 1, engineerId: 8, teamRole: 1 }, { id: "91", fieldJobId: 1, engineerId: 4, teamRole: 2 }];
    });
    const plan = await prepare(s.actions);
    const result = await s.actions.execute(plan.planId, confirmation(plan));
    expect(result.verification?.checks.every(check => check.matched)).toBe(true);
    expect(result.verification?.status).toBe("pending");
    expect(result.state).toBe("applied_pending_verification");
    team = assignedTeam();
    expect((await s.actions.reconcile(plan.planId)).state).toBe("verified");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("keeps a successful response pending while no team row is readable, then reconciles with reads only", async () => {
    const s = setup(); const send = respond(accepted(), () => { record.assigner = 4; });
    const plan = await prepare(s.actions);
    expect((await s.actions.execute(plan.planId, confirmation(plan))).state).toBe("applied_pending_verification");
    expect((await s.actions.execute(plan.planId, confirmation(plan))).state).toBe("applied_pending_verification");
    team = assignedTeam();
    expect((await s.actions.reconcile(plan.planId)).state).toBe("verified");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(["prepare", "execute"])("refuses to overwrite a nonempty team during %s", async (phase) => {
    const s = setup(); const send = respond();
    const plan = phase === "execute" ? await prepare(s.actions) : undefined;
    teamTotal = 1; // Count alone must deny even if a filtered page has no rows.
    const action = plan ? s.actions.execute(plan.planId, confirmation(plan)) : prepare(s.actions);
    await expect(action).rejects.toMatchObject({ code: "PLAN_STALE" });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    { engineerId: "8" }, { keepGroupMember: true }, { nextAssignees: ["4"] },
  ])("refuses other engineers, team replacement options and workflow-routing input %j", async (input) => {
    const s = setup(); const send = respond();
    await expect(prepare(s.actions, input)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ["fieldJobPoolGroup", 8], ["ownerId", 8], ["responsibleTE__c", 8], ["assigner", 4], ["status", 2],
  ])("rechecks the bound parent condition %s before sending", async (field, value) => {
    const s = setup(); const send = respond(); const plan = await prepare(s.actions);
    record[field as string] = value;
    await expect(s.actions.execute(plan.planId, confirmation(plan))).rejects.toMatchObject({ code: "ACTION_NOT_ALLOWED" });
    expect(send).not.toHaveBeenCalled();
    expect(s.store.read(plan.planId).state).toBe("prepared");
  });

  it("refuses another parent even when its owner, pool and business type match", async () => {
    const s = setup(); const send = respond(); record.id = "5";
    await expect(s.actions.prepare({ action: "assign", id: "5", input: {} })).rejects.toMatchObject({ code: "ACTION_NOT_ALLOWED" });
    expect(send).not.toHaveBeenCalled();
  });

  it("rejects a different business type and a changed phase before dispatch", async () => {
    const s = setup(); const send = respond(); const plan = await prepare(s.actions);
    record.entityType = 8;
    await expect(s.actions.execute(plan.planId, confirmation(plan))).rejects.toMatchObject({ code: "UNVERIFIED" });
    record.entityType = 2; record.customItem62__c = 2;
    await expect(s.actions.execute(plan.planId, confirmation(plan))).rejects.toMatchObject({ code: "PLAN_STALE" });
    expect(send).not.toHaveBeenCalled();
  });

  it("treats a record-level failure as rejected even if the outer response and eventual fields look successful", async () => {
    const s = setup(); const send = respond({ status: 0, data: { total: 1, succeed: 0, failedObjects: [{ id: 1 }] } });
    const plan = await prepare(s.actions);
    const result = await s.actions.execute(plan.planId, confirmation(plan));
    expect(result).toMatchObject({ state: "rejected", errorCode: "REMOTE_REJECTED" });
    expect(result.verification).toBeUndefined();
    expect((await s.actions.execute(plan.planId, confirmation(plan))).state).toBe("rejected");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 0, data: {} },
    { status: 0, data: { total: 2, succeed: 1, failedObjects: [] } },
    { status: 0, data: { total: 1, succeed: 0, failedObjects: [] } },
  ])("keeps missing or inconsistent per-record acknowledgements uncertain without replay %j", async (body) => {
    const s = setup(); const send = respond(body); const plan = await prepare(s.actions);
    expect((await s.actions.execute(plan.planId, confirmation(plan))).state).toBe("outcome_unknown");
    expect((await s.actions.execute(plan.planId, confirmation(plan))).state).toBe("outcome_unknown");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("never retries a timed out write across duplicate execution, restart or reconciliation", async () => {
    const s = setup();
    const send = vi.fn(async () => { throw Object.assign(new Error("synthetic response timeout"), { code: "ECONNABORTED" }); });
    getApiClient().defaults.adapter = send;
    const plan = await prepare(s.actions);
    expect((await s.actions.execute(plan.planId, confirmation(plan))).state).toBe("outcome_unknown");
    const restarted = new TicketActions(new CrmTicketBackend(s.registry, 1000, s.store), s.registry, s.store);
    expect((await restarted.execute(plan.planId, confirmation(plan))).state).toBe("outcome_unknown");
    expect((await restarted.reconcile(plan.planId)).state).toBe("outcome_unknown");
    expect(send).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("does not allow a workflow next-assignee route to impersonate the dedicated assignment protocol", () => {
    const config = configuration();
    config.actions[0].request = { ...config.actions[0].request!,
      path: "/rest/workflow/v2.0/fieldJob/next", payload: { nextAssignees: [4] },
    };
    expect(() => new ContractRegistry(config, { allowSynthetic: true })).toThrowError();
  });
});
