import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ACTIONS,
  KNOWN_FIELDS,
  TicketError,
  type ActionContract,
  type Inspection,
  type RecordData,
  type TicketBackend,
  type TicketContext,
  type TicketMetadata,
  type TicketPlan,
} from "../../../src/tickets/types.js";
import { ContractRegistry, digest } from "../../../src/tickets/contracts.js";
import { TicketActions } from "../../../src/tickets/actions.js";
import { OperationStore } from "../../../src/tickets/operation-store.js";
import {
  TicketService,
  operationSummary,
} from "../../../src/services/ticket.service.js";
import { normalizeMetadata } from "../../../src/tickets/metadata.js";
import { guardObjectWrite } from "../../../src/tickets/guard.js";

const temporary: string[] = [];
afterEach(() => {
  for (const p of temporary.splice(0))
    rmSync(p, { recursive: true, force: true });
});
function directory() {
  const p = mkdtempSync(path.join(os.tmpdir(), "xsy-ticket-test-"));
  temporary.push(p);
  return p;
}
function contract(action: (typeof ACTIONS)[number]): ActionContract {
  const c: ActionContract = {
    action,
    verification: "verified",
    version: "synthetic-v1",
    evidence: {
      source: "synthetic",
      reference: "unit fixture; not a CRM contract",
      verifiedAt: "2026-11-24T00:00:00+08:00",
    },
    fields: { reason: { type: "string", required: true } },
    fieldMode: "action",
    required: [],
    defaults: { reason: "synthetic reason" },
    preconditionFields: ["status", "entityType"],
    effects: ["synthetic state change"],
    request: {
      host: "api",
      method: "POST",
      path: `/synthetic/${action}`,
      encoding: "json",
      payload: { reason: { $ref: "input.reason" } },
      successPath: "code",
      successValues: [200],
      resultIdPath: action === "create" ? "data.id" : undefined,
    },
    probe: {
      request: {
        host: "api",
        method: "GET",
        path: "/synthetic/probe",
        encoding: "json",
        successPath: "code",
        successValues: [200],
      },
      permissionPath: "data.permission",
      allowedPath: "data.allowed",
    },
    verify: { checks: [{ field: "status", expected: action }] },
  };
  if (action === "create") {
    c.fieldMode = "create";
    c.fields = { name: { type: "string" }, entityType: { type: "string" } };
    c.defaults = { name: "synthetic", entityType: "2" };
    c.request!.payload = { data: { $ref: "input" } };
  }
  return c;
}
class FakeBackend implements TicketBackend {
  key = "context-one";
  sends = 0;
  permission: Inspection["permission"] = "allowed";
  allowed: Inspection["allowed"] = "allowed";
  identityVerified = true;
  required: string[] = [];
  defaults: RecordData = {};
  formVersion = "one";
  lastQuery = "";
  failure?: string;
  verifyFailure = false;
  verified = true;
  record: RecordData = {
    id: "1",
    status: "New",
    entityType: "2",
    priority: "P1",
    responsibleTE__c: "3",
    customItem62__c: "draft",
    name: "synthetic",
    extraSecret: "must not be returned by search",
  };
  fieldMeta: TicketMetadata = {
    apiKey: "fieldJob",
    flags: { disabled: true, createable: true },
    fields: KNOWN_FIELDS.map((apiKey) => ({
      apiKey,
      label: apiKey,
      type: "String",
      required: false,
      createable: true,
      updateable: !["ownerId", "entityType"].includes(apiKey),
      enabled: true,
      options: [],
    })),
  };
  async context(): Promise<TicketContext> {
    return {
      key: this.key,
      apiBaseUrl: "https://api.example.test",
      crmBaseUrl: "https://crm.example.test",
      tenantId: "synthetic",
      subjectId: "synthetic-user",
      identityVerified: this.identityVerified,
    };
  }
  async metadata() {
    return structuredClone(this.fieldMeta);
  }
  async query(sql: string) {
    this.lastQuery = sql;
    return { records: [{ ...this.record }], count: 1, totalSize: 101 };
  }
  async get(_id: string, fields?: string[]) {
    return fields
      ? Object.fromEntries(fields.map((f) => [f, this.record[f]]))
      : { ...this.record };
  }
  async inspect(
    _contract: ActionContract,
    id: string | undefined,
    _input: RecordData,
  ): Promise<Inspection> {
    return {
      record: id ? { ...this.record } : null,
      permission: this.permission,
      allowed: this.allowed,
      identityVerified: this.identityVerified,
      required: this.required,
      defaults: this.defaults,
      fields: {},
      formVersion: this.formVersion,
    };
  }
  async submit(c: ActionContract, _plan: TicketPlan) {
    this.sends++;
    this.record.status = c.action;
    if (c.action === "create") this.record.id = "2";
    if (this.failure)
      throw new TicketError(this.failure, "synthetic response loss");
    return { id: String(this.record.id), output: {} };
  }
  async verify() {
    if (this.verifyFailure) throw new Error("synthetic read failure");
    return {
      status: this.verified ? ("verified" as const) : ("pending" as const),
      checks: [{ field: "status", matched: this.verified }],
    };
  }
}
function setup(contracts: ActionContract[] = ACTIONS.map(contract)) {
  const registry = new ContractRegistry(
    {
      version: 1,
      scope: {
        apiBaseUrl: "https://api.example.test",
        crmBaseUrl: "https://crm.example.test",
        tenantId: "synthetic",
      },
      actions: contracts,
    },
    { allowSynthetic: true },
  );
  const backend = new FakeBackend();
  const store = new OperationStore(directory());
  let clock = Date.parse("2026-11-24T00:00:00+08:00");
  const actions = new TicketActions(backend, registry, store, () => clock);
  return {
    registry,
    backend,
    store,
    actions,
    tick: () => {
      clock += 3601 * 1000;
    },
  };
}
async function ready(
  s: ReturnType<typeof setup>,
  action: (typeof ACTIONS)[number] = "close",
  input: RecordData = {},
) {
  const result = await s.actions.prepare({
    action,
    id: action === "create" ? undefined : "1",
    input,
  });
  if (result.status !== "ready")
    throw new Error("expected synthetic ready plan");
  return result.plan;
}
const confirm = (p: TicketPlan) => ({
  fingerprint: p.fingerprint,
  source: "cli" as const,
  reference: "explicit synthetic test authorization",
});

describe("工单只读与元数据", () => {
  it("保留 disabled 的歧义并兼容真实字段拼写", () => {
    const meta = normalizeMetadata({
      code: 200,
      data: {
        apiKey: "fieldJob",
        disabled: true,
        createable: true,
        fields: [
          {
            apiKey: "ownerId",
            type: "reference",
            createable: true,
            updateable: false,
          },
        ],
      },
    });
    expect(meta.flags.disabled).toBe(true);
    expect(meta.fields[0].createable).toBe(true);
    expect(meta.fields[0].updateable).toBe(false);
    expect(() =>
      normalizeMetadata({
        code: 200,
        data: { apiKey: "serviceCase", fields: [] },
      }),
    ).toThrow();
  });
  it("过滤销售易 isActive=false 的枚举选项", () => {
    const m = normalizeMetadata({
      code: 200,
      data: {
        apiKey: "fieldJob",
        fields: [
          {
            apiKey: "priority",
            selectitem: [
              { label: "active", value: "P1", isActive: true },
              { label: "inactive", value: "P0", isActive: false },
            ],
          },
        ],
      },
    });
    expect(m.fields[0].options).toEqual([{ label: "active", value: "P1" }]);
  });
  it("分页查询转义字符串，结果在 JSON 格式化前裁剪", async () => {
    const s = setup();
    const service = new TicketService(s.backend, s.registry, s.store);
    const result = await service.search({
      keyword: "it's",
      page: 2,
      size: 20,
      fields: ["id", "name"],
    });
    expect(s.backend.lastQuery).toContain("name like 'it''s%'");
    expect(s.backend.lastQuery).toContain("limit 20,20");
    expect(result.nextPage).toBe(3);
    expect(result.records[0]).toEqual({ id: "1", name: "synthetic" });
    expect(JSON.stringify(result)).not.toContain("extraSecret");
  });
  it.each([
    { size: 101 },
    { page: 0 },
    { size: NaN },
    { id: "1' or 1=1" },
    { fields: ["id,secret"] },
    { keyword: "%" },
  ])("拒绝越界分页和非结构化输入 %j", async (input) => {
    const s = setup();
    const service = new TicketService(s.backend, s.registry, s.store);
    await expect(service.search(input as never)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
  });
  it("未核验编号和日期字段不使用猜测映射", async () => {
    const s = setup();
    const service = new TicketService(s.backend, s.registry, s.store);
    await expect(service.search({ number: "SYN-1" })).rejects.toMatchObject({
      code: "UNVERIFIED",
    });
    await expect(
      service.search({ since: "2026-11-24T00:00:00+08:00" }),
    ).rejects.toMatchObject({ code: "UNVERIFIED" });
  });
  it("历史状态查询不被当前活动选项列表误禁", async () => {
    const s = setup();
    s.backend.fieldMeta.fields.find((f) => f.apiKey === "status")!.options = [
      { value: "New", label: "current" },
    ];
    await new TicketService(s.backend, s.registry, s.store).search({
      status: ["historical-raw-value"],
    });
    expect(s.backend.lastQuery).toContain("status in ('historical-raw-value')");
  });
  it("默认能力报告不把对象 createable 当成用户写权限", async () => {
    const s = setup();
    const service = new TicketService(
      s.backend,
      new ContractRegistry(),
      s.store,
    );
    const caps = await service.capabilities();
    expect(caps.actions).toHaveLength(ACTIONS.length);
    expect(
      caps.actions.every(
        (a) =>
          a.contract === "unverified" &&
          !a.executable &&
          a.permission === "unknown",
      ),
    ).toBe(true);
  });
  it("元数据读取成功不冒充实际记录读取权限", async () => {
    const s = setup();
    const service = new TicketService(
      s.backend,
      new ContractRegistry(),
      s.store,
    );
    expect((await service.capabilities({ refresh: true })).read).toMatchObject({
      runtime: "unverified",
      permission: "unknown",
      metadataRead: "verified",
    });
  });
  it("单个动作探测失败保留 unknown，不隐藏其他能力", async () => {
    const s = setup();
    const inspect = s.backend.inspect.bind(s.backend);
    s.backend.inspect = async (c, id, input) => {
      if (c.action === "pause")
        throw new TicketError("UNVERIFIED", "synthetic missing probe input");
      return inspect(c, id, input);
    };
    const caps = await new TicketService(
      s.backend,
      s.registry,
      s.store,
    ).capabilities({ id: "1" });
    expect(caps.actions.find((a) => a.action === "pause")).toMatchObject({
      permission: "unknown",
      reason: "UNVERIFIED",
      executable: false,
    });
    expect(caps.actions.find((a) => a.action === "close")).toMatchObject({
      permission: "allowed",
    });
  });
  it("缺少远端历史来源时返回未核验", async () => {
    const s = setup();
    await expect(
      new TicketService(s.backend, s.registry, s.store).timeline("1"),
    ).rejects.toMatchObject({ code: "UNVERIFIED" });
  });
});

describe("契约与通用入口保护", () => {
  it("未核验动作只返回 blocked，不生成可执行指纹", async () => {
    const s = setup();
    const actions = new TicketActions(
      s.backend,
      new ContractRegistry(),
      s.store,
    );
    expect(await actions.prepare({ action: "close", id: "1" })).toMatchObject({
      status: "blocked",
      code: "UNVERIFIED",
    });
    expect(s.backend.sends).toBe(0);
  });
  it("生产运行时拒绝合成契约", () => {
    expect(
      () => new ContractRegistry({ version: 1, actions: [contract("close")] }),
    ).toThrow();
  });
  it.each([
    "/rest/data/v2/objects/fieldJob/:id",
    "/rest/data/v2/objects/fieldJob/123",
    "/rest/data/v2/objects/FIELDJOB/123",
  ])("拒绝伪装成关闭的主表 PATCH %s", (route) => {
    const c = contract("close");
    c.request!.method = "PATCH";
    c.request!.path = route;
    expect(() => setup([c])).toThrow("生命周期动作");
  });
  it.each(["fieldJob", "fieldJob/../fieldJob", "fieldJob%2f1"])(
    "保护工单写入及路径变体 %s",
    (apiKey) => expect(() => guardObjectWrite(apiKey)).toThrow(),
  );
  it("其他对象继续使用原通用 CRUD", () =>
    expect(() => guardObjectWrite("account")).not.toThrow());
});

describe("不可变计划与执行保障", () => {
  it("合并已核验表单默认值并检查动态必填", async () => {
    const s = setup();
    s.backend.required = ["reason"];
    await expect(
      s.actions.prepare({ action: "close", id: "1", input: { reason: "" } }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    const p = await ready(s);
    expect(p.payload).toEqual({ reason: "synthetic reason" });
    expect(p.concurrency).toBe("best_effort");
    expect(s.backend.sends).toBe(0);
  });
  it.each(["denied", "unknown"] as const)(
    "权限 %s 时没有写入",
    async (permission) => {
      const s = setup();
      s.backend.permission = permission;
      await expect(ready(s)).rejects.toMatchObject({
        code: permission === "denied" ? "FORBIDDEN" : "UNVERIFIED",
      });
      expect(s.backend.sends).toBe(0);
    },
  );
  it("身份未核验和状态不允许时没有写入", async () => {
    const s = setup();
    s.backend.identityVerified = false;
    await expect(ready(s)).rejects.toMatchObject({
      code: "IDENTITY_UNVERIFIED",
    });
    s.backend.identityVerified = true;
    s.backend.allowed = "denied";
    await expect(ready(s)).rejects.toMatchObject({
      code: "ACTION_NOT_ALLOWED",
    });
  });
  it("ownerId 与 entityType 不可通过普通更新改变", async () => {
    for (const key of ["ownerId", "entityType"]) {
      const c = contract("assign");
      c.fieldMode = "update";
      c.fields = { [key]: { type: "string" } };
      c.defaults = {};
      const s = setup([c]);
      await expect(ready(s, "assign", { [key]: "4" })).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
  });
  it("对象级必填缺失时不能准备创建", async () => {
    const c = contract("create");
    c.fieldMode = "create";
    c.fields = { name: { type: "string" } };
    c.defaults = {};
    const s = setup([c]);
    s.backend.fieldMeta.fields.find((f) => f.apiKey === "address")!.required =
      true;
    await expect(
      ready(s, "create", { name: "synthetic" }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
  });
  it("指纹确认不匹配、状态变化和过期计划均零写入", async () => {
    const s = setup();
    const p = await ready(s);
    await expect(
      s.actions.execute(p.planId, { ...confirm(p), fingerprint: "wrong" }),
    ).rejects.toMatchObject({ code: "CONFIRMATION_MISMATCH" });
    s.backend.record.status = "changed";
    await expect(s.actions.execute(p.planId, confirm(p))).rejects.toMatchObject(
      { code: "PLAN_STALE" },
    );
    s.tick();
    await expect(s.actions.execute(p.planId, confirm(p))).rejects.toMatchObject(
      { code: "PLAN_EXPIRED" },
    );
    expect(s.backend.sends).toBe(0);
  });
  it("表单规则或契约变化使计划失效", async () => {
    const s = setup();
    const p = await ready(s);
    s.backend.formVersion = "two";
    await expect(s.actions.execute(p.planId, confirm(p))).rejects.toMatchObject(
      { code: "PLAN_STALE" },
    );
    s.registry.get("close").version = "changed";
    await expect(s.actions.execute(p.planId, confirm(p))).rejects.toMatchObject(
      { code: "PLAN_STALE" },
    );
  });
  it("对象字段元数据变化使创建计划失效", async () => {
    const s = setup();
    const p = await ready(s, "create");
    s.backend.fieldMeta.fields.find((f) => f.apiKey === "address")!.required =
      true;
    await expect(s.actions.execute(p.planId, confirm(p))).rejects.toMatchObject(
      { code: "PLAN_STALE" },
    );
    expect(s.backend.sends).toBe(0);
  });
  it("身份切换与私有计划被篡改时拒绝执行", async () => {
    const s = setup();
    const p = await ready(s);
    s.backend.key = "another";
    await expect(s.actions.execute(p.planId, confirm(p))).rejects.toMatchObject(
      { code: "CONTEXT_MISMATCH" },
    );
    s.backend.key = "context-one";
    const op = s.store.read(p.planId);
    op.plan.input.reason = "tampered";
    s.store.save(op);
    await expect(s.actions.execute(p.planId, confirm(p))).rejects.toMatchObject(
      { code: "CONFIRMATION_MISMATCH" },
    );
    expect(s.backend.sends).toBe(0);
  });
  it("重复执行只发送一次，过期后仍可读取原执行结果", async () => {
    const s = setup();
    const p = await ready(s);
    expect((await s.actions.execute(p.planId, confirm(p))).state).toBe(
      "verified",
    );
    s.tick();
    expect((await s.actions.execute(p.planId, confirm(p))).state).toBe(
      "verified",
    );
    expect(s.backend.sends).toBe(1);
  });
  it("两个独立存储实例竞争同一计划最多发送一次", async () => {
    const s = setup();
    const p = await ready(s);
    const second = new TicketActions(
      s.backend,
      s.registry,
      new OperationStore(s.store.directory),
      () => Date.parse(p.createdAt),
    );
    const results = await Promise.allSettled([
      s.actions.execute(p.planId, confirm(p)),
      second.execute(p.planId, confirm(p)),
    ]);
    expect(results.some((r) => r.status === "fulfilled")).toBe(true);
    expect(s.backend.sends).toBe(1);
  });
  it.each(["OUTCOME_UNKNOWN", "ECONNRESET"])(
    "写入后 %s 不盲目重放",
    async (error) => {
      const s = setup();
      const p = await ready(s);
      s.backend.failure = error;
      expect((await s.actions.execute(p.planId, confirm(p))).state).toBe(
        "outcome_unknown",
      );
      expect((await s.actions.execute(p.planId, confirm(p))).state).toBe(
        "outcome_unknown",
      );
      expect(s.backend.sends).toBe(1);
    },
  );
  it("明确拒绝与响应不确定分开保存", async () => {
    const s = setup();
    const p = await ready(s);
    s.backend.failure = "REMOTE_REJECTED";
    expect((await s.actions.execute(p.planId, confirm(p))).state).toBe(
      "rejected",
    );
  });
  it("已提交但回读失败保留 pending，回查不会重发", async () => {
    const s = setup();
    const p = await ready(s);
    s.backend.verifyFailure = true;
    expect((await s.actions.execute(p.planId, confirm(p))).state).toBe(
      "applied_pending_verification",
    );
    s.backend.verifyFailure = false;
    expect((await s.actions.reconcile(p.planId)).state).toBe("verified");
    expect(s.backend.sends).toBe(1);
  });
  it("审计摘要保留确认来源，不输出完整 payload 与输入", async () => {
    const s = setup();
    const p = await ready(s);
    const summary = operationSummary(
      await s.actions.execute(p.planId, confirm(p)),
    );
    expect(summary.confirmation?.source).toBe("cli");
    expect(summary).not.toHaveProperty("plan");
    expect(JSON.stringify(summary)).not.toContain("synthetic reason");
  });
  it("崩溃恢复保留 dispatching 的不确定性，不重发", async () => {
    const s = setup();
    const p = await ready(s);
    const op = s.store.read(p.planId);
    op.state = "dispatching";
    s.store.save(op);
    expect((await s.actions.execute(p.planId, confirm(p))).state).toBe(
      "outcome_unknown",
    );
    expect(s.backend.sends).toBe(0);
  });
  it("已退出进程留下执行锁时，仍可只读恢复已确认提交的验证", async () => {
    const s = setup();
    const p = await ready(s);
    s.backend.verifyFailure = true;
    await s.actions.execute(p.planId, confirm(p));
    writeFileSync(
      path.join(s.store.directory, `${p.planId}.lock`),
      JSON.stringify({ pid: 2147483647 }),
    );
    s.backend.verifyFailure = false;
    expect((await s.actions.reconcile(p.planId)).state).toBe("verified");
    expect(s.backend.sends).toBe(1);
  });
  it("计划私有存储权限正确且不借用 auth.json", async () => {
    const s = setup();
    const p = await ready(s);
    expect(statSync(s.store.directory).mode & 0o777).toBe(0o700);
    expect(
      statSync(path.join(s.store.directory, `${p.planId}.json`)).mode & 0o777,
    ).toBe(0o600);
    expect(
      JSON.parse(
        readFileSync(path.join(s.store.directory, `${p.planId}.json`), "utf8"),
      ).plan.fingerprint,
    ).toBe(p.fingerprint);
  });
  it("附件准备不上传，文件改变使执行计划失效", async () => {
    const c = contract("attachment_upload");
    c.fields.filePath = { type: "string", required: true };
    c.request!.encoding = "multipart";
    c.request!.fileField = "file";
    const s = setup([c]);
    const file = path.join(directory(), "synthetic.txt");
    writeFileSync(file, "before");
    const p = await ready(s, "attachment_upload", { filePath: file });
    expect(s.backend.sends).toBe(0);
    writeFileSync(file, "after");
    await expect(s.actions.execute(p.planId, confirm(p))).rejects.toMatchObject(
      { code: "PLAN_STALE" },
    );
    expect(s.backend.sends).toBe(0);
  });
  it.each(ACTIONS)("已核验合成动作 %s 共用执行器且只发送一次", async (action) => {
    const s = setup([contract(action)]);
    const p = await ready(s, action);
    expect((await s.actions.execute(p.planId, confirm(p))).state).toBe("verified");
    expect(s.backend.sends).toBe(1);
    expect(s.registry.get(action).evidence?.source).toBe("synthetic");
  });
  it("模板与契约使用规范 JSON 指纹", () =>
    expect(digest({ b: 1, a: 2 })).toBe(digest({ a: 2, b: 1 })));
});
