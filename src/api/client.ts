// Axios 实例 — 带 auth 拦截器 + 401 自动重试

import axios, { type AxiosInstance, type AxiosError, type InternalAxiosRequestConfig } from "axios";
import { getAuthManager } from "../auth/manager.js";
import { DEFAULT_TIMEOUT } from "../config.js";
import { AuthError } from "./errors.js";

// 可重试的请求标记 — 避免无限循环
interface RetryableConfig extends InternalAxiosRequestConfig {
  __retried?: boolean;
}

// 工单业务写入不能在收到 401 后由底层自动重放。
declare module "axios" {
  interface AxiosRequestConfig { xsyReplay?: "read" | "never"; }
}

let apiClient: AxiosInstance | null = null;

export function getApiClient(): AxiosInstance {
  if (apiClient) return apiClient;

  const client = axios.create({
    timeout: DEFAULT_TIMEOUT,
    headers: {
      "Content-Type": "application/json",
    },
  });

  // ---- 请求拦截器：注入 Authorization header ----
  client.interceptors.request.use(async (config) => {
    const manager = getAuthManager();
    const token = await manager.getToken();
    // 动态设置 baseURL：优先环境变量 > auth state 中的租户 API 地址
    const sessionBase = manager.getApiBaseUrl();
    const isolated = !!process.env.XSY_NEOCRM_PROJECT;
    if (isolated) {
      try {
        const origin = new URL(sessionBase).origin;
        for (const override of [process.env.XSY_API_BASE_URL, config.baseURL]) {
          if (!override) continue;
          const url = new URL(override);
          if (url.origin !== origin || url.username || url.password || url.pathname !== "/" || url.search || url.hash)
            throw new Error();
        }
        const target = new URL(config.url ?? "", sessionBase);
        if (target.protocol !== "https:" || target.origin !== origin || target.username || target.password)
          throw new Error();
      } catch {
        throw new AuthError("请求地址与 NeoCRM 会话环境不一致；未发送凭据。");
      }
      // Never let a redirect forward the isolated bearer token to another host.
      config.maxRedirects = 0;
    }
    const baseUrl = isolated ? sessionBase : process.env.XSY_API_BASE_URL || sessionBase;
    config.baseURL = baseUrl;
    if (token) config.headers.Authorization = `Bearer ${token}`;

    return config;
  });

  // ---- 响应拦截器：401 自动重试 ----
  const mayRetry = (config: RetryableConfig) =>
    config.xsyReplay !== "never" && !config.__retried &&
    (config.xsyReplay === "read" || ["get", "head"].includes(String(config.method).toLowerCase()));
  const refreshRead = async (config: RetryableConfig) => {
    if (process.env.XSY_ACCESS_TOKEN)
      throw new AuthError("环境 Token 已失效，请更新 XSY_ACCESS_TOKEN；未使用或清除其他本地账号凭据");
    config.__retried = true;
    const manager = getAuthManager();
    const authorization = String(config.headers.Authorization ?? "");
    try {
      await manager.refresh(authorization.startsWith("Bearer ") ? authorization.slice(7) : undefined);
      const token = await manager.getToken();
      if (!token) throw new AuthError();
      config.headers.Authorization = `Bearer ${token}`;
    } catch {
      // A failed refresh must not delete credentials, especially on a network error.
      throw new AuthError("Token 刷新或身份复核失败，请验证当前凭据来源；没有切换账号或清除凭据。");
    }
    return client(config);
  };
  client.interceptors.response.use(
    async (response) => {
      // Contract readers may accept all HTTP statuses to classify business errors.
      // Preserve the same single-refresh rule for that fulfilled-response path.
      const config = response.config as RetryableConfig;
      if (response.status === 401 && mayRetry(config)) return refreshRead(config);
      return response;
    },
    async (error: AxiosError) => {
      const config = error.config as RetryableConfig | undefined;
      if (!config) return Promise.reject(error);

      // 仅 401 触发 token 刷新重试，且只重试一次
      if (error.response?.status === 401 && mayRetry(config)) return refreshRead(config);

      return Promise.reject(error);
    }
  );

  apiClient = client;
  return client;
}

// 重置客户端（登出后重建）
export function resetApiClient(): void {
  apiClient = null;
}
