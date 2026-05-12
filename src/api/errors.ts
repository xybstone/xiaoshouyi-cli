// 错误分类

export class XsyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XsyError";
  }
}

/** 认证失败（未登录或 token 无效） */
export class AuthError extends XsyError {
  constructor(message = "认证失败，请先运行: xsy auth login") {
    super(message);
    this.name = "AuthError";
  }
}

/** API 业务错误（code !== 200） */
export class ApiError extends XsyError {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

/** 网络错误（超时、DNS、连接中断等） */
export class NetworkError extends XsyError {
  constructor(message: string) {
    super(message);
    this.name = "NetworkError";
  }
}

// 从 axios error 中提取用户友好的错误消息
export function classifyError(err: unknown): XsyError {
  if (err instanceof XsyError) return err;

  const anyErr = err as Record<string, unknown>;

  // Axios 错误
  if (anyErr.isAxiosError) {
    const response = anyErr.response as Record<string, unknown> | undefined;
    const status = response?.status as number | undefined;

    if (status === 401 || status === 403) {
      return new AuthError();
    }

    if (response?.data) {
      const data = response.data as Record<string, unknown>;
      const code = data.code as number;
      const msg = (data.msg || data.message) as string;
      if (code && msg) {
        return new ApiError(code, msg);
      }
    }

    if (anyErr.code === "ECONNABORTED" || anyErr.code === "ETIMEDOUT") {
      return new NetworkError("请求超时");
    }
    if (anyErr.code === "ENOTFOUND" || anyErr.code === "ECONNREFUSED") {
      return new NetworkError("无法连接到服务器");
    }

    return new NetworkError(`网络错误: ${(anyErr.message as string) || "未知"}`);
  }

  // 普通 Error
  if (err instanceof Error) {
    return new XsyError(err.message);
  }

  return new XsyError(String(err));
}
