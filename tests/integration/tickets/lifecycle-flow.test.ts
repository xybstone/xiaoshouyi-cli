// Offline integration tests: real service, backend, HTTP adapter and response
// decoding against a stateful synthetic server. No network or real CRM data.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getApiClient, resetApiClient } from "../../../src/api/client.js";
import { CrmTicketBackend } from "../../../src/tickets/backend.js";
import { OperationStore } from "../../../src/tickets/operation-store.js";
import { TicketService } from "../../../src/services/ticket.service.js";
import { ContractRegistry } from "../../../src/tickets/contracts.js";
import { ACTIONS, type RecordData, type TicketAction, type TicketPlan } from "../../../src/tickets/types.js";
import { API_ORIGIN, MODELED_ACTIONS, StatefulSyntheticCrm, syntheticRegistry } from "../../fixtures/tickets/stateful-crm.js";

vi.mock("../../../src/auth/manager.js", () => ({
  getAuthManager: () => ({
    getToken: async () => "synthetic-integration-token-not-valid",
    getApiBaseUrl: () => "https://synthetic.invalid",
    getUsername: () => "synthetic-user",
    getStatus: () => ({ tenantId: "synthetic-tenant" }),
    getSessionIdentity: async () => undefined,
    refresh: async () => { throw new Error("Unexpected refresh in offline integration test"); },
  }),
}));
const temporary: string[] = [];
beforeEach(() => {
  vi.stubEnv("XSY_ACCESS_TOKEN", "");
  vi.stubEnv("XSY_NEOCRM_PROJECT", "");
  vi.stubEnv("XSY_API_BASE_URL", API_ORIGIN);
  vi.stubEnv("XSY_TICKET_WRITES", "1");
  resetApiClient();
});
afterEach(() => {
  resetApiClient();
  vi.unstubAllEnvs();
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function setup(unverified: TicketAction[] = [], withRecovery = false) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "xsy-stateful-lifecycle-"));
  temporary.push(directory);
  const server = new StatefulSyntheticCrm();
  getApiClient().defaults.adapter = server.adapter;
  const registry = syntheticRegistry(unverified, withRecovery);
  const service = new TicketService(new CrmTicketBackend(registry), registry, new OperationStore(path.join(directory, "operations")));
  return { service, server, registry, directory };
}
async function ready(service: TicketService, action: TicketAction, id?: string, input: RecordData = { reason: "Synthetic integration reason" }) {
  const prepared = await service.prepare({ action, id, input });
  if (prepared.status !== "ready") throw new Error(`Unexpected blocked synthetic action ${action}`);
  return prepared.plan;
}
function confirm(plan: TicketPlan) {
  return { fingerprint: plan.fingerprint, source: "cli" as const, reference: "Explicit offline integration test authorization" };
}
async function run(service: TicketService, action: TicketAction, id?: string, input?: RecordData) {
  const plan = await ready(service, action, id, input);
  const operation = await service.execute(plan.planId, confirm(plan));
  expect(operation.state).toBe("verified");
  expect(operation.verification?.checks.every((c) => c.matched)).toBe(true);
  return operation;
}
async function create(service: TicketService) {
  return (await run(service, "create", undefined, { name: "Clearly marked synthetic test ticket", entityType: "2" })).submission!.id!;
}
async function processing(service: TicketService) {
  const id = await create(service);
  await run(service, "submit", id);
  await run(service, "assign", id, { responsibleId: "71" });
  await run(service, "accept", id);
  return id;
}
async function finish(service: TicketService, id: string) {
  await run(service, "worklog", id, { hours: 1.5 });
  await run(service, "report", id, { body: "Synthetic signed report" });
  await run(service, "resolve", id, { solution: "Synthetic verified solution" });
  await run(service, "complete", id);
  await run(service, "close", id);
}

describe("同一张合成工单的完整服务/传输生命周期", () => {
  it("创建草稿→提交→分派→领取→追加处理记录→工时/报告→解决→完成→关闭，并逐步核对主表和审计副作用", async () => {
    const s = setup();
    const id = await processing(s.service);
    const assigned = await s.service.get(id, ["id", "ownerId", "responsibleTE__c", "status"]);
    expect(assigned).toMatchObject({ id, ownerId: "42", responsibleTE__c: "71", status: "Processing" });
    await run(s.service, "reply", id, { body: "First diagnostic record" });
    await run(s.service, "reply", id, { body: "Second diagnostic record" });
    await finish(s.service, id);
    expect(s.server.tickets.size).toBe(1);
    expect(s.server.tickets.get(id)).toMatchObject({ status: "Closed", customItem62__c: "Closed", description: "Original immutable description", solution: "Synthetic verified solution" });
    expect(s.server.tables.syntheticReplies.map((r) => r.body)).toEqual(["First diagnostic record", "Second diagnostic record"]);
    expect(s.server.tables.syntheticEvents.map((r) => r.action)).toEqual(["create", "submit", "assign", "accept", "reply", "reply", "worklog", "report", "resolve", "complete", "close"]);
    expect(new Set(s.server.writes.map((r) => r.ticketId))).toEqual(new Set([id]));
    expect(s.server.tables.syntheticWorklogs[0].hours).toBe(1.5);
    expect(s.server.tables.syntheticReports[0].body).toBe("Synthetic signed report");
    expect(s.server.requests.some((r) => r.url === "/rest/data/v2/query")).toBe(true);
    expect(s.server.requests.filter((r) => r.method === "POST").every((r) => r.replay === "never")).toBe(true);
    const timeline = await s.service.timeline(id, 1, 100);
    expect(timeline.coverage).toBe("complete");
    expect(timeline.records).toHaveLength(11);
  });

  it("草稿须显式提交才能分派；提交推进阶段并记录历史，重复提交被拒绝", async () => {
    const s = setup();
    const id = await create(s.service);
    expect(s.server.tickets.get(id)).toMatchObject({ status: "New", customItem62__c: "Draft" });
    await expect(ready(s.service, "assign", id, { responsibleId: "71" })).rejects.toMatchObject({ code: "ACTION_NOT_ALLOWED" });
    expect(s.server.writes).toHaveLength(1);
    await run(s.service, "submit", id);
    expect(s.server.tickets.get(id)).toMatchObject({ status: "Submitted", customItem62__c: "Processing" });
    expect(s.server.tables.syntheticEvents.at(-1)).toMatchObject({ ticketId: id, action: "submit", before: "New", after: "Submitted" });
    await expect(ready(s.service, "submit", id)).rejects.toMatchObject({ code: "ACTION_NOT_ALLOWED" });
    expect(s.server.writes).toHaveLength(2);
    await run(s.service, "assign", id, { responsibleId: "71" });
    await run(s.service, "accept", id);
    expect(s.server.tickets.get(id)).toMatchObject({ status: "Processing", customItem62__c: "Processing" });
  });

  it("暂停/恢复、升级、转派、退回和关闭后重开复用相同目标及真实状态检查", async () => {
    const s = setup();
    const id = await processing(s.service);
    await run(s.service, "pause", id);
    expect(s.server.tickets.get(id)?.status).toBe("Paused");
    await run(s.service, "resume", id);
    await run(s.service, "escalate", id);
    await run(s.service, "reassign", id, { responsibleId: "72" });
    await run(s.service, "accept", id);
    expect(s.server.tickets.get(id)).toMatchObject({ status: "Processing", escalated: true, responsibleTE__c: "72", ownerId: "42" });
    await run(s.service, "resolve", id, { solution: "Synthetic first solution" });
    await run(s.service, "return", id);
    await finish(s.service, id);
    await run(s.service, "reopen", id);
    expect(s.server.tickets.get(id)).toMatchObject({ status: "Processing", customItem62__c: "Processing" });
    expect(s.server.tables.syntheticEvents.filter((r) => r.ticketId === id).map((r) => r.action)).toContain("reopen");
  });

  it("作废保留工单与历史，后续处理动作被拒绝", async () => {
    const s = setup();
    const id = await create(s.service);
    await run(s.service, "void", id);
    expect(s.server.tickets.has(id)).toBe(true);
    expect(s.server.tickets.get(id)?.status).toBe("Voided");
    expect(s.server.tables.syntheticEvents.map((r) => r.action)).toEqual(["create", "void"]);
    await expect(ready(s.service, "assign", id, { responsibleId: "71" })).rejects.toMatchObject({ code: "ACTION_NOT_ALLOWED" });
    expect(s.server.writes).toHaveLength(2);
  });

  it("附件上传与关联分离；关联失败不重传，关联成功后受控下载可还原内容", async () => {
    const s = setup();
    const id = await processing(s.service);
    const file = path.join(s.directory, "synthetic-diagnostic.txt");
    writeFileSync(file, "Synthetic attachment without customer data");
    const uploaded = await run(s.service, "attachment_upload", id, { filePath: file });
    const attachmentId = uploaded.submission!.id!;
    expect(s.server.tables.syntheticAttachments[0]).toMatchObject({ id: attachmentId, uploaded: true, linked: false });
    await expect(s.service.download(id, attachmentId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    s.server.reject.add("attachment_link");
    const linkPlan = await ready(s.service, "attachment_link", id, { attachmentId });
    expect((await s.service.execute(linkPlan.planId, confirm(linkPlan))).state).toBe("rejected");
    expect(s.server.writes.filter((r) => r.action === "attachment_upload")).toHaveLength(1);
    s.server.reject.delete("attachment_link");
    await run(s.service, "attachment_link", id, { attachmentId });
    const downloaded = await s.service.download(id, attachmentId, path.join(s.directory, "download.txt"));
    expect(readFileSync(downloaded.path, "utf8")).toBe("Synthetic attachment without customer data");
    expect(s.server.writes.filter((r) => r.action === "attachment_upload")).toHaveLength(1);
  });

  it("缺少报告/工时的关闭不能通过已完成状态绕过，补齐后按正常链路关闭", async () => {
    const s = setup();
    const id = await processing(s.service);
    await run(s.service, "resolve", id, { solution: "Synthetic solution" });
    await run(s.service, "complete", id);
    const writes = s.server.writes.length;
    await expect(ready(s.service, "close", id)).rejects.toMatchObject({ code: "ACTION_NOT_ALLOWED" });
    expect(s.server.writes).toHaveLength(writes);
    await run(s.service, "return", id);
    await finish(s.service, id);
  });

  it("主表已经改变但审计副作用尚未可见时保持 pending，仅回读恢复验证", async () => {
    const s = setup();
    const id = await processing(s.service);
    s.server.delayAudit.add("pause");
    const p = await ready(s.service, "pause", id);
    const pending = await s.service.execute(p.planId, confirm(p));
    expect(pending.state).toBe("applied_pending_verification");
    expect(s.server.tickets.get(id)?.status).toBe("Paused");
    expect(pending.verification?.checks.some((c) => !c.matched)).toBe(true);
    const writes = s.server.writes.length;
    s.server.flushDelayedAudit();
    expect((await s.service.operation(p.operationId, true)).state).toBe("verified");
    expect(s.server.writes).toHaveLength(writes);
  });

  it("服务器已应用回复后断连，不会重复追加处理记录", async () => {
    const s = setup();
    const id = await processing(s.service);
    s.server.dropReplyAfterApply.add("reply");
    const p = await ready(s.service, "reply", id, { body: "Exactly one synthetic diagnostic event" });
    expect((await s.service.execute(p.planId, confirm(p))).state).toBe("outcome_unknown");
    expect((await s.service.execute(p.planId, confirm(p))).state).toBe("outcome_unknown");
    expect(s.server.tables.syntheticReplies).toHaveLength(1);
    expect(s.server.writes.filter((r) => r.action === "reply")).toHaveLength(1);
  });

  it("创建成功但丢失返回ID，使用发送时绑定的唯一操作关联定位新单并恢复验证", async () => {
    const s = setup([], true);
    s.server.dropReplyAfterApply.add("create");
    const p = await ready(s.service, "create", undefined, { name: "Synthetic correlated create", entityType: "2" });
    expect((await s.service.execute(p.planId, confirm(p))).state).toBe("outcome_unknown");
    expect(s.server.tickets.size).toBe(1);
    const recovered = await s.service.operation(p.operationId, true);
    expect(recovered.state).toBe("verified");
    expect(recovered.submission?.id).toBe([...s.server.tickets.keys()][0]);
    expect(s.server.tables.syntheticEvents[0].operationKey).toBe(p.operationId);
    expect(recovered.recoveryHistory?.at(-1)).toMatchObject({ source: "contract", status: "matched", matchedCount: 1 });
    expect(s.server.writes).toHaveLength(1);
  });

  it("回复成功但回执丢失，通过唯一审计事件回查和关联处理记录完成恢复，不重发", async () => {
    const s = setup([], true);
    const id = await processing(s.service);
    s.server.dropReplyAfterApply.add("reply");
    const p = await ready(s.service, "reply", id, { body: "Synthetic uniquely correlated reply" });
    expect((await s.service.execute(p.planId, confirm(p))).state).toBe("outcome_unknown");
    const recovered = await s.service.operation(p.operationId, true);
    expect(recovered.state).toBe("verified");
    expect(recovered.verification?.checks.every((c) => c.matched)).toBe(true);
    expect(s.server.tables.syntheticReplies).toHaveLength(1);
    expect(s.server.tables.syntheticEvents.filter((r) => r.operationKey === p.operationId)).toHaveLength(1);
    expect(s.server.writes.filter((r) => r.action === "reply")).toHaveLength(1);
  });

  it("关联审计暂不可见或出现多个候选时保留不确定性，只有唯一证据出现后才恢复", async () => {
    const s = setup([], true);
    const id = await processing(s.service);
    s.server.delayAudit.add("reply");
    s.server.dropReplyAfterApply.add("reply");
    const p = await ready(s.service, "reply", id, { body: "Synthetic delayed audit reply" });
    expect((await s.service.execute(p.planId, confirm(p))).state).toBe("outcome_unknown");
    const missing = await s.service.operation(p.operationId, true);
    expect(missing.state).toBe("outcome_unknown");
    expect(missing.recoveryHistory?.at(-1)).toMatchObject({ status: "not_found", matchedCount: 0 });
    s.server.flushDelayedAudit();
    const event = s.server.tables.syntheticEvents.find((r) => r.operationKey === p.operationId)!;
    const duplicate = { ...event, id: "999999" };
    s.server.tables.syntheticEvents.push(duplicate);
    const ambiguous = await s.service.operation(p.operationId, true);
    expect(ambiguous.state).toBe("outcome_unknown");
    expect(ambiguous.recoveryHistory?.at(-1)).toMatchObject({ status: "ambiguous", matchedCount: 2 });
    s.server.tables.syntheticEvents.splice(s.server.tables.syntheticEvents.indexOf(duplicate), 1);
    expect((await s.service.operation(p.operationId, true)).state).toBe("verified");
    expect(s.server.tables.syntheticReplies).toHaveLength(1);
    expect(s.server.writes.filter((r) => r.action === "reply")).toHaveLength(1);
  });

  it("同一计划并发执行最多追加一条处理记录", async () => {
    const s = setup();
    const id = await processing(s.service);
    const p = await ready(s.service, "reply", id, { body: "One concurrent synthetic reply" });
    const executions = await Promise.allSettled([s.service.execute(p.planId, confirm(p)), s.service.execute(p.planId, confirm(p))]);
    expect(executions.some((r) => r.status === "fulfilled")).toBe(true);
    expect(s.server.tables.syntheticReplies).toHaveLength(1);
  });

  it("prepare 后网页式外部改动或角色权限变更，使执行在发送前停止", async () => {
    const s = setup();
    const id = await processing(s.service);
    const p = await ready(s.service, "reply", id, { body: "Synthetic stale plan must not be sent" });
    const writes = s.server.writes.length;
    // Simulate another CRM client changing the current state after preview.
    s.server.tickets.get(id)!.status = "Paused";
    await expect(s.service.execute(p.planId, confirm(p))).rejects.toMatchObject({ code: "PLAN_STALE" });
    expect(s.server.writes).toHaveLength(writes);
    expect(s.server.tables.syntheticReplies).toHaveLength(0);
    s.server.tickets.get(id)!.status = "Processing";
    const second = await ready(s.service, "reply", id, { body: "Synthetic revoked permission must not be sent" });
    s.server.denied.add("reply");
    await expect(s.service.execute(second.planId, confirm(second))).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(s.server.writes).toHaveLength(writes);
    expect(s.server.tables.syntheticReplies).toHaveLength(0);
  });

  it("权限、动态必填和非法状态在发送写请求前拒绝", async () => {
    const s = setup();
    await expect(ready(s.service, "create", undefined, { entityType: "2" })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(s.server.writes).toHaveLength(0);
    const id = await create(s.service);
    s.server.denied.add("assign");
    await expect(ready(s.service, "assign", id, { responsibleId: "71" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(ready(s.service, "resolve", id, { solution: "Synthetic invalid transition" })).rejects.toMatchObject({ code: "ACTION_NOT_ALLOWED" });
    expect(s.server.writes).toHaveLength(1);
  });

  it("其他业务类型和未核验动作不能借用已核验类型的合成协议", async () => {
    const s = setup(["close"]);
    const id = await processing(s.service);
    s.server.tickets.get(id)!.entityType = "3";
    await expect(ready(s.service, "reply", id, { body: "Synthetic other type" })).rejects.toMatchObject({ code: "UNVERIFIED" });
    expect(await s.service.prepare({ action: "close", id, input: { reason: "Synthetic unverified close" } })).toMatchObject({ status: "blocked", code: "UNVERIFIED" });
    expect(s.server.writes).toHaveLength(4);
  });

  it("状态化测试契约不能被生产运行时加载", () => {
    const registry = syntheticRegistry();
    expect(() => new ContractRegistry(registry.config)).toThrow(/合成契约/);
  });

  it("新增生产动作枚举不会自动获得旧fixture的verified契约或假状态迁移", async () => {
    const s = setup(), modeled = new Set<TicketAction>(MODELED_ACTIONS);
    const unmodeled = ACTIONS.filter((action) => !modeled.has(action));
    expect(unmodeled).toEqual(expect.arrayContaining(["advance", "workflow_preprocess", "activity_record", "service_report"]));
    expect(s.registry.config.actions.map((contract) => contract.action)).toEqual([...MODELED_ACTIONS]);
    for (const action of unmodeled) {
      expect(s.registry.get(action).verification).toBe("unverified");
      expect(await s.service.prepare({ action, id: "1", input: {} })).toMatchObject({ status: "blocked", code: "UNVERIFIED", action });
    }
    expect(s.server.requests).toHaveLength(0); expect(s.server.writes).toHaveLength(0);
  });
});
