// Axios 实例 — 带 auth 拦截器 + 401 自动重试

import axios, { type AxiosInstance, type AxiosError, type InternalAxiosRequestConfig } from "axios";
import { getAuthManager } from "../auth/manager.js";
import { DEFAULT_TIMEOUT, API_BASE_URL } from "../config.js";

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

    // 动态设置 baseURL：优先使用 auth state 中的 apiBaseUrl
    const state = manager.getStatus();
    // getStatus() 不返回 apiBaseUrl... 需要用另一种方式
    // 我们用 manager 内部 state 或者直接读取存储
    // 简化：从 config.ts 默认 + 环境变量覆盖
    const baseUrl = process.env.XSY_API_BASE_URL || API_BASE_URL;
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
          // 刷新失败，清除凭据并抛出 auth 错误
          manager.logout();
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
