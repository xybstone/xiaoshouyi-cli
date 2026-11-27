import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  NeoCrmSessionProvider,
  getNeoCrmProvider,
  resetNeoCrmProvider,
  type NeoCrmContext,
} from "../../../src/auth/neocrm-provider.js";

function setup() {
  let now = 1_000;
  const connection = {
    accessToken: "synthetic-token-one",
    baseUrl: "https://api.example.test",
    host: "crm.xiaoshouyi.com",
    tenantId: "tenant-one",
    userId: "user-one",
    clientId: "client-one",
  };
  const ctx: NeoCrmContext = {
    auth: {
      getAccessToken: vi.fn(async () => connection.accessToken),
      getConnection: vi.fn(async () => ({ ...connection })),
      refreshAfter401: vi.fn(async () => { connection.accessToken = "synthetic-token-two"; }),
    },
    transport: {
      request: vi.fn(async () => ({ id: connection.userId, tenantId: connection.tenantId })),
    },
  };
  const create = vi.fn(async () => ctx);
  return {
    connection, ctx, create,
    provider: new NeoCrmSessionProvider(create, () => now),
    advance: () => { now += 60_001; },
  };
}
const directories: string[] = [];
afterEach(() => {
  resetNeoCrmProvider();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("原隔离 NeoCRM 会话持续供给", () => {
  it("通过原身份读取协议验证账号，仅向HTTP返回Token，公开scope不含Token", async () => {
    const s = setup();
    const session = await s.provider.session();
    expect(session.accessToken).toBe(s.connection.accessToken);
    expect(s.ctx.transport.request).toHaveBeenCalledWith({ method: "GET", path: "/user/info", kind: "identity", readOnly: true });
    expect(s.provider.scope()).toEqual({ source: "neocrm", apiBaseUrl: "https://api.example.test", crmBaseUrl: "https://crm.xiaoshouyi.com", tenantId: "tenant-one", subjectId: "user-one", identityVerified: true });
    expect(JSON.stringify(s.provider.scope())).not.toContain("synthetic-token");
  });
  it("并发读取共享加载和身份核验", async () => {
    const s = setup();
    const sessions = await Promise.all(Array.from({ length: 12 }, () => s.provider.session()));
    expect(new Set(sessions.map(v => v.accessToken)).size).toBe(1);
    expect(s.create).toHaveBeenCalledTimes(1);
    expect(s.ctx.transport.request).toHaveBeenCalledTimes(1);
  });
  it("原库轮换Token后重新核验且账号范围稳定", async () => {
    const s = setup();
    const before = await s.provider.session();
    s.connection.accessToken = "synthetic-token-rotated";
    const after = await s.provider.session();
    expect(after.accessToken).not.toBe(before.accessToken);
    expect(after.subjectId).toBe(before.subjectId);
    expect(s.ctx.transport.request).toHaveBeenCalledTimes(2);
  });
  it("同代Token复用短期核验，TTL到期重新读取服务器身份", async () => {
    const s = setup();
    await s.provider.session();
    await s.provider.session();
    expect(s.ctx.transport.request).toHaveBeenCalledTimes(1);
    s.advance();
    await s.provider.session();
    expect(s.ctx.transport.request).toHaveBeenCalledTimes(2);
  });
  it.each(["tenantId", "userId", "clientId", "baseUrl", "host"] as const)("原连接改变 %s 后拒绝继续，不能默默换身份", async field => {
    const s = setup();
    await s.provider.session();
    s.connection[field] = field === "baseUrl" ? "https://other.example.test" : field === "host" ? "crm-other.example.test" : "different";
    await expect(s.provider.session()).rejects.toMatchObject({ name: "AuthError" });
    expect(s.provider.scope()).toBeUndefined();
  });
  it("服务器身份与原存储范围不同则拒绝，并隐藏原始错误", async () => {
    const s = setup();
    vi.mocked(s.ctx.transport.request).mockResolvedValue({ id: "other-user", tenantId: "tenant-one" });
    await expect(s.provider.session()).rejects.toMatchObject({ name: "AuthError" });
    expect(s.provider.scope()).toBeUndefined();
  });
  it("身份核验期间Token轮换会重新读取，避免把旧身份绑定到新Token", async () => {
    const s = setup();
    vi.mocked(s.ctx.transport.request).mockImplementationOnce(async () => {
      s.connection.accessToken = "synthetic-token-rotated";
      return { id: "user-one", tenantId: "tenant-one" };
    });
    expect((await s.provider.session()).accessToken).toBe("synthetic-token-rotated");
    expect(s.ctx.transport.request).toHaveBeenCalledTimes(2);
  });
  it("并发401只调用一次原库refreshAfter401，之后重新核验身份", async () => {
    const s = setup();
    const previous = await s.provider.session();
    await Promise.all(Array.from({ length: 12 }, () => s.provider.refreshAfter401(previous.accessToken)));
    expect(s.ctx.auth.refreshAfter401).toHaveBeenCalledTimes(1);
    expect(s.ctx.auth.refreshAfter401).toHaveBeenCalledWith("synthetic-token-one");
    expect((await s.provider.session()).accessToken).toBe("synthetic-token-two");
    expect(s.ctx.transport.request).toHaveBeenCalledTimes(2);
  });
  it("刷新失败不泄露上游错误且不提供已失效的scope", async () => {
    const s = setup();
    await s.provider.session();
    vi.mocked(s.ctx.auth.refreshAfter401).mockRejectedValue(new Error("SECRET-refresh-token-in-upstream-url"));
    const error = await s.provider.refreshAfter401("synthetic-token-one").catch(v => v);
    expect(error.name).toBe("AuthError");
    expect(error.message).not.toContain("SECRET");
    expect(s.provider.scope()).toBeUndefined();
  });
  it("源库异常不会被包装成含凭据的错误文本", async () => {
    const s = setup();
    vi.mocked(s.ctx.auth.getAccessToken).mockRejectedValue(new Error("secret-cookie-token"));
    const error = await s.provider.session().catch(v => v);
    expect(error.message).not.toContain("secret-cookie-token");
  });
  it("没有显式选择原项目时不加载它", () => {
    vi.stubEnv("XSY_NEOCRM_PROJECT", "");
    expect(getNeoCrmProvider()).toBeUndefined();
  });
  it("静态Token与隔离provider冲突时拒绝混用", () => {
    vi.stubEnv("XSY_NEOCRM_PROJECT", "/tmp");
    vi.stubEnv("XSY_ACCESS_TOKEN", "synthetic-static-token");
    expect(() => getNeoCrmProvider()).toThrow(/只能选择一个/);
  });
  it("运行时不能切换或移除已选择的项目", () => {
    const first = mkdtempSync(path.join(os.tmpdir(), "xsy-auth-scope-a-"));
    const second = mkdtempSync(path.join(os.tmpdir(), "xsy-auth-scope-b-"));
    directories.push(first, second);
    vi.stubEnv("XSY_ACCESS_TOKEN", "");
    vi.stubEnv("XSY_NEOCRM_PROJECT", first);
    expect(getNeoCrmProvider()).toBeDefined();
    vi.stubEnv("XSY_NEOCRM_PROJECT", second);
    expect(() => getNeoCrmProvider()).toThrow(/不能在运行中切换/);
    vi.stubEnv("XSY_NEOCRM_PROJECT", "");
    expect(() => getNeoCrmProvider()).toThrow(/不能在运行中切换/);
  });
  it("包名不符时拒绝加载context，不执行包脚本或main", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "xsy-auth-untrusted-"));
    directories.push(directory);
    mkdirSync(path.join(directory, "src"));
    writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "unrelated-package", main: "src/context.js", scripts: { prepare: "throw" } }));
    writeFileSync(path.join(directory, "src/context.js"), 'throw new Error("UNTRUSTED-CONTEXT-EXECUTED");');
    vi.stubEnv("XSY_ACCESS_TOKEN", ""); vi.stubEnv("XSY_NEOCRM_PROJECT", directory);
    const error = await getNeoCrmProvider()!.session().catch(v => v);
    expect(error.name).toBe("AuthError"); expect(error.message).not.toContain("UNTRUSTED-CONTEXT");
  });
  it("context软链接不能跳出被显式选择的源目录", async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "xsy-auth-entry-"));
    const outside = mkdtempSync(path.join(os.tmpdir(), "xsy-auth-outside-"));
    directories.push(directory, outside);
    mkdirSync(path.join(directory, "src"));
    writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "neocrm-cli-test" }));
    const entry = path.join(outside, "context.js");
    writeFileSync(entry, 'throw new Error("OUTSIDE-CONTEXT-EXECUTED");');
    symlinkSync(entry, path.join(directory, "src/context.js"));
    vi.stubEnv("XSY_ACCESS_TOKEN", ""); vi.stubEnv("XSY_NEOCRM_PROJECT", directory);
    const error = await getNeoCrmProvider()!.session().catch(v => v);
    expect(error.name).toBe("AuthError"); expect(error.message).not.toContain("OUTSIDE-CONTEXT");
  });
});
