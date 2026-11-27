import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  callTicketTool,
  ticketToolDefinitions,
  verifyHostApproval,
} from "../../../src/tickets/mcp.js";
afterEach(() => vi.unstubAllEnvs());
const id = "00000000-0000-4000-8000-000000000001",
  fingerprint = `sha256:${"a".repeat(64)}`,
  secret = "s".repeat(32);
function approval(overrides: Record<string, unknown> = {}) {
  const body = Buffer.from(
    JSON.stringify({
      planId: id,
      fingerprint,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      approvedBy: "synthetic-host",
      reference: "synthetic explicit user approval",
      ...overrides,
    }),
  ).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}
describe("MCP 工单确认", () => {
  it("默认不暴露执行工具", () => {
    vi.stubEnv("XSY_TICKET_WRITES", "");
    expect(
      ticketToolDefinitions().some((t) => t.name === "tickets_execute"),
    ).toBe(false);
  });
  it("启用写入并配置宿主确认后暴露执行工具", () => {
    vi.stubEnv("XSY_TICKET_WRITES", "1");
    vi.stubEnv("XSY_TICKET_APPROVAL_SECRET", secret);
    expect(
      ticketToolDefinitions().some((t) => t.name === "tickets_execute"),
    ).toBe(true);
  });
  it("校验与计划绑定的宿主签名", () => {
    vi.stubEnv("XSY_TICKET_APPROVAL_SECRET", secret);
    expect(verifyHostApproval(approval(), id, fingerprint)).toMatchObject({
      source: "host",
      fingerprint,
    });
  });
  it("拒绝篡改、其他目标和过期确认", () => {
    vi.stubEnv("XSY_TICKET_APPROVAL_SECRET", secret);
    expect(() =>
      verifyHostApproval(approval() + "x", id, fingerprint),
    ).toThrow();
    expect(() =>
      verifyHostApproval(
        approval({ planId: "00000000-0000-4000-8000-000000000002" }),
        id,
        fingerprint,
      ),
    ).toThrow();
    expect(() =>
      verifyHostApproval(
        approval({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
        id,
        fingerprint,
      ),
    ).toThrow();
  });
  it("confirmed:true 不能冒充宿主确认", async () => {
    vi.stubEnv("XSY_TICKET_WRITES", "1");
    vi.stubEnv("XSY_TICKET_APPROVAL_SECRET", secret);
    vi.stubEnv("XSY_TICKET_CONTRACTS", "");
    await expect(
      callTicketTool("tickets_execute", {
        planId: id,
        fingerprint,
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("未登记动作 prepare 返回 blocked", async () => {
    vi.stubEnv("XSY_TICKET_CONTRACTS", "");
    expect(
      await callTicketTool("tickets_prepare", { action: "close", id: "1" }),
    ).toMatchObject({ status: "blocked", code: "UNVERIFIED" });
  });
});
