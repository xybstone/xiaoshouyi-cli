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
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      apiBaseUrl: data.api_base_url || "https://api.xiaoshouyi.com",
      tenantId: data.tenant_id,
    };

    this.state = state;
    this.storage.write(state);
    return state;
  }

  async refresh(): Promise<void> {
    if (!this.state?.refreshToken) {
      throw new Error("No refresh token available");
    }

    const params = new URLSearchParams();
    params.append("grant_type", "refresh_token");
    params.append("refresh_token", this.state.refreshToken);

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
      refreshToken: data.refresh_token || this.state.refreshToken,
      expiresAt: Date.now() + data.expires_in * 1000,
      apiBaseUrl: data.api_base_url || this.state.apiBaseUrl,
      tenantId: data.tenant_id ?? this.state.tenantId,
    };

    this.state = state;
    this.storage.write(state);
  }

  getStatus(): { authenticated: boolean; tenantId?: string; expiresAt?: number } {
    if (!this.state) return { authenticated: false };
    return {
      authenticated: this.isAuthenticated(),
      tenantId: this.state.tenantId,
      expiresAt: this.state.expiresAt,
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
