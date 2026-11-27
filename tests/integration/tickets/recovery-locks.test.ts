// Real OS processes, synthetic local ledger/backend only. No CRM calls.
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { build } from "tsup";
import { OperationStore } from "../../../src/tickets/operation-store.js";
import { fingerprint } from "../../../src/tickets/actions.js";
import { digest } from "../../../src/tickets/contracts.js";
import type { TicketPlan } from "../../../src/tickets/types.js";
import { syntheticRegistry } from "../../fixtures/tickets/stateful-crm.js";

const ID = "00000000-0000-4000-8000-000000000001";
let temporary: string;
let workerPath: string;
const children: ChildProcess[] = [];
beforeAll(async () => {
  temporary = mkdtempSync(path.join(os.tmpdir(), "xsy-recovery-lock-processes-"));
  const entry = path.join(temporary, "worker.ts");
  writeFileSync(entry, `
    import { OperationStore } from ${JSON.stringify(path.resolve("src/tickets/operation-store.ts"))};
    import { TicketActions, operationReviewFingerprint } from ${JSON.stringify(path.resolve("src/tickets/actions.ts"))};
    import { syntheticRegistry } from ${JSON.stringify(path.resolve("tests/fixtures/tickets/stateful-crm.ts"))};
    const store = new OperationStore(process.argv[2]);
    const id = process.argv[3], mode = process.argv[4];
    const tell = phase => process.send({phase});
    const command = () => new Promise(resolve => process.once("message", resolve));
    async function main() {
      if (mode === "gate") { tell("ready"); await command(); }
      if (mode === "lock" || mode === "gate") {
        const release = store.lock(id,"reconcile"); tell("acquired");
        await command(); release(); return;
      }
      const backend = {
        context: async () => ({key:"synthetic-process-context",identityVerified:true}),
        recover: async () => { tell("recover-entered"); await command(); return {status:"unavailable"}; },
        verify: async () => { tell("verify-entered"); await command(); return {status:"pending",checks:[]}; },
        submit: async () => { throw new Error("CRM writes forbidden in lock tests"); },
      };
      const actions = new TicketActions(backend,syntheticRegistry([],true),store);
      let result;
      if (mode === "reconcile") result = await actions.reconcile(id);
      else {
        const plan = store.read(id).plan;
        const review = {outcome:"applied",reviewedBy:"synthetic reviewer",evidenceReferences:["synthetic immutable audit reference"],resultId:"100"};
        result = await actions.review(id,{
          fingerprint:plan.fingerprint,source:"cli",reference:"synthetic explicit review confirmation",
          purpose:"operation_review",reviewFingerprint:operationReviewFingerprint(plan.fingerprint,review),
        },review);
      }
      tell("completed:" + result.state);
    }
    main().then(() => process.exit(0)).catch(error => { tell(String(error.code || "UNEXPECTED_ERROR")); process.exit(0); });
  `);
  await build({ config: false, entry: [entry], outDir: temporary, format: ["cjs"],
    outExtension: () => ({ js: ".cjs" }), platform: "node", target: "node22",
    bundle: true, noExternal: [/./], silent: true, dts: false, clean: false });
  workerPath = path.join(temporary, "worker.cjs");
  expect(existsSync(workerPath)).toBe(true);
}, 30000);
afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise<void>((resolve) => { child.once("exit", () => resolve()); child.kill("SIGKILL"); });
  }));
});
afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });

function run(directory: string, mode: "lock" | "gate" | "reconcile" | "review" = "lock") {
  const child = spawn(process.execPath, [workerPath, directory, ID, mode], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  children.push(child);
  let stderr = "";
  child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  const messages: string[] = [];
  const pending: Array<{ resolve: (value: string) => void; reject: (error: Error) => void }> = [];
  child.on("message", (message) => {
    const value = String((message as { phase?: string }).phase), waiter = pending.shift();
    if (waiter) waiter.resolve(value); else messages.push(value);
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => {
    for (const waiter of pending.splice(0)) waiter.reject(new Error(`Recovery worker exited without acknowledgement: ${stderr.slice(0, 1000)}`));
    resolve();
  }));
  function next() {
    if (messages.length) return Promise.resolve(messages.shift()!);
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Recovery lock worker timed out")), 15000);
      pending.push({ resolve: (value) => { clearTimeout(timeout); resolve(value); }, reject: (error) => { clearTimeout(timeout); reject(error); } });
    });
  }
  return { child, ready: next(), next, exited, send: (command = "release") => child.send(command) };
}
function claims(directory: string) {
  const folder = path.join(directory, `${ID}.reconcile-claims`);
  return readdirSync(folder).filter((name) => name.endsWith(".json")).map((name) => path.join(folder, name));
}
function seed(directory: string) {
  const store = new OperationStore(directory), registry = syntheticRegistry([], true);
  const unsigned: Omit<TicketPlan, "fingerprint"> = {
    planId: ID, operationId: ID, contextKey: "synthetic-process-context", action: "reply", targetId: "100",
    contractVersion: registry.get("reply").version, contractHash: digest(registry.get("reply")), snapshotHash: "synthetic",
    input: { body: "Synthetic process test" }, payload: { body: "Synthetic process test", operationKey: ID }, requestHeaders: {},
    effects: ["synthetic"], createdAt: "2026-11-24T00:00:00+08:00", expiresAt: "2099-01-01T00:00:00+08:00", concurrency: "best_effort",
  };
  store.create({ plan: { ...unsigned, fingerprint: fingerprint(unsigned) }, state: "outcome_unknown", updatedAt: unsigned.createdAt });
  return store;
}
async function terminate(worker: ReturnType<typeof run>) { worker.child.kill("SIGKILL"); await worker.exited; }

describe("只读恢复锁的真实进程边界", () => {
  it("另一进程正在核对时，其他进程不能并发覆盖操作账本", async () => {
    const directory = path.join(temporary, "mutual-exclusion");
    const owner = run(directory); expect(await owner.ready).toBe("acquired");
    const competitor = run(directory); expect(await competitor.ready).toBe("OPERATION_BUSY"); await competitor.exited;
    owner.send(); await owner.exited;
    const successor = run(directory); expect(await successor.ready).toBe("acquired"); successor.send(); await successor.exited;
  }, 30000);

  it("回查进程被强制结束后，忽略死PID声明但保留文件，新持有者仍互斥", async () => {
    const directory = path.join(temporary, "interrupted-recovery");
    const crashed = run(directory); expect(await crashed.ready).toBe("acquired"); const oldClaims = claims(directory);
    await terminate(crashed);
    const recovered = run(directory); expect(await recovered.ready).toBe("acquired"); expect(oldClaims.every(existsSync)).toBe(true);
    const competitor = run(directory); expect(await competitor.ready).toBe("OPERATION_BUSY"); await competitor.exited;
    recovered.send(); await recovered.exited; expect(oldClaims.every(existsSync)).toBe(true);
  }, 30000);

  it("同步启动竞争者最多一个持有者，失败竞争者不能删除赢家声明", async () => {
    const directory = path.join(temporary, "synchronized-race"), workers = Array.from({ length: 6 }, () => run(directory, "gate"));
    expect(await Promise.all(workers.map((w) => w.ready))).toEqual(Array(6).fill("ready"));
    const acknowledgements = workers.map((w) => w.next()); for (const worker of workers) worker.send("go");
    const outcomes = await Promise.all(acknowledgements);
    expect(outcomes.every((outcome) => ["acquired", "OPERATION_BUSY"].includes(outcome))).toBe(true);
    const winners = workers.filter((_, index) => outcomes[index] === "acquired"); expect(winners.length).toBeLessThanOrEqual(1);
    if (winners.length) {
      const winner = winners[0], ownClaim = claims(directory).find((p) => path.basename(p).startsWith(`${winner.child.pid}-`))!;
      expect(existsSync(ownClaim)).toBe(true);
      const competitor = run(directory); expect(await competitor.ready).toBe("OPERATION_BUSY"); await competitor.exited;
      expect(existsSync(ownClaim)).toBe(true); winner.send(); await winner.exited;
    }
    await Promise.all(workers.filter((w) => !winners.includes(w)).map((w) => w.exited));
    const successor = run(directory); expect(await successor.ready).toBe("acquired"); successor.send(); await successor.exited;
  }, 30000);

  it("活PID半写声明保守拒绝且不删除；死PID半写声明不阻塞恢复", async () => {
    const directory = path.join(temporary, "incomplete-claims"), first = run(directory);
    expect(await first.ready).toBe("acquired"); const deadPid = first.child.pid!; await terminate(first);
    const folder = path.dirname(claims(directory)[0]);
    const activePartial = path.join(folder, `${process.pid}-00000000-0000-4000-8000-000000000099.json`);
    writeFileSync(activePartial, "", { mode: 0o600 });
    const blocked = run(directory); expect(await blocked.ready).toBe("OPERATION_BUSY"); await blocked.exited;
    expect(readFileSync(activePartial, "utf8")).toBe(""); unlinkSync(activePartial);
    const deadPartial = path.join(folder, `${deadPid}-00000000-0000-4000-8000-000000000098.json`);
    writeFileSync(deadPartial, "", { mode: 0o600 });
    const recovered = run(directory); expect(await recovered.ready).toBe("acquired"); recovered.send(); await recovered.exited;
    expect(existsSync(deadPartial)).toBe(true);
  }, 30000);

  it("旧执行锁和旧版死PID回查锁在只读恢复后原样保留", async () => {
    const directory = path.join(temporary, "preserve-execution-lock"), store = seed(directory), exited = run(directory);
    expect(await exited.ready).toBe("acquired"); await terminate(exited);
    const execution = path.join(directory, `${ID}.lock`), legacy = path.join(directory, `${ID}.reconcile-lock`), content = JSON.stringify({ pid: exited.child.pid });
    writeFileSync(execution, content); writeFileSync(legacy, content);
    const recovered = run(directory); expect(await recovered.ready).toBe("acquired"); recovered.send(); await recovered.exited;
    expect(readFileSync(execution, "utf8")).toBe(content); expect(readFileSync(legacy, "utf8")).toBe(content);
    expect(() => store.lock(ID, "execute")).toThrow(/保留锁/); expect(readFileSync(execution, "utf8")).toBe(content);
  }, 30000);

  it("旧release只能删除自己的声明，不能误删后继持有者的新声明", async () => {
    const directory = path.join(temporary, "release-ownership"), old = run(directory); expect(await old.ready).toBe("acquired");
    // External cleanup of a live claim is unsafe; simulate it only to check
    // that an old release callback cannot unlink a successor's different claim.
    unlinkSync(claims(directory).find((p) => path.basename(p).startsWith(`${old.child.pid}-`))!);
    const successor = run(directory); expect(await successor.ready).toBe("acquired");
    const newClaim = claims(directory).find((p) => path.basename(p).startsWith(`${successor.child.pid}-`))!;
    old.send(); await old.exited; expect(existsSync(newClaim)).toBe(true);
    const competitor = run(directory); expect(await competitor.ready).toBe("OPERATION_BUSY"); await competitor.exited;
    successor.send(); await successor.exited;
  }, 30000);

  it("两个真实回查进程不能同时恢复或丢失审计记录", async () => {
    const directory = path.join(temporary, "reconcile-vs-reconcile"), store = seed(directory), owner = run(directory, "reconcile");
    expect(await owner.ready).toBe("recover-entered");
    const competitor = run(directory, "reconcile"); expect(await competitor.ready).toBe("OPERATION_BUSY"); await competitor.exited;
    expect(store.read(ID).recoveryHistory).toBeUndefined();
    const completed = owner.next(); owner.send(); expect(await completed).toBe("completed:outcome_unknown"); await owner.exited;
    expect(store.read(ID).recoveryHistory).toHaveLength(1);
  }, 30000);

  it.each(["reconcile", "review"] as const)("%s持有锁时，另一种账本写入不能并发覆盖结果", async (mode) => {
    const directory = path.join(temporary, `${mode}-vs-other`), store = seed(directory), owner = run(directory, mode);
    expect(await owner.ready).toBe(mode === "reconcile" ? "recover-entered" : "verify-entered");
    const competitor = run(directory, mode === "reconcile" ? "review" : "reconcile"); expect(await competitor.ready).toBe("OPERATION_BUSY"); await competitor.exited;
    const completed = owner.next(); owner.send(); expect(await completed).toBe(mode === "reconcile" ? "completed:outcome_unknown" : "completed:applied_pending_verification"); await owner.exited;
    const result = store.read(ID); expect(result.recoveryHistory).toHaveLength(1);
    expect(result.recoveryHistory![0].source).toBe(mode === "reconcile" ? "contract" : "manual");
  }, 30000);
});
