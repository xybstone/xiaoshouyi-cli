import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { CONFIG_DIR } from "../config.js";
import { digest } from "./contracts.js";
import { fail, type TicketOperation } from "./types.js";

export const MAX_RESPONSE_EVIDENCE_BYTES = 256 * 1024;
const MAX_RESPONSE_DEPTH = 16;
const MAX_RESPONSE_NODES = 10000;
const sensitiveKey = /^(?:auth|authorization|proxyauthorization|cookie|setcookie|accesstoken|refreshtoken|idtoken|token|bearer|bearertoken|authtoken|session|sessiontoken|sessionid|clientsecret|secret|password|passwd|rawpassword|securitytoken|credential|credentials|apikey|apisecret|accesskey|accesskeyid|csrftoken|xsrftoken|authentication|oauth)$/i;
function authenticationField(key: string): boolean {
  const normalized = key.replace(/[^A-Za-z0-9]/g, "");
  return sensitiveKey.test(normalized) || (normalized.startsWith("x") && sensitiveKey.test(normalized.slice(1))) ||
    /password|passwd|secret|credential|authorization|authentication|setcookie|accesstoken|refreshtoken|sessiontoken|csrftoken|xsrftoken|bearertoken/i.test(normalized);
}
export interface ResponseEvidence {
  version: 1;
  binding: {
    planId: string; operationId: string; fingerprint: string; contextKey: string;
    action: string; targetId: string | null; contractHash: string;
  };
  capturedAt: string;
  raw: unknown;
  redactedPaths: string[];
  sha256: string;
}
function redactResponse(raw: unknown): { raw: unknown; redactedPaths: string[] } {
  let nodes = 0, budget = 0;
  const ancestors = new Set<object>(), redactions = new Set<string>();
  const charge = (text: string) => {
    budget += Buffer.byteLength(text);
    if (budget > MAX_RESPONSE_EVIDENCE_BYTES)
      fail("RESPONSE_EVIDENCE_LIMIT", "响应证据超过大小上限");
  };
  const redactString = (text: string, location: string) => {
    charge(text);
    let safe = text.replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "[REDACTED_AUTH]");
    safe = safe.replace(/https?:\/\/[^\s<>"']+/gi, (match) => {
      try {
        const url = new URL(match); let changed = false;
        if (url.username || url.password) { url.username = ""; url.password = ""; changed = true; }
        for (const key of [...url.searchParams.keys()])
          if (authenticationField(key) || /^(?:sig|signature|x-amz-signature|x-amz-security-token|x-goog-signature)$/i.test(key)) {
            url.searchParams.delete(key); changed = true;
          }
        return changed ? url.href : match;
      } catch { return match; }
    });
    if (safe !== text) redactions.add(location);
    return safe;
  };
  const walk = (value: unknown, depth: number, location: string): unknown => {
    if (++nodes > MAX_RESPONSE_NODES || depth > MAX_RESPONSE_DEPTH)
      fail("RESPONSE_EVIDENCE_LIMIT", "响应证据超过结构或深度上限");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") return redactString(value, location);
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object" || ancestors.has(value))
      fail("INVALID_RESPONSE_EVIDENCE", "响应证据必须为无循环的JSON数据");
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
      fail("INVALID_RESPONSE_EVIDENCE", "响应证据不支持非JSON对象");
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > 1000) fail("RESPONSE_EVIDENCE_LIMIT", "响应证据数组超过上限");
        const output: unknown[] = [];
        for (let index = 0; index < value.length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || descriptor.get || descriptor.set)
            fail("INVALID_RESPONSE_EVIDENCE", "响应证据数组不能包含空位或访问器");
          output.push(walk(descriptor.value, depth + 1, `${location}[${index}]`));
        }
        return output;
      }
      const descriptors = Object.getOwnPropertyDescriptors(value), entries = Object.entries(descriptors);
      if (entries.length > 1000) fail("RESPONSE_EVIDENCE_LIMIT", "响应证据字段超过上限");
      const output: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, descriptor] of entries) {
        if (!descriptor.enumerable) continue;
        if (Buffer.byteLength(key) > 256) fail("RESPONSE_EVIDENCE_LIMIT", "响应证据键名超过上限");
        const next = `${location}.${/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key) ? key : "[field]"}`;
        if (authenticationField(key) || ["__proto__", "constructor", "prototype"].includes(key)) {
          redactions.add(next); continue;
        }
        if (descriptor.get || descriptor.set) fail("INVALID_RESPONSE_EVIDENCE", "响应证据不能包含访问器");
        if (descriptor.value === undefined) continue;
        charge(key); output[key] = walk(descriptor.value, depth + 1, next);
      }
      return output;
    } finally { ancestors.delete(value); }
  };
  try {
    const sanitized = walk(raw, 0, "$");
    return { raw: sanitized, redactedPaths: [...redactions] };
  } catch (error) {
    if (error && typeof error === "object" && "name" in error && error.name === "TicketError") throw error;
    return fail("INVALID_RESPONSE_EVIDENCE", "响应证据不能安全解释为JSON数据");
  }
}

export class OperationStore {
  readonly directory: string;
  constructor(
    directory = process.env.XSY_TICKET_STATE_DIR ||
      path.join(CONFIG_DIR, "tickets", "operations"),
  ) {
    this.directory = path.resolve(directory);
  }
  private location(id: string, suffix = "json"): string {
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        id,
      )
    )
      fail("VALIDATION_FAILED", "无效操作编号");
    return path.join(this.directory, `${id}.${suffix}`);
  }
  private ensure(): void {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
  }
  read(id: string): TicketOperation {
    const file = this.location(id);
    if (!existsSync(file))
      fail("OPERATION_NOT_FOUND", "未找到该工单计划或操作");
    try {
      const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      let raw: string;
      try {
        fchmodSync(fd, 0o600);
        raw = readFileSync(fd, "utf8");
      } finally {
        closeSync(fd);
      }
      const data = JSON.parse(raw) as TicketOperation;
      if (
        data.plan?.planId !== id ||
        data.plan.operationId !== id ||
        ![
          "prepared",
          "dispatching",
          "rejected",
          "outcome_unknown",
          "applied_pending_verification",
          "verified",
          "not_applied",
        ].includes(data.state)
      )
        fail("INVALID_PLAN", "操作记录损坏");
      return data;
    } catch {
      fail("INVALID_PLAN", "无法安全读取操作记录");
    }
  }
  create(operation: TicketOperation): void {
    this.ensure();
    const file = this.location(operation.plan.planId);
    const fd = openSync(file, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(operation));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }
  save(operation: TicketOperation): void {
    this.ensure();
    const file = this.location(operation.plan.planId);
    const tmp = path.join(this.directory, `.${randomUUID()}.tmp`);
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(operation));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, file);
      const dir = openSync(this.directory, "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } finally {
      if (existsSync(tmp)) unlinkSync(tmp);
    }
  }
  private responseBinding(id: string): ResponseEvidence["binding"] {
    this.location(id);
    let directory;
    try { directory = lstatSync(this.directory); }
    catch { fail("OPERATION_NOT_FOUND", "响应证据只能保存在已有操作目录内"); }
    if (!directory.isDirectory() || directory.isSymbolicLink())
      fail("INVALID_RESPONSE_EVIDENCE", "响应证据目录不能是符号链接或特殊文件");
    chmodSync(this.directory, 0o700);
    const plan = this.read(id).plan;
    const { fingerprint, ...unsigned } = plan;
    if (typeof fingerprint !== "string" || fingerprint !== `sha256:${digest(unsigned)}`)
      fail("INVALID_PLAN", "保存或读取响应证据前需核对计划指纹");
    return {
      planId: plan.planId, operationId: plan.operationId, fingerprint,
      contextKey: plan.contextKey, action: plan.action, targetId: plan.targetId ?? null,
      contractHash: plan.contractHash,
    };
  }
  /** Save the first redacted JSON response before decoding any result IDs. */
  writeResponseEvidence(id: string, raw: unknown): ResponseEvidence {
    const binding = this.responseBinding(id), sanitized = redactResponse(raw);
    const unsigned = { version: 1 as const, binding, capturedAt: new Date().toISOString(), ...sanitized };
    const evidence: ResponseEvidence = { ...unsigned, sha256: digest(unsigned) };
    const serialized = JSON.stringify(evidence);
    if (Buffer.byteLength(serialized) > MAX_RESPONSE_EVIDENCE_BYTES)
      fail("RESPONSE_EVIDENCE_LIMIT", "响应证据超过持久化大小上限");
    const file = this.location(id, "response.json");
    const temporary = path.join(this.directory, `.${randomUUID()}.response.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      fchmodSync(fd, 0o600); writeFileSync(fd, serialized); fsyncSync(fd); closeSync(fd); fd = undefined;
      if (!isDeepStrictEqual(binding, this.responseBinding(id)))
        fail("RESPONSE_EVIDENCE_MISMATCH", "保存期间计划身份范围或内容已变化");
      // A hard link publishes a complete file atomically and cannot replace an
      // existing response, unlike rename. Crashes never expose half-written JSON.
      linkSync(temporary, file);
      const directory = openSync(this.directory, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(directory); } finally { closeSync(directory); }
      return evidence;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        fail("RESPONSE_EVIDENCE_EXISTS", "该操作已有响应证据，不能覆盖或追加另一份结果");
      if (error && typeof error === "object" && "name" in error && error.name === "TicketError") throw error;
      return fail("RESPONSE_EVIDENCE_WRITE_FAILED", "无法安全持久化响应证据；不能重放写入");
    } finally {
      if (fd !== undefined) closeSync(fd);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  /** An old operation without a receipt remains genuinely without evidence. */
  readResponseEvidence(id: string): ResponseEvidence | undefined {
    const binding = this.responseBinding(id), file = this.location(id, "response.json");
    let fd: number;
    try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      fail("INVALID_RESPONSE_EVIDENCE", "无法安全打开响应证据");
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > MAX_RESPONSE_EVIDENCE_BYTES)
        fail("RESPONSE_EVIDENCE_LIMIT", "响应证据不是受控大小的普通文件");
      fchmodSync(fd, 0o600);
      const buffer = Buffer.alloc(MAX_RESPONSE_EVIDENCE_BYTES + 1); let length = 0;
      for (;;) {
        const count = readSync(fd, buffer, length, buffer.length - length, length);
        length += count;
        if (length > MAX_RESPONSE_EVIDENCE_BYTES) fail("RESPONSE_EVIDENCE_LIMIT", "响应证据读取超过大小上限");
        if (!count) break;
      }
      if (fstatSync(fd).size !== stat.size || length !== stat.size)
        fail("INVALID_RESPONSE_EVIDENCE", "响应证据读取期间文件发生变化");
      const text = buffer.subarray(0, length).toString("utf8");
      if (!Buffer.from(text).equals(buffer.subarray(0, length)))
        fail("INVALID_RESPONSE_EVIDENCE", "响应证据不是有效UTF-8数据");
      const evidence = JSON.parse(text) as ResponseEvidence;
      if (!evidence || typeof evidence !== "object" || Array.isArray(evidence) ||
          Object.keys(evidence).sort().join(",") !== "binding,capturedAt,raw,redactedPaths,sha256,version" ||
          evidence.version !== 1 || typeof evidence.capturedAt !== "string" ||
          !Number.isFinite(Date.parse(evidence.capturedAt)) ||
          !Array.isArray(evidence.redactedPaths) || evidence.redactedPaths.length > MAX_RESPONSE_NODES ||
          evidence.redactedPaths.some((entry) => typeof entry !== "string" || entry.length > 4096))
        fail("INVALID_RESPONSE_EVIDENCE", "响应证据结构不符");
      if (!isDeepStrictEqual(evidence.binding, binding))
        fail("RESPONSE_EVIDENCE_MISMATCH", "响应证据属于其他计划、账号、动作或目标");
      const { sha256, ...unsigned } = evidence;
      if (typeof sha256 !== "string" || sha256 !== digest(unsigned))
        fail("INVALID_RESPONSE_EVIDENCE", "响应证据校验失败");
      const sanitized = redactResponse(evidence.raw);
      if (sanitized.redactedPaths.length || digest(sanitized.raw) !== digest(evidence.raw))
        fail("INVALID_RESPONSE_EVIDENCE", "响应证据含未脱敏数据或无效JSON结构");
      return evidence;
    } catch (error) {
      if (error && typeof error === "object" && "name" in error && error.name === "TicketError") throw error;
      fail("INVALID_RESPONSE_EVIDENCE", "无法读取或验证响应证据");
    } finally { closeSync(fd); }
  }
  executionActive(id: string): boolean {
    const file = this.location(id, "lock");
    if (!existsSync(file)) return false;
    let pid: number;
    try {
      pid = JSON.parse(readFileSync(file, "utf8")).pid as number;
    } catch {
      fail("OPERATION_BUSY", "执行锁无法解析，请检查操作记录");
    }
    if (!Number.isInteger(pid) || pid <= 0)
      fail("OPERATION_BUSY", "执行锁无效");
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      return true;
    }
  }
  lock(id: string, kind: "execute" | "reconcile" = "execute"): () => void {
    this.ensure();
    if (kind === "reconcile") return this.reconciliationLock(id);
    const file = this.location(
      id,
      kind === "execute" ? "lock" : "reconcile-lock",
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(file, "wx", 0o600);
        try {
          writeFileSync(fd, JSON.stringify({ pid: process.pid }));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        return () => {
          unlinkSync(file);
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let pid: number;
        try {
          pid = JSON.parse(readFileSync(file, "utf8")).pid as number;
        } catch {
          fail("OPERATION_BUSY", "操作锁需人工检查，不能自动重放");
        }
        if (!Number.isInteger(pid) || pid <= 0)
          fail("OPERATION_BUSY", "操作锁无效");
        try {
          process.kill(pid, 0);
          fail("OPERATION_BUSY", "该计划正在执行");
        } catch (check) {
          if ((check as NodeJS.ErrnoException).code !== "ESRCH")
            fail("OPERATION_BUSY", "该计划正在执行或无法确认执行进程");
        }
        fail(
          "OPERATION_RECOVERY_REQUIRED",
          "执行进程已退出；保留锁与操作记录，请先回查结果，不能自动重放",
        );
      }
    }
    fail("OPERATION_BUSY", "未取得执行锁");
  }
  private reconciliationLock(id: string): () => void {
    // Reconciliation and review never send a CRM write. Their lock can recover
    // after process death, while the original execution lock remains untouched.
    // Ticket claims avoid unlinking a stale shared lock: concurrent reclaimers
    // cannot accidentally remove another process's newly acquired lock.
    const legacy = this.location(id, "reconcile-lock");
    if (existsSync(legacy)) {
      let pid: number;
      try { pid = JSON.parse(readFileSync(legacy, "utf8")).pid as number; }
      catch { fail("OPERATION_BUSY", "旧回查锁损坏，需人工检查"); }
      if (!Number.isInteger(pid) || pid <= 0 || this.pidActive(pid))
        fail("OPERATION_BUSY", "该操作正在回查");
    }
    const directory = this.location(id, "reconcile-claims");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    const name = `${process.pid}-${randomUUID()}.json`;
    const own = path.join(directory, name);
    const fd = openSync(own, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, ticket: 0 })); fsyncSync(fd); }
    finally { closeSync(fd); }
    const release = () => { if (existsSync(own)) unlinkSync(own); };
    try {
      const claims = () => readdirSync(directory).flatMap((entry) => {
        const match = /^([1-9]\d*)-[a-f0-9-]+\.json$/.exec(entry);
        if (!match) return [];
        const pid = Number(match[1]);
        if (!this.pidActive(pid)) return [];
        try {
          const claimFd = openSync(path.join(directory, entry), constants.O_RDONLY | constants.O_NOFOLLOW);
          let claim: { pid?: number; ticket?: number };
          try { claim = JSON.parse(readFileSync(claimFd, "utf8")); }
          finally { closeSync(claimFd); }
          if (claim.pid !== pid || !Number.isSafeInteger(claim.ticket) || claim.ticket! < 0)
            fail("OPERATION_BUSY", "回查声明尚未就绪或已损坏");
          return [{ name: entry, ticket: claim.ticket! }];
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
          fail("OPERATION_BUSY", "回查声明尚未就绪或无法读取");
        }
      });
      const maximum = Math.max(0, ...claims().map((claim) => claim.ticket));
      if (maximum >= Number.MAX_SAFE_INTEGER)
        fail("OPERATION_BUSY", "回查声明编号超出范围");
      const ticket = maximum + 1;
      const tmp = path.join(directory, `.${randomUUID()}.tmp`);
      const update = openSync(tmp, "wx", 0o600);
      try { writeFileSync(update, JSON.stringify({ pid: process.pid, ticket })); fsyncSync(update); }
      finally { closeSync(update); }
      try { renameSync(tmp, own); }
      finally { if (existsSync(tmp)) unlinkSync(tmp); }
      if (claims().some((claim) => claim.name !== name &&
          (claim.ticket === 0 || claim.ticket < ticket ||
            (claim.ticket === ticket && claim.name < name))))
        fail("OPERATION_BUSY", "该操作已有其他回查或人工核对");
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }
  private pidActive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    try { process.kill(pid, 0); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  }
}
