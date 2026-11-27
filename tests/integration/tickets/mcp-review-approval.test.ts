// Exercise the real MCP handler, service, ledger and review execution boundary.
// The only injection is a synthetic local service/backend. No CRM calls.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { getApiClient, resetApiClient } from "../../../src/api/client.js";
import { CrmTicketBackend } from "../../../src/tickets/backend.js";
import { OperationStore } from "../../../src/tickets/operation-store.js";
import { operationReviewFingerprint } from "../../../src/tickets/actions.js";
import { TicketService } from "../../../src/services/ticket.service.js";
import { callTicketTool, ticketToolDefinitions } from "../../../src/tickets/mcp.js";
import type { OperationReview, TicketPlan } from "../../../src/tickets/types.js";
import { API_ORIGIN, StatefulSyntheticCrm, syntheticRegistry } from "../../fixtures/tickets/stateful-crm.js";

const injected = vi.hoisted(() => ({ service: undefined as unknown }));
vi.mock("../../../src/services/ticket.service.js", async (original) => {
  const actual = await original<typeof import("../../../src/services/ticket.service.js")>();
  return { ...actual, createTicketService: () => {
    if (!injected.service) throw new Error("Synthetic service was not configured");
    return injected.service;
  } };
});
vi.mock("../../../src/auth/manager.js", () => ({
  getAuthManager: () => ({
    getToken: async () => "synthetic-review-integration-token-not-valid",
    getApiBaseUrl: () => "https://synthetic.invalid",
    getUsername: () => "synthetic-user",
    getStatus: () => ({ tenantId: "synthetic-tenant" }),
    getSessionIdentity: async () => undefined,
  }),
}));

const secret = "synthetic-host-approval-secret-32-characters";
const directories: string[] = [];
beforeEach(() => {
  vi.stubEnv("XSY_ACCESS_TOKEN", ""); vi.stubEnv("XSY_NEOCRM_PROJECT", "");
  vi.stubEnv("XSY_API_BASE_URL", API_ORIGIN); vi.stubEnv("XSY_TICKET_WRITES", "1");
  vi.stubEnv("XSY_TICKET_APPROVAL_SECRET", secret);
  resetApiClient();
});
afterEach(() => {
  injected.service = undefined; resetApiClient(); vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
async function setup(applied = false) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "xsy-mcp-review-")); directories.push(directory);
  const server = new StatefulSyntheticCrm(), registry = syntheticRegistry();
  getApiClient().defaults.adapter = server.adapter;
  const store = new OperationStore(directory);
  const service = new TicketService(new CrmTicketBackend(registry), registry, store);
  injected.service = service;
  const prepared = await service.prepare({ action: "create", input: { name: "Synthetic review target", entityType: "2" } });
  if (prepared.status !== "ready") throw new Error("Synthetic plan not ready");
  const plan = prepared.plan;
  if (applied) {
    server.dropReplyAfterApply.add("create");
    expect((await service.execute(plan.planId, { fingerprint: plan.fingerprint, source: "cli", reference: "Synthetic explicit execution approval" })).state).toBe("outcome_unknown");
  } else {
    // Simulate a process interrupted before it managed to send the request.
    const operation = store.read(plan.planId); operation.state = "outcome_unknown"; store.save(operation);
  }
  return { server, service, store, plan };
}
function sign(plan: TicketPlan, overrides: Record<string, unknown> = {}) {
  const body = Buffer.from(JSON.stringify({
    planId: plan.planId, fingerprint: plan.fingerprint,
    expiresAt: new Date(Date.now() + 60000).toISOString(),
    approvedBy: "synthetic-trusted-host", reference: "Synthetic reviewed user confirmation", ...overrides,
  })).toString("base64url");
  return `${body}.${createHmac("sha256", secret).update(body).digest("base64url")}`;
}
function signedReview(plan: TicketPlan, review: OperationReview, overrides: Record<string, unknown> = {}) {
  return sign(plan, { purpose: "operation_review", reviewFingerprint: operationReviewFingerprint(plan.fingerprint, review), ...overrides });
}
function callReview(plan: TicketPlan, review: OperationReview, approval: string, overrides: Record<string, unknown> = {}) {
  return callTicketTool("tickets_operation_review", { operationId: plan.planId, fingerprint: plan.fingerprint, approval, review, ...overrides });
}
const review: OperationReview = { outcome: "applied", reviewedBy: "synthetic-operator", evidenceReferences: ["synthetic audit record"], resultId: "100" };

describe("MCP人工核对的独立授权用途与具体结论绑定", () => {
  it("旧执行授权和显式execute授权都不能用于人工核对", async () => {
    const s = await setup(), spy = vi.spyOn(s.service, "review");
    for (const token of [sign(s.plan), sign(s.plan, { purpose: "execute" })]) {
      await expect(callReview(s.plan, review, token)).rejects.toMatchObject({ code: "CONFIRMATION_MISMATCH" });
    }
    expect(spy).not.toHaveBeenCalled(); expect(s.store.read(s.plan.planId).state).toBe("outcome_unknown");
    expect(s.server.writes).toHaveLength(0);
  });

  it("人工核对签名不能反向用于执行工具，哪怕目标与原计划指纹相同", async () => {
    const s = await setup(), spy = vi.spyOn(s.service, "execute");
    await expect(callTicketTool("tickets_execute", { planId: s.plan.planId, fingerprint: s.plan.fingerprint, approval: signedReview(s.plan, review) })).rejects.toMatchObject({ code: "CONFIRMATION_MISMATCH" });
    expect(spy).not.toHaveBeenCalled(); expect(s.server.writes).toHaveLength(0);
  });

  it.each([
    ["结论", { outcome: "not_applied" }],
    ["核对人", { reviewedBy: "different-operator" }],
    ["证据内容", { evidenceReferences: ["different evidence"] }],
    ["证据数量", { evidenceReferences: ["synthetic audit record", "additional unapproved evidence"] }],
    ["结果ID", { resultId: "101" }],
  ])("原计划指纹不变也不能修改已签名的%s", async (_name, mutation) => {
    const s = await setup(), spy = vi.spyOn(s.service, "review");
    await expect(callReview(s.plan, { ...review, ...mutation } as OperationReview, signedReview(s.plan, review))).rejects.toMatchObject({ code: "CONFIRMATION_MISMATCH" });
    expect(spy).not.toHaveBeenCalled(); expect(s.store.read(s.plan.planId).recoveryHistory).toBeUndefined();
    expect(s.server.writes).toHaveLength(0);
  });

  it("签名必须同时绑定操作ID、原计划指纹、到期时间和review用途", async () => {
    const s = await setup(), token = signedReview(s.plan, review);
    await expect(callReview(s.plan, review, token, { operationId: "00000000-0000-4000-8000-000000000099" })).rejects.toMatchObject({ code: "CONFIRMATION_MISMATCH" });
    await expect(callReview(s.plan, review, token, { fingerprint: `sha256:${"f".repeat(64)}` })).rejects.toMatchObject({ code: "CONFIRMATION_MISMATCH" });
    await expect(callReview(s.plan, review, signedReview(s.plan, review, { expiresAt: new Date(Date.now() - 1000).toISOString() }))).rejects.toMatchObject({ code: "CONFIRMATION_MISMATCH" });
    await expect(callReview(s.plan, review, signedReview(s.plan, review, { purpose: "execute" }))).rejects.toMatchObject({ code: "CONFIRMATION_MISMATCH" });
    expect(s.store.read(s.plan.planId).recoveryHistory).toBeUndefined();
  });

  it("未签名的review确认布尔值、额外字段和混入review指纹的执行签名均拒绝", async () => {
    const s = await setup();
    await expect(callReview(s.plan, review, signedReview(s.plan, review), { confirmed: true })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(callTicketTool("tickets_execute", { planId: s.plan.planId, fingerprint: s.plan.fingerprint, approval: sign(s.plan, { purpose: "execute", reviewFingerprint: operationReviewFingerprint(s.plan.fingerprint, review) }) })).rejects.toMatchObject({ code: "CONFIRMATION_MISMATCH" });
    const changedBody = signedReview(s.plan, review).split(".");
    const body = JSON.parse(Buffer.from(changedBody[0], "base64url").toString()); body.approvedBy = "untrusted-other-host";
    changedBody[0] = Buffer.from(JSON.stringify(body)).toString("base64url");
    await expect(callReview(s.plan, review, changedBody.join("."))).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
    expect(s.server.writes).toHaveLength(0);
  });

  it("合法review签名经实际handler更新审计，写入关闭时仍能记录本地未落地结论", async () => {
    const s = await setup(); vi.stubEnv("XSY_TICKET_WRITES", "");
    const notApplied: OperationReview = { outcome: "not_applied", reviewedBy: "synthetic operator", evidenceReferences: ["synthetic pre-send interruption evidence"] };
    expect(ticketToolDefinitions().some((t) => t.name === "tickets_execute")).toBe(false);
    const result = await callReview(s.plan, notApplied, signedReview(s.plan, notApplied)) as { state: string };
    expect(result.state).toBe("not_applied");
    expect(s.store.read(s.plan.planId).recoveryHistory?.[0]).toMatchObject({ source: "manual", status: "not_applied", reviewedBy: notApplied.reviewedBy, evidenceReferences: notApplied.evidenceReferences });
    expect(s.server.writes).toHaveLength(0);
    await expect(callReview(s.plan, notApplied, signedReview(s.plan, notApplied))).rejects.toMatchObject({ code: "INVALID_OPERATION_STATE" });
    expect(s.store.read(s.plan.planId).recoveryHistory).toHaveLength(1);
  });

  it("合法applied核对仍经过正常副作用验证，不能仅凭人工签名强行verified", async () => {
    const s = await setup(true);
    const applied: OperationReview = { ...review, resultId: [...s.server.tickets.keys()][0] };
    const result = await callReview(s.plan, applied, signedReview(s.plan, applied)) as { state: string };
    expect(result.state).toBe("applied_pending_verification");
    expect(s.store.read(s.plan.planId).recoveryHistory?.[0]).toMatchObject({ source: "manual", status: "applied" });
    expect(s.server.writes).toHaveLength(1);
  });

  it("没有宿主密钥时review工具不注册；服务层也拒绝仅原planfp的确认", async () => {
    const s = await setup(); vi.stubEnv("XSY_TICKET_APPROVAL_SECRET", "");
    expect(ticketToolDefinitions().some((t) => t.name === "tickets_operation_review")).toBe(false);
    await expect(callReview(s.plan, review, signedReview(s.plan, review))).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(s.service.review(s.plan.planId, { fingerprint: s.plan.fingerprint, source: "cli", reference: "Synthetic original execution approval" }, review)).rejects.toMatchObject({ code: "CONFIRMATION_MISMATCH" });
    expect(s.store.read(s.plan.planId).recoveryHistory).toBeUndefined(); expect(s.server.writes).toHaveLength(0);
  });
});
