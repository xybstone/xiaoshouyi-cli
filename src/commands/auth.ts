// auth 子命令实现

import { Command } from "commander";
import { input, password as passwordPrompt } from "@inquirer/prompts";
import { getAuthManager } from "../auth/manager.js";
import type { AuthConfig } from "../types/index.js";

const authManager = getAuthManager();

export function registerAuthCommands(parent: Command): void {
  const auth = parent
    .command("auth")
    .description("认证管理");

  // ---- xsy auth login ----
  auth
    .command("login")
    .description("交互式输入凭据完成登录")
    .action(async () => {
      try {
        const clientId = process.env.XSY_CLIENT_ID
          || await input({ message: "Client ID:" });
        const clientSecret = process.env.XSY_CLIENT_SECRET
          || await input({ message: "Client Secret:" });
        const username = process.env.XSY_USERNAME
          || await input({ message: "Username:" });
        const password = process.env.XSY_PASSWORD
          || await passwordPrompt({ message: "Password:" });
        const securityToken = process.env.XSY_SECURITY_TOKEN
          || await passwordPrompt({ message: "Security Token (8 digits):" });

        const config: AuthConfig = {
          clientId,
          clientSecret,
          username,
          password: password + securityToken,
          rawPassword: password,
          securityToken,
        };

        const state = await authManager.login(config);
        console.log(JSON.stringify({
          status: "ok",
          tenantId: state.tenantId,
          expiresAt: new Date(state.expiresAt).toISOString(),
        }));
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(JSON.stringify({ status: "error", message }));
        process.exitCode = 1;
      }
    });

  // ---- xsy auth status ----
  auth
    .command("status")
    .description("查看当前认证状态")
    .action(() => {
      const status = authManager.getStatus();
      console.log(JSON.stringify(status));
    });

  // ---- xsy auth logout ----
  auth
    .command("logout")
    .description("清除本地凭据")
    .action(() => {
      authManager.logout();
      console.log(JSON.stringify({ status: "ok", message: "已登出" }));
    });

  // ---- xsy auth reset ----
  auth
    .command("reset")
    .description("强制重置凭据（恢复用）")
    .action(() => {
      authManager.reset();
      console.log(JSON.stringify({ status: "ok", message: "凭据已强制清除" }));
    });

  // ---- xsy auth crm-cookie ----
  auth
    .command("crm-cookie")
    .description("管理 CRM 域 Cookie（用于跟进记录等操作）")
    .option("--cookie <str>", "手动设置 Cookie 字符串")
    .option("--auto", "使用已保存的凭据自动登录获取 Cookie")
    .option("--clear", "清除已保存的 CRM Cookie")
    .action(async (opts: { cookie?: string; auto?: boolean; clear?: boolean }) => {
      const { saveCrmCookie, clearCrmCookie, hasCrmCookie, loginCrm } = await import("../api/crm-client.js");

      if (opts.clear) {
        clearCrmCookie();
        console.log(JSON.stringify({ status: "ok", message: "CRM Cookie 已清除" }));
        return;
      }

      if (opts.auto) {
        try {
          await loginCrm();
          const { getAuthManager } = await import("../auth/manager.js");
          const status = getAuthManager().getStatus();
          console.log(JSON.stringify({
            status: "ok",
            message: "CRM Cookie 已通过凭据自动登录获取",
            hasCredentials: status.canAutoRefreshCrmCookie,
          }));
        } catch (err: unknown) {
          const m = err instanceof Error ? err.message : String(err);
          console.log(JSON.stringify({
            status: "error",
            message: m,
            hint: "请先通过 xsy auth login 登录并保存凭据",
          }));
          process.exitCode = 1;
        }
        return;
      }

      if (opts.cookie) {
        saveCrmCookie(opts.cookie);
        console.log(JSON.stringify({ status: "ok", message: "CRM Cookie 已保存" }));
      } else if (process.env.XSY_CRM_COOKIE) {
        saveCrmCookie(process.env.XSY_CRM_COOKIE);
        console.log(JSON.stringify({ status: "ok", message: "CRM Cookie 已从环境变量保存" }));
      } else {
        console.log(JSON.stringify({
          status: "error",
          message: "请提供 Cookie 或使用自动登录",
          manual: "xsy auth crm-cookie --cookie 'JSESSIONID=...'",
          auto: "xsy auth crm-cookie --auto",
          hint: "手动方式在浏览器 F12 → Network → 复制任意请求的 Cookie 头",
          clear: "xsy auth crm-cookie --clear",
          current: hasCrmCookie() ? "已配置" : "未配置",
        }));
        process.exitCode = 1;
      }
    });
}
