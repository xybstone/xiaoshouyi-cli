import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { OperationStore, MAX_RESPONSE_EVIDENCE_BYTES } from "../../../src/tickets/operation-store.js";
import { fingerprint } from "../../../src/tickets/actions.js";
import type { TicketOperation, TicketPlan } from "../../../src/tickets/types.js";

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true })));
function fixture() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "xsy-response-evidence-")); temporary.push(directory);
  const id = randomUUID();
  const unsigned: Omit<TicketPlan, "fingerprint"> = {
    planId: id, operationId: id, contextKey: "synthetic-account-context", action: "attachment_upload", targetId: "11",
    contractVersion: "synthetic-upload-v1", contractHash: "synthetic-contract-hash", snapshotHash: "synthetic-snapshot",
    input: { filePath: "/synthetic/local-file.txt" }, payload: {}, requestHeaders: {}, probeOutput: {},
    effects: ["synthetic upload"], createdAt: "2026-11-27T00:00:00+08:00", expiresAt: "2026-11-27T00:05:00+08:00", concurrency: "best_effort",
  };
  const operation: TicketOperation = { plan: { ...unsigned, fingerprint: fingerprint(unsigned) }, state: "dispatching", updatedAt: unsigned.createdAt };
  const store = new OperationStore(directory); store.create(operation);
  return { id, directory, store, operation, file: path.join(directory, `${id}.response.json`), ledger: path.join(directory, `${id}.json`) };
}
const response = { code: "200", data: [{ fileName: "synthetic.txt", fileUrl: "/rest/file/synthetic", fileId: "72" }] };
function failure(action: () => unknown, code: string) {
  expect(action).toThrowError(expect.objectContaining({ code }));
}

describe("解码前响应证据的不可覆盖保存", () => {
  it("绑定计划/账号/动作/目标并保存可恢复响应，不改写操作账本", () => {
    const s = fixture(), before = readFileSync(s.ledger, "utf8");
    const evidence = s.store.writeResponseEvidence(s.id, response);
    expect(evidence.raw).toEqual(response);
    expect(evidence.binding).toEqual({ planId: s.id, operationId: s.id, fingerprint: s.operation.plan.fingerprint, contextKey: s.operation.plan.contextKey, action: "attachment_upload", targetId: "11", contractHash: s.operation.plan.contractHash });
    expect(s.store.readResponseEvidence(s.id)).toEqual(evidence);
    expect(readFileSync(s.ledger, "utf8")).toBe(before);
    expect(statSync(s.directory).mode & 0o777).toBe(0o700);
    expect(statSync(s.file).mode & 0o777).toBe(0o600);
    expect(readdirSync(s.directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
  it("旧未知操作没有回执时返回undefined，不创建证据或修改旧状态", () => {
    const s = fixture(); s.operation.state = "outcome_unknown"; s.store.save(s.operation);
    const before = readFileSync(s.ledger, "utf8");
    expect(s.store.readResponseEvidence(s.id)).toBeUndefined();
    expect(readFileSync(s.ledger, "utf8")).toBe(before);
    expect(readdirSync(s.directory)).toEqual([`${s.id}.json`]);
  });
  it("重复捕获或另一结果不能覆盖第一份回执", () => {
    const s = fixture(); s.store.writeResponseEvidence(s.id, response); const before = readFileSync(s.file);
    failure(() => s.store.writeResponseEvidence(s.id, { code: 200, data: [{ fileId: "other-result" }] }), "RESPONSE_EVIDENCE_EXISTS");
    expect(readFileSync(s.file)).toEqual(before); expect(s.store.readResponseEvidence(s.id)?.raw).toEqual(response);
    expect(readdirSync(s.directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
  it("没有计划不能单独保存所谓回执，计划内容篡改也不能捕获", () => {
    const s = fixture(); failure(() => s.store.writeResponseEvidence(randomUUID(), response), "OPERATION_NOT_FOUND");
    s.operation.plan.contextKey = "changed-without-confirmation"; s.store.save(s.operation);
    failure(() => s.store.writeResponseEvidence(s.id, response), "INVALID_PLAN");
  });
});

describe("响应证据认证信息与结构边界", () => {
  it("递归删除认证字段，保留文件回执业务字段", () => {
    const s = fixture();
    const raw = { ...response, access_token: "RAW-ACCESS", headers: { Authorization: "RAW-AUTH", "Set-Cookie": "RAW-COOKIE", "X-Access-Token": "RAW-X-ACCESS", "Content-Type": "application/json" }, nested: [{ refreshToken: "RAW-REFRESH", client_secret: "RAW-SECRET", sessionId: "RAW-SESSION", fileName: "synthetic.txt" }] };
    const evidence = s.store.writeResponseEvidence(s.id, raw), stored = readFileSync(s.file, "utf8");
    for (const secret of ["RAW-ACCESS", "RAW-AUTH", "RAW-COOKIE", "RAW-X-ACCESS", "RAW-REFRESH", "RAW-SECRET", "RAW-SESSION"]) expect(stored).not.toContain(secret);
    expect(evidence.raw).toMatchObject({ code: "200", data: response.data, headers: { "Content-Type": "application/json" }, nested: [{ fileName: "synthetic.txt" }] });
    expect(evidence.redactedPaths).toEqual(expect.arrayContaining(["$.access_token", "$.headers.Authorization", "$.nested[0].refreshToken"]));
    expect(s.store.readResponseEvidence(s.id)?.raw).toEqual(evidence.raw);
  });
  it("Bearer文本、URL用户凭据及认证查询参数不会被持久化，脱敏位置明确记录", () => {
    const s = fixture();
    const evidence = s.store.writeResponseEvidence(s.id, { message: "Authorization: Bearer RAW-BEARER", fileUrl: "https://user:RAW-PASSWORD@example.test/file?access_token=RAW-URL-TOKEN&signature=RAW-SIGNATURE&id=72" });
    const stored = readFileSync(s.file, "utf8");
    for (const secret of ["RAW-BEARER", "RAW-PASSWORD", "RAW-URL-TOKEN", "RAW-SIGNATURE"]) expect(stored).not.toContain(secret);
    expect(evidence.raw).toMatchObject({ fileUrl: "https://example.test/file?id=72" });
    expect(evidence.redactedPaths).toEqual(["$.message", "$.fileUrl"]);
    expect(s.store.readResponseEvidence(s.id)).toEqual(evidence);
  });
  it("JSON原型注入键被去除，认证访问器不会被执行", () => {
    const s = fixture(); let accessed = false;
    const raw = JSON.parse('{"code":200,"__proto__":{"danger":"ignored"},"constructor":"ignored"}');
    Object.defineProperty(raw, "access_token", { enumerable: true, get() { accessed = true; throw new Error("must not execute"); } });
    const evidence = s.store.writeResponseEvidence(s.id, raw);
    expect(accessed).toBe(false); expect(evidence.raw).toEqual({ code: 200 });
    expect(readFileSync(s.file, "utf8")).not.toContain("danger");
  });
  it.each([NaN, Infinity, new Date(), new Map(), () => "not-json", BigInt(1)])("非JSON值不能被静默转换为不同回执", (raw) => {
    const s = fixture(); failure(() => s.store.writeResponseEvidence(s.id, raw), "INVALID_RESPONSE_EVIDENCE");
  });
  it("循环、非认证访问器、深度、数组和总字节超限都在落盘前拒绝", () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const getter = Object.defineProperty({}, "result", { enumerable: true, get() { throw new Error("getter must not run"); } });
    const arrayGetter = Object.defineProperty([], "0", { enumerable: true, get() { throw new Error("array getter must not run"); } });
    const proxy = new Proxy({}, { ownKeys() { throw new Error("RAW-AUTH-ERROR must not be exposed"); } });
    for (const value of [cyclic, getter, arrayGetter, proxy]) { const s = fixture(); failure(() => s.store.writeResponseEvidence(s.id, value), "INVALID_RESPONSE_EVIDENCE"); }
    let deep: unknown = {}; for (let n = 0; n < 20; n++) deep = { nested: deep };
    for (const value of [deep, Array(1001).fill(null), "x".repeat(MAX_RESPONSE_EVIDENCE_BYTES)]) { const s = fixture(); failure(() => s.store.writeResponseEvidence(s.id, value), "RESPONSE_EVIDENCE_LIMIT"); expect(readdirSync(s.directory)).toEqual([`${s.id}.json`]); }
  });
});

describe("读取回执必须匹配原确认计划", () => {
  it("绑定的context/action/target变化即使重新算出计划指纹，也不能复用旧响应", () => {
    for (const field of ["contextKey", "action", "targetId"] as const) {
      const s = fixture(); s.store.writeResponseEvidence(s.id, response);
      if (field === "action") s.operation.plan.action = "attachment_link";
      else s.operation.plan[field] = "different";
      s.operation.plan.fingerprint = fingerprint(s.operation.plan); s.store.save(s.operation);
      failure(() => s.store.readResponseEvidence(s.id), "RESPONSE_EVIDENCE_MISMATCH");
    }
  });
  it("跨计划复制的回执及被改写的body不能通过读取校验", () => {
    const first = fixture(), second = fixture(); first.store.writeResponseEvidence(first.id, response);
    writeFileSync(second.file, readFileSync(first.file));
    failure(() => second.store.readResponseEvidence(second.id), "RESPONSE_EVIDENCE_MISMATCH");
    const changed = JSON.parse(readFileSync(first.file, "utf8")); changed.raw.data[0].fileId = "fake-id"; writeFileSync(first.file, JSON.stringify(changed));
    failure(() => first.store.readResponseEvidence(first.id), "INVALID_RESPONSE_EVIDENCE");
  });
  it("不跟随证据文件或目录符号链接，也不覆盖被链接的外部文件", () => {
    const s = fixture(), outside = path.join(s.directory, "outside.json"); writeFileSync(outside, "untouched"); symlinkSync(outside, s.file);
    failure(() => s.store.readResponseEvidence(s.id), "INVALID_RESPONSE_EVIDENCE");
    failure(() => s.store.writeResponseEvidence(s.id, response), "RESPONSE_EVIDENCE_EXISTS");
    expect(readFileSync(outside, "utf8")).toBe("untouched");
    const alias = path.join(s.directory, "alias"); symlinkSync(s.directory, alias);
    failure(() => new OperationStore(alias).readResponseEvidence(s.id), "INVALID_RESPONSE_EVIDENCE");
  });
  it("超大文件、截断JSON及非UTF8不能被解释成有效回执", () => {
    for (const content of ["x".repeat(MAX_RESPONSE_EVIDENCE_BYTES + 1), '{"version":1,', Buffer.from([0xff, 0xfe])]) {
      const s = fixture(); writeFileSync(s.file, content);
      expect(() => s.store.readResponseEvidence(s.id)).toThrow();
    }
  });
});
