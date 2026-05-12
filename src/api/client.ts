// Axios 实例 — 带 auth 拦截器 + 401 自动重试

import axios, { type AxiosInstance, type AxiosError, type InternalAxiosRequestConfig } from "axios";
import { getAuthManager } from "../auth/manager.js";
import { DEFAULT_TIMEOUT } from "../config.js";
import { AuthError } from "./errors.js";

// 可重试的请求标记 — 避免无限循环
interface RetryableConfig extends InternalAxiosRequestConfig {
  __retried?: boolean;
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
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }

    // 动态设置 baseURL：优先环境变量 > auth state 中的租户 API 地址
    const baseUrl = process.env.XSY_API_BASE_URL || manager.getApiBaseUrl();
    config.baseURL = baseUrl;

    return config;
  });

  // ---- 响应拦截器：401 自动重试 ----
  client.interceptors.response.use(
    (response) => response,
    async (error: AxiosError) => {
      const config = error.config as RetryableConfig | undefined;
      if (!config) return Promise.reject(error);

      // 仅 401 触发 token 刷新重试，且只重试一次
      if (error.response?.status === 401 && !config.__retried) {
        config.__retried = true;

        const manager = getAuthManager();
        try {
          await manager.refresh();
          const token = await manager.getToken();
          if (token) {
            config.headers.Authorization = `Bearer ${token}`;
          }
          return client(config);
        } catch {
          manager.logout();
          return Promise.reject(new AuthError("Token 刷新失败，请重新登录: xsy auth login"));
        }
      }

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
