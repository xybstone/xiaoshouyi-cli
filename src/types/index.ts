// 销售易 API 通用响应结构

export interface ApiResponse<T = unknown> {
  code: number;
  msg: string;
  result: T;
  ext?: unknown[];
}

export interface QueryResult<T = Record<string, unknown>> {
  totalSize: number;
  count: number;
  records: T[];
}

export interface DescribeField {
  propertyname: string;
  label: string;
  type: string;
  required: boolean;
  creatable: boolean;
  updatable: boolean;
  referToObjectApiKey?: string;
  options?: { label: string; value: string }[];
}

export interface DescribeResult {
  apiKey: string;
  label: string;
  fields: DescribeField[];
}

// 认证状态

export interface AuthState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // unix timestamp ms
  apiBaseUrl: string;
  tenantId?: string;
  clientId: string;
  clientSecret: string;
  /** 用于 refresh_token 不可用时 fallback 到 password grant 自动重登录 */
  username?: string;
  /** 用于 fallback 重登录（已拼接安全令牌） */
  password?: string;
}

export interface AuthConfig {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string; // 含安全令牌拼接
}

// CLI 全局选项

export interface GlobalOptions {
  format: "json" | "table" | "raw";
  jq?: string;
  fields?: string;  // Commander --fields 解析为逗号分隔字符串
  verbose: boolean;
  debug: boolean;
  yes: boolean;
  dryRun: boolean;
  timeout: number;
}
