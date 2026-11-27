import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerApprovalCommands } from "../../src/commands/approval.js";

const mocks = vi.hoisted(() => ({ loginCrm: vi.fn(), getToken: vi.fn() }));
vi.mock("../../src/api/crm-client.js", () => ({ loginCrm: mocks.loginCrm }));
vi.mock("../../src/auth/manager.js", () => ({
  getAuthManager: () => ({ getToken: mocks.getToken }),
}));
vi.mock("../../src/services/approval.service.js", () => ({
  queryApprovalWorkItems: vi.fn(), getApprovalWorkItem: vi.fn(), executeApprovalAction: vi.fn(),
}));

let previousExitCode: typeof process.exitCode;
let stdout: ReturnType<typeof vi.spyOn>, stderr: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
  mocks.loginCrm.mockReset(); mocks.getToken.mockReset();
  mocks.getToken.mockResolvedValue("synthetic-oauth-token-not-valid");
  stdout = vi.spyOn(console, "log").mockImplementation(() => {});
  stderr = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => { process.exitCode = previousExitCode; vi.restoreAllMocks(); });

describe("approval refresh-cookie output", () => {
  it.each([
    "JSESSIONID=synthetic-long-session-identifier-never-log-this; c-user=7; SESSION=synthetic-private-session",
    "SESSION=synthetic-short-cookie",
  ])("reports success without exposing a full or partial session cookie", async cookie => {
    mocks.loginCrm.mockResolvedValue(cookie);
    const program = new Command().exitOverride();
    registerApprovalCommands(program);
    await program.parseAsync(["node", "xsy", "approval", "refresh-cookie"]);

    expect(mocks.getToken).toHaveBeenCalledTimes(1);
    expect(mocks.loginCrm).toHaveBeenCalledExactlyOnceWith();
    expect(process.exitCode ?? 0).toBe(0);
    expect(stderr).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledTimes(1);
    const output = String(stdout.mock.calls[0][0]);
    expect(output).not.toContain(cookie);
    expect(output).not.toContain(cookie.slice(0, 50));
    expect(JSON.parse(output)).toEqual({ status: "ok", message: "CRM Cookie 已自动刷新" });
  });
});
