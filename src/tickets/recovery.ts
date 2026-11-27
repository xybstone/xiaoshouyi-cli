import { buildListQuery, escapeSql } from "../utils/index.js";
import { canonical, template } from "./contracts.js";
import {
  fail,
  idSchema,
  parseInput,
  type ActionContract,
  type RecoveryResult,
  type TicketBackend,
  type TicketPlan,
} from "./types.js";

// Attribution requires the unique operation ID that was sent with the write.
// Matching a current state or a similar title cannot identify this operation.
export async function recoverByCorrelation(
  backend: Pick<TicketBackend, "context" | "query">,
  contract: ActionContract,
  plan: TicketPlan,
): Promise<RecoveryResult> {
  const recovery = contract.recovery;
  if (!recovery || contract.verification !== "verified")
    return { status: "unavailable" };
  const context = await backend.context();
  if (context.key !== plan.contextKey)
    fail("CONTEXT_MISMATCH", "恢复读取属于其他账号或环境");
  if (!context.identityVerified)
    fail("IDENTITY_UNVERIFIED", "恢复读取身份尚未核验");
  const fields = [...new Set([
    "id", recovery.correlationField, recovery.resultIdField,
    ...(recovery.targetField ? [recovery.targetField] : []),
    ...recovery.checks.map((check) => check.field),
    ...Object.values(recovery.outputFields ?? {}),
  ])];
  const page = await backend.query(buildListQuery(recovery.apiKey, fields, {
    where: `${recovery.correlationField} = '${escapeSql(plan.operationId)}'`,
    order: "id desc", offset: 0, size: 2,
  }));
  const current = await backend.context();
  if (current.key !== plan.contextKey || !current.identityVerified)
    fail("CONTEXT_MISMATCH", "恢复读取期间身份发生变化");
  if (!Number.isSafeInteger(page.totalSize) || page.totalSize < 0 ||
      page.records.length > 2 || page.count !== page.records.length ||
      page.totalSize < page.records.length)
    fail("INVALID_RESPONSE", "恢复查询未提供可靠的候选数量");
  if (page.totalSize > 1)
    return { status: "ambiguous", matchedCount: page.totalSize };
  if (!page.totalSize && !page.records.length)
    return { status: "not_found", matchedCount: 0 };
  if (page.totalSize !== 1 || page.records.length !== 1)
    fail("INVALID_RESPONSE", "恢复查询的唯一候选不完整");
  const record = page.records[0];
  if (record[recovery.correlationField] !== plan.operationId)
    fail("INVALID_RESPONSE", "恢复候选没有对应操作关联值");
  if (recovery.targetField &&
      String(record[recovery.targetField]) !== plan.targetId)
    fail("INVALID_RESPONSE", "恢复候选属于其他工单");
  const rawId = record[recovery.resultIdField];
  if (typeof rawId === "number" && !Number.isSafeInteger(rawId))
    fail("INVALID_RESPONSE", "恢复结果ID超出安全数值范围");
  const id = parseInput(idSchema, String(rawId));
  const output = Object.fromEntries(
    Object.entries(recovery.outputFields ?? {}).map(([key, field]) => [key, record[field] ?? null]),
  );
  const bindings = {
    context, input: plan.input, target: { id: plan.targetId ?? id },
    probe: plan.probeOutput ?? {},
    operation: { operationId: plan.operationId, planId: plan.planId },
    result: { ...output, id },
  };
  if (!recovery.checks.every((check) => record[check.field] !== undefined &&
      canonical(record[check.field]) === canonical(template(check.expected, bindings))))
    return { status: "unavailable", matchedCount: 1 };
  return { status: "matched", matchedCount: 1, submission: { id, output } };
}
