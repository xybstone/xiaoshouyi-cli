// Synthetic responses only: no credential provider or CRM transport is used.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getApiClient, resetApiClient } from "../../../src/api/client.js";
import { CrmTicketBackend } from "../../../src/tickets/backend.js";
import { ContractRegistry } from "../../../src/tickets/contracts.js";
import type { ActionContract } from "../../../src/tickets/types.js";

const mocks = vi.hoisted(() => ({ query: vi.fn(), metadata: vi.fn() }));
vi.mock("../../../src/auth/manager.js", () => ({
  getAuthManager: () => ({
    getToken: async () => "synthetic-token", getStatus: () => ({ tenantId: "test-tenant" }),
    getUsername: () => "test-user", getApiBaseUrl: () => "https://api.example.test",
  }),
}));
vi.mock("../../../src/services/object.service.js", () => ({ queryObjects: mocks.query, describeObject: mocks.metadata }));

beforeEach(() => {
  vi.stubEnv("XSY_ACCESS_TOKEN", ""); vi.stubEnv("XSY_API_BASE_URL", ""); resetApiClient();
  mocks.query.mockResolvedValue({ code: 200, result: { records: [{ id: "1", status: "New" }], totalSize: 1 } });
  mocks.metadata.mockResolvedValue({ code: 200, data: { apiKey: "fieldJob", fields: [{ apiKey: "id" }, { apiKey: "status" }] } });
});
afterEach(() => { vi.unstubAllEnvs(); resetApiClient(); });
function backend() { return new CrmTicketBackend(new ContractRegistry()); }

describe("详情目标与查询计数契约", () => {
  it("服务器忽略ID条件而返回其他工单时拒绝详情", async () => {
    mocks.query.mockResolvedValue({ code: 200, result: { records: [{ id: "2", status: "New" }], totalSize: 1 } });
    await expect(backend().get("1", ["status"])).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it.each([
    { records: [{ id: "1" }, { id: "2" }], totalSize: 2 },
    { records: [{ id: "1" }], totalSize: 2 },
  ])("非唯一详情结果不能通过单条请求验证", async (response) => {
    mocks.query.mockResolvedValue({ code: 200, result: response });
    await expect(backend().get("1", ["id"])).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it("有界查询总数不能小于实际返回行数", async () => {
    mocks.query.mockResolvedValue({ code: 200, result: { records: [{ id: "1" }], totalSize: 0 } });
    await expect(backend().query("synthetic bounded query")).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it("不猜测原始count单位，领域count明确等于实际返回记录数", async () => {
    mocks.query.mockResolvedValue({ code: 200, result: { records: [{ id: "1" }], totalSize: 1, count: 999 } });
    expect((await backend().query("synthetic bounded query")).count).toBe(1);
  });
  it("未找到目标与目标错配分别报告", async () => {
    mocks.query.mockResolvedValue({ code: 200, result: { records: [], totalSize: 0 } });
    await expect(backend().get("1", ["id"])).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("真实适配器的动作探测输出投影", () => {
  it("只投影明确声明的task字段，不携带服务器的其他响应或凭据", async () => {
    getApiClient().defaults.adapter = async (config) => ({
      data: { code: 200, data: { permission: true, allowed: true, taskId: "41", nextTaskDefKey: "close", approver: "7", access_token: "synthetic-not-a-real-secret", privateExtra: "not-declared" } },
      status: 200, statusText: "OK", headers: {}, config,
    });
    const c = {
      preconditionFields: ["status"], defaults: {}, request: { host: "api" },
      probe: {
        request: { host: "api", method: "GET", path: "/synthetic/probe", encoding: "json", successPath: "code", successValues: [200] },
        permissionPath: "data.permission", allowedPath: "data.allowed",
        outputPaths: { taskId: "data.taskId", nextTaskDefKey: "data.nextTaskDefKey" },
      },
    } as ActionContract;
    const inspection = await backend().inspect(c, "1", {});
    expect(inspection.output).toEqual({ taskId: "41", nextTaskDefKey: "close" });
    expect(JSON.stringify(inspection.output)).not.toContain("synthetic-not-a-real-secret");
    expect(inspection.permission).toBe("allowed"); expect(inspection.allowed).toBe("allowed");
  });
});
