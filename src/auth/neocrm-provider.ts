// Reuse the original isolated authentication library; never copy its store.
import { createRequire } from "node:module";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { AuthError } from "../api/errors.js";
import { CRM_BASE_URL } from "../config.js";

interface NeoCrmConnection {
  accessToken: string;
  baseUrl: string;
  tenantId?: unknown;
  userId?: unknown;
  clientId?: unknown;
  host?: unknown;
}
export interface NeoCrmContext {
  auth: {
    getAccessToken(): Promise<string>;
    getConnection(): Promise<NeoCrmConnection>;
    refreshAfter401(previousToken: string): Promise<unknown>;
  };
  transport: {
    request(options: {
      method: "GET";
      path: "/user/info";
      kind: "identity";
      readOnly: true;
    }): Promise<unknown>;
  };
}
export interface NeoCrmScope {
  source: "neocrm";
  apiBaseUrl: string;
  crmBaseUrl: string;
  tenantId: string;
  subjectId: string;
  identityVerified: true;
}
interface Session extends NeoCrmScope {
  accessToken: string;
}
function rejected(message = "NeoCRM 会话不可用，请在原隔离环境验证登录；没有使用或清除其他账号凭据。"): AuthError {
  return new AuthError(message);
}
function origin(value: unknown): string {
  if (typeof value !== "string") throw rejected();
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
      throw rejected();
    return url.origin;
  } catch {
    throw rejected();
  }
}
function identifier(value: unknown): string {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0)) throw rejected();
  if (!["string", "number"].includes(typeof value) || !/^[A-Za-z0-9_-]{1,128}$/.test(String(value))) throw rejected();
  return String(value);
}
function token(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 65536 || /[\x00-\x20\x7f]/.test(value)) throw rejected();
  return value;
}
function key(scope: NeoCrmScope): string {
  return JSON.stringify([scope.apiBaseUrl, scope.crmBaseUrl, scope.tenantId, scope.subjectId]);
}

export class NeoCrmSessionProvider {
  private context?: Promise<NeoCrmContext>;
  private pending?: Promise<Session>;
  private refreshing?: Promise<Session>;
  private current?: Session;
  private pinned?: string;
  private clientId?: string;
  private verifiedAt = 0;
  constructor(
    private readonly createContext: () => Promise<NeoCrmContext>,
    private readonly now: () => number = Date.now,
    private readonly verifyTtlMs = 60_000,
  ) {}

  // Public status never contains a token; the token is only returned to HTTP.
  scope(): NeoCrmScope | undefined {
    if (!this.current) return undefined;
    const { accessToken: _secret, ...scope } = this.current;
    return scope;
  }

  async session(): Promise<Session> {
    if (this.refreshing) return this.refreshing;
    if (this.pending) return this.pending;
    this.pending = this.load();
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
    }
  }

  async refreshAfter401(previousToken?: string): Promise<Session> {
    if (this.refreshing) return this.refreshing;
    const pending = this.pending;
    // Publish one refresh promise before yielding so concurrent 401s share it.
    this.refreshing = (async () => {
      if (pending) await pending;
      const context = await (this.context ??= this.createContext());
      const connection = await context.auth.getConnection();
      this.checkConnection(connection);
      const previous = previousToken ?? this.current?.accessToken;
      if (!previous) throw rejected();
      // The original library handles its interprocess lock and stale generation.
      await context.auth.refreshAfter401(token(previous));
      this.verifiedAt = 0;
      this.current = undefined;
      return this.load();
    })().catch(() => {
      this.current = undefined;
      throw rejected("NeoCRM 会话刷新或身份复核失败，请在原隔离环境重新验证；没有重放写入或切换账号。");
    });
    try {
      return await this.refreshing;
    } finally {
      this.refreshing = undefined;
    }
  }

  private checkConnection(connection: NeoCrmConnection): NeoCrmScope {
    const crmBaseUrl = connection.host
      ? origin(`https://${String(connection.host)}`)
      : CRM_BASE_URL;
    const scope: NeoCrmScope = {
      source: "neocrm",
      apiBaseUrl: origin(connection.baseUrl),
      crmBaseUrl,
      tenantId: identifier(connection.tenantId),
      subjectId: identifier(connection.userId),
      identityVerified: true,
    };
    const client = identifier(connection.clientId);
    if ((this.pinned && key(scope) !== this.pinned) || (this.clientId && client !== this.clientId))
      throw rejected("原 NeoCRM 登录的账号、租户或环境已变化；请重启调用进程并重新准备计划。");
    return scope;
  }

  private async load(): Promise<Session> {
    try {
      const context = await (this.context ??= this.createContext());
      for (let attempt = 0; attempt < 2; attempt++) {
        const accessToken = token(await context.auth.getAccessToken());
        const connection = await context.auth.getConnection();
        const claimed = this.checkConnection(connection);
        if (token(connection.accessToken) !== accessToken) continue;
        const fresh = this.current?.accessToken === accessToken &&
          this.now() - this.verifiedAt < this.verifyTtlMs;
        if (!fresh) {
          const raw = await context.transport.request({
            method: "GET", path: "/user/info", kind: "identity", readOnly: true,
          });
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw rejected();
          const identity = raw as Record<string, unknown>;
          if (identifier(identity.id) !== claimed.subjectId || identifier(identity.tenantId) !== claimed.tenantId)
            throw rejected();
          const latest = await context.auth.getConnection();
          this.checkConnection(latest);
          if (token(latest.accessToken) !== accessToken) continue;
          if (String(latest.clientId) !== String(connection.clientId) || key(this.checkConnection(latest)) !== key(claimed)) throw rejected();
          this.verifiedAt = this.now();
        }
        this.pinned ??= key(claimed);
        this.clientId ??= identifier(connection.clientId);
        this.current = { ...claimed, accessToken };
        return this.current;
      }
      throw rejected();
    } catch (error) {
      this.current = undefined;
      // Source failures can contain secret URLs or credentials. Never wrap them.
      if (error instanceof AuthError) throw error;
      throw rejected();
    }
  }
}

let configuredRoot: string | undefined;
let provider: NeoCrmSessionProvider | undefined;
export function getNeoCrmProvider(): NeoCrmSessionProvider | undefined {
  const project = process.env.XSY_NEOCRM_PROJECT;
  if (!project) {
    if (configuredRoot) throw rejected("不能在运行中切换凭据来源，请重启进程。");
    return undefined;
  }
  if (process.env.XSY_ACCESS_TOKEN) throw rejected("XSY_NEOCRM_PROJECT 与 XSY_ACCESS_TOKEN 只能选择一个凭据来源。");
  let root: string;
  try { root = realpathSync(path.resolve(project)); } catch { throw rejected(); }
  if (configuredRoot && root !== configuredRoot) throw rejected("不能在运行中切换 NeoCRM 隔离项目，请重启进程。");
  if (!provider) {
    configuredRoot = root;
    provider = new NeoCrmSessionProvider(async () => {
      try {
        const packageFile = path.join(root, "package.json");
        const packageStat = lstatSync(packageFile);
        if (!packageStat.isFile() || packageStat.isSymbolicLink() || packageStat.size > 1024 * 1024) throw rejected();
        const manifest = JSON.parse(readFileSync(packageFile, "utf8"));
        if (manifest.name !== "neocrm-cli-test") throw rejected();
        const entry = realpathSync(path.join(root, "src/context.js"));
        if (!entry.startsWith(`${root}${path.sep}src${path.sep}`) || !lstatSync(entry).isFile()) throw rejected();
        const require = createRequire(path.join(root, "package.json"));
        // The host explicitly selects trusted local source; never use npm's main,
        // execute package scripts, download a module, or accept a path from MCP.
        const module = require(entry) as {
          createContext(options: { projectRoot: string }): Promise<NeoCrmContext>;
        };
        return await module.createContext({ projectRoot: root });
      } catch { throw rejected(); }
    });
  }
  return provider;
}

// Clears in-memory test/session objects only; never modifies either auth store.
export function resetNeoCrmProvider(): void {
  provider = undefined;
  configuredRoot = undefined;
}
