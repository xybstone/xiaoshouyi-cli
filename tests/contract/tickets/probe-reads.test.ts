// Focused synthetic HTTP tests: adapters intercept every request, never CRM.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getApiClient, resetApiClient } from "../../../src/api/client.js";
import { CrmTicketBackend } from "../../../src/tickets/backend.js";
import { ContractRegistry, projectProbeOutput } from "../../../src/tickets/contracts.js";

vi.mock("../../../src/auth/manager.js", () => ({
  getAuthManager: () => ({
    getToken: async () => "synthetic-not-real",
    getApiBaseUrl: () => "https://api.example.test",
    getUsername: () => "synthetic-user",
    getStatus: () => ({ tenantId: "synthetic-tenant" }),
  }),
}));
vi.mock("../../../src/api/crm-client.js", () => ({ getCrmCookie: () => "synthetic=not-real" }));
vi.mock("../../../src/services/object.service.js", () => ({
  describeObject: async () => ({ code: 200, data: { apiKey: "fieldJob", fields: [
    { apiKey: "status", type: "int", enabled: true },
  ] } }),
  queryObjects: async () => ({ code: 200, result: {
    records: [{ id: "1", status: 1 }], totalSize: 1, count: 1,
  } }),
}));

const request = (path: string) => ({
  host: "api", method: "POST", path, encoding: "json",
  payload: { data: { dataId: { $ref: "target.id", $type: "integer" } } },
  successPath: "code", successValues: [200, "200"],
});
function registry(probeOverrides: Record<string, unknown> = {}) {
  return new ContractRegistry({
    version: 1,
    scope: { apiBaseUrl: "https://api.example.test", crmBaseUrl: "https://crm.xiaoshouyi.com", tenantId: "synthetic-tenant" },
    actions: [{
      action: "submit", verification: "verified", version: "synthetic-probe-reads",
      evidence: { source: "synthetic", reference: "offline fixture", verifiedAt: "2026-11-26T00:00:00+08:00" },
      request: request("/synthetic/submit"),
      probe: {
        request: request("/synthetic/permission"),
        permissionPath: "data.permission", allowedPath: "data.allowed",
        outputPaths: { taskId: "data.task.id" },
        reads: [{ request: request("/synthetic/chooser"), outputPaths: {
          procdefId: "data.procdefId", nextTaskDefKey: "data.nextTaskDefKey", candidates: "data.candidates",
        } }],
        ...probeOverrides,
      },
      verify: { checks: [{ field: "status", expected: 1 }] },
    }],
  }, { allowSynthetic: true });
}
beforeEach(() => {
  vi.stubEnv("XSY_ACCESS_TOKEN", ""); vi.stubEnv("XSY_API_BASE_URL", ""); vi.stubEnv("XSY_NEOCRM_PROJECT", "");
  resetApiClient();
});
afterEach(() => { resetApiClient(); vi.unstubAllEnvs(); });

describe("动作探测的顺序只读请求", () => {
  it("按序读取并合并冻结业务值，额外请求可使用之前投影，权限只取主探测", async () => {
    const r = registry({ reads: [
      { request: request("/synthetic/chooser"), outputPaths: { procdefId: "data.procdefId", candidates: "data.candidates" } },
      { request: { ...request("/synthetic/next"), payload: { procdefId: { $ref: "probe.procdefId", $type: "integer" } } }, outputPaths: { nextTaskDefKey: "data.nextTaskDefKey" } },
    ] });
    const calls: Array<{ url: string; payload: unknown; replay: unknown }> = [];
    getApiClient().defaults.adapter = async (config) => {
      const index = calls.length;
      calls.push({ url: String(config.url), payload: JSON.parse(String(config.data)), replay: config.xsyReplay });
      const data = [
        { permission: true, allowed: false, task: { id: "12" } },
        { procdefId: "17", candidates: [{ id: "9", name: "synthetic" }], permission: true, allowed: true },
        { nextTaskDefKey: "process" },
      ][index];
      return { status: 200, statusText: "OK", headers: {}, config, data: { code: "200", data } };
    };
    const inspected = await new CrmTicketBackend(r).inspect(r.get("submit"), "1", {});
    expect(calls.map((c) => c.url)).toEqual(["/synthetic/permission", "/synthetic/chooser", "/synthetic/next"]);
    expect(calls.map((c) => c.replay)).toEqual(["read", "read", "read"]);
    expect(calls[0].payload).toEqual({ data: { dataId: 1 } });
    expect(calls[2].payload).toEqual({ procdefId: 17 });
    expect(inspected.output).toEqual({ taskId: "12", procdefId: "17", candidates: [{ id: "9", name: "synthetic" }], nextTaskDefKey: "process" });
    expect(inspected.permission).toBe("allowed"); expect(inspected.allowed).toBe("denied");
  });
  it("附加读取业务失败即停止，不运行后续读取或伪造输出", async () => {
    const r = registry({ reads: [
      { request: request("/synthetic/chooser"), outputPaths: { procdefId: "data.procdefId" } },
      { request: request("/synthetic/never"), outputPaths: { next: "data.next" } },
    ] });
    const urls: string[] = [];
    getApiClient().defaults.adapter = async (config) => {
      urls.push(String(config.url));
      return { status: 200, statusText: "OK", headers: {}, config, data: {
        code: urls.length === 1 ? 200 : 400,
        data: { permission: true, allowed: true },
      } };
    };
    await expect(new CrmTicketBackend(r).inspect(r.get("submit"), "1", {})).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(urls).toEqual(["/synthetic/permission", "/synthetic/chooser"]);
  });
  it("附加 CRM 读取也要求独立的 Cookie 身份核验，未核验时零请求", async () => {
    const r = registry({ reads: [{ request: { ...request("/synthetic/chooser"), host: "crm" }, outputPaths: { procdefId: "data.procdefId" } }] });
    const adapter = vi.fn(); getApiClient().defaults.adapter = adapter;
    const result = await new CrmTicketBackend(r).inspect(r.get("submit"), "1", {});
    expect(result.identityVerified).toBe(false); expect(result.permission).toBe("unknown");
    expect(adapter).not.toHaveBeenCalled();
  });
  it("主输出与附加输出以及不同附加输出不能重名", () => {
    expect(() => registry({ reads: [{ request: request("/synthetic/chooser"), outputPaths: { taskId: "data.task" } }] })).toThrow();
    expect(() => registry({ reads: [
      { request: request("/synthetic/one"), outputPaths: { procdefId: "data.first" } },
      { request: request("/synthetic/two"), outputPaths: { procdefId: "data.second" } },
    ] })).toThrow();
  });
  it("最多允许五个附加读取", () => {
    const reads = Array.from({ length: 5 }, (_, i) => ({ request: request(`/synthetic/${i}`), outputPaths: { [`result${i}`]: "data.value" } }));
    expect(() => registry({ reads })).not.toThrow();
    expect(() => registry({ reads: [...reads, { request: request("/synthetic/extra"), outputPaths: { extra: "data.value" } }] })).toThrow();
  });
  it.each([
    { request: { ...request("/synthetic/chooser"), method: "PATCH" }, outputPaths: { value: "data.value" } },
    { request: { ...request("/synthetic/chooser"), encoding: "multipart" }, outputPaths: { value: "data.value" } },
    { request: request("/synthetic/chooser"), outputPaths: { token: "data.value" } },
    { request: request("/synthetic/chooser"), outputPaths: { value: "data.access_token" } },
  ])("拒绝副作用探测或认证输出 %j", (read) => {
    expect(() => registry({ reads: [read] })).toThrow();
  });
  it("不能通过投影整个候选子树泄露嵌套认证字段", () => {
    expect(() => projectProbeOutput({ data: { candidates: [{ id: "9", accessToken: "synthetic" }] } }, { candidates: "data.candidates" })).toThrow();
    expect(() => projectProbeOutput({ data: { node: { nested: { Cookie: "synthetic" } } } }, { node: "data.node" })).toThrow();
  });
});
