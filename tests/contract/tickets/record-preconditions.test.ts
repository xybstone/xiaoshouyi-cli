// Synthetic adapters only: prove semantic denial precedes any remote action probe.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getApiClient, resetApiClient } from "../../../src/api/client.js";
import { CrmTicketBackend } from "../../../src/tickets/backend.js";
import { ContractRegistry } from "../../../src/tickets/contracts.js";
import { TicketService } from "../../../src/services/ticket.service.js";
import type { RecordPrecondition } from "../../../src/tickets/types.js";

const mocks = vi.hoisted(() => ({ describe: vi.fn(), query: vi.fn() }));
vi.mock("../../../src/auth/manager.js", () => ({
  getAuthManager: () => ({ getToken: async () => "synthetic-not-real", getApiBaseUrl: () => "https://api.example.test", getUsername: () => "synthetic-user", getStatus: () => ({ tenantId: "synthetic-tenant" }) }),
}));
vi.mock("../../../src/api/crm-client.js", () => ({ getCrmCookie: () => "synthetic=not-real" }));
vi.mock("../../../src/services/object.service.js", () => ({ describeObject: mocks.describe, queryObjects: mocks.query }));

function registry(conditions: RecordPrecondition[] = [{ field: "phase__c", expected: 1 }], overrides: Record<string, unknown> = {}) {
  return new ContractRegistry({ version: 1,
    scope: { apiBaseUrl: "https://api.example.test", crmBaseUrl: "https://crm.xiaoshouyi.com", tenantId: "synthetic-tenant" },
    actions: [{ action: "submit", verification: "verified", version: "synthetic-record-condition-v1",
      evidence: { source: "synthetic", reference: "offline condition contract", verifiedAt: "2026-11-27T00:00:00+08:00" },
      preconditionFields: [], recordPreconditions: conditions,
      request: { host: "api", method: "POST", path: "/synthetic/submit", encoding: "json", successPath: "code", successValues: [200] },
      probe: { request: { host: "api", method: "GET", path: "/synthetic/permission", encoding: "json", successPath: "code", successValues: [200] }, permissionPath: "data.permission", allowedPath: "data.allowed" },
      verify: { checks: [{ field: "status", expected: 1 }] },
      ...overrides,
    }],
  }, { allowSynthetic: true });
}
function metadata(enabled = true) {
  return { code: 200, data: { apiKey: "fieldJob", fields: [
    { apiKey: "status", type: "int", enabled: true },
    { apiKey: "phase__c", type: "int", enabled },
  ] } };
}
beforeEach(() => {
  vi.stubEnv("XSY_ACCESS_TOKEN", ""); vi.stubEnv("XSY_API_BASE_URL", ""); vi.stubEnv("XSY_NEOCRM_PROJECT", ""); vi.stubEnv("XSY_TICKET_WRITES", "1");
  resetApiClient(); vi.clearAllMocks();
  mocks.describe.mockResolvedValue(metadata());
  mocks.query.mockResolvedValue({ code: 200, result: { records: [{ id: "1", status: 1, phase__c: 1 }], totalSize: 1, count: 1 } });
});
afterEach(() => { resetApiClient(); vi.unstubAllEnvs(); });

describe("生产后端的显式记录条件", () => {
  it("能力查询合并多个动作的元数据，下一条命令仍重新读取", async () => {
    const definition = registry().config;
    const r = new ContractRegistry({ ...definition, actions: ["submit", "close", "worklog", "report"].map((action) => ({
      ...definition.actions[0], action,
    })) }, { allowSynthetic: true });
    mocks.query.mockResolvedValue({ code: 200, result: { records: [{ id: "1", status: 1, phase__c: 4 }], totalSize: 1, count: 1 } });
    const adapter = vi.fn(); getApiClient().defaults.adapter = adapter;
    const service = new TicketService(new CrmTicketBackend(r), r);
    await service.capabilities({ id: "1", refresh: true });
    expect(mocks.describe).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledTimes(5);
    await service.capabilities({ id: "1" });
    expect(mocks.describe).toHaveBeenCalledTimes(2);
    expect(mocks.query).toHaveBeenCalledTimes(10);
    expect(adapter).not.toHaveBeenCalled();
  });
  it("条件字段自动加入读取，匹配后才进行真实权限探测", async () => {
    const r = registry(); const calls: string[] = [];
    getApiClient().defaults.adapter = async (config) => { calls.push(String(config.url)); return { status: 200, statusText: "OK", headers: {}, config, data: { code: 200, data: { permission: true, allowed: true } } }; };
    const inspected = await new CrmTicketBackend(r).inspect(r.get("submit"), "1", {});
    expect(mocks.describe).toHaveBeenCalledTimes(1);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("phase__c"))).toBe(true);
    expect(calls).toEqual(["/synthetic/permission"]);
    expect(inspected).toMatchObject({ permission: "allowed", allowed: "allowed", identityVerified: true });
  });
  it("已关闭记录即便服务器可能返回submit=true，也直接denied且权限保留unknown", async () => {
    const r = registry(); mocks.query.mockResolvedValue({ code: 200, result: { records: [{ id: "1", status: 1, phase__c: 4 }], totalSize: 1, count: 1 } });
    const adapter = vi.fn(); getApiClient().defaults.adapter = adapter;
    const inspected = await new CrmTicketBackend(r).inspect(r.get("submit"), "1", {});
    expect(inspected).toMatchObject({ permission: "unknown", allowed: "denied", identityVerified: true });
    expect(adapter).not.toHaveBeenCalled();
    const capabilities = await new TicketService(new CrmTicketBackend(r), r).capabilities({ id: "1" });
    expect(capabilities.actions.find((action) => action.action === "submit")).toMatchObject({ permission: "unknown", recordAction: "denied", executable: false });
  });
  it.each(["absent", "disabled"])("条件字段%s时明确UNVERIFIED，不能悄悄过滤后继续", async (mode) => {
    const r = registry();
    mocks.describe.mockResolvedValue(mode === "disabled" ? metadata(false) : { code: 200, data: { apiKey: "fieldJob", fields: [{ apiKey: "status", type: "int", enabled: true }] } });
    const adapter = vi.fn(); getApiClient().defaults.adapter = adapter;
    await expect(new CrmTicketBackend(r).inspect(r.get("submit"), "1", {})).rejects.toMatchObject({ code: "UNVERIFIED" });
    expect(mocks.query).not.toHaveBeenCalled(); expect(adapter).not.toHaveBeenCalled();
  });
  it("记录缺字段不会被当成期望null，仍明确denied", async () => {
    const r = registry([{ field: "phase__c", expected: null }]);
    mocks.query.mockResolvedValue({ code: 200, result: { records: [{ id: "1", status: 1 }], totalSize: 1, count: 1 } });
    const adapter = vi.fn(); getApiClient().defaults.adapter = adapter;
    expect(await new CrmTicketBackend(r).inspect(r.get("submit"), "1", {})).toMatchObject({ permission: "unknown", allowed: "denied" });
    expect(adapter).not.toHaveBeenCalled();
  });
  it("未核验业务类型在权限探测前UNVERIFIED，能力报告不可误报可执行", async () => {
    const r = registry(undefined, { entityTypes: ["2"] });
    const description = metadata();
    description.data.fields.push({ apiKey: "entityType", type: "entitytype", enabled: true });
    mocks.describe.mockResolvedValue(description);
    mocks.query.mockResolvedValue({ code: 200, result: { records: [{ id: "1", entityType: "3", status: 1, phase__c: 1 }], totalSize: 1, count: 1 } });
    const adapter = vi.fn(); getApiClient().defaults.adapter = adapter;
    await expect(new CrmTicketBackend(r).inspect(r.get("submit"), "1", {})).rejects.toMatchObject({ code: "UNVERIFIED" });
    const capabilities = await new TicketService(new CrmTicketBackend(r), r).capabilities({ id: "1" });
    expect(capabilities.actions.find((action) => action.action === "submit")).toMatchObject({ executable: false, reason: "UNVERIFIED" });
    expect(adapter).not.toHaveBeenCalled();
  });
});
