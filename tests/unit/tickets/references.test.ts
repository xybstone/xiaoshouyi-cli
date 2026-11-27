import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ContractRegistry } from "../../../src/tickets/contracts.js";
import { TicketReferences, eventTime, referenceSchema } from "../../../src/tickets/references.js";
import { TicketService } from "../../../src/services/ticket.service.js";
import { OperationStore } from "../../../src/tickets/operation-store.js";
import { CrmTicketBackend } from "../../../src/tickets/backend.js";
import { callTicketTool, ticketToolDefinitions } from "../../../src/tickets/mcp.js";
import type { TicketBackend, RecordData } from "../../../src/tickets/types.js";

const scope = { apiBaseUrl: "https://api.example.test", crmBaseUrl: "https://crm.example.test", tenantId: "test" };
const evidence = { source: "synthetic", reference: "bounded reference fixture, not a CRM contract", verifiedAt: "2026-11-24T00:00:00+08:00" };
function queryContract(extra: RecordData = {}) {
  return referenceSchema.parse({ kind: "responsible", verification: "verified", evidence,
    query: { apiKey: "person", nameField: "displayName" }, ...extra });
}
function backend() {
  return {
    context: vi.fn(async () => ({ ...scope, key: "test", subjectId: "tester", identityVerified: true, crmIdentityVerified: true })),
    query: vi.fn(async (_sql: string) => ({ records: [{ id: "2", displayName: "工程师" }], totalSize: 1, count: 1 })),
    readRequest: vi.fn(async () => ({ code: 200, data: { records: [], total: 0, hasMore: false } })),
    get: vi.fn(async () => ({ id: "1", entityType: "3", status: 1 })),
    metadata: vi.fn(async () => ({ apiKey: "fieldJob", flags: {}, fields: [] })),
    inspect: vi.fn(async () => ({ record: { id: "1", entityType: "3", status: 1 }, permission: "allowed", allowed: "allowed", identityVerified: true,
      required: [], defaults: {}, fields: {}, formVersion: "one" })),
    submit: vi.fn(), verify: vi.fn(),
  } as unknown as TicketBackend & { query: ReturnType<typeof vi.fn>; readRequest: ReturnType<typeof vi.fn>; context: ReturnType<typeof vi.fn>; inspect: ReturnType<typeof vi.fn> };
}
const dirs: string[] = [];
afterEach(() => {
  for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe("有证据范围的引用解析", () => {
  it("未核验引用不发查询；指定ID不能绕过核验", async () => {
    const b = backend();
    const r = await new TicketReferences(b, [], scope).resolve({ kind: "responsible", id: "2" });
    expect(r).toMatchObject({ status: "blocked", code: "UNVERIFIED", eligibility: "unknown" });
    expect(b.query).not.toHaveBeenCalled();
  });
  it("拒绝不匹配身份范围，避免跨租户解析", async () => {
    const b = backend();
    await expect(new TicketReferences(b, [queryContract()], { ...scope, tenantId: "other" }).resolve({ kind: "responsible", name: "工程师" }))
      .rejects.toMatchObject({ code: "CONTEXT_MISMATCH" });
    expect(b.query).not.toHaveBeenCalled();
  });
  it("未知身份保持未核验，不冒充明确跨租户冲突", async () => {
    const b = backend();
    b.context.mockResolvedValue({ ...scope, key: "test", identityVerified: false });
    await expect(new TicketReferences(b, [queryContract()], scope).resolve({ kind: "responsible", id: "2" }))
      .rejects.toMatchObject({ code: "IDENTITY_UNVERIFIED" });
    expect(b.query).not.toHaveBeenCalled();
  });
  it("唯一精确名称解析成ID，仍不宣称允许分派", async () => {
    const b = backend();
    const r = await new TicketReferences(b, [queryContract()], scope).resolve({ kind: "responsible", name: "工程师", limit: 2 });
    expect(r).toMatchObject({ status: "resolved", id: "2", totalCount: 1, eligibility: "unknown" });
    expect(b.query.mock.calls[0][0]).toBe("select id,displayName from person where displayName = '工程师' order by id asc limit 0,2");
  });
  it("同名多候选阻止自动选择，即使本页只有1个候选", async () => {
    const b = backend();
    b.query.mockResolvedValue({ records: [{ id: "2", displayName: "工程师" }], totalSize: 3, count: 1 });
    const r = await new TicketReferences(b, [queryContract()], scope).resolve({ kind: "responsible", name: "工程师", limit: 1 });
    expect(r).toMatchObject({ status: "blocked", code: "AMBIGUOUS_REFERENCE", totalCount: 3, truncated: true });
  });
  it("池或部门约束缺失时阻止宽查询，提供后绑定条件", async () => {
    const b = backend();
    const c = queryContract({ query: { apiKey: "person", nameField: "displayName", filters: [{ field: "pool", input: "poolId" }] } });
    const r = new TicketReferences(b, [c], scope);
    expect(await r.resolve({ kind: "responsible", name: "工程师" })).toMatchObject({ code: "REFERENCE_CONTEXT_REQUIRED" });
    expect(b.query).not.toHaveBeenCalled();
    expect(await r.resolve({ kind: "responsible", name: "工程师", poolId: "3" })).toMatchObject({ status: "resolved" });
    expect(b.query.mock.calls[0][0]).toContain("pool = '3' and displayName = '工程师'");
  });
  it("不默默忽略调用者提供但契约未核验的池约束", async () => {
    const b = backend();
    expect(await new TicketReferences(b, [queryContract()], scope).resolve({ kind: "responsible", name: "工程师", poolId: "3" }))
      .toMatchObject({ status: "blocked", code: "REFERENCE_CONSTRAINT_UNVERIFIED" });
    expect(b.query).not.toHaveBeenCalled();
  });
  it("有池约束时选择已核验成员关联查询，支持三级字段但不猜成员对象", async () => {
    const b = backend();
    const c = queryContract({ scopedQueries: [{ input: "poolId", query: {
      apiKey: "syntheticPoolMember", idField: "member.id", nameField: "member.displayName",
      filters: [{ field: "pool", input: "poolId" }],
    } }] });
    b.query.mockResolvedValue({ records: [{ member: { id: "2", displayName: "工程师" } }], totalSize: 1, count: 1 });
    expect(await new TicketReferences(b, [c], scope).resolve({ kind: "responsible", name: "工程师", poolId: "3" }))
      .toMatchObject({ status: "resolved", id: "2", eligibility: "unknown" });
    expect(b.query.mock.calls[0][0]).toContain("from syntheticPoolMember where pool = '3' and member.displayName = '工程师'");
  });
  it("两步池成员核验可在完整同名候选中消歧，不依赖引用字段join", async () => {
    const b = backend();
    const c = queryContract({ membership: { apiKey: "syntheticMembers", candidateField: "member", poolField: "pool" } });
    b.query.mockResolvedValueOnce({ records: [{ id: "2", displayName: "工程师" }, { id: "4", displayName: "工程师" }], totalSize: 2, count: 2 });
    b.query.mockResolvedValueOnce({ records: [], totalSize: 0, count: 0 });
    b.query.mockResolvedValueOnce({ records: [{ id: "9", member: "4", pool: "3" }], totalSize: 1, count: 1 });
    expect(await new TicketReferences(b, [c], scope).resolve({ kind: "responsible", name: "工程师", poolId: "3" }))
      .toMatchObject({ status: "resolved", id: "4", eligibility: "unknown" });
    expect(b.query.mock.calls[2][0]).toContain("where member = '4' and pool = '3'");
  });
  it("池不包含候选时阻止解析；候选分页不全不能推断池内唯一", async () => {
    const b = backend();
    const c = queryContract({ membership: { apiKey: "syntheticMembers", candidateField: "member", poolField: "pool" } });
    b.query.mockResolvedValueOnce({ records: [{ id: "2", displayName: "工程师" }], totalSize: 1, count: 1 });
    b.query.mockResolvedValueOnce({ records: [], totalSize: 0, count: 0 });
    const r = new TicketReferences(b, [c], scope);
    expect(await r.resolve({ kind: "responsible", name: "工程师", poolId: "3" })).toMatchObject({ status: "blocked", code: "POOL_MEMBERSHIP_UNVERIFIED", eligibility: "unknown" });
    b.query.mockResolvedValueOnce({ records: [{ id: "2", displayName: "工程师" }], totalSize: 2, count: 1 });
    expect(await r.resolve({ kind: "responsible", name: "工程师", poolId: "3", limit: 1 }))
      .toMatchObject({ status: "blocked", code: "REFERENCE_CANDIDATES_INCOMPLETE", truncated: true });
    expect(b.query).toHaveBeenCalledTimes(3);
  });
  it("转义精确名称且拒绝查询不遵守匹配条件", async () => {
    const b = backend();
    b.query.mockResolvedValue({ records: [{ id: "2", displayName: "O'Reilly" }], totalSize: 1, count: 1 });
    const r = new TicketReferences(b, [queryContract()], scope);
    await r.resolve({ kind: "responsible", name: "O'Reilly" });
    expect(b.query.mock.calls[0][0]).toContain("displayName = 'O''Reilly'");
    await expect(r.resolve({ kind: "responsible", id: "3" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it("未经核验的反斜杠和控制字符转义不进入查询", async () => {
    const b = backend(); const r = new TicketReferences(b, [queryContract()], scope);
    for (const name of ["a\\'b", "a\nb", "a\u0000b"])
      await expect(r.resolve({ kind: "responsible", name })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(b.query).not.toHaveBeenCalled();
  });
  it("拒绝无效计数、重复ID和不安全数值ID", async () => {
    const b = backend(); const r = new TicketReferences(b, [queryContract()], scope);
    for (const page of [
      { records: [{ id: "2", displayName: "工程师" }], totalSize: 0 },
      { records: [{ id: "2", displayName: "工程师" }, { id: "2", displayName: "工程师" }], totalSize: 2 },
      { records: [{ id: Number.MAX_SAFE_INTEGER + 1, displayName: "工程师" }], totalSize: 1 },
    ]) {
      b.query.mockResolvedValue(page);
      await expect(r.resolve({ kind: "responsible", name: "工程师" })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    }
  });
  it("接口列表不完整时不能把单个命中视为唯一", async () => {
    const b = backend();
    const c = queryContract({ query: undefined, request: { host: "api", method: "GET", path: "/synthetic/options", successPath: "code", successValues: [200] }, recordsPath: "data.records", totalPath: "data.total", hasMorePath: "data.hasMore" });
    b.readRequest.mockResolvedValue({ code: 200, data: { records: [{ id: "2", name: "工程师" }], total: 3, hasMore: true } });
    expect(await new TicketReferences(b, [c], scope).resolve({ kind: "responsible", name: "工程师" }))
      .toMatchObject({ status: "blocked", code: "REFERENCE_RESULTS_INCOMPLETE" });
  });
  it("选项接口经过完整性映射后只投影ID和名称", async () => {
    const b = backend();
    const c = queryContract({ query: undefined, request: { host: "api", method: "GET", path: "/synthetic/options", successPath: "code", successValues: [200] }, recordsPath: "data.records", totalPath: "data.total", hasMorePath: "data.hasMore" });
    b.readRequest.mockResolvedValue({ code: 200, data: { records: [{ id: "2", name: "工程师", privateValue: "do-not-return" }], total: 1, hasMore: false } });
    const r = await new TicketReferences(b, [c], scope).resolve({ kind: "responsible", name: "工程师" });
    expect(r).toMatchObject({ status: "resolved", candidates: [{ id: "2", name: "工程师" }] });
    expect(JSON.stringify(r)).not.toContain("do-not-return");
  });
  it("生产拒绝synthetic引用，已核验引用必须有范围，不能登记重复类型", () => {
    expect(() => new ContractRegistry({ version: 1, scope, references: [queryContract()] }))
      .toThrow();
    expect(() => new ContractRegistry({ version: 1, references: [queryContract()] }, { allowSynthetic: true }))
      .toThrow();
    expect(() => referenceSchema.parse({ kind: "customer", verification: "verified", evidence, query: { apiKey: "account", nameField: "name" }, options: [] }))
      .toThrow();
    expect(() => new ContractRegistry({ version: 1, scope, references: [queryContract(), queryContract()] }, { allowSynthetic: true }))
      .toThrow();
  });
});

describe("引用与人工核对的MCP入口边界", () => {
  it("引用解析注册为只读，人工核对默认不注册", () => {
    vi.stubEnv("XSY_TICKET_APPROVAL_SECRET", "");
    const tools = ticketToolDefinitions();
    expect(tools.find((t) => t.name === "tickets_reference_resolve")?.annotations.readOnlyHint).toBe(true);
    expect(tools.some((t) => t.name === "tickets_operation_review")).toBe(false);
  });
  it("写入关闭后仍可做有宿主确认的本地核对，不注册执行工具", () => {
    vi.stubEnv("XSY_TICKET_APPROVAL_SECRET", "synthetic-approval-secret-at-least-32-bytes");
    vi.stubEnv("XSY_TICKET_WRITES", "");
    const tools = ticketToolDefinitions();
    expect(tools.find((t) => t.name === "tickets_operation_review")?.annotations.readOnlyHint).toBe(false);
    expect(tools.some((t) => t.name === "tickets_execute")).toBe(false);
  });
  it("confirmed:true不能冒充人工核对的宿主授权", async () => {
    vi.stubEnv("XSY_TICKET_APPROVAL_SECRET", "synthetic-approval-secret-at-least-32-bytes");
    await expect(callTicketTool("tickets_operation_review", {
      operationId: "10000000-0000-4000-8000-000000000001", confirmed: true,
      review: { outcome: "not_applied", reviewedBy: "test", evidenceReferences: ["test-evidence"] },
    })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("伪造宿主签名不能进入账本核对", async () => {
    vi.stubEnv("XSY_TICKET_APPROVAL_SECRET", "synthetic-approval-secret-at-least-32-bytes");
    await expect(callTicketTool("tickets_operation_review", {
      operationId: "10000000-0000-4000-8000-000000000001", fingerprint: `sha256:${"0".repeat(64)}`, approval: "forged.signature",
      review: { outcome: "not_applied", reviewedBy: "test", evidenceReferences: ["test-evidence"] },
    })).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED" });
  });
});

function serviceSetup() {
  const b = backend();
  const registry = new ContractRegistry({ version: 1, scope, references: [queryContract()], actions: [{
    action: "assign", verification: "verified", version: "test", evidence,
    fields: { responsibleTE__c: { type: "string", required: true } },
    request: { host: "api", method: "POST", path: "/synthetic/assign", successPath: "code", successValues: [200], payload: { assignee: { $ref: "input.responsibleTE__c" } } },
    probe: { request: { host: "api", method: "GET", path: "/synthetic/probe", successPath: "code", successValues: [200] }, permissionPath: "data.permission", allowedPath: "data.allowed" },
    verify: { checks: [{ field: "responsibleTE__c", expected: { $ref: "input.responsibleTE__c" } }] },
  }] }, { allowSynthetic: true });
  const directory = mkdtempSync(path.join(os.tmpdir(), "xsy-reference-test-")); dirs.push(directory);
  return { b, service: new TicketService(b, registry, new OperationStore(directory)) };
}
describe("准备动作前的显式引用绑定", () => {
  it("详情按经核验引用读取客户上下文，主表仍遵守字段投影", async () => {
    const b = backend();
    vi.spyOn(b, "metadata").mockResolvedValue({ apiKey: "fieldJob", flags: {}, fields: ["fieldJobAccountId", "fieldJobAssetId"].map((apiKey) => ({ apiKey, label: apiKey, type: "reference", required: false, options: [] })) });
    vi.spyOn(b, "get").mockResolvedValue({ id: "1", fieldJobAccountId: "2", fieldJobAssetId: null });
    b.query.mockResolvedValue({ records: [{ id: "2", accountName: "客户" }], totalSize: 1, count: 1 });
    const registry = new ContractRegistry({ version: 1, scope, references: [queryContract({ kind: "customer", query: { apiKey: "account", nameField: "accountName" } })] }, { allowSynthetic: true });
    const result = await new TicketService(b, registry).get("1", ["id"], true);
    expect(result).toMatchObject({ record: { id: "1" }, context: { account: { coverage: "verified", records: [{ id: "2", name: "客户" }] }, asset: { coverage: "not_linked" } }, coverage: "complete" });
    expect(result.record).not.toHaveProperty("fieldJobAccountId");
  });
  it("将唯一候选绑定到最终payload和指纹计划，不执行写入", async () => {
    const { b, service } = serviceSetup();
    const result = await service.prepare({ action: "assign", id: "1", references: [{ field: "responsibleTE__c", reference: { kind: "responsible", name: "工程师" } }] });
    expect(result).toMatchObject({ status: "ready", plan: { input: { responsibleTE__c: "2" }, payload: { assignee: "2" } } });
    expect(b.submit).not.toHaveBeenCalled();
  });
  it("多个候选时不创建可执行计划，不默认选第一项", async () => {
    const { b, service } = serviceSetup();
    b.query.mockResolvedValue({ records: [{ id: "2", displayName: "工程师" }], totalSize: 2, count: 1 });
    const result = await service.prepare({ action: "assign", id: "1", references: [{ field: "responsibleTE__c", reference: { kind: "responsible", name: "工程师" } }] });
    expect(result).toMatchObject({ status: "blocked", code: "AMBIGUOUS_REFERENCE" });
    expect(result).not.toHaveProperty("plan");
    expect(b.inspect).not.toHaveBeenCalled();
  });
  it("不能覆盖已有显式输入，重复绑定字段同样拒绝", async () => {
    const { service } = serviceSetup();
    const ref = { field: "responsibleTE__c", reference: { kind: "responsible", id: "2" } };
    await expect(service.prepare({ action: "assign", id: "1", input: { responsibleTE__c: "3" }, references: [ref] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    await expect(service.prepare({ action: "assign", id: "1", references: [ref, ref] })).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("未核验动作不为解析引用额外查询", async () => {
    const { b, service } = serviceSetup();
    expect(await service.prepare({ action: "close", id: "1", references: [{ field: "responsibleTE__c", reference: { kind: "responsible", id: "2" } }] })).toMatchObject({ status: "blocked", code: "UNVERIFIED" });
    expect(b.query).not.toHaveBeenCalled();
  });
});

describe("工单服务拒绝不可靠分页返回", () => {
  it.each([
    { records: [{ id: "1" }, { id: "2" }], count: 2, totalSize: 2 },
    { records: [{ id: "1" }], count: 2, totalSize: 2 },
    { records: [{ id: "1" }], count: 1, totalSize: Number.NaN },
    { records: [{ id: "1" }], count: 1, totalSize: Number.MAX_SAFE_INTEGER + 1 },
    { records: [{ id: "1" }], count: 1, totalSize: 0 },
    { records: [], count: 0, totalSize: -1 },
  ])("拒绝忽略上限或冲突计数的页 %#", async (page) => {
    const b = backend(); b.query.mockResolvedValue(page);
    await expect(new TicketService(b, new ContractRegistry()).search({ fields: ["id"], size: 1 }))
      .rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
  it("返回有界一页并保留服务器总数，不把本页当全量", async () => {
    const b = backend(); b.query.mockResolvedValue({ records: [{ id: "1" }], count: 1, totalSize: 101 });
    expect(await new TicketService(b, new ContractRegistry()).search({ fields: ["id"], size: 1 }))
      .toMatchObject({ records: [{ id: "1" }], totalSize: 101, count: 1, nextPage: 2 });
  });
});

describe("时间线按经核验事件时间合并", () => {
  it("仅接受显式编码，不猜秒、标签或不含时区的日期", () => {
    expect(eventTime(1, undefined)).toBeUndefined();
    expect(eventTime("2026-11-24T10:00:00", "iso")).toBeUndefined();
    expect(eventTime("2026-11-24T10:00:00+08:00", "iso")).toBe(Date.parse("2026-11-24T10:00:00+08:00"));
    expect(eventTime("1000", "unix-ms")).toBeUndefined();
  });
  it("合并本次各来源记录，分页未读完时coverage为partial", async () => {
    const registry = new ContractRegistry({ version: 1, scope, timeline: ["a", "b"].map((name) => ({ name, verification: "verified", evidence, query: { apiKey: name, fields: ["body"], linkField: "job", timeField: "occurred", dateEncoding: "unix-ms" } })) }, { allowSynthetic: true });
    class TestBackend extends CrmTicketBackend {
      override async get() { return { id: "1" }; }
      override async resource(q: { apiKey: string; fields: string[] }) {
        expect(q.fields).toContain("occurred");
        return { records: [{ id: q.apiKey === "a" ? "2" : "3", occurred: q.apiKey === "a" ? 1000 : 2000 }], totalSize: q.apiKey === "a" ? 10 : 1, count: 1 };
      }
    }
    const service = new TicketService(new TestBackend(registry), registry);
    const result = await service.timeline("1", 1, 1);
    expect(result.records.map((r) => r.source)).toEqual(["b", "a"]);
    expect(result.coverage).toBe("partial");
    expect(result.ordering).toEqual({ mode: "event_time", scope: "returned_page", complete: true });
  });
});
