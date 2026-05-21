// OAuth2 Password Grant 认证管理器

import axios from "axios";
import { AUTH_BASE_URL, DEFAULT_TIMEOUT, TOKEN_REFRESH_MARGIN } from "../config.js";
import type { AuthState, AuthConfig } from "../types/index.js";
import type { AuthStorage } from "./storage.js";
import { createAuthStorage } from "./storage.js";

// OAuth2 token 响应体
interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number; // seconds
  tenant_id?: string;
  api_base_url?: string;
}

/** 判断错误是否为认证相关（400/401），应 fallthrough；网络等错误应向上抛 */
function isAuthError(err: unknown): boolean {
  if (
    err && typeof err === "object" &&
    "response" in err &&
    typeof (err as Record<string, unknown>).response === "object"
  ) {
    const status = ((err as Record<string, unknown>).response as Record<string, unknown>).status;
    return status === 400 || status === 401;
  }
  return false;
}

export class AuthManager {
  private storage: AuthStorage;
  private state: AuthState | null = null;

  constructor(storage?: AuthStorage) {
    this.storage = storage ?? createAuthStorage();
    this.state = this.storage.read();
  }

  // 是否已登录且 token 未过期
  isAuthenticated(): boolean {
    if (!this.state) return false;
    return Date.now() < this.state.expiresAt - TOKEN_REFRESH_MARGIN;
  }

  // 获取有效 access token，必要时自动刷新
  async getToken(): Promise<string | null> {
    // 环境变量直通（CI 场景）
    if (process.env.XSY_ACCESS_TOKEN) {
      return process.env.XSY_ACCESS_TOKEN;
    }

    if (!this.state) return null;

    // 未过期直接返回
    if (Date.now() < this.state.expiresAt - TOKEN_REFRESH_MARGIN) {
      return this.state.accessToken;
    }

    // 尝试刷新
    try {
      await this.refresh();
      return this.state?.accessToken ?? null;
    } catch {
      return null;
    }
  }

  async login(config: AuthConfig): Promise<AuthState> {
    const params = new URLSearchParams();
    params.append("grant_type", "password");
    params.append("client_id", config.clientId);
    params.append("client_secret", config.clientSecret);
    params.append("username", config.username);
    params.append("password", config.password);

    const response = await axios.get<TokenResponse>(
      `${AUTH_BASE_URL}/auc/oauth2/token`,
      {
        params,
        timeout: DEFAULT_TIMEOUT,
      }
    );

    const data = response.data;
    const state: AuthState = {
      accessToken: data.access_token,
      // NOTE: 销售易 Password Grant 通常不返回 refresh_token
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      apiBaseUrl: data.api_base_url || "https://api.xiaoshouyi.com",
      tenantId: data.tenant_id,
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      // 存储 username/password 用于 refresh_token 不可用时的 fallback 重登录
      // 这些凭据以 0o600 权限持久化在本地文件或 Keychain 中，等同于明文存储
      username: config.username,
      password: config.password,
    };

    this.state = state;
    this.storage.write(state);
    return state;
  }

  async refresh(): Promise<void> {
    // 阶段 1：尝试 refresh_token grant
    if (this.state?.refreshToken) {
      try {
        await this.refreshWithGrant("refresh_token", { refresh_token: this.state.refreshToken });
        return;
      } catch (err) {
        // 仅在认证错误（400/401）时 fallthrough，网络/超时等直接抛出
        if (!isAuthError(err)) throw err;
      }
    }

    // 阶段 2：fallback — 用存储的 username/password 重新走 password grant
    const { username, password } = this.state ?? {};
    if (username && password) {
      await this.refreshWithGrant("password", { username, password });
      return;
    }

    throw new Error("No valid credential to refresh token");
  }

  private async refreshWithGrant(
    grantType: string,
    extraParams: Record<string, string>,
  ): Promise<void> {
    const s = this.state;
    if (!s) throw new Error("No auth state");

    const params = new URLSearchParams();
    params.append("grant_type", grantType);
    params.append("client_id", s.clientId);
    params.append("client_secret", s.clientSecret);
    for (const [key, value] of Object.entries(extraParams)) {
      params.append(key, value);
    }

    const response = await axios.get<TokenResponse>(
      `${AUTH_BASE_URL}/auc/oauth2/token`,
      { params, timeout: DEFAULT_TIMEOUT }
    );

    const data = response.data;
    this.state = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || s.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
      apiBaseUrl: data.api_base_url || s.apiBaseUrl,
      tenantId: data.tenant_id ?? s.tenantId,
      clientId: s.clientId,
      clientSecret: s.clientSecret,
      username: s.username,
      password: s.password,
    };
    this.storage.write(this.state);
  }

  getApiBaseUrl(): string {
    return this.state?.apiBaseUrl ?? API_BASE_URL;
  }

  getStatus(): {
    authenticated: boolean;
    tenantId?: string;
    expiresAt?: number;
    hasRefreshToken: boolean;
    hasCredentialsForRelogin: boolean;
  } {
    if (!this.state) {
      return { authenticated: false, hasRefreshToken: false, hasCredentialsForRelogin: false };
    }
    return {
      authenticated: this.isAuthenticated(),
      tenantId: this.state.tenantId,
      expiresAt: this.state.expiresAt,
      hasRefreshToken: !!this.state.refreshToken,
      hasCredentialsForRelogin: !!(this.state.username && this.state.password),
    };
  }

  logout(): void {
    this.state = null;
    this.storage.delete();
  }

  // 强制重置（清除存储 + 重置内存状态）
  reset(): void {
    this.logout();
  }
}

// 全局单例
let instance: AuthManager | null = null;

export function getAuthManager(): AuthManager {
  if (!instance) {
    instance = new AuthManager();
  }
  return instance;
}
