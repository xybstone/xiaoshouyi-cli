import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ provider: vi.fn() }));
vi.mock("../../../src/auth/neocrm-provider.js", () => ({ getNeoCrmProvider: mocks.provider }));
import { AuthManager } from "../../../src/auth/manager.js";
import { AuthError } from "../../../src/api/errors.js";

function setup() {
  const scope = { source: "neocrm", apiBaseUrl: "https://api.example.test", crmBaseUrl: "https://crm.xiaoshouyi.com", tenantId: "tenant-one", subjectId: "user-one", identityVerified: true };
  const provider = {
    session: vi.fn(async () => ({ ...scope, accessToken: "synthetic-token-one" })),
    scope: vi.fn(() => scope),
    refreshAfter401: vi.fn(async () => undefined),
  };
  const storage = { read: vi.fn(), write: vi.fn(), delete: vi.fn() };
  mocks.provider.mockReturnValue(provider);
  return { provider, storage, manager: new AuthManager(storage) };
}
beforeEach(() => { vi.stubEnv("XSY_ACCESS_TOKEN", ""); vi.stubEnv("XSY_API_BASE_URL", ""); });
afterEach(() => { vi.unstubAllEnvs(); mocks.provider.mockReset(); });

describe("AuthManager原隔离provider接入", () => {
  it("不读写其他账号的本地存储", async () => {
    const s = setup();
    expect(await s.manager.getToken()).toBe("synthetic-token-one");
    expect(s.storage.read).not.toHaveBeenCalled();
    expect(s.storage.write).not.toHaveBeenCalled();
    expect(s.storage.delete).not.toHaveBeenCalled();
  });
  it("每次请求从原provider获取有效Token并提供不含凭据的身份", async () => {
    const s = setup();
    expect(await s.manager.getToken()).toBe("synthetic-token-one");
    s.provider.session.mockResolvedValue({ ...s.provider.scope(), accessToken: "synthetic-token-two" });
    expect(await s.manager.getToken()).toBe("synthetic-token-two");
    expect(await s.manager.getSessionIdentity()).not.toHaveProperty("accessToken");
  });
  it("401续期交给原库，不调用本项目认证存储", async () => {
    const s = setup();
    await s.manager.refresh("synthetic-rejected-token");
    expect(s.provider.refreshAfter401).toHaveBeenCalledWith("synthetic-rejected-token");
    expect(s.storage.write).not.toHaveBeenCalled();
  });
  it.each(["https://other.example.test", "https://user:pass@api.example.test", "https://api.example.test/path", "not-a-url"])("API环境不一致时拒绝把Token发送至 %s", value => {
    const s = setup();
    vi.stubEnv("XSY_API_BASE_URL", value);
    expect(() => s.manager.getApiBaseUrl()).toThrow(/环境不符/);
  });
  it("provider模式不能登录或登出另一个账号的本地存储", async () => {
    const s = setup();
    await expect(s.manager.login({} as never)).rejects.toMatchObject({ name: "AuthError" });
    expect(() => s.manager.logout()).toThrow(/原 NeoCRM/);
    expect(s.manager.getRawPassword()).toBeUndefined();
    expect(s.manager.getUsername()).toBeUndefined();
    expect(s.storage.delete).not.toHaveBeenCalled();
    expect(s.storage.write).not.toHaveBeenCalled();
  });
  it("Token与身份来自同一次session，不再分别读取Token和身份", async () => {
    const s = setup();
    const token = vi.spyOn(s.manager, "getToken");
    const identity = vi.spyOn(s.manager, "getSessionIdentity");
    const result = await s.manager.getRequestSession();
    expect(result).toEqual({ token: "synthetic-token-one", identity: s.provider.scope() });
    expect(s.provider.session).toHaveBeenCalledTimes(1);
    expect(token).not.toHaveBeenCalled(); expect(identity).not.toHaveBeenCalled();
    expect(s.storage.read).not.toHaveBeenCalled(); expect(s.storage.write).not.toHaveBeenCalled();
  });
  it("逐次读取原session且不混合两代Token与scope快照", async () => {
    const s = setup();
    const first = { ...s.provider.scope(), accessToken: "synthetic-generation-one", subjectId: "user-one" };
    const second = { ...s.provider.scope(), accessToken: "synthetic-generation-two", subjectId: "user-two" };
    s.provider.session.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    s.provider.scope.mockClear();
    expect(await s.manager.getRequestSession()).toMatchObject({ token: "synthetic-generation-one", identity: { subjectId: "user-one" } });
    expect(await s.manager.getRequestSession()).toMatchObject({ token: "synthetic-generation-two", identity: { subjectId: "user-two" } });
    expect(s.provider.session).toHaveBeenCalledTimes(2); expect(s.provider.scope).not.toHaveBeenCalled();
  });
  it("身份只投影固定白名单，原session新增秘密或子树不被夹带", async () => {
    const s = setup();
    s.provider.session.mockResolvedValue({ ...s.provider.scope(), accessToken: "synthetic-token-one",
      refreshToken: "RAW-REFRESH", cookie: "RAW-COOKIE", password: "RAW-PASSWORD", arbitrary: { credentials: "RAW-CREDENTIALS" },
    } as never);
    const result = await s.manager.getRequestSession();
    expect(Object.keys(result.identity!).sort()).toEqual(["apiBaseUrl", "crmBaseUrl", "identityVerified", "source", "subjectId", "tenantId"]);
    expect(JSON.stringify(result.identity)).not.toMatch(/RAW-|accessToken|refreshToken|cookie|password|arbitrary/);
    expect(result.token).toBe("synthetic-token-one");
  });
  it.each(["account changed", "refresh rejected"])("session异常%s继续抛出，不回退其他账号", async message => {
    const s = setup(); const error = new AuthError(message);
    s.provider.session.mockRejectedValue(error);
    await expect(s.manager.getRequestSession()).rejects.toBe(error);
    expect(s.storage.read).not.toHaveBeenCalled(); expect(s.storage.write).not.toHaveBeenCalled(); expect(s.storage.delete).not.toHaveBeenCalled();
  });
  it("配置身份切换错误继续抛出，不降级静态Token", async () => {
    const s = setup(); const error = new AuthError("credential source changed");
    mocks.provider.mockImplementation(() => { throw error; });
    await expect(s.manager.getRequestSession()).rejects.toBe(error);
    expect(s.provider.session).not.toHaveBeenCalled(); expect(s.storage.read).not.toHaveBeenCalled();
  });
  it("非provider的环境Token保持原有直通语义，不推断身份", async () => {
    mocks.provider.mockReturnValue(undefined); vi.stubEnv("XSY_ACCESS_TOKEN", "synthetic-static-token");
    const storage = { read: vi.fn(() => null), write: vi.fn(), delete: vi.fn() };
    const manager = new AuthManager(storage); const token = vi.spyOn(manager, "getToken");
    expect(await manager.getRequestSession()).toEqual({ token: "synthetic-static-token", identity: undefined });
    expect(token).toHaveBeenCalledTimes(1); expect(storage.write).not.toHaveBeenCalled();
  });
  it("非provider未登录仍返回null身份未知", async () => {
    mocks.provider.mockReturnValue(undefined);
    const manager = new AuthManager({ read: () => null, write: vi.fn(), delete: vi.fn() });
    expect(await manager.getRequestSession()).toEqual({ token: null, identity: undefined });
  });
  it("非provider委托原getToken并保留其异常", async () => {
    mocks.provider.mockReturnValue(undefined);
    const manager = new AuthManager({ read: () => null, write: vi.fn(), delete: vi.fn() });
    const error = new AuthError("original getToken failure"); vi.spyOn(manager, "getToken").mockRejectedValue(error);
    await expect(manager.getRequestSession()).rejects.toBe(error);
  });
});
