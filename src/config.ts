// 常量配置：API URL、apiKey 映射等

export const API_BASE_URL = "https://api.xiaoshouyi.com";
export const AUTH_BASE_URL = "https://login.xiaoshouyi.com";

export const API_PREFIX = "/rest/data/v2";
export const API_OBJECTS_PREFIX = `${API_PREFIX}/objects`;
export const DESCRIBE_PREFIX = "/rest/data/v2.0/xobjects";

export const DEFAULT_TIMEOUT = 30_000; // 30s
export const TOKEN_REFRESH_MARGIN = 60_000; // 过期前 1 分钟刷新

// 凭据存储路径
export const CONFIG_DIR = `${process.env.HOME || "~"}/.config/xiaoshouyi-cli`;
export const AUTH_FILE = `${CONFIG_DIR}/auth.json`;

// 常用业务对象 apiKey 映射
export const API_KEY_MAP: Record<string, { label: string; apiKey: string }> = {
  account: { label: "客户", apiKey: "account" },
  opportunity: { label: "商机", apiKey: "opportunity" },
  oppProcess: { label: "商机阶段", apiKey: "oppProcess" },
  visitRecord: { label: "跟进记录", apiKey: "visitRecord" },
};

// 环境变量键名（CI 场景）
export const ENV_KEYS = {
  CLIENT_ID: "XSY_CLIENT_ID",
  CLIENT_SECRET: "XSY_CLIENT_SECRET",
  USERNAME: "XSY_USERNAME",
  PASSWORD: "XSY_PASSWORD",
  SECURITY_TOKEN: "XSY_SECURITY_TOKEN",
  API_BASE_URL: "XSY_API_BASE_URL",
} as const;
