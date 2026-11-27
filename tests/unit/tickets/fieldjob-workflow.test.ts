import { describe, expect, it } from "vitest";
import {
  createFieldJobWorkflowProfile, discoverFieldJobWorkflow, guardFieldJobWorkflowInspection,
  trustedPreprocessingFromOperation, validateFieldJobWorkflowSubmission,
  type FieldJobWorkflowReader,
} from "../../../src/tickets/fieldjob-workflow.js";
import { ContractRegistry, digest, projectProbeOutput, template } from "../../../src/tickets/contracts.js";
import type { ActionContract, Inspection, RecordData, RequestSpec, TicketContext, TicketOperation, TicketPlan } from "../../../src/tickets/types.js";

const NOW = Date.UTC(2026, 10, 27, 0);
const context: TicketContext = { key: "synthetic-workflow-context", apiBaseUrl: "https://api.example.test", crmBaseUrl: "https://crm.example.test", tenantId: "synthetic-tenant", subjectId: "3", identityVerified: true };
const record: RecordData = { id: "1", entityType: "2", status: 3, customItem62__c: 3 };
const candidate = { id: 3, name: "Synthetic Engineer", label: "Synthetic Engineer" };
function nextData(terminal = false): RecordData {
  return { procdefId: 11, nextTaskDefKey: terminal ? null : "task_next", nextTaskDefName: terminal ? null : "Synthetic next task",
    nextTaskType: terminal ? "EndNoneEvent" : "UserTask", nextEndNodeFlag: terminal, showAgreeFields: false,
    chooseApprover: terminal ? null : [candidate],
    nextUserTasks: terminal ? null : [{ nextTaskDefKey: "task_next", nextTaskDefName: "Synthetic next task", candidates: [3], chooseApprover: [candidate], nextUsertaskType: 1, nextAdjustAssigneeFlag: false, optionalChooseApprover: false }],
  };
}
function permission(taskId: number | null = null, submit = true) {
  return { code: "200", data: { task: { taskId, editableFields: [{ itemApiKey: "reportText__c", editable: true, required: false }] }, actions: {
    submit: { permission: submit }, agree: { permission: !submit && taskId !== null }, reject: { permission: !submit && taskId !== null },
  } } };
}
function profile() {
  return createFieldJobWorkflowProfile({
    scope: { apiBaseUrl: context.apiBaseUrl, crmBaseUrl: context.crmBaseUrl, tenantId: context.tenantId! }, entityTypes: ["2"],
    evidence: { source: "synthetic", reference: "offline workflow fixtures derived from response shapes only", verifiedAt: "2026-11-27T00:00:00+08:00" },
    guards: {
      submit: [{ field: "customItem62__c", expected: 1 }], advance: [{ field: "customItem62__c", expected: 2 }], close: [{ field: "customItem62__c", expected: 3 }],
    },
    verify: { submit: { checks: [{ field: "customItem62__c", expected: 2 }] }, advance: { checks: [{ field: "customItem62__c", expected: 3 }] }, close: { checks: [{ field: "customItem62__c", expected: 4 }] } },
  });
}
function contract(kind: string) { return profile().actions.find((action) => action.action === kind)!; }
function inspected(c: ActionContract, taskId: number | null = null, data = nextData()): Inspection {
  let output: RecordData = projectProbeOutput(permission(taskId, c.action === "submit"), c.probe!.outputPaths);
  for (const read of c.probe!.reads ?? []) output = { ...output, ...projectProbeOutput({ code: "200", data }, read.outputPaths) };
  return { record: { ...record }, permission: "allowed", allowed: "allowed", identityVerified: true, fields: {}, defaults: {}, required: [], formVersion: "synthetic", output };
}
function operation(terminal = false): TicketOperation {
  const c = contract("workflow_preprocess"), i = guardFieldJobWorkflowInspection(c, inspected(c, 12), {});
  const input = { workflowRecord: i.defaults.workflowRecord };
  const unsigned: Omit<TicketPlan, "fingerprint"> = {
    planId: "00000000-0000-4000-8000-000000000001", operationId: "00000000-0000-4000-8000-000000000001",
    contextKey: context.key, action: "workflow_preprocess", targetId: "1", contractVersion: c.version, contractHash: digest(c), snapshotHash: "synthetic",
    input, payload: template(c.request!.payload, { input, target: { id: "1" }, probe: i.output }), probeOutput: i.output,
    effects: c.effects, createdAt: new Date(NOW).toISOString(), expiresAt: new Date(NOW + 60000).toISOString(), concurrency: "best_effort",
  };
  const submission = validateFieldJobWorkflowSubmission(c, { output: projectProbeOutput({ code: "200", data: nextData(terminal) }, c.request!.outputPaths) });
  return { plan: { ...unsigned, fingerprint: `sha256:${digest(unsigned)}` }, state: "verified", submission, updatedAt: new Date(NOW).toISOString() };
}
class Reader implements FieldJobWorkflowReader {
  calls: Array<{ request: RequestSpec; bindings: RecordData }> = [];
  current = { ...context };
  parent = { ...record, customItem62__c: 1, status: 1 };
  permission = permission();
  chooser: unknown = { code: "200", data: nextData() };
  async context() { return this.current; }
  async get(id: string, fields?: string[]) { expect(id).toBe(String(this.parent.id)); expect(fields).toEqual(["id", "entityType", "status", "customItem62__c"]); return this.parent; }
  async readRequest(request: RequestSpec, bindings: RecordData) { this.calls.push({ request, bindings }); return request.path.endsWith("getPermission") ? this.permission : this.chooser; }
}

describe("通用fieldJob工作流发现", () => {
  it("只调用已核验读取，动态返回任务、权限、下一节点和候选，无单测试单绑定", async () => {
    const reader = new Reader(); reader.parent.id = "42";
    const result = await discoverFieldJobWorkflow(reader, "42");
    expect(result).toMatchObject({ targetId: "42", state: "draft", task: { id: null }, allowedActions: ["submit"], chooser: { status: "ready", transition: { key: "task_next", candidates: [{ id: "3", name: "Synthetic Engineer" }] } } });
    expect(reader.calls).toHaveLength(2); expect(reader.calls.every((call) => call.request.host === "api")).toBe(true);
    expect(reader.calls.map((call) => call.request.path)).not.toContain(expect.stringContaining("preProcessor"));
    expect(template(reader.calls[0].request.payload, reader.calls[0].bindings)).toEqual({ data: { entityApiKey: "fieldJob", dataId: 42 } });
  });
  it("处理中只表示服务器agree权限，不把它冒充resolve/assign或自动预处理", async () => {
    const reader = new Reader(); reader.permission = permission(12, false); reader.chooser = { code: "1602004", data: null };
    const result = await discoverFieldJobWorkflow(reader, "1");
    expect(result).toMatchObject({ state: "active", task: { id: "12" }, allowedActions: ["agree", "reject"], chooser: { status: "already_submitted" }, coverage: { nextTransition: "unverified" } });
    expect(reader.calls).toHaveLength(2);
  });
  it("结束需明确服务端结束诊断与无任务/允许动作，不强行把status设为Closed", async () => {
    const reader = new Reader(); reader.permission = permission(null, false); reader.chooser = { code: "1602002", data: null }; reader.parent.status = 9; reader.parent.customItem62__c = 4;
    const result = await discoverFieldJobWorkflow(reader, "1");
    expect(result).toMatchObject({ state: "ended", record: { status: 9, customItem62__c: 4 }, allowedActions: [] });
  });
  it("空任务/空允许动作本身不证明结束，缺少明确布尔权限也不当作false", async () => {
    const reader = new Reader(); reader.permission = permission(null, false);
    expect((await discoverFieldJobWorkflow(reader, "1", { includeSubmitChooser: false })).state).toBe("unverified");
    expect(reader.calls).toHaveLength(1);
    reader.chooser = { code: "1602002", data: null };
    (reader.permission.data.actions.submit as RecordData).permission = "true";
    expect((await discoverFieldJobWorkflow(reader, "1")).state).toBe("unverified");
  });
  it.each(["bad-envelope", "unsafe-id", "duplicate-candidate"])("未知或不安全响应%s明确拒绝", async (mode) => {
    const reader = new Reader();
    if (mode === "bad-envelope") reader.chooser = { code: 0, data: nextData() };
    else { const d = nextData(); if (mode === "unsafe-id") d.procdefId = Number.MAX_SAFE_INTEGER + 1; else d.chooseApprover = [candidate, candidate]; reader.chooser = { code: "200", data: d }; }
    await expect(discoverFieldJobWorkflow(reader, "1")).rejects.toThrow();
  });
});

describe("范围绑定的工作流合同与动态选人保护", () => {
  it("生成新profile不含工单/任务/处理人绑定，未配置语义guard/verify的动作保持unverified", () => {
    const c = profile(); expect(new ContractRegistry(c, { allowSynthetic: true }).get("workflow_preprocess").verification).toBe("verified");
    const raw = JSON.stringify(c);
    expect(raw).not.toContain("Synthetic Engineer"); expect(raw).not.toContain("task_next");
    expect(raw).not.toContain("preProcessor\",\"encoding\":\"json\",\"payload\":{\"data\":{\"action\":\"agree\",\"entityApiKey\":\"fieldJob\",\"dataId\":42");
    const bare = createFieldJobWorkflowProfile({ scope: c.scope, entityTypes: ["2"], evidence: c.actions[0].evidence! });
    expect(bare.actions.filter((action) => action.action !== "workflow_preprocess").every((action) => action.verification === "unverified")).toBe(true);
  });
  it("submit每次从当前候选交集约束处理人，不允许注入任意nextUserTasks", () => {
    const c = contract("submit"), i = inspected(c), guarded = guardFieldJobWorkflowInspection(c, i, { assigneeId: "3" });
    expect(guarded.fields.assigneeId.enum).toEqual(["3"]);
    expect(() => guardFieldJobWorkflowInspection(c, i, { assigneeId: "99" })).toThrow();
    const payload = template(c.request!.payload, { target: { id: "42" }, probe: guarded.output, input: { assigneeId: "3", comment: "synthetic", nextUserTasks: [{ nextAssignees: [99] }] } }) as RecordData;
    expect((payload.data as RecordData).nextUserTasks).toEqual([{ nextTaskDefKey: "task_next", nextAssignees: [3] }]);
  });
  it("准备后候选变化会得到新的enum与快照输出，旧人不能在execute复查时继续通过", () => {
    const c = contract("submit"), changed = nextData();
    changed.chooseApprover = [{ id: 4, name: "Another synthetic engineer" }];
    changed.nextUserTasks = [{ nextTaskDefKey: "task_next", candidates: [4], chooseApprover: [{ id: 4 }], nextUsertaskType: 1, nextAdjustAssigneeFlag: false, optionalChooseApprover: false }];
    expect(() => guardFieldJobWorkflowInspection(c, inspected(c, null, changed), { assigneeId: "3" })).toThrow();
    expect(guardFieldJobWorkflowInspection(c, inspected(c, null, changed), { assigneeId: "4" }).fields.assigneeId.enum).toEqual(["4"]);
  });
  it.each(["raw-array", "probe-preprocessor", "parallel", "unknown-mode", "form"])("不支持或篡改语义%s不能发送", (mode) => {
    const c = contract("submit"), d = nextData();
    if (mode === "raw-array") ((c.request!.payload as RecordData).data as RecordData).nextUserTasks = { $ref: "input.tasks" };
    if (mode === "probe-preprocessor") c.probe!.reads![0].request.path = "/rest/data/v2.0/creekflow/task/actions/preProcessor";
    if (mode === "parallel") (d.nextUserTasks as unknown[]).push({ ...(d.nextUserTasks as RecordData[])[0], nextTaskDefKey: "second" });
    if (mode === "unknown-mode") (d.nextUserTasks as RecordData[])[0].nextUsertaskType = 2;
    if (mode === "form") d.showAgreeFields = true;
    expect(() => guardFieldJobWorkflowInspection(c, inspected(c, null, d), { assigneeId: "3" })).toThrow();
  });
});

describe("单次副作用预处理与可信账本收据", () => {
  it("预处理是独立写动作、探测只读getPermission、父记录快照由实时检查冻结", () => {
    const c = contract("workflow_preprocess"), i = guardFieldJobWorkflowInspection(c, inspected(c, 12), {});
    expect(c.request!.method).toBe("POST"); expect(c.request!.path).toMatch(/preProcessor$/);
    expect(c.probe!.request.path).toMatch(/getPermission$/); expect(c.probe!.reads).toBeUndefined();
    expect(i.defaults.workflowRecord).toEqual(record); expect(i.fields.workflowRecord.enum).toEqual([record]);
    expect(c.verify!.checks.map((check) => check.field)).toEqual(c.preconditionFields);
  });
  it("不能把code200但无有效下一节点的预处理响应记录为成功", () => {
    const c = contract("workflow_preprocess");
    expect(() => validateFieldJobWorkflowSubmission(c, { output: { workflowResponseCode: "200" } })).toThrow();
    const result = operation(); expect(result.state).toBe("verified");
  });
  it("只接受当前身份、目标且已验证的P2操作，不接受raw客户端预处理内容", () => {
    const op = operation(); expect(trustedPreprocessingFromOperation(op, context, "1")).toMatchObject({ operationId: op.plan.operationId, targetId: "1", taskId: "12" });
    expect(() => trustedPreprocessingFromOperation(op, { ...context, key: "other" }, "1")).toThrow();
    expect(() => trustedPreprocessingFromOperation(op, context, "2")).toThrow();
    expect(() => trustedPreprocessingFromOperation({ ...op, state: "applied_pending_verification" }, context, "1")).toThrow();
    const c = contract("advance");
    expect(() => guardFieldJobWorkflowInspection(c, inspected(c, 12), { preprocessingOperationId: op.plan.operationId, preprocessing: op.submission!.output, assigneeId: "3" }, { now: NOW })).toThrow();
  });
  it("原计划内容被篡改时，不能把账本状态verified当作收据依据", () => {
    const op = operation(); (op.plan.payload as RecordData).extra = true;
    expect(() => trustedPreprocessingFromOperation(op, context, "1")).toThrow();
  });
  it("advance绑定当次任务、父记录及期限，不能借用别人的终结证据", () => {
    const op = operation(), receipt = trustedPreprocessingFromOperation(op, context, "1"), c = contract("advance");
    const i = guardFieldJobWorkflowInspection(c, inspected(c, 12), { preprocessingOperationId: receipt.operationId, assigneeId: "3" }, { trustedPreprocessing: receipt, now: NOW });
    expect(i.fields.assigneeId.enum).toEqual(["3"]);
    expect(() => guardFieldJobWorkflowInspection(c, inspected(c, 13), { preprocessingOperationId: receipt.operationId, assigneeId: "3" }, { trustedPreprocessing: receipt, now: NOW })).toThrow();
    expect(() => guardFieldJobWorkflowInspection(c, inspected(c, 12), { preprocessingOperationId: receipt.operationId, assigneeId: "3" }, { trustedPreprocessing: receipt, now: NOW + 60001 })).toThrow();
    const changed = inspected(c, 12); changed.record!.status = 9;
    expect(() => guardFieldJobWorkflowInspection(c, changed, { preprocessingOperationId: receipt.operationId, assigneeId: "3" }, { trustedPreprocessing: receipt, now: NOW })).toThrow();
  });
  it("close只接受已验证终结节点，agree=true或无下一任务数组并不足够", () => {
    const c = contract("close"), op = operation(true), receipt = trustedPreprocessingFromOperation(op, context, "1");
    expect(guardFieldJobWorkflowInspection(c, inspected(c, 12), { preprocessingOperationId: receipt.operationId }, { trustedPreprocessing: receipt, now: NOW }).output?.workflowEndNode).toBe(true);
    const nonterminal = trustedPreprocessingFromOperation(operation(), context, "1");
    expect(() => guardFieldJobWorkflowInspection(c, inspected(c, 12), { preprocessingOperationId: nonterminal.operationId }, { trustedPreprocessing: nonterminal, now: NOW })).toThrow();
  });
});
