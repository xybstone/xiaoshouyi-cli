import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ContractRegistry, canonical, digest, isServerReportUpdate, recordPreconditionsMatch, template } from "./contracts.js";
import { OperationStore } from "./operation-store.js";
import { withFreshReads } from "./read-scope.js";
import { fieldJobServerAction } from "./fieldjob-server-actions.js";
import {
  fail,
  parseInput,
  prepareSchema,
  idSchema,
  object,
  TicketError,
  safeDiagnosticMessage,
  safeRemoteError,
  type ActionContract,
  type FileBinding,
  type Inspection,
  type RecordData,
  type OperationReview,
  type TicketBackend,
  type TicketOperation,
  type TicketPlan,
  type TicketMetadata,
} from "./types.js";

export function bindFile(filePath: string): FileBinding {
  const resolved = realpathSync(filePath);
  const info = statSync(resolved);
  if (!info.isFile() || info.size > 20 * 1024 * 1024 || info.size === 0)
    fail("VALIDATION_FAILED", "附件必须为 1 字节至 20MiB 的普通文件");
  const data = readFileSync(resolved);
  if (data.length !== info.size) fail("PLAN_STALE", "附件读取时发生变化");
  return {
    path: resolved,
    name: path.basename(resolved),
    size: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}
export function fingerprint(
  plan: Omit<TicketPlan, "fingerprint"> | TicketPlan,
): string {
  const { fingerprint: _ignored, ...rest } = plan as TicketPlan;
  return `sha256:${digest(rest)}`;
}
// Description APIs may return fields and picklist options in different orders.
// Their order is not a write constraint. Preserve every value and rule while
// comparing the sets in a deterministic order.
export function metadataFingerprint(metadata: TicketMetadata): string {
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  return digest({
    ...metadata,
    fields: metadata.fields.map((field) => ({
      ...field,
      options: [...field.options].sort((a, b) => compare(canonical(a), canonical(b))),
    })).sort((a, b) => compare(a.apiKey, b.apiKey)),
  });
}
function same(a: string, b: string): boolean {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function snapshot(c: ActionContract, i: Inspection): string {
  const record = Object.fromEntries(
    [...new Set([...c.preconditionFields, ...(c.recordPreconditions ?? []).map((condition) => condition.field)])]
      .map((k) => [k, i.record?.[k] ?? null]),
  );
  return digest({
    record,
    permission: i.permission,
    allowed: i.allowed,
    required: i.required,
    defaults: i.defaults,
    fields: i.fields,
    formVersion: i.formVersion,
    output: i.output ?? {},
  });
}
function validateInput(
  contract: ActionContract,
  inspection: Inspection,
  input: RecordData,
): void {
  const fields = { ...contract.fields, ...inspection.fields };
  const required = new Set([
    ...contract.required,
    ...inspection.required,
    ...Object.entries(contract.fields)
      .filter(([, v]) => v.required)
      .map(([k]) => k),
    ...Object.entries(inspection.fields)
      .filter(([, v]) => v.required)
      .map(([k]) => k),
  ]);
  for (const key of required)
    if (input[key] === undefined || input[key] === null || input[key] === "")
      fail("VALIDATION_FAILED", `缺少必填字段: ${key}`);
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(fields, key))
      fail("VALIDATION_FAILED", `未登记的动作字段: ${key}`);
    const rules = [contract.fields[key], inspection.fields[key]].filter(
      Boolean,
    );
    for (const rule of rules) {
      const type = Array.isArray(value)
        ? "array"
        : value === null
          ? "null"
          : typeof value;
      if (type !== rule.type) fail("VALIDATION_FAILED", `字段类型不符: ${key}`);
      if (
        rule.enum &&
        !rule.enum.some((v) => canonical(v) === canonical(value))
      )
        fail("VALIDATION_FAILED", `字段枚举值无效: ${key}`);
      const size =
        typeof value === "number"
          ? value
          : typeof value === "string" || Array.isArray(value)
            ? value.length
            : undefined;
      if (
        size !== undefined &&
        ((rule.min !== undefined && size < rule.min) ||
          (rule.max !== undefined && size > rule.max))
      )
        fail("VALIDATION_FAILED", `字段超出范围: ${key}`);
    }
  }
  canonical(input);
}
function assertInspection(i: Inspection, contract: ActionContract): void {
  if (!i.identityVerified) fail("IDENTITY_UNVERIFIED", "当前请求身份未核验");
  const standardServerCreate = contract.authorization === "server" &&
    contract.request?.host === "api" && contract.request.method === "POST" &&
    contract.request.encoding === "json" &&
    ((contract.action === "create" && contract.fieldMode === "create" &&
      contract.request.path === "/rest/data/v2.0/xobjects/fieldJob") ||
     (contract.action === "worklog" && contract.fieldMode === "action" &&
      contract.request.path === "/rest/data/v2.0/xobjects/timeSheetDetatils__c"));
  if ((standardServerCreate || isServerReportUpdate(contract) || fieldJobServerAction(contract, String(contract.defaults.engineerId ?? ""))) &&
    i.permission !== "denied" && i.allowed !== "denied") return;
  if (i.permission !== "allowed")
    fail(
      i.permission === "denied" ? "FORBIDDEN" : "UNVERIFIED",
      "当前账号动作权限未允许",
    );
  if (i.allowed !== "allowed")
    fail(
      i.allowed === "denied" ? "ACTION_NOT_ALLOWED" : "UNVERIFIED",
      "当前工单动作未允许",
    );
}
export interface Confirmation {
  fingerprint: string;
  source: "cli" | "host";
  reference: string;
  purpose?: "execute" | "operation_review";
  reviewFingerprint?: string;
}
const reviewSchema = z.object({
  outcome: z.enum(["applied", "not_applied", "inconclusive"]),
  reviewedBy: z.string().trim().min(1).max(200),
  evidenceReferences: z.array(z.string().trim().min(1).max(1000)).min(1).max(20),
  resultId: idSchema.optional(),
}).strict().refine((review) => review.outcome !== "applied" || !!review.resultId, "确认已落地必须提供经核对的结果ID");
export function operationReviewFingerprint(planFingerprint: string, rawReview: OperationReview): string {
  const review = normalizeOperationReview(rawReview);
  return `sha256:${digest({ purpose: "operation_review", planFingerprint, review })}`;
}
export function normalizeOperationReview(raw: unknown): OperationReview {
  return parseInput(reviewSchema, raw);
}
type PreparationResult =
  | { status: "blocked"; code: string; action: string; reason: string }
  | { status: "ready"; plan: TicketPlan };
export class TicketActions {
  constructor(
    readonly backend: TicketBackend,
    readonly registry: ContractRegistry,
    readonly store: OperationStore,
    readonly now: () => number = Date.now,
  ) {}
  async prepare(raw: unknown): Promise<PreparationResult> {
    return withFreshReads(this.backend, () => this.prepareInScope(raw));
  }
  private async prepareInScope(raw: unknown): Promise<PreparationResult> {
    const args = parseInput(prepareSchema, raw);
    const contract = this.registry.get(args.action);
    if (contract.verification !== "verified")
      return {
        status: "blocked",
        code:
          contract.verification === "unsupported"
            ? "UNSUPPORTED"
            : "UNVERIFIED",
        action: args.action,
        reason: "尚无可执行的已核验动作契约",
      };
    if (args.action !== "create" && !args.id)
      fail("VALIDATION_FAILED", "该动作需要明确工单 ID");
    if (args.action === "create" && args.id)
      fail("VALIDATION_FAILED", "创建动作不能指定已有工单 ID");
    const context = await this.backend.context();
    const inspection = await this.backend.inspect(
      contract,
      args.id,
      args.input,
    );
    if (!recordPreconditionsMatch(contract, inspection.record))
      fail("ACTION_NOT_ALLOWED", "当前工单状态不满足该动作的记录条件");
    assertInspection(inspection, contract);
    const input = {
      ...contract.defaults,
      ...inspection.defaults,
      ...args.input,
    };
    validateInput(contract, inspection, input);
    const entityType =
      args.action === "create"
        ? input.entityType
        : inspection.record?.entityType;
    if (
      contract.entityTypes &&
      !contract.entityTypes.includes(String(entityType))
    )
      fail("UNVERIFIED", "该业务类型尚未核验此动作");
    let metadataHash: string | undefined;
    if (contract.fieldMode !== "action") {
      const metadata = await this.backend.metadata();
      metadataHash = metadataFingerprint(metadata);
      for (const [key, value] of Object.entries(input)) {
        const field = metadata.fields.find((f) => f.apiKey === key);
        if (!field || field.enabled === false)
          fail("VALIDATION_FAILED", `字段不存在或不可用: ${key}`);
        if (["reference", "entitytype", "dimension"].includes(field.type.toLowerCase()))
          parseInput(idSchema, value);
        if (
          (contract.fieldMode === "create"
            ? field.createable
            : field.updateable) !== true
        )
          fail("FORBIDDEN", `字段不可写: ${key}`);
        if (
          contract.fieldMode === "update" &&
          ["ownerId", "entityType"].includes(key)
        )
          fail("FORBIDDEN", `工单字段不可更新: ${key}`);
        if (
          field.options.length &&
          !field.options.some((o) => canonical(o.value) === canonical(value))
        )
          fail("VALIDATION_FAILED", `字段选项不可用: ${key}`);
      }
      if (contract.fieldMode === "create")
        for (const f of metadata.fields)
          if (
            f.required &&
            (input[f.apiKey] === undefined ||
              input[f.apiKey] === null ||
              input[f.apiKey] === "")
          )
            fail("VALIDATION_FAILED", `缺少对象级必填: ${f.apiKey}`);
    }
    const file =
      contract.request?.encoding === "multipart"
        ? bindFile(String(input.filePath ?? ""))
        : undefined;
    const id = randomUUID();
    const bindings = {
      input,
      target: { id: args.id },
      context,
      record: inspection.record,
      probe: inspection.output ?? {},
      operation: { operationId: id, planId: id },
    };
    const payload = template(contract.request?.payload ?? {}, bindings);
    const requestHeaders = object(template(contract.request?.headers ?? {}, bindings)) as Record<string, string>;
    for (const value of Object.values(requestHeaders))
      if (typeof value !== "string" || /[\r\n]/.test(value))
        fail("VALIDATION_FAILED", "计划接口头部必须为无换行字符串");
    const created = this.now();
    const unsigned = {
      planId: id,
      operationId: id,
      contextKey: context.key,
      action: args.action,
      targetId: args.id,
      contractVersion: contract.version,
      contractHash: digest(contract),
      snapshotHash: snapshot(contract, inspection),
      metadataHash,
      input,
      payload,
      requestHeaders,
      probeOutput: inspection.output ?? {},
      file,
      effects: contract.effects,
      createdAt: new Date(created).toISOString(),
      expiresAt: new Date(created + args.ttlSeconds * 1000).toISOString(),
      concurrency: "best_effort" as const,
    };
    const plan: TicketPlan = {
      ...unsigned,
      fingerprint: fingerprint(unsigned),
    };
    this.store.create({ plan, state: "prepared", updatedAt: plan.createdAt });
    return { status: "ready", plan };
  }
  async execute(
    id: string,
    confirmation: Confirmation,
  ): Promise<TicketOperation> {
    return withFreshReads(this.backend, () => this.executeInScope(id, confirmation));
  }
  private async executeInScope(id: string, confirmation: Confirmation): Promise<TicketOperation> {
    if (confirmation?.purpose === "operation_review")
      fail("CONFIRMATION_MISMATCH", "人工核对授权不能用于发送工单动作");
    const initial = this.store.read(id);
    await this.assertPlan(
      initial.plan,
      confirmation,
      initial.state === "prepared",
    );
    if (initial.state !== "prepared")
      return initial.state === "dispatching"
        ? {
            ...initial,
            state: "outcome_unknown",
            errorCode: "INTERRUPTED_OR_IN_PROGRESS",
          }
        : initial;
    const release = this.store.lock(id);
    try {
      const operation = this.store.read(id);
      const plan = operation.plan;
      if (operation.state !== "prepared") return operation;
      await this.assertPlan(plan, confirmation);
      const contract = this.registry.get(plan.action);
      const inspection = await this.backend.inspect(
        contract,
        plan.targetId,
        plan.input,
      );
      if (!recordPreconditionsMatch(contract, inspection.record))
        fail("ACTION_NOT_ALLOWED", "当前工单状态不满足该动作的记录条件");
      assertInspection(inspection, contract);
      if (snapshot(contract, inspection) !== plan.snapshotHash)
        fail("PLAN_STALE", "工单状态、权限或表单规则已变化，请重新 prepare");
      if (
        plan.metadataHash &&
        metadataFingerprint(await this.backend.metadata()) !== plan.metadataHash
      )
        fail("PLAN_STALE", "字段元数据已变化，请重新 prepare");
      validateInput(contract, inspection, plan.input);
      if (plan.file && digest(bindFile(plan.file.path)) !== digest(plan.file))
        fail("PLAN_STALE", "附件内容或路径已变化");
      const context = await this.backend.context();
      const payload = template(contract.request?.payload ?? {}, {
        input: plan.input,
        target: { id: plan.targetId },
        context,
        record: inspection.record,
        probe: inspection.output ?? {},
        operation: { operationId: plan.operationId, planId: plan.planId },
      });
      if (canonical(payload) !== canonical(plan.payload))
        fail("PLAN_STALE", "最终请求内容已变化");
      const requestHeaders = template(contract.request?.headers ?? {}, {
        input: plan.input, target: { id: plan.targetId }, context,
        record: inspection.record,
        probe: inspection.output ?? {},
        operation: { operationId: plan.operationId, planId: plan.planId },
      });
      if (canonical(requestHeaders) !== canonical(plan.requestHeaders ?? {}))
        fail("PLAN_STALE", "最终请求头部已变化");
      operation.confirmation = {
        source: confirmation.source,
        reference: confirmation.reference,
        confirmedAt: new Date(this.now()).toISOString(),
      };
      operation.state = "dispatching";
      operation.updatedAt = new Date(this.now()).toISOString();
      this.store.save(operation);
      try {
        operation.submission = await this.backend.submit(contract, plan);
        operation.state = "applied_pending_verification";
      } catch (error) {
        // 仅已核验协议明确拒绝时才判定 rejected；其余发送后异常不重放。
        const code =
          error && typeof error === "object" && "code" in error
            ? String(error.code)
            : "OUTCOME_UNKNOWN";
        operation.state =
          code === "REMOTE_REJECTED" ? "rejected" : "outcome_unknown";
        operation.errorCode = code;
        if (error instanceof TicketError) {
          operation.errorMessage = safeDiagnosticMessage(error.message);
          const diagnostic = safeRemoteError(error.details);
          if (Object.keys(diagnostic).length) operation.remoteError = diagnostic;
        }
        operation.updatedAt = new Date(this.now()).toISOString();
        this.store.save(operation);
        return operation;
      }
      operation.updatedAt = new Date(this.now()).toISOString();
      this.store.save(operation);
      return await this.verifyOperation(operation, contract);
    } finally {
      release();
    }
  }
  async reconcile(id: string): Promise<TicketOperation> {
    const operation = this.store.read(id);
    const context = await this.backend.context();
    if (context.key !== operation.plan.contextKey)
      fail("CONTEXT_MISMATCH", "操作属于其他账号或环境");
    if (!same(fingerprint(operation.plan), operation.plan.fingerprint))
      fail("INVALID_PLAN", "计划内容或指纹已变化");
    if (!["dispatching", "outcome_unknown", "applied_pending_verification"].includes(operation.state))
      return operation;
    const contract = this.registry.get(operation.plan.action);
    if (
      contract.verification !== "verified" ||
      digest(contract) !== operation.plan.contractHash
    )
      fail("PLAN_STALE", "回查契约已变化");
    if (this.store.executionActive(id))
      fail("OPERATION_BUSY", "执行进程仍在处理该操作，请稍后回查");
    const release = this.store.lock(id, "reconcile");
    try {
      const latest = this.store.read(id);
      if (!latest.submission && ["dispatching", "outcome_unknown"].includes(latest.state)) {
        latest.state = "outcome_unknown";
        try {
          const fileAcknowledgement = ["attachment_upload", "attachment_link"].includes(fieldJobServerAction(contract) ?? "");
          const recovery = (contract.recovery || fileAcknowledgement) && this.backend.recover
            ? await this.backend.recover(contract, latest.plan)
            : { status: "unavailable" as const };
          latest.recoveryHistory = [...(latest.recoveryHistory ?? []), {
            source: "contract", status: recovery.status,
            matchedCount: recovery.matchedCount,
            checkedAt: new Date(this.now()).toISOString(),
          }];
          if (recovery.status === "matched" && recovery.submission) {
            latest.submission = recovery.submission;
            latest.state = "applied_pending_verification";
            delete latest.errorCode;
          } else latest.errorCode = `RECOVERY_${recovery.status.toUpperCase()}`;
        } catch (error) {
          const code = error && typeof error === "object" && "code" in error
            ? String(error.code) : "RECOVERY_READ_FAILED";
          latest.errorCode = code;
          latest.recoveryHistory = [...(latest.recoveryHistory ?? []), {
            source: "contract", status: "unavailable",
            checkedAt: new Date(this.now()).toISOString(),
          }];
        }
        latest.updatedAt = new Date(this.now()).toISOString();
        this.store.save(latest);
      }
      return latest.state === "applied_pending_verification"
        ? await this.verifyOperation(latest, contract)
        : latest;
    } finally {
      release();
    }
  }
  async review(
    id: string,
    confirmation: Confirmation,
    rawReview: OperationReview,
  ): Promise<TicketOperation> {
    const review = parseInput(reviewSchema, rawReview);
    const initial = this.store.read(id);
    await this.assertPlan(initial.plan, confirmation, false);
    if (confirmation.purpose !== "operation_review" ||
        !same(confirmation.reviewFingerprint ?? "", operationReviewFingerprint(initial.plan.fingerprint, review)))
      fail("CONFIRMATION_MISMATCH", "人工核对需独立确认用途与该核对内容的指纹");
    if (this.store.executionActive(id))
      fail("OPERATION_BUSY", "执行进程尚未退出，不能记录最终人工核对结果");
    const release = this.store.lock(id, "reconcile");
    try {
      const operation = this.store.read(id);
      if (!["dispatching", "outcome_unknown"].includes(operation.state) || operation.submission)
        fail("INVALID_OPERATION_STATE", "仅无回执的不确定操作允许人工核对");
      if (review.outcome === "applied" && !review.resultId)
        fail("VALIDATION_FAILED", "确认已落地必须提供经核对的结果ID");
      operation.recoveryHistory = [...(operation.recoveryHistory ?? []), {
        source: "manual", status: review.outcome,
        reviewedBy: review.reviewedBy,
        evidenceReferences: review.evidenceReferences,
        confirmationReference: confirmation.reference,
        checkedAt: new Date(this.now()).toISOString(),
      }];
      operation.updatedAt = new Date(this.now()).toISOString();
      if (review.outcome === "applied") {
        operation.submission = { id: review.resultId, output: {} };
        operation.state = "applied_pending_verification";
        delete operation.errorCode;
      } else if (review.outcome === "not_applied") {
        operation.state = "not_applied";
        operation.errorCode = "MANUALLY_CONFIRMED_NOT_APPLIED";
      } else {
        operation.state = "outcome_unknown";
        operation.errorCode = "MANUAL_REVIEW_INCONCLUSIVE";
      }
      this.store.save(operation);
      // Human attribution does not replace the normal side-effect verification.
      const contract = this.registry.get(operation.plan.action);
      return operation.submission && contract.verification === "verified" &&
        digest(contract) === operation.plan.contractHash
        ? await this.verifyOperation(operation, contract) : operation;
    } finally {
      release();
    }
  }
  private async verifyOperation(
    operation: TicketOperation,
    contract: ActionContract,
  ): Promise<TicketOperation> {
    try {
      operation.verification = await this.backend.verify(
        contract,
        operation.plan,
        operation.submission!,
      );
      if (operation.verification.status === "verified") {
        operation.state = "verified";
        delete operation.errorCode;
      }
    } catch {
      operation.errorCode = "VERIFICATION_PENDING";
    }
    operation.updatedAt = new Date(this.now()).toISOString();
    this.store.save(operation);
    return operation;
  }
  private async assertPlan(
    plan: TicketPlan,
    confirmation: Confirmation,
    fresh = true,
  ): Promise<void> {
    if (
      !confirmation ||
      !["cli", "host"].includes(confirmation.source) ||
      !confirmation.reference?.trim() ||
      confirmation.reference.length > 2000
    )
      fail("CONFIRMATION_REQUIRED", "需要与该计划绑定的明确用户确认");
    if (
      !same(fingerprint(plan), plan.fingerprint) ||
      !same(plan.fingerprint, confirmation.fingerprint)
    )
      fail("CONFIRMATION_MISMATCH", "确认指纹与计划不符");
    if ((await this.backend.context()).key !== plan.contextKey)
      fail("CONTEXT_MISMATCH", "计划属于其他账号或环境");
    if (!fresh) return;
    const contract = this.registry.get(plan.action);
    if (
      contract.verification !== "verified" ||
      digest(contract) !== plan.contractHash
    )
      fail("PLAN_STALE", "动作契约已变化");
    if (
      !Number.isFinite(Date.parse(plan.expiresAt)) ||
      Date.parse(plan.expiresAt) <= this.now()
    )
      fail("PLAN_EXPIRED", "计划已过期，请重新 prepare");
  }
}
