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
}
