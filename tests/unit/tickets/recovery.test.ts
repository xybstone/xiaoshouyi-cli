import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TicketActions, operationReviewFingerprint } from "../../../src/tickets/actions.js";
import { ContractRegistry } from "../../../src/tickets/contracts.js";
import { OperationStore } from "../../../src/tickets/operation-store.js";
import { recoverByCorrelation } from "../../../src/tickets/recovery.js";
import {
  TicketError,
  type ActionContract,
  type RecordData,
  type TicketBackend,
  type TicketPlan,
  type OperationReview,
} from "../../../src/tickets/types.js";

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));
const evidence = {
  source: "synthetic" as const,
  reference: "recovery fixture; never a production CRM contract",
  verifiedAt: "2026-11-24T00:00:00+08:00",
};
const scope = { apiBaseUrl: "https://api.example.test", crmBaseUrl: "https://crm.example.test", tenantId: "test-tenant" };
function contract(create = false): ActionContract {
  return {
    action: create ? "create" : "close", verification: "verified", version: "synthetic-recovery-v1", evidence,
    fields: create ? { name: { type: "string", required: true } } : {},
    defaults: create ? { name: "synthetic" } : {}, required: [], fieldMode: create ? "create" : "action",
    preconditionFields: ["status"], effects: ["synthetic effect"],
    request: {
      host: "api", method: "POST", path: "/synthetic/action", encoding: "json",
      payload: { operationKey: { $ref: "operation.operationId" } },
      successPath: "code", successValues: [200], resultIdPath: create ? "data.id" : undefined,
    },
    probe: { request: { host: "api", method: "GET", path: "/synthetic/probe", encoding: "json", successPath: "code", successValues: [200] }, permissionPath: "permission", allowedPath: "allowed" },
    verify: { checks: [{ field: "status", expected: "Closed" }] },
    recovery: {
      evidence, apiKey: create ? "fieldJob" : "syntheticHistory", correlationField: "operationKey", resultIdField: "resultId",
      targetField: create ? undefined : "ticketId", checks: [{ field: "action", expected: create ? "create" : "close" }],
      outputFields: { eventId: "id" },
    },
  };
}
class Backend implements TicketBackend {
  contextKey = "test-context";
  identityVerified = true;
  sends = 0;
  reads = 0;
  verifications = 0;
  queryText = "";
  rows: RecordData[] = [];
  total?: number;
  queryError = false;
  verifyPending = false;
  failWrite = true;
  recordStatus = "New";
  probeOutput: RecordData = { taskId: "42", nextTaskDefKey: "solve", approverId: "7" };
  gate?: () => Promise<void>;
  async context() {
    return { key: this.contextKey, ...scope, subjectId: "test-user", identityVerified: this.identityVerified };
  }
  async metadata() {
    return { apiKey: "fieldJob" as const, flags: {}, fields: [{ apiKey: "name", label: "name", type: "string", required: true, createable: true, options: [] }] };
  }
  async inspect(c: ActionContract) {
    return { record: { id: "1", status: this.recordStatus }, permission: "allowed" as const, allowed: "allowed" as const, identityVerified: true, required: [], defaults: {}, fields: {}, formVersion: "one", output: Object.fromEntries(Object.keys(c.probe?.outputPaths ?? {}).map((key) => [key, this.probeOutput[key]])) };
  }
  async query(sql: string) {
    this.reads++; this.queryText = sql;
    if (this.gate) await this.gate();
    if (this.queryError) throw new Error("synthetic read failure");
    return { records: this.rows, count: this.rows.length, totalSize: this.total ?? this.rows.length };
  }
  async get() { return { id: "1", status: "Closed" }; }
  async submit(c: ActionContract, plan: TicketPlan) {
    this.sends++;
    const resultId = c.action === "create" ? "22" : "1";
    this.rows = [{ id: "100", operationKey: plan.operationId, ticketId: plan.targetId, resultId, action: c.action }];
    if (this.failWrite) throw new TicketError("OUTCOME_UNKNOWN", "synthetic response lost after persistence");
    return { id: resultId, output: {} };
  }
  async recover(c: ActionContract, plan: TicketPlan) { return recoverByCorrelation(this, c, plan); }
  async verify() {
    this.verifications++;
    return { status: this.verifyPending ? "pending" as const : "verified" as const, checks: [{ field: "status", matched: !this.verifyPending }] };
  }
}
async function setup(create = false, transform?: (c: ActionContract) => void, initialize?: (backend: Backend) => void) {
  const c = contract(create); transform?.(c);
  const registry = new ContractRegistry({ version: 1, scope, actions: [c] }, { allowSynthetic: true });
  const backend = new Backend();
  initialize?.(backend);
  const directory = mkdtempSync(path.join(os.tmpdir(), "xsy-recovery-test-")); directories.push(directory);
  const store = new OperationStore(directory);
  const actions = new TicketActions(backend, registry, store);
  const ready = await actions.prepare({ action: c.action, id: create ? undefined : "1" });
  if (ready.status !== "ready") throw new Error("Expected ready synthetic plan");
  const plan = ready.plan;
  const confirmation = { fingerprint: plan.fingerprint, source: "cli" as const, reference: "explicit synthetic authorization" };
  return { backend, registry, store, actions, plan, confirmation };
}
async function unknown(s: Awaited<ReturnType<typeof setup>>) {
  expect((await s.actions.execute(s.plan.planId, s.confirmation)).state).toBe("outcome_unknown");
}
const review = {
  outcome: "applied" as const, reviewedBy: "test-operator", evidenceReferences: ["synthetic admin history record"], resultId: "1",
};
function reviewConfirmation(s: Awaited<ReturnType<typeof setup>>, value: OperationReview) {
  return { ...s.confirmation, purpose: "operation_review" as const, reviewFingerprint: operationReviewFingerprint(s.plan.fingerprint, value) };
}

describe("无回执的只读关联恢复", () => {
  it("写入成功但回执丢失，通过操作关联与后续联动回读恢复，不重发", async () => {
    const s = await setup(); await unknown(s);
    expect(s.plan.payload).toEqual({ operationKey: s.plan.operationId });
    const result = await s.actions.reconcile(s.plan.planId);
    expect(result.state).toBe("verified");
    expect(result.submission).toEqual({ id: "1", output: { eventId: "100" } });
    expect(result.recoveryHistory?.[0]).toMatchObject({ source: "contract", status: "matched", matchedCount: 1 });
    expect(s.backend.queryText).toContain(`operationKey = '${s.plan.operationId}'`);
    expect(s.backend.queryText).toMatch(/limit 0,2$/i);
    expect(s.backend.sends).toBe(1);
    await s.actions.execute(s.plan.planId, s.confirmation);
    expect(s.backend.sends).toBe(1);
  });
  it("创建回执丢失可以定位唯一的新工单ID，再做常规副作用回读", async () => {
    const s = await setup(true); await unknown(s);
    const recovered = await s.actions.reconcile(s.plan.planId);
    expect(recovered.state).toBe("verified"); expect(recovered.submission?.id).toBe("22"); expect(s.backend.sends).toBe(1);
  });
  it("没有关联证据时，即使当前主表状态已相同也不归因于本次操作", async () => {
    const s = await setup(); await unknown(s); s.backend.rows = [];
    expect((await s.actions.reconcile(s.plan.planId)).state).toBe("outcome_unknown");
    expect(s.store.read(s.plan.planId).recoveryHistory?.[0].status).toBe("not_found");
    expect(s.backend.verifications).toBe(0); expect(s.backend.sends).toBe(1);
  });
  it("多个候选保持不确定，即使候选看起来一致也不选第一条", async () => {
    const s = await setup(); await unknown(s); s.backend.rows.push({ ...s.backend.rows[0], id: "101" });
    const result = await s.actions.reconcile(s.plan.planId);
    expect(result.state).toBe("outcome_unknown"); expect(result.errorCode).toBe("RECOVERY_AMBIGUOUS"); expect(s.backend.verifications).toBe(0);
  });
  it.each(["operationKey", "ticketId", "action"])("候选%s不匹配时不能恢复成功", async (field) => {
    const s = await setup(); await unknown(s); s.backend.rows[0][field] = "different";
    const result = await s.actions.reconcile(s.plan.planId);
    expect(result.state).toBe("outcome_unknown"); expect(s.backend.verifications).toBe(0); expect(s.backend.sends).toBe(1);
  });
  it("关联读取超时只记录恢复失败，不重放写入", async () => {
    const s = await setup(); await unknown(s); s.backend.queryError = true;
    expect((await s.actions.reconcile(s.plan.planId)).state).toBe("outcome_unknown");
    expect(s.backend.sends).toBe(1); expect(s.backend.verifications).toBe(0);
  });
  it("查询总数与候选数不一致时不能宣称唯一结果", async () => {
    const s = await setup(); await unknown(s); s.backend.rows = []; s.backend.total = 1;
    const result = await s.actions.reconcile(s.plan.planId);
    expect(result.state).toBe("outcome_unknown"); expect(result.errorCode).toBe("INVALID_RESPONSE");
  });
  it("不安全的数值ID不会被恢复结果静默接受", async () => {
    const s = await setup(); await unknown(s); s.backend.rows[0].resultId = Number.MAX_SAFE_INTEGER + 1;
    expect((await s.actions.reconcile(s.plan.planId)).state).toBe("outcome_unknown"); expect(s.backend.verifications).toBe(0);
  });
  it("身份切换阻断恢复，身份未核验时不会查询关联", async () => {
    const s = await setup(); await unknown(s); s.backend.contextKey = "other-context";
    await expect(s.actions.reconcile(s.plan.planId)).rejects.toMatchObject({ code: "CONTEXT_MISMATCH" });
    s.backend.contextKey = s.plan.contextKey; s.backend.identityVerified = false;
    expect((await s.actions.reconcile(s.plan.planId)).errorCode).toBe("IDENTITY_UNVERIFIED"); expect(s.backend.reads).toBe(0);
  });
  it("发送进程崩溃且留下执行锁，确认进程已退出后可只读恢复", async () => {
    const s = await setup(); await unknown(s);
    const operation = s.store.read(s.plan.planId); operation.state = "dispatching"; s.store.save(operation);
    writeFileSync(path.join(s.store.directory, `${s.plan.planId}.lock`), JSON.stringify({ pid: 2147483647 }));
    expect((await s.actions.reconcile(s.plan.planId)).state).toBe("verified"); expect(s.backend.sends).toBe(1);
  });
  it("执行进程尚存活时不能与其竞争恢复", async () => {
    const s = await setup(); await unknown(s);
    writeFileSync(path.join(s.store.directory, `${s.plan.planId}.lock`), JSON.stringify({ pid: process.pid }));
    await expect(s.actions.reconcile(s.plan.planId)).rejects.toMatchObject({ code: "OPERATION_BUSY" }); expect(s.backend.reads).toBe(0);
  });
  it("回查进程自身崩溃留下未完成声明时，不需要移除执行锁即可恢复", async () => {
    const s = await setup(); await unknown(s);
    const directory = path.join(s.store.directory, `${s.plan.planId}.reconcile-claims`);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, "2147483647-00000000-0000-4000-8000-000000000000.json"), "partial interrupted write");
    expect((await s.actions.reconcile(s.plan.planId)).state).toBe("verified"); expect(s.backend.sends).toBe(1);
  });
  it("旧版本回查锁所属进程已退出时可兼容恢复，活进程仍然互斥", async () => {
    const s = await setup(); await unknown(s);
    const legacy = path.join(s.store.directory, `${s.plan.planId}.reconcile-lock`);
    writeFileSync(legacy, JSON.stringify({ pid: process.pid }));
    await expect(s.actions.reconcile(s.plan.planId)).rejects.toMatchObject({ code: "OPERATION_BUSY" });
    writeFileSync(legacy, JSON.stringify({ pid: 2147483647 }));
    expect((await s.actions.reconcile(s.plan.planId)).state).toBe("verified");
  });
  it("两个实例并发恢复只会有一个读取并更新操作", async () => {
    const s = await setup(); await unknown(s);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    s.backend.gate = async () => { enter(); await blocked; };
    const first = s.actions.reconcile(s.plan.planId); await entered;
    const other = new TicketActions(s.backend, s.registry, new OperationStore(s.store.directory));
    await expect(other.reconcile(s.plan.planId)).rejects.toMatchObject({ code: "OPERATION_BUSY" });
    release(); expect((await first).state).toBe("verified"); expect(s.backend.reads).toBe(1); expect(s.backend.sends).toBe(1);
  });
  it("人工核对与自动回查共用锁，不会覆盖仍在处理的恢复结论", async () => {
    const s = await setup(); await unknown(s);
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    s.backend.gate = async () => { enter(); await blocked; };
    const pending = s.actions.reconcile(s.plan.planId); await entered;
    await expect(s.actions.review(s.plan.planId, reviewConfirmation(s, { ...review, outcome: "not_applied" }), { ...review, outcome: "not_applied" })).rejects.toMatchObject({ code: "OPERATION_BUSY" });
    release(); expect((await pending).state).toBe("verified");
    expect(s.store.read(s.plan.planId).recoveryHistory?.map((entry) => entry.source)).toEqual(["contract"]);
  });
  it("恢复归因成功但副作用未完成时保持pending，再次回查不再做归因查询", async () => {
    const s = await setup(); await unknown(s); s.backend.verifyPending = true;
    expect((await s.actions.reconcile(s.plan.planId)).state).toBe("applied_pending_verification");
    s.backend.verifyPending = false; expect((await s.actions.reconcile(s.plan.planId)).state).toBe("verified");
    expect(s.backend.reads).toBe(1); expect(s.backend.sends).toBe(1);
  });
  it("未登记恢复协议时保留明确的不可用状态与人工核对出口", async () => {
    const s = await setup(false, (c) => { delete c.recovery; }); await unknown(s);
    const result = await s.actions.reconcile(s.plan.planId);
    expect(result.state).toBe("outcome_unknown"); expect(result.errorCode).toBe("RECOVERY_UNAVAILABLE"); expect(s.backend.reads).toBe(0);
  });
  it("尚未发送的计划回查不触发恢复或消费执行资格", async () => {
    const s = await setup(); expect((await s.actions.reconcile(s.plan.planId)).state).toBe("prepared"); expect(s.backend.reads).toBe(0); expect(s.backend.sends).toBe(0);
  });
});

describe("有依据的人工核对", () => {
  it("执行授权不能被复用成人工核对授权，核对内容修改也必须重新确认", async () => {
    const s = await setup(); await unknown(s);
    await expect(s.actions.review(s.plan.planId, s.confirmation, review)).rejects.toMatchObject({ code: "CONFIRMATION_MISMATCH" });
    const confirmation = reviewConfirmation(s, review);
    await expect(s.actions.review(s.plan.planId, confirmation, { ...review, outcome: "not_applied" })).rejects.toMatchObject({ code: "CONFIRMATION_MISMATCH" });
    await expect(s.actions.execute(s.plan.planId, confirmation)).rejects.toMatchObject({ code: "CONFIRMATION_MISMATCH" });
    expect(s.backend.sends).toBe(1); expect(s.store.read(s.plan.planId).recoveryHistory).toBeUndefined();
  });
  it("人工确认已落地仍需常规副作用验证，并记录操作者和证据引用", async () => {
    const s = await setup(); await unknown(s); s.backend.verifyPending = true;
    const result = await s.actions.review(s.plan.planId, reviewConfirmation(s, review), review);
    expect(result.state).toBe("applied_pending_verification");
    expect(result.recoveryHistory?.[0]).toMatchObject({ source: "manual", status: "applied", reviewedBy: review.reviewedBy, evidenceReferences: review.evidenceReferences, confirmationReference: s.confirmation.reference });
    s.backend.verifyPending = false; expect((await s.actions.reconcile(s.plan.planId)).state).toBe("verified"); expect(s.backend.sends).toBe(1);
  });
  it("确认未落地有独立终态，重复execute也不重发旧计划", async () => {
    const s = await setup(); await unknown(s);
    expect((await s.actions.review(s.plan.planId, reviewConfirmation(s, { ...review, outcome: "not_applied", resultId: undefined }), { ...review, outcome: "not_applied", resultId: undefined })).state).toBe("not_applied");
    expect(s.store.read(s.plan.planId).state).toBe("not_applied");
    expect((await s.actions.execute(s.plan.planId, s.confirmation)).state).toBe("not_applied"); expect(s.backend.sends).toBe(1);
  });
  it("人工核对仍不明确时保留不确定性和全部核对记录", async () => {
    const s = await setup(); await unknown(s);
    await s.actions.review(s.plan.planId, reviewConfirmation(s, { ...review, outcome: "inconclusive", resultId: undefined }), { ...review, outcome: "inconclusive", resultId: undefined });
    const result = await s.actions.review(s.plan.planId, reviewConfirmation(s, { ...review, outcome: "not_applied", resultId: undefined }), { ...review, outcome: "not_applied", resultId: undefined });
    expect(result.recoveryHistory?.map((entry) => entry.status)).toEqual(["inconclusive", "not_applied"]);
  });
  it.each([
    { ...review, evidenceReferences: [] },
    { ...review, reviewedBy: " " },
    { ...review, resultId: undefined },
  ])("缺少核对依据、操作者或结果ID时拒绝记录为成功", async (invalid) => {
    const s = await setup(); await unknown(s);
    await expect(s.actions.review(s.plan.planId, s.confirmation, invalid)).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(s.store.read(s.plan.planId).state).toBe("outcome_unknown"); expect(s.backend.verifications).toBe(0);
  });
  it("人工核对也必须确认原计划指纹", async () => {
    const s = await setup(); await unknown(s);
    await expect(s.actions.review(s.plan.planId, { ...s.confirmation, fingerprint: "wrong" }, review)).rejects.toMatchObject({ code: "CONFIRMATION_MISMATCH" });
  });
  it("未发送或已验证的计划不能被人工核对改写", async () => {
    const s = await setup();
    await expect(s.actions.review(s.plan.planId, reviewConfirmation(s, review), review)).rejects.toMatchObject({ code: "INVALID_OPERATION_STATE" });
    s.backend.failWrite = false; await s.actions.execute(s.plan.planId, s.confirmation);
    await expect(s.actions.review(s.plan.planId, reviewConfirmation(s, { ...review, outcome: "not_applied" }), { ...review, outcome: "not_applied" })).rejects.toMatchObject({ code: "INVALID_OPERATION_STATE" });
  });
});

describe("恢复契约证据边界", () => {
  it("已声明probe输出进入冻结payload/header并被计划保存", async () => {
    const s = await setup(false, (c) => {
      c.probe!.outputPaths = { taskId: "data.taskId", nextTaskDefKey: "data.nextTaskDefKey" };
      c.request!.payload = { operationKey: { $ref: "operation.operationId" }, taskId: { $ref: "probe.taskId" }, next: { $ref: "probe.nextTaskDefKey" } };
      c.request!.headers = { "x-task-id": { $ref: "probe.taskId" } };
    });
    expect(s.plan.payload).toMatchObject({ taskId: "42", next: "solve" });
    expect(s.plan.requestHeaders).toEqual({ "x-task-id": "42" });
    expect(s.plan.probeOutput).toEqual({ taskId: "42", nextTaskDefKey: "solve" });
    expect(s.plan.probeOutput).not.toHaveProperty("approverId");
  });
  it.each(["taskId", "approverId"])("probe的%s改变会使原计划失效，且零写入", async (key) => {
    const s = await setup(false, (c) => {
      c.probe!.outputPaths = { taskId: "data.taskId", approverId: "data.approverId" };
      c.request!.payload = { operationKey: { $ref: "operation.operationId" }, taskId: { $ref: "probe.taskId" } };
    });
    s.backend.probeOutput[key] = "99";
    await expect(s.actions.execute(s.plan.planId, s.confirmation)).rejects.toMatchObject({ code: "PLAN_STALE" });
    expect(s.backend.sends).toBe(0);
  });
  it.each([undefined, null])("probe引用缺失或为空时不能生成可执行计划", async (value) => {
    await expect(setup(false, (c) => {
      c.probe!.outputPaths = { taskId: "data.taskId" };
      c.request!.payload = { operationKey: { $ref: "operation.operationId" }, taskId: { $ref: "probe.taskId" } };
    }, (backend) => { backend.probeOutput.taskId = value; })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("probe不能通过别名将认证凭据投影进计划", () => {
    const c = contract(); c.probe!.outputPaths = { taskId: "data.access_token" };
    expect(() => new ContractRegistry({ version: 1, scope, actions: [c] }, { allowSynthetic: true })).toThrowError(expect.objectContaining({ code: "VALIDATION_FAILED" }));
  });
  it("操作关联头部解析为冻结值并直接参与计划指纹", async () => {
    const s = await setup(false, (c) => {
      c.request!.payload = {};
      c.request!.headers = { "x-operation-id": { $ref: "operation.operationId" } };
    });
    expect(s.plan.requestHeaders).toEqual({ "x-operation-id": s.plan.operationId });
    const operation = s.store.read(s.plan.planId);
    operation.plan.requestHeaders!["x-operation-id"] = "different-operation";
    s.store.save(operation);
    await expect(s.actions.execute(s.plan.planId, s.confirmation)).rejects.toMatchObject({ code: "CONFIRMATION_MISMATCH" });
    expect(s.backend.sends).toBe(0);
  });
  it("动态业务头部变化也要求重新prepare，不能沿用原确认发送", async () => {
    const s = await setup(false, (c) => {
      c.preconditionFields = [];
      c.request!.headers = { "x-record-state": { $ref: "record.status" } };
    });
    s.backend.recordStatus = "Closed";
    await expect(s.actions.execute(s.plan.planId, s.confirmation)).rejects.toMatchObject({ code: "PLAN_STALE" });
    expect(s.backend.sends).toBe(0);
  });
  it("无写请求操作关联值时不能启用恢复", () => {
    const c = contract(); c.request!.payload = { status: "Closed" };
    expect(() => new ContractRegistry({ version: 1, scope, actions: [c] }, { allowSynthetic: true })).toThrow(/operation/);
  });
  it.each(["name", "status", "customItem62__c", "id"])("不能用%s作为归因关联字段", (field) => {
    const c = contract(); c.recovery!.correlationField = field;
    expect(() => new ContractRegistry({ version: 1, scope, actions: [c] }, { allowSynthetic: true })).toThrow(/关联字段/);
  });
  it("已有工单动作恢复必须校验事件与目标工单的关系", () => {
    const c = contract(); delete c.recovery!.targetField;
    expect(() => new ContractRegistry({ version: 1, scope, actions: [c] }, { allowSynthetic: true })).toThrow(/目标关联/);
  });
  it("恢复证据也必须拒绝synthetic进入生产", () => {
    const c = contract(); c.evidence = { ...evidence, source: "official" };
    expect(() => new ContractRegistry({ version: 1, scope, actions: [c] })).toThrow(/合成契约/);
  });
  it("可以通过已核验请求头传送操作关联ID，不要求伪造业务字段", () => {
    const c = contract(); c.request!.payload = {}; c.request!.headers = { "x-operation-id": { $ref: "operation.operationId" } };
    expect(() => new ContractRegistry({ version: 1, scope, actions: [c] }, { allowSynthetic: true })).not.toThrow();
  });
});
