// auth-check 中间件 — 在需要认证的命令执行前检查登录状态

import { getAuthManager } from "../auth/manager.js";

export async function requireAuth(): Promise<void> {
  const manager = getAuthManager();
  const token = await manager.getToken();
  if (!token) {
    console.error(JSON.stringify({
      status: "error",
      message: "未登录，请先运行: xsy auth login",
    }));
    process.exit(1);
  }
}

// 包装一个 action handler，在执行前检查认证
export function withAuth<T extends unknown[]>(
  fn: (...args: T) => void | Promise<void>
): (...args: T) => Promise<void> {
  return async (...args: T) => {
    await requireAuth();
    return fn(...args);
  };
}
