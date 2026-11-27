// 合成传输契约：Axios adapter 截获全部请求，不连接 CRM。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import axios, { AxiosError, type AxiosRequestConfig } from "axios";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getApiClient, resetApiClient } from "../../../src/api/client.js";
import { CrmTicketBackend } from "../../../src/tickets/backend.js";
import { ContractRegistry } from "../../../src/tickets/contracts.js";
import { bindFile } from "../../../src/tickets/actions.js";
import { KNOWN_FIELDS, type TicketPlan } from "../../../src/tickets/types.js";
const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  refresh: vi.fn(),
  query: vi.fn(),
  describe: vi.fn(),
}));
vi.mock("../../../src/auth/manager.js", () => ({
  getAuthManager: () => ({
    getToken: mocks.token,
    refresh: mocks.refresh,
    getApiBaseUrl: () => "https://api.example.test",
    getUsername: () => "synthetic-user",
    getStatus: () => ({ tenantId: "synthetic-tenant" }),
    logout: vi.fn(),
  }),
}));
vi.mock("../../../src/api/crm-client.js", () => ({
  getCrmCookie: () => "synthetic-cookie=not-real",
}));
vi.mock("../../../src/services/object.service.js", () => ({
  queryObjects: mocks.query,
  describeObject: mocks.describe,
}));
function registry(override: Record<string, unknown> = {}) {
  return new ContractRegistry(
    {
      version: 1,
      scope: {
        apiBaseUrl: "https://api.example.test",
        crmBaseUrl: "https://crm.xiaoshouyi.com",
        tenantId: "synthetic-tenant",
      },
      actions: [
        {
          action: "close",
          verification: "verified",
          version: "test-1",
          evidence: {
            source: "synthetic",
            reference: "adapter fixture; not real CRM",
            verifiedAt: "2026-11-24T00:00:00+08:00",
          },
          fields: { reason: { type: "string" } },
          fieldMode: "action",
          defaults: {},
          request: {
            host: "api",
            method: "POST",
            path: "/synthetic/close/:id",
            encoding: "json",
            payload: { reason: { $ref: "input.reason" } },
            successPath: "code",
            successValues: [200],
            rejectValues: [400],
            outputPaths: { eventId: "data.eventId" },
          },
          probe: {
            request: {
              host: "api",
              method: "GET",
              path: "/synthetic/probe/:id",
              encoding: "json",
              successPath: "code",
              successValues: [200],
            },
            permissionPath: "data.permission",
            allowedPath: "data.allowed",
          },
          verify: { checks: [{ field: "status", expected: "Closed" }] },
          ...override,
        },
      ],
    },
    { allowSynthetic: true },
  );
}
function plan(contextKey: string): TicketPlan {
  return {
    planId: "00000000-0000-4000-8000-000000000001",
    operationId: "00000000-0000-4000-8000-000000000001",
    contextKey,
    action: "close",
    targetId: "1",
    contractHash: "test",
    contractVersion: "test-1",
    snapshotHash: "test",
    input: { reason: "synthetic" },
    payload: { reason: "synthetic" },
    effects: [],
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    fingerprint: "test",
    concurrency: "best_effort",
  };
}
const temps: string[] = [];
beforeEach(() => {
  vi.stubEnv("XSY_ACCESS_TOKEN", "");
  vi.stubEnv("XSY_API_BASE_URL", "");
  resetApiClient();
  mocks.token.mockResolvedValue("synthetic-not-a-real-token");
  mocks.refresh.mockReset();
  mocks.describe.mockResolvedValue({
    code: 200,
    data: {
      apiKey: "fieldJob",
      disabled: true,
      fields: KNOWN_FIELDS.map((apiKey) => ({
        apiKey,
        enabled: true,
        type: "String",
        createable: true,
        updateable: true,
      })),
    },
  });
  mocks.query.mockResolvedValue({
    code: 200,
    result: {
      records: [
        {
          id: "1",
          status: "Closed",
          entityType: "2",
          priority: "P1",
          responsibleTE__c: "3",
          customItem62__c: "closed",
        },
      ],
      totalSize: 1,
      count: 1,
    },
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  resetApiClient();
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true });
});
describe("生产适配器的合成传输契约", () => {
  it("同一次读取合并并发元数据请求，业务记录仍每次重新查询", async () => {
    const backend = new CrmTicketBackend(registry());
    mocks.describe.mockClear(); mocks.query.mockClear();
    await backend.withReadScope(async () => {
      const [first, second] = await Promise.all([backend.metadata(), backend.metadata()]);
      expect(second).toBe(first);
      await backend.get("1");
      await backend.get("1");
    });
    expect(mocks.describe).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledTimes(2);
  });
  it("顺序及并发读取作用域独立，无作用域时也不复用旧元数据", async () => {
    const backend = new CrmTicketBackend(registry());
    mocks.describe.mockClear();
    await backend.withReadScope(() => backend.metadata());
    await backend.withReadScope(() => backend.metadata());
    await Promise.all([
      backend.withReadScope(() => backend.metadata()),
      backend.withReadScope(() => backend.metadata()),
    ]);
    await backend.metadata();
    await backend.metadata();
    expect(mocks.describe).toHaveBeenCalledTimes(6);
  });
  it("同一身份刷新令牌后重新读取元数据", async () => {
    const backend = new CrmTicketBackend(registry());
    mocks.describe.mockClear();
    await backend.withReadScope(async () => {
      await backend.metadata();
      mocks.token.mockResolvedValue("synthetic-refreshed-token");
      await backend.metadata();
    });
    expect(mocks.describe).toHaveBeenCalledTimes(2);
  });
  it("元数据请求失败后可以在同一次读取中重试", async () => {
    const backend = new CrmTicketBackend(registry());
    mocks.describe.mockClear();
    mocks.describe.mockRejectedValueOnce(new Error("synthetic metadata failure"));
    await backend.withReadScope(async () => {
      await expect(backend.metadata()).rejects.toThrow("synthetic metadata failure");
      expect((await backend.metadata()).apiKey).toBe("fieldJob");
    });
    expect(mocks.describe).toHaveBeenCalledTimes(2);
  });
  it("单次动作检查复用对象定义，并重新读取动作权限", async () => {
    const r = registry(); const backend = new CrmTicketBackend(r);
    const send = vi.fn(async (config) => ({
      config, status: 200, statusText: "OK", headers: {},
      data: { code: 200, data: { permission: true, allowed: true } },
    }));
    getApiClient().defaults.adapter = send;
    mocks.describe.mockClear(); mocks.query.mockClear();
    await backend.withReadScope(async () => {
      await backend.inspect(r.get("close"), "1", {});
      await backend.inspect(r.get("close"), "1", {});
    });
    expect(mocks.describe).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(2);
  });
  it("发送最终 payload，禁止写入重放与重定向", async () => {
    const r = registry();
    const backend = new CrmTicketBackend(r);
    let captured: AxiosRequestConfig | undefined;
    getApiClient().defaults.adapter = async (config) => {
      captured = config;
      return {
        data: { code: 200, data: { eventId: "9" } },
        status: 200,
        statusText: "OK",
        headers: {},
        config,
      };
    };
    const p = plan((await backend.context()).key);
    const result = await backend.submit(r.get("close"), p);
    expect(captured?.url).toBe("/synthetic/close/1");
    expect(JSON.parse(String(captured?.data))).toEqual(p.payload);
    expect(captured?.xsyReplay).toBe("never");
    expect(captured?.maxRedirects).toBe(0);
    expect(result.output).toEqual({ eventId: "9" });
  });
  it("底层 401 不重发标记的写入或刷新凭据", async () => {
    let requests = 0;
    getApiClient().defaults.adapter = async (config) => {
      requests++;
      throw new AxiosError(
        "synthetic 401",
        "ERR_BAD_REQUEST",
        config,
        undefined,
        {
          data: {},
          status: 401,
          statusText: "Unauthorized",
          headers: {},
          config,
        },
      );
    };
    await expect(
      getApiClient().post("/synthetic/write", {}, { xsyReplay: "never" }),
    ).rejects.toBeInstanceOf(AxiosError);
    expect(requests).toBe(1);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("不识别响应与明确拒绝分别处理", async () => {
    const r = registry();
    const backend = new CrmTicketBackend(r);
    const p = plan((await backend.context()).key);
    getApiClient().defaults.adapter = async (config) => ({
      data: "<html>synthetic login</html>",
      status: 200,
      statusText: "OK",
      headers: {},
      config,
    });
    await expect(backend.submit(r.get("close"), p)).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
    });
    getApiClient().defaults.adapter = async (config) => ({
      data: { code: 400 },
      status: 400,
      statusText: "Bad request",
      headers: {},
      config,
    });
    await expect(backend.submit(r.get("close"), p)).rejects.toMatchObject({
      code: "REMOTE_REJECTED",
    });
  });
  it("表单 JSON 字段按显式契约编码", async () => {
    const r = registry({
      request: {
        host: "api",
        method: "POST",
        path: "/synthetic/form",
        encoding: "form",
        jsonFields: ["record"],
        successPath: "code",
        successValues: [200],
      },
    });
    const backend = new CrmTicketBackend(r);
    let body = "";
    getApiClient().defaults.adapter = async (config) => {
      body = String(config.data);
      return {
        data: { code: 200 },
        status: 200,
        statusText: "OK",
        headers: {},
        config,
      };
    };
    const p = plan((await backend.context()).key);
    p.payload = { record: { reason: "synthetic" } };
    await backend.submit(r.get("close"), p);
    expect(JSON.parse(new URLSearchParams(body).get("record")!)).toEqual({
      reason: "synthetic",
    });
  });
  it("上传发送绑定文件，multipart 不继承 JSON 默认头", async () => {
    const r = registry({
      request: {
        host: "api",
        method: "POST",
        path: "/synthetic/upload",
        encoding: "multipart",
        fileField: "file",
        successPath: "code",
        successValues: [200],
      },
    });
    const backend = new CrmTicketBackend(r);
    let data: unknown;
    let contentType = "";
    getApiClient().defaults.adapter = async (config) => {
      data = config.data;
      contentType = String(config.headers["Content-Type"]);
      return {
        data: { code: 200 },
        status: 200,
        statusText: "OK",
        headers: {},
        config,
      };
    };
    const d = mkdtempSync(path.join(os.tmpdir(), "xsy-upload-test-"));
    temps.push(d);
    const f = path.join(d, "synthetic.txt");
    writeFileSync(f, "synthetic bytes");
    const p = plan((await backend.context()).key);
    p.file = bindFile(f);
    await backend.submit(r.get("close"), p);
    expect(data).toBeInstanceOf(FormData);
    expect(contentType).toContain("multipart/form-data");
    expect(await ((data as FormData).get("file") as Blob).text()).toBe(
      "synthetic bytes",
    );
  });
  it("env Token 不混用本地账号身份", async () => {
    vi.stubEnv("XSY_ACCESS_TOKEN", "another-synthetic-token");
    await expect(
      new CrmTicketBackend(registry()).context(),
    ).rejects.toMatchObject({ code: "IDENTITY_UNVERIFIED" });
  });
  it("env Token 失效不刷新其他账号的存储凭据", async () => {
    vi.stubEnv("XSY_ACCESS_TOKEN", "synthetic-expired-env-token");
    getApiClient().defaults.adapter = async (config) => {
      throw new AxiosError(
        "synthetic 401",
        "ERR_BAD_REQUEST",
        config,
        undefined,
        {
          data: {},
          status: 401,
          statusText: "Unauthorized",
          headers: {},
          config,
        },
      );
    };
    await expect(getApiClient().get("/synthetic/read")).rejects.toMatchObject({
      name: "AuthError",
    });
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("OAuth 身份不自动证明 Cookie 身份", async () => {
    const r = registry({
      request: {
        host: "crm",
        method: "POST",
        path: "/synthetic/action",
        encoding: "json",
        successPath: "code",
        successValues: [200],
      },
    });
    const backend = new CrmTicketBackend(r);
    const adapter = axios.defaults.adapter;
    axios.defaults.adapter = async (config) => ({
      data: { code: 200, data: { permission: true, allowed: true } },
      status: 200,
      statusText: "OK",
      headers: {},
      config,
    });
    try {
      const i = await backend.inspect(r.get("close"), "1", {});
      expect(i.permission).toBe("unknown");
      expect(i.identityVerified).toBe(false);
    } finally {
      axios.defaults.adapter = adapter;
    }
  });
  it("检查不能跨多行拼凑成功", async () => {
    const r = registry({
      verify: {
        query: {
          apiKey: "syntheticHistory",
          fields: ["a", "b"],
          linkField: "ticketId",
        },
        checks: [
          { field: "a", expected: 1 },
          { field: "b", expected: 1 },
        ],
      },
    });
    const backend = new CrmTicketBackend(r);
    mocks.query.mockResolvedValue({
      code: 200,
      result: {
        records: [
          { id: "1", a: 1, b: 0 },
          { id: "2", a: 0, b: 1 },
        ],
        totalSize: 2,
      },
    });
    expect(
      (
        await backend.verify(
          r.get("close"),
          plan((await backend.context()).key),
          { output: {} },
        )
      ).status,
    ).toBe("pending");
  });
  it("主表正确但必要联动缺失时仍 pending", async () => {
    const r = registry({
      verify: {
        checks: [{ field: "status", expected: "Closed" }],
        additional: [
          {
            name: "notification",
            query: {
              apiKey: "syntheticHistory",
              fields: ["event"],
              linkField: "ticketId",
            },
            checks: [{ field: "event", expected: "notified" }],
          },
        ],
      },
    });
    const backend = new CrmTicketBackend(r);
    mocks.query.mockImplementation(async (sql: string) => ({
      code: 200,
      result: {
        records: sql.includes("syntheticHistory")
          ? []
          : [{ id: "1", status: "Closed" }],
        totalSize: sql.includes("syntheticHistory") ? 0 : 1,
      },
    }));
    const result = await backend.verify(
      r.get("close"),
      plan((await backend.context()).key),
      { output: {} },
    );
    expect(result.status).toBe("pending");
    expect(result.checks).toContainEqual({
      field: "notification.event",
      matched: false,
    });
  });
});
