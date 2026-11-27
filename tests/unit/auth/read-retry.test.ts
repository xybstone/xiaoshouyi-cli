import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AxiosError } from "axios";
const mocks = vi.hoisted(() => ({ token: vi.fn(), refresh: vi.fn(), logout: vi.fn() }));
vi.mock("../../../src/auth/manager.js", () => ({
  getAuthManager: () => ({ getToken: mocks.token, refresh: mocks.refresh, logout: mocks.logout, getApiBaseUrl: () => "https://api.example.test" }),
}));
import { getApiClient, resetApiClient } from "../../../src/api/client.js";

beforeEach(() => {
  vi.stubEnv("XSY_ACCESS_TOKEN", ""); vi.stubEnv("XSY_API_BASE_URL", "");
  resetApiClient(); mocks.token.mockReset().mockResolvedValue("synthetic-token-one");
  mocks.refresh.mockReset().mockImplementation(async () => { mocks.token.mockResolvedValue("synthetic-token-two"); });
  mocks.logout.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); resetApiClient(); });

describe("只读401续接与写入禁重放", () => {
  it("GET401只刷新并重试一次，传入被拒绝的Token代际", async () => {
    const calls: string[] = [];
    getApiClient().defaults.adapter = async config => {
      calls.push(String(config.headers.Authorization));
      if (calls.length === 1) throw new AxiosError("synthetic", "ERR_BAD_REQUEST", config, undefined, { status: 401, statusText: "Unauthorized", data: {}, headers: {}, config });
      return { status: 200, statusText: "OK", data: {}, headers: {}, config };
    };
    await getApiClient().get("/synthetic/read");
    expect(calls).toEqual(["Bearer synthetic-token-one", "Bearer synthetic-token-two"]);
    expect(mocks.refresh).toHaveBeenCalledWith("synthetic-token-one");
  });
  it("读取契约validateStatus放行401时仍只刷新一次", async () => {
    let attempts = 0;
    getApiClient().defaults.adapter = async config => ({ status: ++attempts === 1 ? 401 : 200, statusText: "synthetic", data: {}, headers: {}, config });
    await getApiClient().post("/synthetic/probe", {}, { xsyReplay: "read", validateStatus: () => true });
    expect(attempts).toBe(2); expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
  it("续期后再401不形成刷新循环", async () => {
    let attempts = 0;
    getApiClient().defaults.adapter = async config => { attempts++; throw new AxiosError("synthetic", "ERR_BAD_REQUEST", config, undefined, { status: 401, statusText: "Unauthorized", data: {}, headers: {}, config }); };
    await expect(getApiClient().get("/synthetic/read")).rejects.toBeInstanceOf(AxiosError);
    expect(attempts).toBe(2); expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });
  it.each(["post", "patch", "delete"] as const)("未标只读的 %s 不刷新或重放", async method => {
    let attempts = 0;
    getApiClient().defaults.adapter = async config => { attempts++; throw new AxiosError("synthetic", "ERR_BAD_REQUEST", config, undefined, { status: 401, statusText: "Unauthorized", data: {}, headers: {}, config }); };
    await expect(getApiClient().request({ method, url: "/synthetic/write" })).rejects.toBeInstanceOf(AxiosError);
    expect(attempts).toBe(1); expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("显式never写入放行401也不刷新", async () => {
    let attempts = 0;
    getApiClient().defaults.adapter = async config => ({ status: ++attempts && 401, statusText: "synthetic", data: {}, headers: {}, config });
    expect((await getApiClient().post("/synthetic/write", {}, { xsyReplay: "never", validateStatus: () => true })).status).toBe(401);
    expect(attempts).toBe(1); expect(mocks.refresh).not.toHaveBeenCalled();
  });
  it("刷新错误不输出上游异常，不登出或清除凭据", async () => {
    mocks.refresh.mockRejectedValue(new Error("SECRET-upstream-refresh-url"));
    getApiClient().defaults.adapter = async config => { throw new AxiosError("synthetic", "ERR_BAD_REQUEST", config, undefined, { status: 401, statusText: "Unauthorized", data: {}, headers: {}, config }); };
    const error = await getApiClient().get("/synthetic/read").catch(v => v);
    expect(error.name).toBe("AuthError"); expect(error.message).not.toContain("SECRET"); expect(mocks.logout).not.toHaveBeenCalled();
  });
});
