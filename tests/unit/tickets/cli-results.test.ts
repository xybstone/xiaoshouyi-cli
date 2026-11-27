import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { registerTicketCommands } from "../../../src/commands/ticket.js";
import { TicketError, type TicketOperation, type OperationState } from "../../../src/tickets/types.js";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), operation: vi.fn(), prepare: vi.fn() }));
vi.mock("../../../src/services/ticket.service.js", async (original) => {
  const actual = await original<typeof import("../../../src/services/ticket.service.js")>();
  return { ...actual, createTicketService: () => mocks };
});
const id = "00000000-0000-4000-8000-000000000001";
const fingerprint = `sha256:${"a".repeat(64)}`;
let previousExitCode: typeof process.exitCode;
let log: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
function operation(state: OperationState, errorCode?: string): TicketOperation {
  return {
    plan: {
      planId: id, operationId: id, contextKey: "synthetic-context", action: "create",
      contractVersion: "synthetic", contractHash: "synthetic", snapshotHash: "synthetic",
      input: { secret: "synthetic-private-input" }, payload: { secret: "synthetic-private-payload" },
      effects: [], createdAt: "2026-11-24T00:00:00+08:00", expiresAt: "2099-01-01T00:00:00+08:00",
      fingerprint, concurrency: "best_effort",
    },
    state, errorCode, updatedAt: "2026-11-24T00:01:00+08:00",
    submission: ["verified", "applied_pending_verification"].includes(state) ? { id: "100", output: {} } : undefined,
    verification: state === "verified" ? { status: "verified", checks: [] } : undefined,
  };
}
function cli(args: string[]) {
  const program = new Command().exitOverride()
    .option("--format <format>", "format", "json")
    .option("--timeout <seconds>", "timeout", "30")
    .option("--dry-run", "preview only");
  registerTicketCommands(program);
  return program.parseAsync(["node", "xsy", ...args]);
}
function stderr() { return JSON.parse(String(error.mock.calls[0][0])); }
function stdout() { return JSON.parse(String(log.mock.calls[0][0])); }
beforeEach(() => {
  previousExitCode = process.exitCode; process.exitCode = undefined;
  log = vi.spyOn(console, "log").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.execute.mockReset(); mocks.operation.mockReset(); mocks.prepare.mockReset();
});
afterEach(() => { process.exitCode = previousExitCode; vi.restoreAllMocks(); });

describe("ticket execute 的业务结果和CLI退出状态", () => {
  it("只有已验证完成的操作输出成功JSON并保持exit0", async () => {
    mocks.execute.mockResolvedValue(operation("verified"));
    await cli(["ticket", "execute", id, "--confirm", fingerprint]);
    expect(process.exitCode ?? 0).toBe(0); expect(error).not.toHaveBeenCalled();
    expect(stdout()).toMatchObject({ code: 200, result: { operationId: id, state: "verified", resultId: "100" } });
    expect(mocks.execute).toHaveBeenCalledExactlyOnceWith(id, { fingerprint, source: "cli", reference: "explicit CLI confirmation" });
  });

  it.each([
    ["rejected", 1, "rejected", "REMOTE_REJECTED"],
    ["not_applied", 1, "not_applied", "NOT_APPLIED"],
    ["outcome_unknown", 2, "outcome_unknown", "OUTCOME_UNKNOWN"],
    ["dispatching", 2, "outcome_unknown", "OUTCOME_UNKNOWN"],
    ["applied_pending_verification", 3, "pending", "VERIFICATION_PENDING"],
    ["prepared", 2, "incomplete", "OPERATION_INCOMPLETE"],
  ] as const)("%s 不冒充成功，保留操作摘要并以exit%s返回", async (state, exitCode, status, code) => {
    mocks.execute.mockResolvedValue(operation(state));
    await cli(["ticket", "execute", id, "--confirm", fingerprint]);
    expect(process.exitCode).toBe(exitCode); expect(log).not.toHaveBeenCalled();
    expect(stderr()).toMatchObject({ status, code, operation: { operationId: id, planId: id, state },
      next: { command: `xsy ticket operation ${id} --reconcile`, crmWrite: false } });
    expect(stderr().code).not.toBe(200);
    expect(String(error.mock.calls[0][0])).not.toContain("synthetic-private-input");
    expect(String(error.mock.calls[0][0])).not.toContain("synthetic-private-payload");
    expect(mocks.execute).toHaveBeenCalledTimes(1);
  });

  it.each(["raw", "table"])("--format %s 不会把未确定结果改成成功输出", async (format) => {
    mocks.execute.mockResolvedValue(operation("outcome_unknown", "ECONNRESET"));
    await cli(["--format", format, "ticket", "execute", id, "--confirm", fingerprint]);
    expect(process.exitCode).toBe(2); expect(log).not.toHaveBeenCalled();
    expect(stderr()).toMatchObject({ status: "outcome_unknown", code: "ECONNRESET", operation: { operationId: id } });
  });

  it("回读失败保留具体错误分类，不能建议重发或丢失返回资源ID", async () => {
    mocks.execute.mockResolvedValue(operation("applied_pending_verification", "VERIFICATION_PENDING"));
    await cli(["ticket", "execute", id, "--confirm", fingerprint, "--confirmation-reference", "synthetic explicit approval"]);
    expect(process.exitCode).toBe(3);
    expect(stderr()).toMatchObject({ code: "VERIFICATION_PENDING", operation: { state: "applied_pending_verification", resultId: "100" }, next: { crmWrite: false } });
    expect(mocks.execute.mock.calls[0][1].reference).toBe("synthetic explicit approval");
  });

  it("execute --dry-run 仅显示计划，成功退出不代表执行成功", async () => {
    mocks.operation.mockResolvedValue(operation("prepared"));
    await cli(["--dry-run", "ticket", "execute", id]);
    expect(process.exitCode ?? 0).toBe(0); expect(error).not.toHaveBeenCalled();
    expect(stdout().result).toMatchObject({ dryRun: true, operation: { state: "prepared" } });
    expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.operation).toHaveBeenCalledExactlyOnceWith(id);
  });

  it("operation的exit0表示读取成功，返回的不确定业务状态仍明确保留", async () => {
    mocks.operation.mockResolvedValue(operation("outcome_unknown", "RECOVERY_NOT_FOUND"));
    await cli(["ticket", "operation", id, "--reconcile"]);
    expect(process.exitCode ?? 0).toBe(0); expect(error).not.toHaveBeenCalled();
    expect(stdout()).toMatchObject({ code: 200, result: { state: "outcome_unknown", errorCode: "RECOVERY_NOT_FOUND" } });
    expect(mocks.execute).not.toHaveBeenCalled(); expect(mocks.operation).toHaveBeenCalledExactlyOnceWith(id, true);
  });

  it("执行前拒绝仍返回标准错误且不会伪造操作摘要", async () => {
    mocks.execute.mockRejectedValue(new TicketError("FORBIDDEN", "synthetic denied"));
    await cli(["ticket", "execute", id, "--confirm", fingerprint]);
    expect(process.exitCode).toBe(1); expect(log).not.toHaveBeenCalled();
    expect(stderr()).toMatchObject({ status: "error", code: "FORBIDDEN" });
    expect(stderr()).not.toHaveProperty("operation");
  });

  it("未核验prepare仍返回blocked和exit1", async () => {
    mocks.prepare.mockResolvedValue({ status: "blocked", code: "UNVERIFIED", action: "close" });
    await cli(["ticket", "prepare", "close", "--id", "100"]);
    expect(process.exitCode).toBe(1); expect(log).not.toHaveBeenCalled();
    expect(stderr()).toMatchObject({ status: "blocked", code: "UNVERIFIED", action: "close" });
  });
});
