// This suite tests the live-acceptance orchestrator with an injected CLI model.
// The runner must label that evidence synthetic and must never contact CRM.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fingerprint as planFingerprint } from "../../../src/tickets/actions.js";
import {
  classifyResult, LIVE_COVERAGE, parseArgs, runAcceptance, TEST_MARKER, validateManifest,
} from "../../../scripts/ticket-live-acceptance.mjs";

const directories: string[] = [];
beforeEach(() => vi.stubEnv("XSY_TICKET_WRITES", ""));
afterEach(() => { vi.unstubAllEnvs(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function directory() { const created = mkdtempSync(path.join(os.tmpdir(), "xsy-live-runner-test-")); directories.push(created); return created; }
function manifest(extra: Array<Record<string, unknown>> = []) {
  return { version: 1, suite: "synthetic-runner-suite", steps: [
    { key: "create", action: "create", input: { name: `${TEST_MARKER} Synthetic runner ticket`, status: 1, entityType: "2" } },
    ...extra,
  ] };
}
function response(value: unknown) { return { status: 0, stdout: JSON.stringify({ code: 200, result: value }), stderr: "" }; }
function harness() {
  const calls: string[][] = [], plans = new Map<string, Record<string, any>>(), operations = new Map<string, Record<string, any>>();
  let next = 0;
  const state = { row: undefined as Record<string, any> | undefined, nextOutcome: "verified", nextPrepareCode: "", appliedEffects: 0, wrongPlan: false, wrongMarker: false, wrongOperation: false, unsafeId: false };
  const invoke = async (original: string[]) => {
    calls.push([...original]); const args = [...original];
    if (args[0] === "--fields") args.splice(0, 2);
    const value = (flag: string) => args[args.indexOf(flag) + 1];
    if (args[0] !== "ticket") throw new Error("Unexpected non-ticket command");
    if (args[1] === "prepare") {
      const action = args[2], input = JSON.parse(value("--data")), sequence = ++next;
      if (state.nextPrepareCode) {
        const code = state.nextPrepareCode; state.nextPrepareCode = "";
        return { status: 1, stdout: "", stderr: JSON.stringify({ status: "error", code }) };
      }
      if (action === "escalate") return { status: 1, stdout: "", stderr: JSON.stringify({ status: "blocked", code: "UNVERIFIED", action }) };
      const planId = `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
      const plan = { planId, operationId: planId, action, input, payload: { data: { ...input } },
        targetId: args.includes("--id") ? value("--id") : undefined,
        fingerprint: `sha256:${sequence.toString(16).padStart(64, "0")}`,
        expiresAt: new Date(Date.now() + 300000).toISOString() };
      if (state.wrongPlan) plan.targetId = "999";
      if (state.wrongMarker) plan.payload.data.name = "An unmarked original CRM ticket";
      plans.set(planId, plan);
      operations.set(planId, { planId, operationId: planId, action, fingerprint: plan.fingerprint, state: "prepared" });
      return response({ status: "ready", plan });
    }
    if (args[1] === "get") return response({ ...state.row });
    if (args[1] === "operation") return response(operations.get(args[2]));
    if (args[1] !== "execute") throw new Error("Unexpected runner command");
    const plan = plans.get(args[2])!, outcome = state.nextOutcome; state.nextOutcome = "verified";
    if (outcome === "PLAN_STALE") return { status: 1, stdout: "", stderr: JSON.stringify({ status: "error", code: "PLAN_STALE" }) };
    if (["verified", "applied_pending_verification", "timeout", "outcome_unknown"].includes(outcome)) {
      state.appliedEffects++;
      if (plan.action === "create") state.row = { id: "101", name: plan.input.name, status: 1, customItem62__c: 1 };
      if (plan.action === "submit") Object.assign(state.row!, { status: 3, customItem62__c: 2 });
      if (plan.action === "close") Object.assign(state.row!, { status: 11, customItem62__c: 4 });
      if (plan.action === "reopen") Object.assign(state.row!, { status: 3, customItem62__c: 2 });
    }
    const operation = { planId: plan.planId, operationId: plan.planId, action: plan.action, fingerprint: plan.fingerprint,
      state: outcome === "timeout" ? "outcome_unknown" : outcome,
      resultId: plan.action === "create" ? "101" : plan.action === "attachment_upload" ? "201" : undefined };
    if (state.wrongOperation) operation.operationId = "00000000-0000-4000-8000-000000000099";
    if (state.unsafeId) (operation as Record<string, unknown>).resultId = Number.MAX_SAFE_INTEGER + 4;
    operations.set(plan.planId, operation);
    if (outcome === "timeout") return { status: null, stdout: "", stderr: "", processError: true };
    if (outcome === "verified") return response(operation);
    return { status: outcome === "rejected" ? 1 : outcome === "applied_pending_verification" ? 3 : 2,
      stdout: "", stderr: JSON.stringify({ code: outcome === "rejected" ? "REMOTE_REJECTED" : "OUTCOME_UNKNOWN", operation }) };
  };
  return { invoke, calls, plans, operations, state, executions: () => calls.filter((args) => args[0] === "ticket" && args[1] === "execute") };
}
function pending(report: Record<string, any>) { return report.steps.find((step: Record<string, any>) => !["live_passed", "synthetic_passed"].includes(step.outcome)); }
async function prepare(input: unknown, output: string, fake: ReturnType<typeof harness>) {
  return runAcceptance({ manifest: input, output, mode: "prepare" }, { invoke: fake.invoke });
}
async function execute(input: unknown, output: string, fake: ReturnType<typeof harness>, fingerprint: string) {
  return runAcceptance({ manifest: input, output, mode: "execute", confirm: fingerprint, confirmationReference: "synthetic existing user authorization" }, { invoke: fake.invoke });
}
async function existingCreate(fake: ReturnType<typeof harness>, input: ReturnType<typeof manifest>) {
  const stateDirectory = path.join(directory(), "operations"); mkdirSync(stateDirectory, { mode: 0o700 });
  vi.stubEnv("XSY_TICKET_STATE_DIR", stateDirectory);
  const prepared = await fake.invoke(["ticket", "prepare", "create", "--data", JSON.stringify(input.steps[0].input), "--ttl", "300"]);
  const plan = JSON.parse(prepared.stdout).result.plan;
  plan.contextKey = "synthetic-current-context"; plan.fingerprint = planFingerprint(plan);
  const operation = { planId: plan.planId, operationId: plan.planId, action: "create", fingerprint: plan.fingerprint, state: "verified", resultId: "101" };
  fake.operations.set(plan.planId, operation);
  fake.state.row = { id: "101", name: input.steps[0].input.name, status: 1, customItem62__c: 1 };
  const ledger = { plan, state: "verified", submission: { id: "101", output: {} }, updatedAt: new Date().toISOString() };
  const file = path.join(stateDirectory, `${plan.planId}.json`);
  writeFileSync(file, JSON.stringify(ledger), { mode: 0o600 }); fake.calls.splice(0);
  return { plan, operation, ledger, file };
}

describe("真实验收runner的默认门禁、来源绑定和证据分类", () => {
  it("默认dry-run不运行任何CLI或CRM调用，也不声称线上验收通过", async () => {
    const fake = harness(), result = await runAcceptance({ manifest: manifest(), output: directory() }, { invoke: fake.invoke });
    expect(fake.calls).toHaveLength(0); expect(result.cliCalls).toBe(0);
    expect(result.evidenceKind).toBe("none"); expect(result.liveAcceptancePassed).toBe(false);
    expect(result.steps[0].outcome).toBe("not_run");
  });

  it("拒绝未标记工单、已有目标ID、重复create和未来资源引用", () => {
    const unmarked = manifest(); unmarked.steps[0].input.name = "Original customer ticket";
    expect(() => validateManifest(unmarked)).toThrow("TEST_TARGET_MARKER_REQUIRED");
    expect(() => validateManifest({ ...manifest(), ticketId: "999" })).toThrow("INVALID_MANIFEST");
    expect(() => validateManifest(manifest([{ key: "second", action: "create", input: {} }]))).toThrow("FRESH_CREATE_REQUIRED");
    expect(() => validateManifest(manifest([{ key: "link", action: "attachment_link", input: { attachmentId: { $from: "steps.future.resultId" } } }]))).toThrow("INVALID_BINDING");
    expect(() => validateManifest(manifest([{ key: "submit", action: "submit", targetId: "999", input: {} }]))).toThrow("INVALID_MANIFEST_STEP");
  });

  it("拒绝清单携带凭据和CLI命令伪装", () => {
    const input = manifest(); (input.steps[0].input as Record<string, unknown>).accessToken = "synthetic-secret";
    expect(() => validateManifest(input)).toThrow("UNSAFE_MANIFEST_FIELD");
    expect(() => parseArgs(["--execute", "--dry-run"])).toThrow("CONFLICTING_MODES");
    expect(() => parseArgs(["--ticket-id", "999"])).toThrow("INVALID_OPTIONS");
    expect(() => parseArgs(["--manifest", "--execute"])).toThrow("INVALID_OPTIONS");
  });

  it("prepare仅生成可审核计划，注入测试始终标synthetic而不是live", async () => {
    const fake = harness(), output = directory(), result = await prepare(manifest(), output, fake);
    expect(fake.executions()).toHaveLength(0); expect(result.steps[0].outcome).toBe("awaiting_approval");
    expect(result.evidenceKind).toBe("synthetic"); expect(result.liveAcceptancePassed).toBe(false);
    expect(existsSync(path.join(output, result.steps[0].planArtifact))).toBe(true);
    expect(classifyResult(response({ state: "verified" }), "synthetic").outcome).toBe("synthetic_passed");
    expect(classifyResult(response({ state: "verified" }), "live").outcome).toBe("live_passed");
  });

  it("读取配置修正后prepare成功会清理旧拒绝/进程错误及过期结果诊断", async () => {
    vi.stubEnv("XSY_TICKET_WRITES", "1");
    const fake = harness(), output = directory(), input = manifest([{ key: "submit", action: "submit", input: {} }]);
    const created = await prepare(input, output, fake); fake.state.nextPrepareCode = "ACTION_NOT_ALLOWED";
    const denied = await execute(input, output, fake, pending(created).fingerprint);
    expect(denied.steps[1]).toMatchObject({ outcome: "blocked", code: "ACTION_NOT_ALLOWED" });
    const file = path.join(output, "checkpoint.json"), checkpoint = JSON.parse(readFileSync(file, "utf8"));
    Object.assign(checkpoint.steps[1], { processError: true, errorCode: "OLD_ERROR", errorMessage: "old diagnostic", remoteError: { serverCode: 400 },
      verification: { checkCount: 1 }, serverVerified: true, resultId: "999" });
    writeFileSync(file, JSON.stringify(checkpoint));
    const refreshed = await prepare(input, output, fake), current = pending(refreshed);
    expect(current.outcome).toBe("awaiting_approval");
    for (const key of ["code", "processError", "errorCode", "errorMessage", "remoteError", "verification", "serverVerified", "resultId"])
      expect(current).not.toHaveProperty(key);
    expect(fake.state.appliedEffects).toBe(1); // Only the already-confirmed create.
  });

  it.each(["ACTION_NOT_ALLOWED", "PLAN_STALE"])("旧awaiting_approval遗留%s时，清理诊断且stale计划不得继续复用", async (legacyCode) => {
    const fake = harness(), output = directory(), input = manifest(), prepared = await prepare(input, output, fake);
    const file = path.join(output, "checkpoint.json"), checkpoint = JSON.parse(readFileSync(file, "utf8"));
    Object.assign(checkpoint.steps[0], { code: legacyCode, processError: true }); writeFileSync(file, JSON.stringify(checkpoint));
    const refreshed = await prepare(input, output, fake), current = pending(refreshed);
    expect(current.outcome).toBe("awaiting_approval"); expect(current).not.toHaveProperty("code"); expect(current).not.toHaveProperty("processError");
    if (legacyCode === "PLAN_STALE") {
      expect(current.planId).not.toBe(prepared.steps[0].planId);
      expect(current.previousPlans.at(-1)).toMatchObject({ planId: prepared.steps[0].planId, code: "PLAN_STALE" });
      expect(fake.calls.filter((args) => args[1] === "prepare")).toHaveLength(2);
    } else {
      expect(current.planId).toBe(prepared.steps[0].planId);
      expect(fake.calls.filter((args) => args[1] === "prepare")).toHaveLength(1);
    }
    expect(fake.executions()).toHaveLength(0);
  });

  it("执行发现外部附件变更导致PLAN_STALE时零业务写入，重新prepare产生新计划并保留旧账本", async () => {
    vi.stubEnv("XSY_TICKET_WRITES", "1");
    const fake = harness(), output = directory(), input = manifest([{ key: "submit", action: "submit", input: {} }]);
    let report = await prepare(input, output, fake);
    report = await execute(input, output, fake, pending(report).fingerprint);
    const oldPlan = pending(report), beforePlan = JSON.stringify(fake.plans.get(oldPlan.planId)), beforeLedger = JSON.stringify(fake.operations.get(oldPlan.planId));
    // Another approved client links a file after preview. The domain engine,
    // not this runner, detects its changed snapshot before sending submit.
    fake.state.row!.customItem69__c = ["201"]; fake.state.nextOutcome = "PLAN_STALE";
    const stale = await execute(input, output, fake, oldPlan.fingerprint);
    expect(pending(stale)).toMatchObject({ outcome: "blocked", code: "PLAN_STALE", planId: oldPlan.planId });
    expect(fake.state.appliedEffects).toBe(1);
    expect(JSON.stringify(fake.operations.get(oldPlan.planId))).toBe(beforeLedger);
    report = await prepare(input, output, fake);
    const fresh = pending(report);
    expect(fresh.outcome).toBe("awaiting_approval"); expect(fresh).not.toHaveProperty("code");
    expect(fresh.planId).not.toBe(oldPlan.planId); expect(fresh.fingerprint).not.toBe(oldPlan.fingerprint);
    expect(fresh.previousPlans.at(-1)).toMatchObject({ planId: oldPlan.planId, outcome: "blocked", code: "PLAN_STALE" });
    expect(JSON.stringify(fake.plans.get(oldPlan.planId))).toBe(beforePlan);
    expect(JSON.stringify(fake.operations.get(oldPlan.planId))).toBe(beforeLedger);
    await expect(execute(input, output, fake, oldPlan.fingerprint)).rejects.toThrow("CONFIRMATION_MISMATCH");
    expect(fake.state.appliedEffects).toBe(1);
    expect((await execute(input, output, fake, fresh.fingerprint)).complete).toBe(true);
    expect(fake.state.appliedEffects).toBe(2);
    expect(JSON.stringify(fake.operations.get(oldPlan.planId))).toBe(beforeLedger);
  });

  it("execute必须显式启用写入，且不能用另一个计划指纹自动批准", async () => {
    const fake = harness(), output = directory(), input = manifest(), prepared = await prepare(input, output, fake);
    await expect(execute(input, output, fake, prepared.steps[0].fingerprint)).rejects.toThrow("WRITES_DISABLED");
    vi.stubEnv("XSY_TICKET_WRITES", "1");
    await expect(execute(input, output, fake, `sha256:${"f".repeat(64)}`)).rejects.toThrow("CONFIRMATION_MISMATCH");
    expect(fake.executions()).toHaveLength(0);
    expect(JSON.parse(readFileSync(path.join(output, "checkpoint.json"), "utf8")).steps[0].outcome).toBe("awaiting_approval");
  });

  it("每次只执行调用者已确认的计划，后续ID从create返回值串联，完成后也不重发", async () => {
    vi.stubEnv("XSY_TICKET_WRITES", "1");
    const fake = harness(), output = directory(), input = manifest([
      { key: "submit", action: "submit", input: {} },
      { key: "reply", action: "reply", input: { body: "Synthetic acceptance reply" } },
    ]);
    let report = await prepare(input, output, fake);
    for (let step = 0; step < 3; step++) {
      const fingerprint = pending(report).fingerprint;
      report = await execute(input, output, fake, fingerprint);
      expect(fake.executions()).toHaveLength(step + 1);
    }
    expect(report.complete).toBe(true); expect(report.liveAcceptancePassed).toBe(false);
    expect(report.ticketId).toBe("101"); expect(report.steps.every((step: Record<string, unknown>) => step.outcome === "synthetic_passed")).toBe(true);
    const prepareCalls = fake.calls.filter((args) => args[0] === "ticket" && args[1] === "prepare");
    expect(prepareCalls.slice(1).every((args) => args[args.indexOf("--id") + 1] === "101")).toBe(true);
    await execute(input, output, fake, report.steps[0].fingerprint); expect(fake.executions()).toHaveLength(3);
  });

  it("附件关联句柄仅来自已验证上传返回值，不硬编码其他工单资源", async () => {
    vi.stubEnv("XSY_TICKET_WRITES", "1");
    const fake = harness(), output = directory(), input = manifest([
      { key: "upload", action: "attachment_upload", input: { filePath: "/tmp/synthetic-only.txt" } },
      { key: "link", action: "attachment_link", input: { attachmentId: { $from: "steps.upload.resultId" } } },
    ]);
    let report = await prepare(input, output, fake);
    for (let index = 0; index < 3; index++) report = await execute(input, output, fake, pending(report).fingerprint);
    const link = fake.calls.find((args) => args[0] === "ticket" && args[1] === "prepare" && args[2] === "attachment_link")!;
    expect(JSON.parse(link[link.indexOf("--data") + 1]).attachmentId).toBe("201");
    expect(link[link.indexOf("--id") + 1]).toBe("101");
  });

  it("预处理无业务resultId时，advance仅可绑定已verified前置步骤的operationId", async () => {
    vi.stubEnv("XSY_TICKET_WRITES", "1");
    const fake = harness(), output = directory(), input = manifest([
      { key: "preprocess", action: "workflow_preprocess", input: {} },
      { key: "advance", action: "advance", input: { preprocessingOperationId: { $from: "steps.preprocess.operationId" } } },
      { key: "activity", action: "activity_record", input: { content: "Synthetic activity" } },
    ]);
    let report = await prepare(input, output, fake);
    for (let index = 0; index < 4; index++) report = await execute(input, output, fake, pending(report).fingerprint);
    const preprocess = report.steps.find((step: Record<string, unknown>) => step.key === "preprocess");
    expect(preprocess.resultId).toBeUndefined();
    const advance = fake.calls.find((args) => args[0] === "ticket" && args[1] === "prepare" && args[2] === "advance")!;
    expect(JSON.parse(advance[advance.indexOf("--data") + 1]).preprocessingOperationId).toBe(preprocess.planId);
    expect(report.complete).toBe(true);
    expect(() => validateManifest(manifest([{ key: "advance", action: "advance", input: { preprocessingOperationId: { $from: "steps.future.operationId" } } }]))).toThrow("INVALID_BINDING");
  });

  it("预处理pending时不得把operationId提前传给advance", async () => {
    vi.stubEnv("XSY_TICKET_WRITES", "1");
    const fake = harness(), output = directory(), input = manifest([
      { key: "preprocess", action: "workflow_preprocess", input: {} },
      { key: "advance", action: "advance", input: { preprocessingOperationId: { $from: "steps.preprocess.operationId" } } },
    ]);
    let report = await prepare(input, output, fake);
    report = await execute(input, output, fake, pending(report).fingerprint);
    fake.state.nextOutcome = "applied_pending_verification";
    report = await execute(input, output, fake, pending(report).fingerprint);
    expect(report.steps[1].outcome).toBe("pending_verification");
    expect(report.steps[2].outcome).toBe("not_run");
    expect(fake.calls.some((args) => args[1] === "prepare" && args[2] === "advance")).toBe(false);
  });

  it("超时后只能回查原操作，不再次execute或重新prepare创建", async () => {
    vi.stubEnv("XSY_TICKET_WRITES", "1");
    const fake = harness(), output = directory(), input = manifest(), prepared = await prepare(input, output, fake);
    fake.state.nextOutcome = "timeout";
    const first = await execute(input, output, fake, prepared.steps[0].fingerprint);
    expect(first.steps[0].outcome).toBe("outcome_unknown"); expect(first.ticketId).toBeNull();
    const again = await execute(input, output, fake, prepared.steps[0].fingerprint);
    expect(again.steps[0].outcome).toBe("outcome_unknown");
    expect(fake.executions()).toHaveLength(1);
    expect(fake.calls.filter((args) => args[1] === "prepare")).toHaveLength(1);
    expect(fake.calls.some((args) => args[1] === "operation" && args.includes("--reconcile"))).toBe(true);
  });

  it("只读对账可恢复已落地的创建ID，随后仍等待下一步单独确认", async () => {
    vi.stubEnv("XSY_TICKET_WRITES", "1");
    const fake = harness(), output = directory(), input = manifest([{ key: "submit", action: "submit", input: {} }]), prepared = await prepare(input, output, fake);
    fake.state.nextOutcome = "outcome_unknown";
    await execute(input, output, fake, prepared.steps[0].fingerprint);
    fake.operations.get(prepared.steps[0].planId)!.state = "verified";
    vi.stubEnv("XSY_TICKET_WRITES", "");
    const reconciled = await runAcceptance({ manifest: input, output, mode: "reconcile" }, { invoke: fake.invoke });
    expect(reconciled.ticketId).toBe("101"); expect(reconciled.steps[0].outcome).toBe("synthetic_passed");
    expect(reconciled.steps[1].outcome).toBe("not_run"); expect(fake.executions()).toHaveLength(1);
  });

  it.each(["rejected", "applied_pending_verification"])("%s不能报告通过或继续下一步", async (state) => {
    vi.stubEnv("XSY_TICKET_WRITES", "1");
    const fake = harness(), output = directory(), input = manifest([{ key: "submit", action: "submit", input: {} }]), prepared = await prepare(input, output, fake);
    fake.state.nextOutcome = state;
    const result = await execute(input, output, fake, prepared.steps[0].fingerprint);
    expect(result.steps[0].outcome).toBe(state === "rejected" ? "rejected" : "pending_verification");
    expect(result.steps[1].outcome).toBe("not_run"); expect(result.liveAcceptancePassed).toBe(false);
  });

  it("未核验动作只记录unverified，不能被当作一次真实通过", async () => {
    vi.stubEnv("XSY_TICKET_WRITES", "1");
    const fake = harness(), output = directory(), input = manifest([{ key: "escalate", action: "escalate", input: {} }]), prepared = await prepare(input, output, fake);
    const result = await execute(input, output, fake, prepared.steps[0].fingerprint);
    expect(result.steps[1]).toMatchObject({ outcome: "unverified", code: "UNVERIFIED" });
    expect(fake.executions()).toHaveLength(1); expect(result.complete).toBe(false);
  });

  it("目标名称改变或未经本run关闭的目标已关闭时拒绝后续写入", async () => {
    vi.stubEnv("XSY_TICKET_WRITES", "1");
    const fake = harness(), output = directory(), input = manifest([{ key: "submit", action: "submit", input: {} }]);
    const prepared = await prepare(input, output, fake), next = await execute(input, output, fake, prepared.steps[0].fingerprint);
    fake.state.row!.name = "Original unrelated closed ticket";
    await expect(execute(input, output, fake, pending(next).fingerprint)).rejects.toThrow("TEST_TARGET_SCOPE_MISMATCH");
    fake.state.row!.name = input.steps[0].input.name; fake.state.row!.status = 11; fake.state.row!.customItem62__c = 4;
    await expect(execute(input, output, fake, pending(next).fingerprint)).rejects.toThrow("CLOSED_TEST_TARGET_PROTECTED");
    expect(fake.executions()).toHaveLength(1);
  });

  it("本run自己关闭的新工单可经单独确认重开，旧关闭测试单没有入口", async () => {
    vi.stubEnv("XSY_TICKET_WRITES", "1");
    const fake = harness(), output = directory(), input = manifest([
      { key: "close", action: "close", input: {} }, { key: "reopen", action: "reopen", input: {} },
    ]);
    let report = await prepare(input, output, fake);
    for (let index = 0; index < 3; index++) report = await execute(input, output, fake, pending(report).fingerprint);
    expect(report.complete).toBe(true); expect(fake.state.row!.status).toBe(3);
    expect(() => parseArgs(["--existing-id", "999"])).toThrow("INVALID_OPTIONS");
  });

  it("额外回读不符合预期时保持pending而不是以CLI退出0推断通过", async () => {
    vi.stubEnv("XSY_TICKET_WRITES", "1");
    const fake = harness(), output = directory(), input = manifest();
    (input.steps[0] as Record<string, unknown>).expected = { status: 999 };
    const prepared = await prepare(input, output, fake), result = await execute(input, output, fake, prepared.steps[0].fingerprint);
    expect(result.steps[0]).toMatchObject({ outcome: "pending_verification", code: "ACCEPTANCE_READBACK_PENDING" });
    expect(result.complete).toBe(false); expect(result.liveAcceptancePassed).toBe(false);
    const reconciled = await runAcceptance({ manifest: input, output, mode: "reconcile" }, { invoke: fake.invoke });
    expect(reconciled.steps[0]).toMatchObject({ outcome: "pending_verification", code: "ACCEPTANCE_READBACK_PENDING" });
    expect(reconciled.complete).toBe(false); expect(fake.executions()).toHaveLength(1);
    fake.state.row!.status = 999;
    const matched = await runAcceptance({ manifest: input, output, mode: "reconcile" }, { invoke: fake.invoke });
    expect(matched.complete).toBe(true); expect(matched.liveAcceptancePassed).toBe(false); expect(fake.executions()).toHaveLength(1);
  });

  it("创建后的显式验收可引用当步返回ID，未完成的预期检查不能被恢复绕过", async () => {
    vi.stubEnv("XSY_TICKET_WRITES", "1");
    const fake = harness(), output = directory(), input = manifest();
    (input.steps[0] as Record<string, unknown>).expected = { id: { $from: "steps.create.resultId" } };
    const prepared = await prepare(input, output, fake), result = await execute(input, output, fake, prepared.steps[0].fingerprint);
    expect(result.complete).toBe(true); expect(result.steps[0].resultId).toBe("101");
  });

  it("可只读采用当前context下verified create，不接受任意existing ID且不重复创建", async () => {
    const fake = harness(), input = manifest([{ key: "submit", action: "submit", input: {} }]), source = await existingCreate(fake, input);
    const report = await runAcceptance({ manifest: input, output: directory(), mode: "prepare", adoptCreateOperation: source.plan.planId }, { invoke: fake.invoke });
    expect(report.ticketId).toBe("101"); expect(report.creationOperationId).toBe(source.plan.planId);
    expect(report.steps[0]).toMatchObject({ outcome: "synthetic_passed", fingerprint: source.plan.fingerprint });
    expect(report.steps[1].outcome).toBe("awaiting_approval");
    expect(fake.calls.some((args) => args[1] === "prepare" && args[2] === "create")).toBe(false);
    expect(fake.executions()).toHaveLength(0);
    expect(fake.calls.some((args) => args[1] === "operation" && args[2] === source.plan.planId)).toBe(true);
  });

  it("adopt标志在默认dry-run下仍零CLI调用", async () => {
    const fake = harness(), input = manifest(), source = await existingCreate(fake, input);
    const result = await runAcceptance({ manifest: input, output: directory(), adoptCreateOperation: source.plan.planId }, { invoke: fake.invoke });
    expect(fake.calls).toHaveLength(0); expect(result.ticketId).toBeNull(); expect(result.evidenceKind).toBe("none");
  });

  it("adopt要求完整input一致，不能用重算过的有效指纹替代原清单授权范围", async () => {
    const fake = harness(), input = manifest(), source = await existingCreate(fake, input);
    source.ledger.plan.input.status = 3;
    source.ledger.plan.fingerprint = planFingerprint(source.ledger.plan);
    source.operation.fingerprint = source.ledger.plan.fingerprint;
    writeFileSync(source.file, JSON.stringify(source.ledger));
    await expect(runAcceptance({ manifest: input, output: directory(), mode: "prepare", adoptCreateOperation: source.plan.planId }, { invoke: fake.invoke })).rejects.toThrow("ADOPTION_SCOPE_MISMATCH");
    expect(fake.executions()).toHaveLength(0);
  });

  it.each(["not-create", "not-verified", "context-denied", "fingerprint", "input", "title"])("拒绝adopt来源不符：%s", async (failure) => {
    const fake = harness(), input = manifest(), source = await existingCreate(fake, input);
    if (failure === "not-create") source.operation.action = "assign";
    if (failure === "not-verified") source.operation.state = "outcome_unknown";
    if (failure === "fingerprint") source.operation.fingerprint = `sha256:${"f".repeat(64)}`;
    if (failure === "input") { source.ledger.plan.input.status = 3; writeFileSync(source.file, JSON.stringify(source.ledger)); }
    if (failure === "title") fake.state.row!.name = "An original unrelated test ticket";
    const invoke = failure === "context-denied"
      ? async () => ({ status: 1, stdout: "", stderr: JSON.stringify({ status: "error", code: "CONTEXT_MISMATCH" }) })
      : fake.invoke;
    await expect(runAcceptance({ manifest: input, output: directory(), mode: "prepare", adoptCreateOperation: source.plan.planId }, { invoke })).rejects.toThrow();
    expect(fake.executions()).toHaveLength(0);
    expect(fake.calls.some((args) => args[1] === "prepare")).toBe(false);
  });

  it("即使创建来源和标题匹配，也不能adopt原来已关闭的测试单", async () => {
    const fake = harness(), input = manifest(), source = await existingCreate(fake, input);
    fake.state.row!.status = 11; fake.state.row!.customItem62__c = 4;
    await expect(runAcceptance({ manifest: input, output: directory(), mode: "prepare", adoptCreateOperation: source.plan.planId }, { invoke: fake.invoke })).rejects.toThrow("CLOSED_TEST_TARGET_PROTECTED");
    expect(fake.executions()).toHaveLength(0);
  });

  it("不能将另一个清单或synthetic证据checkpoint提升成真实线上验收", async () => {
    const fake = harness(), output = directory(), input = manifest(); await prepare(input, output, fake);
    const changed = manifest(); changed.steps[0].input.name += " changed";
    await expect(prepare(changed, output, fake)).rejects.toThrow("CHECKPOINT_SCOPE_MISMATCH");
    // No dependency injection here: scope validation must stop before the real
    // CLI could be called, even in a dry run.
    await expect(runAcceptance({ manifest: input, output })).rejects.toThrow("CHECKPOINT_SCOPE_MISMATCH");
    expect(fake.executions()).toHaveLength(0);
  });

  it("返回的计划、操作ID和不安全数值ID都需要核验，不能串到旧目标", async () => {
    const input = manifest();
    const wrong = harness(); wrong.state.wrongPlan = true;
    await expect(prepare(input, directory(), wrong)).rejects.toThrow("PREPARED_PLAN_SCOPE_MISMATCH");
    const unmarked = harness(); unmarked.state.wrongMarker = true;
    await expect(prepare(input, directory(), unmarked)).rejects.toThrow("TEST_TARGET_MARKER_REQUIRED");
    vi.stubEnv("XSY_TICKET_WRITES", "1");
    const fake = harness(), output = directory(), prepared = await prepare(input, output, fake); fake.state.wrongOperation = true;
    await expect(execute(input, output, fake, prepared.steps[0].fingerprint)).rejects.toThrow("OPERATION_SCOPE_MISMATCH");
    const unsafe = harness(), other = directory(), another = await prepare(input, other, unsafe); unsafe.state.unsafeId = true;
    await expect(execute(input, other, unsafe, another.steps[0].fingerprint)).rejects.toThrow("UNSAFE_RECORD_ID");
  });

  it("证据目录0700、原始输出与checkpoint/summary 0600，锁残留和符号链接保守拒绝", async () => {
    const fake = harness(), output = directory(); await prepare(manifest(), output, fake);
    expect(lstatSync(output).mode & 0o777).toBe(0o700);
    expect(readdirSync(output).every((entry) => (lstatSync(path.join(output, entry)).mode & 0o777) === 0o600)).toBe(true);
    writeFileSync(path.join(output, "runner.lock"), JSON.stringify({ pid: 2147483647, nonce: "synthetic stale runner" }), { mode: 0o600 });
    await expect(prepare(manifest(), output, fake)).rejects.toThrow("RUNNER_LOCKED_REVIEW_BEFORE_RECOVERY");
    expect(existsSync(path.join(output, "runner.lock"))).toBe(true);
    const parent = directory(), actual = path.join(parent, "actual"), link = path.join(parent, "link"); mkdirSync(actual); symlinkSync(actual, link);
    await expect(prepare(manifest(), link, fake)).rejects.toThrow("UNSAFE_OUTPUT_DIRECTORY");
  });

  it("覆盖表明确区分安全真实验收与只能离线确定性故障注入", () => {
    expect(LIVE_COVERAGE.find((entry) => entry.case === "concurrent execution")?.safeLive).toBe("offline-deterministic");
    expect(LIVE_COVERAGE.find((entry) => entry.case === "timeout/unknown result/process crash")?.safeLive).toBe("offline-fault-injection");
    expect(LIVE_COVERAGE.find((entry) => entry.case === "missing required fields")?.safeLive).toBe("prepare-only");
    expect(LIVE_COVERAGE.find((entry) => entry.case === "current-user permissions")?.proof).toContain("other roles");
  });

  it("未验证、不支持和本地/权限阻止保持不同口径，shell成功不能替代业务验证", () => {
    const rejected = (code: string) => ({ status: 1, stdout: "", stderr: JSON.stringify({ status: "error", code }) });
    expect(classifyResult(rejected("UNVERIFIED"))).toMatchObject({ outcome: "unverified", code: "UNVERIFIED" });
    expect(classifyResult(rejected("UNSUPPORTED"))).toMatchObject({ outcome: "unsupported", code: "UNSUPPORTED" });
    expect(classifyResult(rejected("FORBIDDEN"))).toMatchObject({ outcome: "blocked", code: "FORBIDDEN" });
    expect(classifyResult(response({ state: "prepared" }))).toMatchObject({ outcome: "failed" });
  });

  it("prepare进程中断只标读取受阻，可以重做prepare，不冒称发生未知CRM写入", async () => {
    const output = directory(), input = manifest(), fake = harness();
    let failOnce = true;
    const invoke = async (args: string[]) => {
      if (failOnce) { failOnce = false; return { status: null, stdout: "", stderr: "", processError: true }; }
      return fake.invoke(args);
    };
    const first = await runAcceptance({ manifest: input, output, mode: "prepare" }, { invoke });
    expect(first.steps[0]).toMatchObject({ outcome: "blocked", code: "PREPARE_READ_UNCERTAIN" });
    const second = await runAcceptance({ manifest: input, output, mode: "prepare" }, { invoke });
    expect(second.steps[0].outcome).toBe("awaiting_approval"); expect(fake.executions()).toHaveLength(0);
  });
});
