// Actual TicketService + CrmTicketBackend + object service decoding. The Axios
// adapter catches every request; all responses and identities are synthetic.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { getApiClient, resetApiClient } from "../../../src/api/client.js";
import { CrmTicketBackend } from "../../../src/tickets/backend.js";
import { ContractRegistry } from "../../../src/tickets/contracts.js";
import { OperationStore } from "../../../src/tickets/operation-store.js";
import { TicketService } from "../../../src/services/ticket.service.js";
import type { RecordData } from "../../../src/tickets/types.js";

const identity = vi.hoisted(() => ({ subject: "3", token: "synthetic-timeline-token", refresh: vi.fn() }));
vi.mock("../../../src/auth/manager.js", () => ({ getAuthManager: () => ({
  getToken: async () => identity.token, getApiBaseUrl: () => "https://api.example.test",
  getUsername: () => identity.subject, getStatus: () => ({ tenantId: "synthetic-tenant" }), refresh: identity.refresh,
}) }));

const TARGET = "101", PARENT_OBJECT = "700", BASE = Date.UTC(2026, 10, 27, 8);
const WORKFLOW = "/rest/data/v2.0/creekflow/approval/flowInstance/taskHistory/fieldJob";
const evidence = { source: "synthetic", reference: "offline native timeline service transport fixture; not CRM acceptance", verifiedAt: "2026-11-27T00:00:00+08:00" };
const temporary: string[] = [];
function configuration(pinSubject = true) {
  return { version: 1, scope: { apiBaseUrl: "https://api.example.test", crmBaseUrl: "https://crm.xiaoshouyi.com", tenantId: "synthetic-tenant", ...(pinSubject ? { subjectId: "3" } : {}) },
    fieldJobHistory: { parentObjectId: PARENT_OBJECT, evidence } };
}
function activity(extra: RecordData = {}) {
  return { id: 401, activityRecordFrom: 700, activityRecordFrom_data: 101, ownerId: 3, createdAt: BASE + 100,
    entityType: 7, startTime: BASE, content: "SYNTHETIC_PRIVATE_ACTIVITY_CONTENT", contactEmail: "synthetic@example.test", ...extra };
}
function report(extra: RecordData = {}) {
  return { id: 501, relateEntity: 700, relateEntity_data: 101, createdBy: 3, createdAt: BASE + 200,
    state: 1, isSignoff: false, reportHtml: "SYNTHETIC_PRIVATE_REPORT_CONTENT", ...extra };
}
function workflowLog(index = 0, extra: RecordData = {}) {
  return { id: 601 + index, procInstId: 901, assignee: { uid: 3, name: "SYNTHETIC_PRIVATE_ACTOR_NAME" }, endAt: BASE + 300 + index,
    operateApiKey: null, operateLabel: "Synthetic approval", operateType: 2, statusExt: 6,
    opinion: "SYNTHETIC_PRIVATE_WORKFLOW_OPINION", ...extra };
}
function workflowProcess(logs: RecordData[] = [workflowLog()], extra: RecordData = {}): RecordData {
  const processId = extra.id ?? 901;
  return { id: processId, entityApikey: "fieldJob", dataId: null, userTaskInstances: [
    { id: 801, procInstId: processId, status: 2, usertaskLogs: logs },
  ], ...extra };
}
function envelope(records: RecordData[], totalSize = records.length) { return { code: 200, result: { records, count: records.length, totalSize } }; }

function setup(pinSubject = true) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "xsy-native-timeline-")); temporary.push(directory);
  const registry = new ContractRegistry(configuration(pinSubject), { allowSynthetic: true });
  const store = new OperationStore(directory), backend = new CrmTicketBackend(registry, 30000, store);
  const service = new TicketService(backend, registry, store);
  const requests: InternalAxiosRequestConfig[] = [];
  const state = {
    activities: [activity()], reports: [report()], processes: [workflowProcess()],
    failedSources: new Set<string>(), businessFailure: new Set<string>(), malformedPage: new Set<string>(),
    parentMissing: false, wrongParentRead: false, parallel: false, changeIdentity: false, rotateToken: false,
  };
  const started = new Set<string>();
  let release: () => void = () => {};
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const response = (config: InternalAxiosRequestConfig, data: unknown, status = 200) => ({ config, data, status, statusText: status === 200 ? "OK" : "Denied", headers: {} });
  const page = (rows: RecordData[], sql: string) => {
    const match = / limit (\d+),(\d+)$/i.exec(sql);
    if (!match) throw new Error("The timeline must issue a bounded query");
    const offset = Number(match[1]), size = Number(match[2]);
    return envelope([...rows].sort((a, b) => Number(b.id) - Number(a.id)).slice(offset, offset + size), rows.length);
  };
  getApiClient().defaults.adapter = async (config) => {
    requests.push(config);
    if (config.method === "get" && config.url === "/rest/data/v2.0/xobjects/fieldJob/description") {
      return response(config, { code: 200, data: { apiKey: "fieldJob", queryable: true, disabled: true,
        fields: [{ apiKey: "id", type: "long", enabled: true, createable: false }] } });
    }
    const sql = String(config.params?.q ?? "");
    if (config.method === "get" && config.url === "/rest/data/v2/query" && / from fieldJob /i.test(sql))
      return response(config, envelope(state.parentMissing ? [] : [{ id: state.wrongParentRead ? "999" : TARGET }]));
    const source = config.url === WORKFLOW ? "workflow_tasks" : / from activityrecord /i.test(sql) ? "activity" : / from serviceReport /i.test(sql) ? "reports" : undefined;
    if (!source) throw new Error("Unexpected request escaped native timeline routing");
    if (state.parallel) { started.add(source); if (started.size === 3) release(); await barrier; }
    if (state.failedSources.has(source)) throw new AxiosError("SYNTHETIC_PRIVATE_UPSTREAM_ERROR", "ECONNRESET", config);
    if (state.businessFailure.has(source)) return response(config, { code: 403, msg: "SYNTHETIC_PRIVATE_PERMISSION_RESPONSE" });
    if (source === "workflow_tasks") {
      const requested = JSON.parse(config.data).data;
      if (!Number.isSafeInteger(requested.dataId) || requested.dataId !== Number(TARGET))
        throw new Error("Native workflow history requires a lossless numeric dataId");
      if (state.changeIdentity) identity.subject = "4";
      if (state.rotateToken) identity.token = "synthetic-rotated-same-user-token";
      return response(config, { code: 200, data: state.processes });
    }
    const result = page(source === "activity" ? state.activities : state.reports, sql);
    if (state.malformedPage.has(source)) result.result.count++;
    return response(config, result);
  };
  return { service, backend, registry, state, requests, started };
}
beforeEach(() => {
  for (const key of ["XSY_NEOCRM_PROJECT", "XSY_ACCESS_TOKEN", "XSY_API_BASE_URL", "XSY_CRM_COOKIE"]) vi.stubEnv(key, "");
  identity.subject = "3"; identity.token = "synthetic-timeline-token"; identity.refresh.mockReset(); resetApiClient();
});
afterEach(() => { resetApiClient(); vi.unstubAllEnvs(); for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("原生fieldJob时间线的服务与真实HTTP适配边界", () => {
  it("混合活动、服务报告和流程记录保留各自证据边界，按返回页事件时间排序", async () => {
    const s = setup();
    const result = await s.service.timeline(TARGET, 1, 20);
    expect(s.backend).toBeInstanceOf(CrmTicketBackend);
    expect(result).toMatchObject({ coverage: "partial", historyCompleteness: "unknown", coverageScope: "activity_reports_workflow_tasks", consistency: "best_effort",
      ordering: { mode: "event_time", scope: "returned_page", complete: true } });
    expect(result.records.map((row) => row.source)).toEqual(["creekflow_task_history", "serviceReport", "activityrecord"]);
    expect(result.records.map((row) => row.parentId)).toEqual([TARGET, TARGET, TARGET]);
    expect(result.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "activity", status: "verified", parentEvidence: "returned_fields_verified", paginationScope: "source", nextPage: null, count: 1 }),
      expect.objectContaining({ source: "reports", status: "verified", parentEvidence: "returned_fields_verified", paginationScope: "source", nextPage: null, count: 1 }),
      expect.objectContaining({ source: "workflow_tasks", status: "verified", parentEvidence: "request_bound", paginationScope: "bounded_response", nextPage: null, count: 1 }),
    ]));
    expect(result.records.every((row) => row.visibility === "unverified")).toBe(true);
    expect(result.records[0].businessStateTransition).toBe("unverified");
    expect(result.records[1].stateTransition).toBe("unverified");
  });

  it("真实请求同时限定父类型及父工单，流程POST使用读取标记而非userTaskLog写动作", async () => {
    const s = setup(); await s.service.timeline(TARGET, 1, 2);
    const history = s.requests.filter((request) => String(request.params?.q).includes(" from activityrecord ") || String(request.params?.q).includes(" from serviceReport "));
    expect(history).toHaveLength(2);
    expect(String(history[0].params.q)).toContain("activityRecordFrom_data = '101' and activityRecordFrom = '700'");
    expect(String(history[1].params.q)).toContain("relateEntity_data = '101' and relateEntity = '700'");
    expect(history.every((request) => request.method === "get" && request.xsyReplay === "read" && / limit 0,2$/.test(String(request.params.q)))).toBe(true);
    const workflow = s.requests.find((request) => request.url === WORKFLOW)!;
    expect(workflow).toMatchObject({ method: "post", xsyReplay: "read", maxRedirects: 0 });
    expect(JSON.parse(workflow.data)).toEqual({ data: { xObjectApiKey: "fieldJob", dataId: Number(TARGET), srcProcInstId: -1 } });
    expect(s.requests.some((request) => String(request.url).includes("userTaskLog"))).toBe(false);
  });

  it("默认查询不请求content，响应也不泄露意见、正文、姓名及多余字段", async () => {
    const s = setup(), result = await s.service.timeline(TARGET, 1, 20);
    expect(s.requests.filter((request) => request.params?.q).every((request) => !/\bcontent\b/i.test(String(request.params.q)))).toBe(true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("SYNTHETIC_PRIVATE");
    expect(serialized).not.toContain("contactEmail"); expect(serialized).not.toContain("reportHtml"); expect(serialized).not.toContain('"opinion"');
  });

  it("已实证的流程实例→任务实例→日志结构保留正日志，未来节点占位不冒充已完成事件", async () => {
    const s = setup(), process = workflowProcess();
    (process.userTaskInstances as RecordData[]).push({ id: 802, procInstId: 901, status: 101, usertaskLogs: [
      { id: null, procInstId: null, assignee: null, endAt: null, operateType: null, operateApiKey: null, operateLabel: "", statusExt: 109, opinion: null },
    ] });
    s.state.processes = [process];
    const result = await s.service.timeline(TARGET);
    expect(result.records.filter((row) => row.source === "creekflow_task_history")).toEqual([
      expect.objectContaining({ id: "601", actorId: "3", actionApiKey: null, actionLabel: "Synthetic approval", workflowOperationType: 2,
        workflowActionStatus: 6, workflowTaskStatus: 2, parentEvidence: "request_bound", businessStateTransition: "unverified" }),
    ]);
    expect(result.records).toHaveLength(3);
  });

  it("流程实例明确返回dataId时核验父工单，不能仅因请求目标正确就信任外部记录", async () => {
    const s = setup(); s.state.processes = [workflowProcess([workflowLog()], { dataId: Number(TARGET) })];
    const result = await s.service.timeline(TARGET);
    expect(result.sources.find((source) => source.source === "workflow_tasks")).toMatchObject({ status: "verified", parentEvidence: "returned_fields_verified" });
    expect(result.records.find((row) => row.source === "creekflow_task_history")?.parentEvidence).toBe("returned_fields_verified");
  });

  it.each(["object", "target", "task-process", "log-process"])("流程来源%s关联错误仅隔离流程源", async (failure) => {
    const s = setup(), process = workflowProcess(), task = (process.userTaskInstances as RecordData[])[0];
    if (failure === "object") process.entityApikey = "account";
    if (failure === "target") process.dataId = 999;
    if (failure === "task-process") task.procInstId = 902;
    if (failure === "log-process") (task.usertaskLogs as RecordData[])[0].procInstId = 902;
    s.state.processes = [process];
    const result = await s.service.timeline(TARGET);
    expect(result.records).toHaveLength(2);
    expect(result.sources.find((source) => source.source === "workflow_tasks")).toMatchObject({ status: "unavailable", reason: "INVALID_RESPONSE" });
    expect(result.sources.filter((source) => source.source !== "workflow_tasks").every((source) => source.status === "verified")).toBe(true);
  });

  it("此前错误的扁平task数组被拒绝，不能兼容为无历史或假正日志", async () => {
    const s = setup(); s.state.processes = [{ status: 2, usertaskLogs: [workflowLog()] }];
    const result = await s.service.timeline(TARGET);
    expect(result.records).toHaveLength(2);
    expect(result.sources.find((source) => source.source === "workflow_tasks")).toMatchObject({ status: "unavailable", reason: "INVALID_RESPONSE" });
    expect(result.historyCompleteness).toBe("unknown");
  });

  it.each([
    ["activity", { activityRecordFrom: 701 }],
    ["activity", { activityRecordFrom_data: 999 }],
    ["reports", { relateEntity: 701 }],
    ["reports", { relateEntity_data: 999 }],
  ])("%s跨父对象返回只使该源unavailable，其他正记录继续保留", async (source, changed) => {
    const s = setup(); Object.assign(source === "activity" ? s.state.activities[0] : s.state.reports[0], changed);
    const result = await s.service.timeline(TARGET);
    expect(result.records).toHaveLength(2);
    expect(result.sources.find((entry) => entry.source === source)).toMatchObject({ status: "unavailable", reason: "INVALID_RESPONSE" });
    expect(result.sources.filter((entry) => entry.source !== source).every((entry) => entry.status === "verified")).toBe(true);
    expect(result.records.some((row) => source === "activity" ? row.source === "activityrecord" : row.source === "serviceReport")).toBe(false);
  });

  it("单源网络错误不丢掉其他来源，也不把上游错误正文放入结果", async () => {
    const s = setup(); s.state.failedSources.add("reports");
    const result = await s.service.timeline(TARGET);
    expect(result.records).toHaveLength(2);
    expect(result.sources.find((entry) => entry.source === "reports")).toMatchObject({ status: "unavailable", reason: "ECONNRESET" });
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE_UPSTREAM_ERROR");
  });

  it("HTTP200中的业务拒绝和分页计数错误也只隔离失败来源", async () => {
    const s = setup(); s.state.businessFailure.add("activity"); s.state.malformedPage.add("reports");
    const result = await s.service.timeline(TARGET);
    expect(result.records).toHaveLength(1); expect(result.records[0].source).toBe("creekflow_task_history");
    expect(result.sources.filter((entry) => entry.status === "unavailable")).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC_PRIVATE_PERMISSION_RESPONSE");
  });

  it("三来源并行读取，不在第一个来源完成前阻塞其余请求", async () => {
    const s = setup(); s.state.parallel = true;
    const result = await s.service.timeline(TARGET);
    expect([...s.started].sort()).toEqual(["activity", "reports", "workflow_tasks"]); expect(result.records).toHaveLength(3);
  }, 10000);

  it("三来源空结果仍是partial/unknown，不能宣称工单没有历史", async () => {
    const s = setup(); s.state.activities = []; s.state.reports = []; s.state.processes = [];
    const result = await s.service.timeline(TARGET);
    expect(result).toMatchObject({ records: [], coverage: "partial", historyCompleteness: "unknown", ordering: { mode: "source", complete: false } });
    expect(result.sources.filter((entry) => entry.parentEvidence === "no_rows")).toHaveLength(2);
    expect(result.sources.every((entry) => entry.status === "verified")).toBe(true);
  });

  it("所有历史源不可用时仍保留来源失败信息，不返回假complete", async () => {
    const s = setup(); ["activity", "reports", "workflow_tasks"].forEach((source) => s.state.failedSources.add(source));
    const result = await s.service.timeline(TARGET);
    expect(result).toMatchObject({ records: [], coverage: "partial", historyCompleteness: "unknown" });
    expect(result.sources.every((entry) => entry.status === "unavailable")).toBe(true);
  });

  it("来源各自分页，流程只对有界响应切页且不冒充服务器全历史分页", async () => {
    const s = setup();
    s.state.activities = [activity({ id: 401 }), activity({ id: 402 }), activity({ id: 403 })];
    s.state.reports = [report({ id: 501 }), report({ id: 502 })];
    s.state.processes = [workflowProcess([workflowLog(0), workflowLog(1), workflowLog(2), workflowLog(3)])];
    const result = await s.service.timeline(TARGET, 2, 1);
    expect(result.records.map((row) => row.id).sort()).toEqual(["402", "501", "602"]);
    expect(result.sources.find((entry) => entry.source === "activity")).toMatchObject({ count: 1, nextPage: 3, paginationScope: "source" });
    expect(result.sources.find((entry) => entry.source === "reports")).toMatchObject({ count: 1, nextPage: null, paginationScope: "source" });
    expect(result.sources.find((entry) => entry.source === "workflow_tasks")).toMatchObject({ count: 1, nextPage: 3, paginationScope: "bounded_response" });
    const queries = s.requests.filter((request) => / from (activityrecord|serviceReport) /i.test(String(request.params?.q)));
    expect(queries.every((request) => / limit 1,1$/.test(String(request.params.q)))).toBe(true);
    expect(JSON.parse(s.requests.find((request) => request.url === WORKFLOW)!.data).data).not.toHaveProperty("page");
    expect(result.historyCompleteness).toBe("unknown");
  });

  it("流程响应越界只使流程源不可用，未提供时间则不猜全局排序", async () => {
    const s = setup(); s.state.processes = Array.from({ length: 101 }, (_, index) => workflowProcess([], { id: 901 + index }));
    s.state.activities[0].createdAt = null;
    const result = await s.service.timeline(TARGET);
    expect(result.sources.find((entry) => entry.source === "workflow_tasks")).toMatchObject({ status: "unavailable", reason: "INVALID_RESPONSE" });
    expect(result.records).toHaveLength(2); expect(result.ordering).toMatchObject({ mode: "source", complete: false });
  });

  it.each([0, 101])("size=%s在任何HTTP请求前被拒绝", async (size) => {
    const s = setup(); await expect(s.service.timeline(TARGET, 1, size)).rejects.toMatchObject({ code: "VALIDATION_FAILED" }); expect(s.requests).toHaveLength(0);
  });

  it.each(["parentMissing", "wrongParentRead"] as const)("%s不得绕过父工单读取再检索历史", async (failure) => {
    const s = setup(); s.state[failure] = true;
    await expect(s.service.timeline(TARGET)).rejects.toMatchObject({ code: failure === "parentMissing" ? "NOT_FOUND" : "INVALID_RESPONSE" });
    expect(s.requests.some((request) => request.url === WORKFLOW || / from (activityrecord|serviceReport) /i.test(String(request.params?.q)))).toBe(false);
  });

  it("历史返回期间当前身份改变时整次拒绝，不能混合返回两个身份的数据", async () => {
    const s = setup(false); s.state.changeIdentity = true;
    await expect(s.service.timeline(TARGET)).rejects.toMatchObject({ code: "CONTEXT_MISMATCH" });
  });

  it("同一身份Token轮换不误判切换，下一次请求重新读取元数据", async () => {
    const s = setup(); s.state.rotateToken = true;
    expect((await s.service.timeline(TARGET)).records).toHaveLength(3);
    expect((await s.service.timeline(TARGET)).records).toHaveLength(3);
    expect(s.requests.filter((request) => request.url === "/rest/data/v2.0/xobjects/fieldJob/description")).toHaveLength(2);
  });

  it("原生历史必须绑定scope，synthetic证据不能被生产加载", () => {
    const raw = configuration();
    expect(() => new ContractRegistry({ ...raw, scope: undefined }, { allowSynthetic: true })).toThrow(/身份范围/);
    expect(() => new ContractRegistry(raw)).toThrow(/合成契约/);
  });
});
