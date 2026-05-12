// auth-check 中间件 — 在需要认证的命令执行前检查登录状态

import { getAuthManager } from "../auth/manager.js";

export function requireAuth(): void {
  const manager = getAuthManager();
  if (!manager.isAuthenticated()) {
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
): (...args: T) => void | Promise<void> {
  return (...args: T) => {
    requireAuth();
    return fn(...args);
  };
}
