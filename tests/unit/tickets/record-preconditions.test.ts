import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TicketActions } from "../../../src/tickets/actions.js";
import { ContractRegistry, digest, recordPreconditionsMatch } from "../../../src/tickets/contracts.js";
import { OperationStore } from "../../../src/tickets/operation-store.js";
import type { ActionContract, Inspection, RecordData, RecordPrecondition, TicketBackend } from "../../../src/tickets/types.js";

const scope = { apiBaseUrl: "https://api.example.test", crmBaseUrl: "https://crm.example.test", tenantId: "synthetic-tenant" };
const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));
function baseContract(): ActionContract {
  return {
    action: "submit", verification: "verified", version: "synthetic-record-preconditions-v1",
    evidence: { source: "synthetic", reference: "offline record semantics fixture", verifiedAt: "2026-11-27T00:00:00+08:00" },
    fields: {}, defaults: {}, required: [], fieldMode: "action", effects: [], preconditionFields: ["status"],
    request: { host: "api", method: "POST", path: "/synthetic/write", encoding: "json", payload: {}, successPath: "code", successValues: [200] },
    probe: { request: { host: "api", method: "GET", path: "/synthetic/probe", encoding: "json", successPath: "code", successValues: [200] }, permissionPath: "permission", allowedPath: "allowed" },
    verify: { checks: [{ field: "status", expected: 3 }] },
  };
}
function registry(c: ActionContract) {
  return new ContractRegistry({ version: 1, scope, actions: [c] }, { allowSynthetic: true });
}
class Backend implements TicketBackend {
  record: RecordData = { id: "1", status: 1, phase__c: 1 };
  sends = 0;
  async context() { return { key: "synthetic-context", ...scope, subjectId: "synthetic-user", identityVerified: true }; }
  async metadata() { return { apiKey: "fieldJob" as const, flags: {}, fields: [] }; }
  async inspect(): Promise<Inspection> {
    // Deliberately permissive custom adapter: actions must still enforce semantics.
    return { record: { ...this.record }, permission: "allowed", allowed: "allowed", identityVerified: true, required: [], defaults: {}, fields: {}, formVersion: "same", output: {} };
  }
  async get() { return { ...this.record }; }
  async query() { return { records: [{ ...this.record }], totalSize: 1, count: 1 }; }
  async submit() { this.sends++; return { id: "1", output: {} }; }
  async verify() { return { status: "verified" as const, checks: [] }; }
}
function setup(c: ActionContract) {
  const backend = new Backend(), r = registry(c);
  const directory = mkdtempSync(path.join(os.tmpdir(), "xsy-record-preconditions-")); directories.push(directory);
  const store = new OperationStore(directory);
  return { backend, registry: r, store, actions: new TicketActions(backend, r, store) };
}

describe("动作记录状态的显式语义条件", () => {
  it("无条件保持兼容，缺字段不能与null相等", () => {
    expect(recordPreconditionsMatch({}, null)).toBe(true);
    const c = { recordPreconditions: [{ field: "phase__c", expected: null }] };
    expect(recordPreconditionsMatch(c, {})).toBe(false);
    expect(recordPreconditionsMatch(c, { phase__c: undefined })).toBe(false);
    expect(recordPreconditionsMatch(c, Object.create({ phase__c: null }))).toBe(false);
    expect(recordPreconditionsMatch(c, { phase__c: null })).toBe(true);
  });
  it("按严格canonical比较JSON字面量，不做字符串数值强转或模板求值", () => {
    const c: { recordPreconditions: RecordPrecondition[] } = { recordPreconditions: [
      { field: "phase__c", expected: 1 },
      { field: "details", expected: { b: [true, null], a: "x" } },
    ] };
    expect(recordPreconditionsMatch(c, { phase__c: 1, details: { a: "x", b: [true, null] } })).toBe(true);
    expect(recordPreconditionsMatch(c, { phase__c: "1", details: { a: "x", b: [true, null] } })).toBe(false);
    expect(recordPreconditionsMatch({ recordPreconditions: [{ field: "phase__c", expected: { $ref: "input.phase" } }] }, { phase__c: 1 })).toBe(false);
  });
  it("未声明可选条件的旧合同hash及旧快照不变，原准备计划可继续执行", async () => {
    const original = baseContract(), legacyHash = digest(original), s = setup(original);
    const parsed = s.registry.get("submit");
    expect(Object.hasOwn(parsed, "recordPreconditions")).toBe(false);
    expect(digest(parsed)).toBe(legacyHash);
    const inspected = await s.backend.inspect();
    const legacySnapshot = digest({
      record: Object.fromEntries(original.preconditionFields.map((field) => [field, inspected.record?.[field] ?? null])),
      permission: inspected.permission, allowed: inspected.allowed, required: inspected.required,
      defaults: inspected.defaults, fields: inspected.fields, formVersion: inspected.formVersion, output: inspected.output ?? {},
    });
    const ready = await s.actions.prepare({ action: "submit", id: "1" });
    if (ready.status !== "ready") throw new Error("Expected ready");
    expect(ready.plan.contractHash).toBe(legacyHash);
    expect(ready.plan.snapshotHash).toBe(legacySnapshot);
    expect((await s.actions.execute(ready.plan.planId, { fingerprint: ready.plan.fingerprint, source: "cli", reference: "synthetic authorization" })).state).toBe("verified");
    expect(s.backend.sends).toBe(1);
  });
  it("prepare即使遇到错误声称allowed的自定义适配器，也拒绝非草稿submit", async () => {
    const c = baseContract(); c.recordPreconditions = [{ field: "phase__c", expected: 1 }, { field: "status", expected: 1 }];
    const s = setup(c); s.backend.record.phase__c = 4;
    await expect(s.actions.prepare({ action: "submit", id: "1" })).rejects.toMatchObject({ code: "ACTION_NOT_ALLOWED" });
    expect(s.backend.sends).toBe(0);
  });
  it("execute在assertInspection前重新校验记录条件，状态变化后零写入", async () => {
    const c = baseContract(); c.recordPreconditions = [{ field: "phase__c", expected: 1 }];
    const s = setup(c), ready = await s.actions.prepare({ action: "submit", id: "1" });
    if (ready.status !== "ready") throw new Error("Expected ready");
    s.backend.record.phase__c = 4;
    await expect(s.actions.execute(ready.plan.planId, { fingerprint: ready.plan.fingerprint, source: "cli", reference: "synthetic authorization" })).rejects.toMatchObject({ code: "ACTION_NOT_ALLOWED" });
    expect(s.backend.sends).toBe(0); expect(s.store.read(ready.plan.planId).state).toBe("prepared");
  });
  it("条件字段即使没有列入preconditionFields也自动参与快照", async () => {
    const c = baseContract(); c.preconditionFields = []; c.recordPreconditions = [{ field: "phase__c", expected: 1 }];
    const s = setup(c), ready = await s.actions.prepare({ action: "submit", id: "1" });
    if (ready.status !== "ready") throw new Error("Expected ready");
    const inspected = await s.backend.inspect();
    const snapshot = { record: { phase__c: 1 }, permission: inspected.permission, allowed: inspected.allowed, required: [], defaults: {}, fields: {}, formVersion: "same", output: {} };
    expect(ready.plan.snapshotHash).toBe(digest(snapshot));
    expect(ready.plan.snapshotHash).not.toBe(digest({ ...snapshot, record: {} }));
  });
  it("创建动作不能声明任何记录条件，包括空数组", () => {
    for (const conditions of [[], [{ field: "phase__c", expected: 1 }]]) {
      const c = baseContract(); c.action = "create"; c.fieldMode = "create"; c.request!.resultIdPath = "data.id"; c.recordPreconditions = conditions;
      expect(() => registry(c)).toThrow("不能声明记录状态条件");
    }
  });
  it.each([undefined, NaN, Infinity, () => 1, new Date("2026-11-27T00:00:00Z")])("expected必须为JSON字面量 %j", (expected) => {
    const c = baseContract();
    expect(() => new ContractRegistry({ version: 1, scope, actions: [{ ...c, recordPreconditions: [{ field: "status", expected }] }] }, { allowSynthetic: true })).toThrow();
  });
});
