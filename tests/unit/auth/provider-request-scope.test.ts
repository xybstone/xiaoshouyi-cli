import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ token: vi.fn(), refresh: vi.fn() }));
vi.mock("../../../src/auth/manager.js", () => ({
  getAuthManager: () => ({ getToken: mocks.token, refresh: mocks.refresh, getApiBaseUrl: () => "https://api.example.test" }),
}));
import { getApiClient, resetApiClient } from "../../../src/api/client.js";
beforeEach(() => {
  vi.stubEnv("XSY_NEOCRM_PROJECT", "/synthetic/explicit-source");
  vi.stubEnv("XSY_ACCESS_TOKEN", ""); vi.stubEnv("XSY_API_BASE_URL", "");
  mocks.token.mockResolvedValue("synthetic-isolated-token"); resetApiClient();
});
afterEach(() => { vi.unstubAllEnvs(); resetApiClient(); });
describe("隔离provider出站域绑定", () => {
  it.each([
    { url: "https://outside.example.test/read" },
    { url: "//outside.example.test/read" },
    { url: "/read", baseURL: "https://outside.example.test" },
    { url: "https://user:pass@api.example.test/read" },
    { url: "/read", baseURL: "https://api.example.test/path" },
  ])("跨域或带凭据地址在HTTP发送前拒绝 %j", async request => {
    const adapter = vi.fn(); getApiClient().defaults.adapter = adapter;
    await expect(getApiClient().request(request)).rejects.toMatchObject({ name: "AuthError" });
    expect(adapter).not.toHaveBeenCalled();
  });
  it("残留的API环境覆盖不能把原会话Token发送到其他站", async () => {
    vi.stubEnv("XSY_API_BASE_URL", "https://outside.example.test");
    const adapter = vi.fn(); getApiClient().defaults.adapter = adapter;
    await expect(getApiClient().get("/read")).rejects.toMatchObject({ name: "AuthError" });
    expect(adapter).not.toHaveBeenCalled();
  });
  it("同域读取绑定原API且强制禁用重定向", async () => {
    let captured: unknown;
    getApiClient().defaults.adapter = async config => { captured = { baseURL: config.baseURL, maxRedirects: config.maxRedirects, authorization: config.headers.Authorization }; return { status: 200, statusText: "OK", data: {}, headers: {}, config }; };
    await getApiClient().get("/read", { maxRedirects: 10 });
    expect(captured).toEqual({ baseURL: "https://api.example.test", maxRedirects: 0, authorization: "Bearer synthetic-isolated-token" });
  });
});
