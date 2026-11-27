// Stateful synthetic HTTP contract: production backend/actions/store, no CRM calls.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AxiosError, type InternalAxiosRequestConfig } from "axios";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getApiClient, resetApiClient } from "../../../src/api/client.js";
import { CrmTicketBackend } from "../../../src/tickets/backend.js";
import { TicketActions } from "../../../src/tickets/actions.js";
import { ContractRegistry } from "../../../src/tickets/contracts.js";
import { createFieldJobWorkflowProfile } from "../../../src/tickets/fieldjob-workflow.js";
import { OperationStore } from "../../../src/tickets/operation-store.js";
import type { RecordData, TicketOperation, TicketPlan } from "../../../src/tickets/types.js";

vi.mock("../../../src/auth/manager.js", () => ({ getAuthManager: () => ({
  getToken: async () => "synthetic-workflow-not-real", getApiBaseUrl: () => "https://api.example.test",
  getUsername: () => "3", getStatus: () => ({ tenantId: "synthetic-tenant" }),
}) }));
vi.mock("../../../src/api/crm-client.js", () => ({ getCrmCookie: () => null }));

const directories: string[] = [];
beforeEach(() => {
  vi.stubEnv("XSY_NEOCRM_PROJECT", ""); vi.stubEnv("XSY_ACCESS_TOKEN", ""); vi.stubEnv("XSY_API_BASE_URL", "");
  resetApiClient();
});
afterEach(() => { resetApiClient(); vi.unstubAllEnvs(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });

class WorkflowServer {
  record: RecordData = { id: "1", entityType: "2", status: 1, customItem62__c: 1 };
  taskId: number | null = null;
  candidateIds = [3];
  writes: Array<{ path: string; data: RecordData; replay: unknown; redirects: unknown }> = [];
  preprocessTimeout = false;
  preprocessMalformed = false;
  preprocessMutatesRecord = false;
  metadataQueries = 0;
  recordQueries = 0;
  next() {
    const terminal = this.record.customItem62__c === 3;
    const key = this.record.customItem62__c === 1 ? "process" : "finish_info";
    const approvers = this.candidateIds.map((id) => ({ id, name: `Synthetic ${id}`, label: `Synthetic ${id}` }));
    return { procdefId: 11, nextTaskDefKey: terminal ? null : key, nextTaskDefName: terminal ? null : `Synthetic ${key}`,
      nextTaskType: terminal ? "EndNoneEvent" : "UserTask", nextEndNodeFlag: terminal, showAgreeFields: false,
      chooseApprover: terminal ? null : approvers,
      nextUserTasks: terminal ? null : [{ nextTaskDefKey: key, nextTaskDefName: `Synthetic ${key}`, candidates: [...this.candidateIds], chooseApprover: approvers,
        nextUsertaskType: 1, nextAdjustAssigneeFlag: false, optionalChooseApprover: false }],
    };
  }
  async http(config: InternalAxiosRequestConfig) {
    const route = String(config.url), method = String(config.method).toUpperCase();
    const response = (data: unknown) => ({ status: 200, statusText: "OK", data, headers: {}, config });
    if (method === "GET" && route.endsWith("/fieldJob/description")) {
      this.metadataQueries++;
      return response({ code: "200", data: { apiKey: "fieldJob", fields: Object.keys(this.record).map((apiKey) => ({ apiKey, type: apiKey === "id" || apiKey === "entityType" ? "text" : "int", enabled: true })) } });
    }
    if (method === "GET" && route === "/rest/data/v2/query") {
      this.recordQueries++;
      const sql = String(config.params?.q), match = sql.match(/^select\s+(.+?)\s+from\s+fieldJob\s/i);
      if (!match || !sql.includes("id = '1'")) throw new Error("Unexpected synthetic query");
      return response({ code: 200, result: { totalSize: 1, count: 1, records: [Object.fromEntries(match[1].split(",").map((key) => [key.trim(), this.record[key.trim()]]))] } });
    }
    const body = typeof config.data === "string" ? JSON.parse(config.data) : config.data;
    const data = body?.data as RecordData;
    if (method !== "POST" || Number(data?.dataId) !== 1) throw new Error("Unexpected synthetic workflow request");
    if (route.endsWith("getPermission")) return response({ code: "200", data: {
      task: { taskId: this.taskId, editableFields: [] }, actions: {
        submit: { permission: this.record.customItem62__c === 1 },
        agree: { permission: this.taskId !== null && this.record.customItem62__c !== 4 },
      },
    } });
    if (route.endsWith("submitChooser/fieldJob")) return response(this.record.customItem62__c === 1 ? { code: "200", data: this.next() } : { code: "1602004", data: null });
    this.writes.push({ path: route, data, replay: config.xsyReplay, redirects: config.maxRedirects });
    if (route.endsWith("preProcessor")) {
      if (Number(data.usertaskLogId) !== this.taskId) throw new Error("Preprocessing task mismatch");
      if (this.preprocessTimeout) throw new AxiosError("synthetic timeout after preprocessing was dispatched", "ECONNABORTED", config);
      const next = this.next();
      if (this.preprocessMutatesRecord) this.record.status = 9;
      return response({ code: "200", data: this.preprocessMalformed ? {} : next });
    }
    if (!route.endsWith("userTaskLog/fieldJob")) throw new Error("Unexpected synthetic mutation route");
    if (data.action === "submit") {
      expect(data.nextTaskDefKey).toBe("process"); expect(data.nextUserTasks).toEqual([{ nextTaskDefKey: "process", nextAssignees: [3] }]);
      this.record.customItem62__c = 2; this.taskId = 12;
    } else if (this.record.customItem62__c === 2) {
      expect(data.usertaskLogId).toBe(12); expect(data.nextTaskDefKey).toBe("finish_info");
      expect(data.nextUserTasks).toEqual([{ nextTaskDefKey: "finish_info", nextAssignees: [3] }]);
      this.record.customItem62__c = 3; this.record.status = 3; this.taskId = 13;
    } else if (this.record.customItem62__c === 3) {
      expect(data.usertaskLogId).toBe(13); expect(data.nextUserTasks).toEqual([]);
      this.record.customItem62__c = 4; this.record.status = 9; this.taskId = null;
    } else throw new Error("Invalid synthetic transition");
    return response({ code: "200", data: {} });
  }
}
function setup() {
  const profile = createFieldJobWorkflowProfile({
    scope: { apiBaseUrl: "https://api.example.test", crmBaseUrl: "https://crm.xiaoshouyi.com", tenantId: "synthetic-tenant", subjectId: "3" }, entityTypes: ["2"],
    evidence: { source: "synthetic", reference: "stateful HTTP workflow integration fixture", verifiedAt: "2026-11-27T00:00:00+08:00" },
    guards: { submit: [{ field: "customItem62__c", expected: 1 }], advance: [{ field: "customItem62__c", expected: 2 }], close: [{ field: "customItem62__c", expected: 3 }] },
    verify: { submit: { checks: [{ field: "customItem62__c", expected: 2 }] }, advance: { checks: [{ field: "customItem62__c", expected: 3 }, { field: "status", expected: 3 }] }, close: { checks: [{ field: "customItem62__c", expected: 4 }, { field: "status", expected: 9 }] } },
  });
  const registry = new ContractRegistry(profile, { allowSynthetic: true }), server = new WorkflowServer();
  getApiClient().defaults.adapter = (config) => server.http(config);
  const directory = mkdtempSync(path.join(os.tmpdir(), "xsy-workflow-engine-")); directories.push(directory);
  const store = new OperationStore(directory), backend = new CrmTicketBackend(registry, 30000, store), actions = new TicketActions(backend, registry, store);
  const prepare = async (action: "submit" | "advance" | "close" | "workflow_preprocess", input: RecordData = {}) => {
    const result = await actions.prepare({ action, id: "1", input });
    if (result.status !== "ready") throw new Error("Expected ready synthetic workflow plan");
    return result.plan;
  };
  const execute = (plan: TicketPlan) => actions.execute(plan.planId, { fingerprint: plan.fingerprint, source: "cli", reference: "explicit synthetic workflow authorization" });
  const step = async (action: "submit" | "advance" | "close" | "workflow_preprocess", input: RecordData = {}) => execute(await prepare(action, input));
  return { server, store, backend, actions, prepare, execute, step };
}
const submitInput = { assigneeId: "3", comment: "Synthetic submit" };
async function submitted() { const s = setup(); expect((await s.step("submit", submitInput)).state).toBe("verified"); return s; }
async function preprocessed() { const s = await submitted(), result = await s.step("workflow_preprocess"); expect(result.state).toBe("verified"); return { ...s, receipt: result }; }
const advanceInput = (receipt: TicketOperation) => ({ preprocessingOperationId: receipt.plan.operationId, assigneeId: "3", comment: "Synthetic advance" });

describe("生产引擎的通用fieldJob工作流合成HTTP闭环", () => {
  it("submit→单次预处理→advance→新预处理→close，经实际后端/执行器/账本逐步验证", async () => {
    const s = await preprocessed();
    expect(s.receipt.plan.input.workflowRecord).toMatchObject({ id: "1", customItem62__c: 2 });
    expect((await s.step("advance", advanceInput(s.receipt))).state).toBe("verified");
    const terminal = await s.step("workflow_preprocess"); expect(terminal.state).toBe("verified");
    const closed = await s.step("close", { preprocessingOperationId: terminal.plan.operationId, comment: "Synthetic terminal task" });
    expect(closed.state).toBe("verified"); expect(s.server.record).toMatchObject({ status: 9, customItem62__c: 4 }); expect(s.server.taskId).toBeNull();
    expect(s.server.writes.map((entry) => entry.path.split("/").at(-1))).toEqual(["fieldJob", "preProcessor", "fieldJob", "preProcessor", "fieldJob"]);
    expect(s.server.writes.every((entry) => entry.replay === "never" && entry.redirects === 0)).toBe(true);
    expect(s.server.recordQueries).toBeGreaterThan(5); expect(s.server.metadataQueries).toBeGreaterThan(0);
    expect(s.store.read(s.receipt.plan.operationId).state).toBe("verified");
  });
  it("execute实时复查候选，处理人被移出后不发送准备好的submit", async () => {
    const s = setup(), plan = await s.prepare("submit", submitInput); s.server.candidateIds = [4];
    await expect(s.execute(plan)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(s.server.writes).toHaveLength(0); expect(s.store.read(plan.planId).state).toBe("prepared");
  });
  it("候选集合变化即使原选中人仍合法，也必须重新prepare", async () => {
    const s = setup(), plan = await s.prepare("submit", submitInput); s.server.candidateIds = [3, 4];
    await expect(s.execute(plan)).rejects.toMatchObject({ code: "PLAN_STALE" }); expect(s.server.writes).toHaveLength(0);
  });
  it("旧预处理receipt不能在advance后的新任务用来close，原账本不被更改", async () => {
    const s = await preprocessed(); await s.step("advance", advanceInput(s.receipt));
    const before = s.server.writes.length;
    await expect(s.prepare("close", { preprocessingOperationId: s.receipt.plan.operationId, comment: "Wrong old receipt" })).rejects.toMatchObject({ code: "PLAN_STALE" });
    expect(s.server.writes).toHaveLength(before); expect(s.store.read(s.receipt.plan.operationId).state).toBe("verified");
  });
  it("网页式任务变化使已验证receipt立即失效，未发送advance", async () => {
    const s = await preprocessed(); s.server.taskId = 15; const before = s.server.writes.length;
    await expect(s.prepare("advance", advanceInput(s.receipt))).rejects.toMatchObject({ code: "PLAN_STALE" }); expect(s.server.writes).toHaveLength(before);
  });
  it("预处理超时后保持unknown，重复execute不自动重放或伪造receipt", async () => {
    const s = await submitted(); s.server.preprocessTimeout = true;
    const plan = await s.prepare("workflow_preprocess"), result = await s.execute(plan);
    expect(result.state).toBe("outcome_unknown"); expect((await s.execute(plan)).state).toBe("outcome_unknown");
    expect(s.server.writes.filter((entry) => entry.path.endsWith("preProcessor"))).toHaveLength(1);
    await expect(s.prepare("advance", advanceInput(result))).rejects.toMatchObject({ code: "UNVERIFIED" });
  });
  it("code200但无下一步结构的预处理响应不记verified", async () => {
    const s = await submitted(); s.server.preprocessMalformed = true;
    const result = await s.step("workflow_preprocess"); expect(result.state).toBe("outcome_unknown");
    await expect(s.prepare("advance", advanceInput(result))).rejects.toMatchObject({ code: "UNVERIFIED" });
  });
  it("预处理引起意外父记录变化时，回读保持pending，禁止拿该操作推进", async () => {
    const s = await submitted(); s.server.preprocessMutatesRecord = true;
    const result = await s.step("workflow_preprocess"); expect(result.state).toBe("applied_pending_verification");
    expect(result.verification?.checks.some((check) => !check.matched)).toBe(true);
    await expect(s.prepare("advance", advanceInput(result))).rejects.toMatchObject({ code: "UNVERIFIED" });
  });
});
