// Repeatable real-CRM acceptance orchestration. No credentials are imported or
// copied here; all CRM work uses the existing CLI and its operation ledger.
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync,
  constants, fstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const TEST_MARKER = "[CLI-LIFECYCLE-TEST]";
const ACTIONS = new Set(["create", "submit", "workflow_preprocess", "advance", "activity_record", "assign", "reassign", "accept", "reply", "pause", "resume", "escalate", "resolve", "complete", "close", "reopen", "return", "void", "attachment_upload", "attachment_link", "worklog", "report"]);
const MODES = new Set(["dry-run", "prepare", "execute", "reconcile"]);
const READ_FIELDS = ["id", "name", "status", "customItem62__c", "responsibleTE__c", "fieldJobPoolGroup", "ownerId", "priority", "entityType"];
const TERMINAL = new Set(["live_passed", "synthetic_passed"]);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export const LIVE_COVERAGE = [
  { case: "metadata/search/pagination/detail", safeLive: "bounded-read", proof: "explicit fields and limits, server counts, stable ordering; no full traversal" },
  { case: "current-user permissions", safeLive: "read-only-probe", proof: "a denied current-user probe proves only that role/target; other roles need their own authorized sessions" },
  { case: "missing required fields", safeLive: "prepare-only", proof: "local metadata/form validation; conditional server rules require an explicitly approved test payload" },
  { case: "illegal state transition", safeLive: "prepare-only", proof: "current allowed-actions probe; never force PATCH to discover workflow rules" },
  { case: "repeat same approved operation", safeLive: "dedicated-new-target-only", proof: "ledger result and audit readback; do not create another plan to simulate a retry" },
  { case: "concurrent execution", safeLive: "offline-deterministic", proof: "process-lock tests establish local protection; server/web-client races cannot be safely manufactured" },
  { case: "timeout/unknown result/process crash", safeLive: "offline-fault-injection", proof: "do not intentionally interrupt a real write; reconcile naturally occurring uncertainty without replay" },
  { case: "attachment missing/file changed", safeLive: "prepare-only", proof: "local file/hash checks; no real upload is required" },
  { case: "attachment upload/link partial failure", safeLive: "offline-fault-injection", proof: "real uploads/links only on the approved new target; do not force network/object-store failure" },
  { case: "SLA/report/history/notification/external sync", safeLive: "read-only-evidence", proof: "each configured side effect needs observable server evidence; missing evidence remains unverified" },
  { case: "business types and roles", safeLive: "separate-authorized-cases", proof: "one type/role cannot establish coverage for another" },
];

class AcceptanceError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function fail(code) { throw new AcceptanceError(code); }
function record(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
const digest = (value) => createHash("sha256").update(stable(value)).digest("hex");
function id(value) {
  if (typeof value === "number" && !Number.isSafeInteger(value)) fail("UNSAFE_RECORD_ID");
  if (!/^[1-9]\d*$/.test(String(value))) fail("INVALID_RECORD_ID");
  return String(value);
}
function code(value, fallback) { return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value) ? value : fallback; }
function privateDirectory(directory) {
  const absolute = path.resolve(directory);
  if (absolute === path.parse(absolute).root) fail("INVALID_OUTPUT_DIRECTORY");
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  if (lstatSync(absolute).isSymbolicLink() || !lstatSync(absolute).isDirectory()) fail("UNSAFE_OUTPUT_DIRECTORY");
  chmodSync(absolute, 0o700);
  return absolute;
}
function readJson(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) fail("UNSAFE_INPUT_FILE");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { if (fd !== undefined) closeSync(fd); }
}
function saveJson(file, value) {
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) fail("UNSAFE_OUTPUT_FILE");
  const temporary = path.join(path.dirname(file), `.${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(value, null, 2) + "\n"); fsyncSync(fd); }
  finally { closeSync(fd); }
  try {
    renameSync(temporary, file);
    const directory = openSync(path.dirname(file), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function assertJson(value) {
  if (Array.isArray(value)) { value.forEach(assertJson); return; }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (["__proto__", "prototype", "constructor"].includes(key) || /^(access_?token|refresh_?token|password|cookie|authorization|client_?secret)$/i.test(key)) fail("UNSAFE_MANIFEST_FIELD");
      assertJson(child);
    }
  } else if (typeof value === "number" && !Number.isFinite(value)) fail("INVALID_MANIFEST");
  else if (!["string", "number", "boolean"].includes(typeof value) && value !== null) fail("INVALID_MANIFEST");
}
export function validateManifest(raw) {
  const manifest = record(raw);
  assertJson(manifest);
  if (Object.keys(manifest).some((key) => !["version", "suite", "steps"].includes(key)) || manifest.version !== 1 || typeof manifest.suite !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,79}$/.test(manifest.suite) || !Array.isArray(manifest.steps) || !manifest.steps.length || manifest.steps.length > 40) fail("INVALID_MANIFEST");
  const keys = new Set();
  for (const [index, rawStep] of manifest.steps.entries()) {
    const step = record(rawStep);
    if (Object.keys(step).some((key) => !["key", "action", "input", "expected"].includes(key)) || typeof step.key !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/.test(step.key) || keys.has(step.key) || !ACTIONS.has(step.action) || !step.input || Array.isArray(step.input) || typeof step.input !== "object") fail("INVALID_MANIFEST_STEP");
    if ((index === 0) !== (step.action === "create")) fail("FRESH_CREATE_REQUIRED");
    if (step.action === "create" && (typeof step.input.name !== "string" || !step.input.name.startsWith(TEST_MARKER + " ") || step.input.name.length <= TEST_MARKER.length + 1 || "id" in step.input)) fail("TEST_TARGET_MARKER_REQUIRED");
    if (step.expected && (Array.isArray(step.expected) || typeof step.expected !== "object" || Object.keys(step.expected).some((field) => !READ_FIELDS.includes(field)))) fail("INVALID_EXPECTED_FIELDS");
    const checkBindings = (value, allowCurrentTicket = false) => {
      if (Array.isArray(value)) { value.forEach((item) => checkBindings(item, allowCurrentTicket)); return; }
      if (!value || typeof value !== "object") return;
      if ("$from" in value) {
        if (Object.keys(value).length !== 1 || typeof value.$from !== "string") fail("INVALID_BINDING");
        if (value.$from !== "ticket.id") {
          const match = /^steps\.([a-z][a-z0-9_-]{0,39})\.(resultId|operationId)$/.exec(value.$from);
          if (!match || !keys.has(match[1])) fail("INVALID_BINDING");
        } else if (index === 0 && !allowCurrentTicket) fail("INVALID_BINDING");
      } else Object.values(value).forEach((item) => checkBindings(item, allowCurrentTicket));
    };
    checkBindings(step.input); keys.add(step.key); checkBindings(step.expected, true);
  }
  return manifest;
}
function resolveBindings(value, checkpoint) {
  if (Array.isArray(value)) return value.map((entry) => resolveBindings(entry, checkpoint));
  if (value && typeof value === "object") {
    if (Object.keys(value).length === 1 && typeof value.$from === "string") {
      if (value.$from === "ticket.id") return id(checkpoint.ticketId);
      const match = /^steps\.([a-z][a-z0-9_-]{0,39})\.(resultId|operationId)$/.exec(value.$from);
      const step = checkpoint.steps.find((entry) => entry.key === match?.[1]);
      if (!step || (!TERMINAL.has(step.outcome) && step.serverVerified !== true)) fail("UNRESOLVED_BINDING");
      if (match?.[2] === "operationId") {
        if (!TERMINAL.has(step.outcome) || !UUID.test(step.planId)) fail("UNRESOLVED_BINDING");
        return step.planId;
      }
      return id(step.resultId);
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveBindings(item, checkpoint)]));
  }
  return value;
}
function unwrap(result) {
  let stdout, stderr;
  try { stdout = result.stdout ? JSON.parse(result.stdout) : undefined; } catch {}
  try { stderr = result.stderr ? JSON.parse(result.stderr) : undefined; } catch {}
  if (stdout?.code === 200) return { ok: true, value: stdout.result };
  if (stderr?.operation) return { ok: false, value: stderr.operation, code: code(stderr.code, "CLI_FAILED") };
  const error = record(stderr ?? stdout);
  return { ok: false, value: error, code: code(error.code, result.processError ? "CLI_PROCESS_UNCERTAIN" : "CLI_FAILED") };
}
export function classifyResult(raw, evidenceKind = "live") {
  const parsed = unwrap(raw), value = record(parsed.value);
  if (value.state === "verified" && parsed.ok && raw.status === 0) return { outcome: evidenceKind === "live" ? "live_passed" : "synthetic_passed", operation: value };
  if (["rejected", "not_applied"].includes(value.state)) return { outcome: "rejected", code: parsed.code ?? code(value.errorCode, "REMOTE_REJECTED"), operation: value };
  if (value.state === "applied_pending_verification") return { outcome: "pending_verification", code: "VERIFICATION_PENDING", operation: value };
  if (["outcome_unknown", "dispatching"].includes(value.state) || raw.processError) return { outcome: "outcome_unknown", code: parsed.code ?? "OUTCOME_UNKNOWN", operation: value };
  if (parsed.code === "UNSUPPORTED") return { outcome: "unsupported", code: parsed.code };
  if (parsed.code === "UNVERIFIED") return { outcome: "unverified", code: parsed.code };
  const blocked = value.status === "blocked" || ["FORBIDDEN", "ACTION_NOT_ALLOWED", "VALIDATION_FAILED", "IDENTITY_UNVERIFIED", "WRITES_DISABLED", "PLAN_STALE", "PLAN_EXPIRED", "CONFIRMATION_REQUIRED", "CONFIRMATION_MISMATCH"].includes(parsed.code);
  return { outcome: blocked ? "blocked" : "failed", code: parsed.code ?? "INVALID_CLI_RESPONSE" };
}
function closed(record) {
  const status = String(record.status ?? ""), stage = String(record.customItem62__c ?? "");
  return status === "11" || /^Closed(?:\s|$)/i.test(status) || stage === "4" || /^(?:Closed|工单关闭)$/i.test(stage);
}
function clearPreparedDiagnostics(step) {
  // These describe an older attempt, not a new immutable plan. In particular,
  // a cached ready result from an older runner may still carry a denial code.
  for (const key of ["code", "processError", "error", "errorCode", "errorMessage", "remoteError", "verification", "serverVerified", "resultId"])
    delete step[key];
}
function defaultInvoke(args) {
  const result = spawnSync(process.execPath, [path.join(ROOT, "dist/cli.js"), "--format", "json", ...args], {
    cwd: ROOT, env: process.env, encoding: "utf8", timeout: 60000, maxBuffer: 4 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", processError: !!result.error || !!result.signal };
}

export async function runAcceptance(options, dependencies = {}) {
  const mode = options.mode ?? "dry-run";
  if (!MODES.has(mode) || !options.output) fail("INVALID_OPTIONS");
  if (options.adoptCreateOperation && !UUID.test(options.adoptCreateOperation)) fail("INVALID_ADOPTION_OPERATION");
  const manifest = validateManifest(options.manifest), hash = digest(manifest), directory = privateDirectory(options.output);
  const evidenceKind = dependencies.invoke ? "synthetic" : "live";
  const invoke = dependencies.invoke ?? defaultInvoke;
  const checkpointFile = path.join(directory, "checkpoint.json"), summaryFile = path.join(directory, "summary.json");
  const lockFile = path.join(directory, "runner.lock");
  let lock;
  try { lock = openSync(lockFile, "wx", 0o600); }
  catch { fail("RUNNER_LOCKED_REVIEW_BEFORE_RECOVERY"); }
  const nonce = randomUUID();
  try { writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce })); fsyncSync(lock); }
  finally { closeSync(lock); }
  let checkpoint;
  try {
    checkpoint = existsSync(checkpointFile) ? readJson(checkpointFile) : {
      version: 1, runId: randomUUID(), manifestHash: hash, ticketName: manifest.steps[0].input.name,
      evidenceKind, ticketId: null, creationOperationId: null,
      steps: manifest.steps.map((step) => ({ key: step.key, action: step.action, outcome: "not_run" })),
    };
    if (checkpoint.manifestHash !== hash || checkpoint.ticketName !== manifest.steps[0].input.name || checkpoint.evidenceKind !== evidenceKind || checkpoint.steps.length !== manifest.steps.length || checkpoint.steps.some((step, index) => step.key !== manifest.steps[index].key || step.action !== manifest.steps[index].action)) fail("CHECKPOINT_SCOPE_MISMATCH");
    let usedConfirmation = false, calls = 0, rawBytes = 0;
    const persist = () => saveJson(checkpointFile, checkpoint);
    const command = async (args, purpose) => {
      let result;
      try { result = await invoke(args); }
      catch { result = { status: null, stdout: "", stderr: "", processError: true }; }
      result = { ...result, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? "") };
      const base = `${String(++calls).padStart(3, "0")}-${purpose}-${randomUUID()}`;
      for (const [stream, content] of [["stdout", result.stdout], ["stderr", result.stderr]]) {
        const file = path.join(directory, `${base}.${stream}.json`), fd = openSync(file, "wx", 0o600);
        try { writeFileSync(fd, content); } finally { closeSync(fd); }
        rawBytes += Buffer.byteLength(content);
      }
      return { ...result, artifact: `${base}.stdout.json` };
    };
    const applyResult = (step, result) => {
      const classified = classifyResult(result, evidenceKind);
      const operation = classified.operation ?? {};
      if (operation.state && (operation.operationId !== step.planId || operation.planId !== step.planId || operation.fingerprint !== step.fingerprint || operation.action !== step.action)) fail("OPERATION_SCOPE_MISMATCH");
      const resultId = operation.resultId !== undefined ? id(operation.resultId) : step.resultId;
      const createdId = TERMINAL.has(classified.outcome) && step.action === "create" ? id(resultId) : undefined;
      const hasAcceptanceCheck = !!manifest.steps.find((entry) => entry.key === step.key)?.expected;
      step.serverVerified = TERMINAL.has(classified.outcome);
      step.outcome = step.serverVerified && hasAcceptanceCheck ? "pending_verification" : classified.outcome;
      step.code = step.serverVerified && hasAcceptanceCheck ? "ACCEPTANCE_READBACK_PENDING" : classified.code;
      if (operation.verification) {
        const checks = Array.isArray(operation.verification.checks) ? operation.verification.checks : [];
        step.verification = { status: code(operation.verification.status, "unavailable"),
          checkCount: checks.length, matchedCount: checks.filter((check) => check.matched === true).length };
      }
      if (resultId !== undefined) step.resultId = resultId;
      if (createdId) { checkpoint.ticketId = createdId; checkpoint.creationOperationId = step.planId; }
      persist();
    };
    const checkAcceptance = async (step, definition) => {
      if (!step.serverVerified || !definition.expected || !checkpoint.ticketId) return;
      const checked = await command(["--fields", READ_FIELDS.join(","), "ticket", "get", id(checkpoint.ticketId)], `${definition.key}-readback`);
      const parsed = unwrap(checked), row = record(parsed.value);
      let matches = false;
      try {
        matches = parsed.ok && checked.status === 0 && id(row.id) === checkpoint.ticketId && row.name === checkpoint.ticketName &&
          Object.entries(definition.expected).every(([key, value]) => stable(row[key]) === stable(resolveBindings(value, checkpoint)));
      } catch {}
      step.outcome = matches ? evidenceKind === "live" ? "live_passed" : "synthetic_passed" : "pending_verification";
      step.code = matches ? undefined : "ACCEPTANCE_READBACK_PENDING";
      persist();
    };
    const readTarget = async (action) => {
      if (!checkpoint.ticketId || !checkpoint.creationOperationId || checkpoint.steps[0].resultId !== checkpoint.ticketId || !TERMINAL.has(checkpoint.steps[0].outcome)) fail("FRESH_CREATE_REQUIRED");
      const result = await command(["--fields", READ_FIELDS.join(","), "ticket", "get", id(checkpoint.ticketId)], "target-guard");
      const parsed = unwrap(result), row = record(parsed.value);
      if (!parsed.ok || result.status !== 0 || id(row.id) !== checkpoint.ticketId || row.name !== checkpoint.ticketName || !row.name.startsWith(TEST_MARKER + " ")) fail("TEST_TARGET_SCOPE_MISMATCH");
      if (!["string", "number"].includes(typeof row.status) || (row.customItem62__c != null && !["string", "number"].includes(typeof row.customItem62__c))) fail("UNVERIFIED_TARGET_STATE");
      const closedByThisRun = checkpoint.steps.some((step) => step.action === "close" && TERMINAL.has(step.outcome));
      if (closed(row) && !(action === "reopen" && closedByThisRun)) fail("CLOSED_TEST_TARGET_PROTECTED");
      return row;
    };
    const verifyCreationSummary = (raw, operationId, expectedFingerprint, expectedId) => {
      const parsed = unwrap(raw), operation = record(parsed.value);
      if (!parsed.ok || raw.status !== 0 || operation.state !== "verified" || operation.action !== "create" ||
        operation.operationId !== operationId || operation.planId !== operationId ||
        (expectedFingerprint && operation.fingerprint !== expectedFingerprint) ||
        (expectedId && String(operation.resultId) !== expectedId)) fail("ADOPTION_CREATE_UNVERIFIED");
      return operation;
    };
    if (options.adoptCreateOperation && mode !== "dry-run") {
      const operationId = options.adoptCreateOperation;
      if (checkpoint.creationOperationId && checkpoint.creationOperationId !== operationId) fail("ADOPTION_SCOPE_MISMATCH");
      if (!checkpoint.creationOperationId) {
        if (checkpoint.steps.some((step) => step.planId || step.outcome !== "not_run")) fail("ADOPTION_SCOPE_MISMATCH");
        // CLI operation reads validate the current authentication/context using
        // the existing domain service, rather than trusting a copied ledger.
        const operation = verifyCreationSummary(await command(["ticket", "operation", operationId], "adopt-create"), operationId);
        const stateDirectory = process.env.XSY_TICKET_STATE_DIR || path.join(os.homedir(), ".config", "xiaoshouyi-cli", "tickets", "operations");
        if (!existsSync(stateDirectory) || !lstatSync(stateDirectory).isDirectory() || lstatSync(stateDirectory).isSymbolicLink() || (lstatSync(stateDirectory).mode & 0o077)) fail("UNSAFE_ADOPTION_LEDGER");
        const file = path.join(stateDirectory, `${operationId}.json`);
        if (!existsSync(file) || (lstatSync(file).mode & 0o077)) fail("UNSAFE_ADOPTION_LEDGER");
        const ledger = readJson(file), plan = record(ledger.plan), { fingerprint, ...unsigned } = plan;
        if (ledger.state !== "verified" || plan.action !== "create" || plan.planId !== operationId || plan.operationId !== operationId ||
          !plan.contextKey || fingerprint !== operation.fingerprint || fingerprint !== `sha256:${digest(unsigned)}` ||
          stable(plan.input) !== stable(manifest.steps[0].input) || record(record(plan.payload).data).name !== checkpoint.ticketName ||
          String(record(ledger.submission).id) !== String(operation.resultId)) fail("ADOPTION_SCOPE_MISMATCH");
        const first = checkpoint.steps[0];
        Object.assign(first, { planId: operationId, fingerprint, expiresAt: plan.expiresAt,
          resultId: id(operation.resultId), outcome: evidenceKind === "live" ? "live_passed" : "synthetic_passed", serverVerified: true });
        checkpoint.ticketId = first.resultId; checkpoint.creationOperationId = operationId;
        try { await readTarget("adopt"); }
        catch (error) { checkpoint.ticketId = null; checkpoint.creationOperationId = null;
          first.outcome = "blocked"; first.code = "ADOPTION_TARGET_PROTECTED"; throw error; }
        checkpoint.adoptedCreate = { operationId, fingerprint, contextVerifiedBy: "CLI ticket operation" };
        persist();
        if (manifest.steps[0].expected) { first.outcome = "pending_verification"; persist(); await checkAcceptance(first, manifest.steps[0]); }
      }
    }
    if (mode !== "dry-run" && checkpoint.creationOperationId && checkpoint.ticketId) {
      verifyCreationSummary(await command(["ticket", "operation", checkpoint.creationOperationId], "creation-provenance"),
        checkpoint.creationOperationId, checkpoint.steps[0].fingerprint, checkpoint.ticketId);
    }
    if (mode === "dry-run") {
      persist();
    } else if (mode === "reconcile") {
      for (const [index, step] of checkpoint.steps.entries()) {
        if (!step.planId || TERMINAL.has(step.outcome) || ["awaiting_approval", "prepared", "unverified", "blocked", "rejected"].includes(step.outcome)) continue;
        applyResult(step, await command(["ticket", "operation", step.planId, "--reconcile"], "reconcile"));
        await checkAcceptance(step, manifest.steps[index]);
        if (!TERMINAL.has(step.outcome)) break;
      }
    } else {
      if (mode === "execute" && process.env.XSY_TICKET_WRITES !== "1") fail("WRITES_DISABLED");
      for (const [index, definition] of manifest.steps.entries()) {
        const step = checkpoint.steps[index];
        if (TERMINAL.has(step.outcome)) continue;
        if (["executing", "outcome_unknown", "pending_verification"].includes(step.outcome)) {
          if (!step.planId) fail("MISSING_OPERATION_ID");
          applyResult(step, await command(["ticket", "operation", step.planId, "--reconcile"], "resume-reconcile"));
          await checkAcceptance(step, definition);
          if (!TERMINAL.has(step.outcome)) break;
          if (options.confirm === step.fingerprint) usedConfirmation = true;
          continue;
        }
        if (["rejected", "failed"].includes(step.outcome)) break;
        if (index > 0) await readTarget(definition.action);
        const stalePlan = ["PLAN_STALE", "PLAN_EXPIRED"].includes(step.code);
        const preparedReusable = step.planId && !stalePlan && ["prepared", "awaiting_approval"].includes(step.outcome) && (mode !== "prepare" || Date.parse(step.expiresAt) > Date.now());
        if (!preparedReusable) {
          const args = ["ticket", "prepare", definition.action];
          if (index > 0) args.push("--id", id(checkpoint.ticketId));
          args.push("--data", JSON.stringify(resolveBindings(definition.input, checkpoint)), "--ttl", "300");
          const result = await command(args, `${definition.key}-prepare`), parsed = unwrap(result), prepared = record(parsed.value), plan = record(prepared.plan);
          if (!parsed.ok || result.status !== 0 || prepared.status !== "ready") {
            const classified = classifyResult(result, evidenceKind);
            step.outcome = result.processError ? "blocked" : classified.outcome;
            step.code = result.processError ? "PREPARE_READ_UNCERTAIN" : classified.code;
            persist(); break;
          }
          if (plan.action !== definition.action || (index > 0 ? String(plan.targetId) !== checkpoint.ticketId : plan.targetId !== undefined) || typeof plan.planId !== "string" || !UUID.test(plan.planId) || !/^sha256:[a-f0-9]{64}$/.test(plan.fingerprint)) fail("PREPARED_PLAN_SCOPE_MISMATCH");
          if (index === 0 && (record(plan.input).name !== checkpoint.ticketName || record(record(plan.payload).data).name !== checkpoint.ticketName)) fail("TEST_TARGET_MARKER_REQUIRED");
          if (step.planId === plan.planId) fail("PREPARE_DID_NOT_REFRESH_PLAN");
          if (step.planId) step.previousPlans = [...(step.previousPlans ?? []), {
            planId: step.planId, fingerprint: step.fingerprint, expiresAt: step.expiresAt,
            outcome: step.outcome, code: step.code, planArtifact: step.planArtifact,
          }];
          clearPreparedDiagnostics(step);
          Object.assign(step, { planId: plan.planId, fingerprint: plan.fingerprint, expiresAt: plan.expiresAt, planArtifact: result.artifact, outcome: "awaiting_approval" }); persist();
        } else { clearPreparedDiagnostics(step); persist(); }
        if (mode === "prepare" || !options.confirm || usedConfirmation) break;
        if (options.confirm !== step.fingerprint || typeof options.confirmationReference !== "string" || !options.confirmationReference.trim()) fail("CONFIRMATION_MISMATCH");
        if (index > 0) await readTarget(definition.action);
        step.outcome = "executing"; persist(); usedConfirmation = true;
        const result = await command(["ticket", "execute", step.planId, "--confirm", options.confirm, "--confirmation-reference", options.confirmationReference], `${definition.key}-execute`);
        applyResult(step, result);
        await checkAcceptance(step, definition);
        if (!TERMINAL.has(step.outcome)) break;
      }
    }
    const complete = checkpoint.steps.every((step) => TERMINAL.has(step.outcome));
    const pending = checkpoint.steps.find((step) => !TERMINAL.has(step.outcome));
    const summary = { version: 1, mode, evidenceKind: mode === "dry-run" ? "none" : evidenceKind,
      suite: manifest.suite, runId: checkpoint.runId, verifiedAt: new Date().toISOString(),
      complete, liveAcceptancePassed: complete && evidenceKind === "live" && mode !== "dry-run",
      acceptanceScope: { object: "fieldJob", actions: manifest.steps.map((step) => step.action),
        coverage: "Only this manifest, derived test target and current identity; unconfigured side effects and other business types remain unverified." },
      ticketId: checkpoint.ticketId, creationOperationId: checkpoint.creationOperationId,
      cliCalls: calls, rawOutputBytes: rawBytes, traversal: false,
      steps: checkpoint.steps, pendingStep: pending?.key,
      coverage: LIVE_COVERAGE, retention: "Private test evidence; eligible for cleanup after acceptance.",
      note: "A local/synthetic test is never reported as live acceptance. A passing subset is not full lifecycle acceptance. Unknown writes are only reconciled, never replayed."
    };
    saveJson(summaryFile, summary);
    return { ...summary, summaryPath: summaryFile };
  } catch (error) {
    saveJson(summaryFile, { version: 1, mode, evidenceKind: mode === "dry-run" ? "none" : evidenceKind,
      complete: false, liveAcceptancePassed: false, verifiedAt: new Date().toISOString(),
      runnerError: { code: error instanceof AcceptanceError ? error.code : "ACCEPTANCE_FAILED" },
      steps: checkpoint?.steps ?? [], coverage: LIVE_COVERAGE,
      note: "The runner stopped. Inspect private evidence; no write is automatically replayed." });
    throw error;
  } finally {
    // Never unlink another run's replacement lock.
    try { if (readJson(lockFile).nonce === nonce) unlinkSync(lockFile); } catch {}
  }
}

export function parseArgs(args) {
  const options = { mode: "dry-run" }; let selectedMode = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (["--help", "--coverage"].includes(arg)) { options[arg.slice(2)] = true; continue; }
    if (["--dry-run", "--prepare", "--execute", "--reconcile", "--read-only"].includes(arg)) {
      if (selectedMode) fail("CONFLICTING_MODES"); selectedMode = true;
      options.mode = arg === "--read-only" ? "reconcile" : arg.slice(2); continue;
    }
    const fields = { "--manifest": "manifestFile", "--output": "output", "--confirm": "confirm", "--confirmation-reference": "confirmationReference", "--adopt-create-operation": "adoptCreateOperation" };
    if (!Object.hasOwn(fields, arg) || !args[index + 1] || args[index + 1].startsWith("--")) fail("INVALID_OPTIONS");
    if (options[fields[arg]] !== undefined) fail("DUPLICATE_OPTION"); options[fields[arg]] = args[++index];
  }
  return options;
}
async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log("Usage: node scripts/ticket-live-acceptance.mjs --manifest <private.json> --output <private-directory> [--dry-run|--prepare|--reconcile|--execute --confirm <CLI-plan-fingerprint> --confirmation-reference <existing-authorization>] [--adopt-create-operation <verified-create-UUID>]\nDefault: dry-run, zero CLI/CRM calls. A suite starts with create and derives every target ID from that operation. Adoption only accepts a current-context verified create ledger whose complete input and test title match; arbitrary existing record IDs and closed targets are rejected. --execute also requires XSY_TICKET_WRITES=1. A stale runner.lock must be reviewed before manual cleanup; it is never automatically reclaimed. --coverage prints the live/offline evidence matrix.");
    return;
  }
  if (options.coverage) { console.log(JSON.stringify(LIVE_COVERAGE, null, 2)); return; }
  if (!options.manifestFile) fail("MANIFEST_REQUIRED");
  options.manifest = readJson(path.resolve(options.manifestFile));
  const summary = await runAcceptance(options);
  const pending = summary.steps.find((step) => !TERMINAL.has(step.outcome));
  console.log(JSON.stringify({ mode: summary.mode, evidenceKind: summary.evidenceKind,
    complete: summary.complete, liveAcceptancePassed: summary.liveAcceptancePassed,
    summaryPath: summary.summaryPath, cliCalls: summary.cliCalls, rawOutputBytes: summary.rawOutputBytes,
    pending: pending ? { key: pending.key, outcome: pending.outcome, code: pending.code,
      planId: pending.planId, fingerprint: pending.fingerprint, planArtifact: pending.planArtifact } : undefined }));
  if (summary.mode !== "dry-run" && !summary.complete) process.exitCode = 2;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error(JSON.stringify({ status: "error", code: error instanceof AcceptanceError ? error.code : "ACCEPTANCE_FAILED" }));
    process.exitCode = 1;
  });
}
