import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import axios from "axios";
const mocks = vi.hoisted(() => ({ provider: vi.fn(), auth: vi.fn() }));
vi.mock("../../../src/auth/neocrm-provider.js", () => ({ getNeoCrmProvider: mocks.provider }));
vi.mock("../../../src/auth/manager.js", () => ({ getAuthManager: mocks.auth }));
import { clearCrmCookie, crmPost, getCrmCookie, loginCrm, saveCrmCookie } from "../../../src/api/crm-client.js";

beforeEach(() => { vi.stubEnv("XSY_CRM_COOKIE", ""); mocks.provider.mockReturnValue({}); mocks.auth.mockReset(); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("NeoCRM模式Cookie隔离与遗留请求禁重放", () => {
  it("未显式提供Cookie时不读取本地其他账号的Cookie文件", () => {
    const exists = vi.spyOn(fs, "existsSync"); const read = vi.spyOn(fs, "readFileSync");
    expect(getCrmCookie()).toBeNull();
    expect(exists).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  });
  it("显式Cookie仅按需传递，不从文件合并其他账号内容", () => {
    vi.stubEnv("XSY_CRM_COOKIE", "synthetic=explicit-not-real");
    const read = vi.spyOn(fs, "readFileSync");
    expect(getCrmCookie()).toBe("synthetic=explicit-not-real"); expect(read).not.toHaveBeenCalled();
  });
  it("不保存、清除或自动登录Cookie，也不调用原本地账号认证", async () => {
    const write = vi.spyOn(fs, "writeFileSync"); const unlink = vi.spyOn(fs, "unlinkSync");
    const request = vi.spyOn(axios, "get");
    expect(() => saveCrmCookie("synthetic=new-cookie")).toThrow(/不向本地/);
    expect(() => clearCrmCookie()).toThrow(/不删除/);
    await expect(loginCrm()).rejects.toMatchObject({ name: "AuthError" });
    expect(write).not.toHaveBeenCalled(); expect(unlink).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled(); expect(mocks.auth).not.toHaveBeenCalled();
  });
  it("遗留POST未标只读时，即使请求自动刷新也不重放或重定向", async () => {
    mocks.provider.mockReturnValue(undefined);
    const post = vi.spyOn(axios, "post").mockResolvedValue({ data: "synthetic-login-page", headers: {} });
    const result = await crmPost("/synthetic/write", {}, { cookie: "synthetic=cookie", autoRefresh: true });
    expect(result.status).toBe(-1); expect(post).toHaveBeenCalledTimes(1); expect(mocks.auth).not.toHaveBeenCalled();
    expect(post.mock.calls[0][2]).toMatchObject({ maxRedirects: 0 });
  });
  it("provider模式只读POST也不会通过本地Cookie自动登录换账号", async () => {
    const post = vi.spyOn(axios, "post").mockResolvedValue({ data: "synthetic-login-page", headers: {} });
    await crmPost("/synthetic/read", {}, { cookie: "synthetic=cookie", readOnly: true, autoRefresh: true });
    expect(post).toHaveBeenCalledTimes(1); expect(mocks.auth).not.toHaveBeenCalled();
  });
});
