import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { fail, idSchema, object, parseInput, type ActionContract, type Decision, type Evidence } from "./types.js";

/** Public page call sites establish wire shapes, not tenant permissions. */
export const FIELDJOB_DISPATCH_EVIDENCE = {
  verification: "unverified" as const,
  source: "page" as const,
  references: [
    "neo-ui-component-servicecloud-web fieldJobMultiAssign.js: single assignment and changeServiceTeamMember",
    "neo-ui-component-servicecloud-web fieldJobOperation.js modules 68738/2193: acceptOrReject POST form",
    "src_entityExtends_components_multiTransferCustomize_component_tsx.97b2a6ea.js: fieldJob transfer mapping",
  ],
  note: "Static protocol evidence; legacy configuration GETs returned HTTP 302 under the tested isolated OAuth session. These observations alone do not establish dispatch permission or completed write effects.",
  bundles: {
    assign: {
      url: "https://neors.ingageapp.com/projects/neo-ui-component-servicecloud-web/2023/build/static/js/src_entityExtends_fieldJob_comps_multiAssign_component_tsx.f044812e.js",
      sha256: "21afe277563911b27d1868cb1da827b124f5bd2f838874e90a5de13c8dfb5542",
    },
    accept: {
      url: "https://neors.ingageapp.com/projects/neo-ui-component-servicecloud-web/2023/build/static/js/src_entityExtends_fieldJob_comps_fieldJobOperation_component_tsx.d6d3988b.js",
      sha256: "85be9ca7f1a7afec252ecbf84952ecb8a67d3fbfe7ecd2a2f83d3ab8e4b59223",
    },
    transfer: {
      url: "https://neors.ingageapp.com/projects/neo-ui-component-servicecloud-web/2023/build/static/js/src_entityExtends_components_multiTransferCustomize_component_tsx.97b2a6ea.js",
      sha256: "3ffbe65f3af600536507400c85c605b2c18b12140b3adeece572ac0c91169abe",
    },
  },
} as const;

export const FIELDJOB_DISPATCH_PATHS = {
  distribution: "/json/crm_458/getDistributionType.action",
  skillRequired: "/json/crm_458/isAllowSkillRequired.action",
  staff: "/json/crm_458/queryFieldJobStaffNew.action",
  poolStaff: "/json/crm_458/queryFieldJobStaff.action",
  recommendations: "/rest/data/v2.0/xobjects/fieldJob/actions/recommendDispatch",
  assign: "/json/crm_458/assign.action",
  reassign: "/json/crm_customize/transfer.action",
  team: "/rest/data/v2.0/xobjects/fieldJob/actions/changeServiceTeamMember",
  accept: "/json/crm_458/acceptOrReject.action",
} as const;

export type DispatchAction = "assign" | "reassign" | "accept";
export interface ObservedDispatchRequest {
  method: "POST";
  path: string;
  // The page uses FormData without files. It must not be silently converted to
  // urlencoded form or routed through the existing file-upload requirement.
  encoding: "multipart-fields" | "form" | "json";
  payload: Record<string, unknown>;
  verification: "unverified";
  requiredReadback: readonly string[];
}
const readback = [
  "ownerId", "responsibleTE__c", "assigner", "dispatchMethod",
  "fieldJobPoolGroup", "status", "serviceTeamMembers", "dispatchHistory",
] as const;
const assignmentInput = z.object({
  fieldJobId: idSchema,
  targetId: idSchema,
  keepOwnerAsGroupMember: z.boolean().default(false),
}).strict();
const transferInput = assignmentInput.extend({
  retainedOwnerPermission: z.enum(["read", "edit"]).default("read"),
}).strict();

/** A nonexecutable preview of the observed single-owner dispatch request. */
export function buildSingleFieldJobAssignment(raw: z.input<typeof assignmentInput>): ObservedDispatchRequest {
  const input = parseInput(assignmentInput, raw);
  return {
    method: "POST", path: FIELDJOB_DISPATCH_PATHS.assign, encoding: "multipart-fields",
    payload: {
      fieldJobIds: input.fieldJobId, target: input.targetId,
      keepOwnerAsGroupMember: input.keepOwnerAsGroupMember ? "1" : "0",
    },
    verification: "unverified", requiredReadback: readback,
  };
}

/** Transfer changes ownership/access; it is distinct from workflow routing. */
export function buildFieldJobTransfer(raw: z.input<typeof transferInput>): ObservedDispatchRequest {
  const input = parseInput(transferInput, raw);
  if (!input.keepOwnerAsGroupMember && input.retainedOwnerPermission === "edit")
    fail("VALIDATION_FAILED", "保留原负责人修改权限必须同时保留其为团队成员");
  const keep = input.keepOwnerAsGroupMember ? "1" : "0";
  return {
    method: "POST", path: FIELDJOB_DISPATCH_PATHS.reassign, encoding: "multipart-fields",
    payload: {
      customizeIds: input.fieldJobId, belongId: "458", target: input.targetId,
      keepOwnerAsGroupMember: keep, keepAsMember: keep,
      keepAsOwner: input.retainedOwnerPermission === "edit" ? "1" : "0",
    },
    verification: "unverified", requiredReadback: readback,
  };
}

/** Server identity accepts its own dispatch; a caller cannot impersonate one. */
export function buildFieldJobAcceptance(raw: { fieldJobId: string }): ObservedDispatchRequest {
  const input = parseInput(z.object({ fieldJobId: idSchema }).strict(), raw);
  return {
    method: "POST", path: FIELDJOB_DISPATCH_PATHS.accept, encoding: "form",
    payload: { fieldJobIds: input.fieldJobId, operation: "accept" },
    verification: "unverified", requiredReadback: readback,
  };
}

const timestamp = z.number().int().nonnegative().refine(
  (value) => Number.isSafeInteger(value) && Number.isFinite(new Date(value).getTime()),
  "计划时间必须为有效毫秒时间戳",
).nullable().default(null);
const teamMember = z.object({
  userId: idSchema, teamRole: z.union([z.literal(1), z.literal(2)]),
  plannedStartTime: timestamp, plannedEndTime: timestamp,
}).strict();
const teamInput = z.object({
  fieldJobId: idSchema,
  members: z.array(teamMember).min(1).max(100),
  keepGroupMember: z.boolean().default(false),
}).strict();
export interface ExistingDispatchMember {
  userId: string;
  teamRole: 1 | 2;
  executionStatus: number;
  plannedStartTime: number | null;
  plannedEndTime: number | null;
}
function numericId(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || String(number) !== value)
    fail("VALIDATION_FAILED", "服务团队接口需要可无损转换为数值的ID");
  return number;
}

/** Preserve active team members instead of implementing transfer by PATCH. */
export function buildFieldJobTeamAssignment(
  raw: z.input<typeof teamInput>,
  previous: ExistingDispatchMember[] = [],
): ObservedDispatchRequest {
  const input = parseInput(teamInput, raw);
  if (input.members.filter((member) => member.teamRole === 1).length !== 1)
    fail("VALIDATION_FAILED", "服务团队必须明确且仅有一名主工程师");
  const ids = new Set(input.members.map((member) => member.userId));
  if (ids.size !== input.members.length)
    fail("VALIDATION_FAILED", "服务团队成员不能重复");
  for (const member of input.members)
    if ((member.plannedStartTime === null && member.plannedEndTime !== null) ||
        (member.plannedStartTime !== null && member.plannedEndTime !== null && member.plannedStartTime > member.plannedEndTime))
      fail("VALIDATION_FAILED", "计划开始时间不能晚于结束时间");
  for (const old of previous.filter((member) => [2, 3].includes(member.executionStatus))) {
    const next = input.members.find((member) => member.userId === old.userId);
    if (!next || next.teamRole !== old.teamRole || next.plannedStartTime !== old.plannedStartTime || next.plannedEndTime !== old.plannedEndTime)
      fail("ACTION_NOT_ALLOWED", "不能删除或变更页面标为不可编辑的已执行服务团队成员");
  }
  return {
    method: "POST", path: FIELDJOB_DISPATCH_PATHS.team, encoding: "json",
    payload: {
      fieldJobIdList: [numericId(input.fieldJobId)],
      serviceTeamList: input.members.map((member) => ({ ...member, userId: numericId(member.userId) })),
      keepGroupMember: input.keepGroupMember,
    },
    verification: "unverified", requiredReadback: readback,
  };
}

export interface DispatchEligibility {
  action: DispatchAction;
  protocol: "verified" | "unverified";
  identityVerified: boolean;
  expectedFieldJobId: string;
  observedFieldJobId: string;
  expectedPoolId: string;
  observedPoolId: string;
  actionPermission: Decision;
  currentActionAllowed: Decision;
  candidateInPool?: Decision;
  candidateRoleEligible?: Decision;
  actorIsAssignedMember?: Decision;
}

/** Pool membership, role, actor identity and action permission are independent. */
export function assessFieldJobDispatchEligibility(input: DispatchEligibility): {
  decision: Decision; reasons: string[];
} {
  const reasons: string[] = [];
  let denied = false;
  if (!input.identityVerified) { reasons.push("IDENTITY_UNVERIFIED"); denied = true; }
  if (input.expectedFieldJobId !== input.observedFieldJobId) { reasons.push("TARGET_MISMATCH"); denied = true; }
  if (input.expectedPoolId !== input.observedPoolId) { reasons.push("POOL_CHANGED"); denied = true; }
  if (input.protocol !== "verified") reasons.push("PROTOCOL_UNVERIFIED");
  const checks: Array<[string, Decision | undefined]> = [
    ["ACTION_PERMISSION", input.actionPermission], ["CURRENT_ACTION", input.currentActionAllowed],
    ...(input.action === "accept"
      ? [["ACTOR_ASSIGNED_MEMBER", input.actorIsAssignedMember] as [string, Decision | undefined]]
      : [["CANDIDATE_POOL", input.candidateInPool], ["CANDIDATE_ROLE", input.candidateRoleEligible]] as Array<[string, Decision | undefined]>),
  ];
  for (const [name, decision] of checks)
    if (decision !== "allowed") {
      reasons.push(`${name}_${decision === "denied" ? "DENIED" : "UNKNOWN"}`);
      denied ||= decision === "denied";
    }
  return { decision: denied ? "denied" : reasons.length ? "unknown" : "allowed", reasons };
}

export interface DispatchHttpResponse { httpStatus: number; body: unknown }
function observedBody(response: DispatchHttpResponse): Record<string, unknown> | undefined {
  if (response.httpStatus < 200 || response.httpStatus >= 300) return undefined;
  const body = object(response.body);
  const status = body.status ?? body.code;
  if (status !== undefined && ![0, "0", 200, "200"].includes(status as string | number)) return undefined;
  return body;
}

/** Distribution mode says nothing about the current user's right to dispatch. */
export function decodeFieldJobDistribution(response: DispatchHttpResponse) {
  const body = observedBody(response), data = object(body?.data);
  return {
    availability: [301, 302, 303, 307, 308, 401].includes(response.httpStatus) ? "session_required" as const
      : body && typeof data.allowMultiAssign === "boolean" ? "observed" as const : "unverified" as const,
    allowMultiAssign: typeof data.allowMultiAssign === "boolean" ? data.allowMultiAssign : undefined,
    permission: "unknown" as const,
  };
}

/** This is a team snapshot, never a list of eligible dispatch candidates. */
export function decodeFieldJobDispatchStaff(response: DispatchHttpResponse): {
  availability: "observed" | "session_required" | "unverified";
  members: ExistingDispatchMember[];
  permission: "unknown";
} {
  if ([301, 302, 303, 307, 308, 401].includes(response.httpStatus))
    return { availability: "session_required", members: [], permission: "unknown" };
  const body = observedBody(response);
  const info = object(body?.multiAssignInfo);
  if (!body || !Array.isArray(info.serviceTeamInfo))
    return { availability: "unverified", members: [], permission: "unknown" };
  if (info.serviceTeamInfo.length > 100) fail("INVALID_RESPONSE", "服务团队读取超过受控上限");
  const members = info.serviceTeamInfo.map((raw) => {
    const member = object(raw);
    if (typeof member.userId === "number" && !Number.isSafeInteger(member.userId))
      fail("INVALID_RESPONSE", "服务团队用户ID不安全");
    const userId = parseInput(idSchema, String(member.userId));
    if (![true, false, 0, 1].includes(member.isMain as boolean | number) ||
        typeof member.executionStatus !== "number" || !Number.isSafeInteger(member.executionStatus))
      fail("INVALID_RESPONSE", "服务团队主工程师/执行状态尚未核验");
    return {
      userId, teamRole: member.isMain === true || member.isMain === 1 ? 1 as const : 2 as const,
      executionStatus: member.executionStatus,
      plannedStartTime: parseInput(timestamp, member.plannedStartTime ?? null),
      plannedEndTime: parseInput(timestamp, member.plannedEndTime ?? null),
    };
  });
  return { availability: "observed", members, permission: "unknown" };
}

/** Decode record-level failures before considering the eventual readback. */
export function decodeFieldJobDispatchResponse(response: DispatchHttpResponse): {
  status: "accepted" | "rejected" | "outcome_unknown" | "session_required";
  failedCount?: number;
  readbackRequired: true;
} {
  if ([301, 302, 303, 307, 308, 401].includes(response.httpStatus))
    return { status: "session_required", readbackRequired: true };
  const body = observedBody(response), data = object(body?.data);
  if (!body || !Array.isArray(data.failedObjects)) return { status: "outcome_unknown", readbackRequired: true };
  if (data.failedObjects.length) return { status: "rejected", failedCount: data.failedObjects.length, readbackRequired: true };
  if ((data.total !== undefined && data.total !== 1) || (data.succeed !== undefined && data.succeed !== 1))
    return { status: "outcome_unknown", readbackRequired: true };
  return { status: "accepted", failedCount: 0, readbackRequired: true };
}

/** Skill filtering is useful candidate evidence, not a role/permission grant. */
export function decodeFieldJobDispatchCandidates(response: DispatchHttpResponse, actorId: string) {
  parseInput(idSchema, actorId);
  const body = observedBody(response);
  if (!body || !Array.isArray(body.batchData))
    return { availability: "unverified" as const, candidates: [], currentActorIsOnlyReturnedCandidate: false, roleEligibility: "unknown" as const };
  if (body.batchData.length > 100) fail("INVALID_RESPONSE", "派工候选超过受控读取上限");
  const candidates = body.batchData.map((entry) => {
    const result = object(entry), data = object(result.data);
    if (![200, "200"].includes(result.code as number | string))
      fail("INVALID_RESPONSE", "派工候选中存在失败子响应");
    if (typeof data.id === "number" && !Number.isSafeInteger(data.id))
      fail("INVALID_RESPONSE", "派工候选ID无法无损读取");
    return { id: parseInput(idSchema, String(data.id)) };
  });
  return {
    availability: "observed" as const, candidates,
    currentActorIsOnlyReturnedCandidate: candidates.length === 1 && candidates[0].id === actorId,
    roleEligibility: "unknown" as const,
  };
}

interface SelfAssignmentProof {
  scope: { apiBaseUrl: string; crmBaseUrl: string; tenantId: string; subjectId: string };
  fieldJobId: string;
  entityType: string;
  entityTypeValue: string | number;
  poolId: string;
  poolValue: string | number;
  actorId: string;
  candidateId: string;
  candidateIsOnlyReturnedActor: true;
  initialTeamCount: 0;
  initialTeamComplete: true;
  evidence: Evidence;
}

/**
 * Host-only configuration factory for the observed REST self-assignment shape.
 * "verified" describes the observed protocol; writing remains server-authorized
 * and has not been accepted until the executor's readbacks all pass.
 */
export function createScopedFieldJobSelfAssignment(proof: SelfAssignmentProof) {
  for (const id of [proof.fieldJobId, proof.entityType, proof.poolId, proof.actorId, proof.candidateId, proof.scope.subjectId])
    parseInput(idSchema, id);
  if (proof.actorId !== proof.candidateId || proof.actorId !== proof.scope.subjectId ||
      proof.candidateIsOnlyReturnedActor !== true || proof.initialTeamCount !== 0 || proof.initialTeamComplete !== true ||
      String(proof.entityTypeValue) !== proof.entityType || String(proof.poolValue) !== proof.poolId)
    fail("UNVERIFIED", "仅对已核验本人候选、明确业务类型/池、空服务团队的新测试单生成派工配置");
  const origin = new URL(proof.scope.apiBaseUrl);
  if (origin.protocol !== "https:" || origin.origin !== proof.scope.apiBaseUrl ||
      proof.scope.crmBaseUrl !== origin.origin || origin.username || origin.password || !proof.scope.tenantId)
    fail("CONTEXT_MISMATCH", "专用派工配置必须绑定同源、租户及本人身份");
  const integer = (reference: string) => ({ $ref: reference, $type: "integer" });
  const actor = numericId(proof.actorId);
  numericId(proof.fieldJobId);
  const contract: ActionContract = {
    action: "assign", verification: "verified", authorization: "server",
    version: "fieldjob-self-team-assignment-v1", evidence: proof.evidence,
    entityTypes: [proof.entityType], fieldMode: "action",
    fields: {
      engineerId: { type: "string", required: true, enum: [proof.actorId] },
      keepGroupMember: { type: "boolean", required: true, enum: [false] },
    },
    required: ["engineerId", "keepGroupMember"],
    defaults: { engineerId: proof.actorId, keepGroupMember: false },
    preconditionFields: ["status", "customItem62__c", "entityType", "fieldJobPoolGroup", "ownerId", "responsibleTE__c", "assigner", "dispatchMethod"],
    recordPreconditions: [
      { field: "id", expected: proof.fieldJobId }, { field: "entityType", expected: proof.entityTypeValue },
      { field: "fieldJobPoolGroup", expected: proof.poolValue }, { field: "status", expected: 1 },
      { field: "ownerId", expected: actor }, { field: "responsibleTE__c", expected: actor }, { field: "assigner", expected: null },
    ],
    effects: [
      "通过专用服务团队动作将当前本人设置为该测试单主工程师；服务器最终检查动作、池及角色权限",
      "写后核对分配人、所有人、自定义负责人、派工池与新服务团队关联；不把工作流nextAssignees当作派工",
    ],
    request: {
      host: "api", method: "POST", path: FIELDJOB_DISPATCH_PATHS.team, encoding: "json",
      payload: {
        fieldJobIdList: [integer("target.id")],
        serviceTeamList: [{ userId: integer("input.engineerId"), teamRole: 1, plannedStartTime: null, plannedEndTime: null }],
        keepGroupMember: { $ref: "input.keepGroupMember" },
      },
      successPath: "status", successValues: [0],
    },
    verify: {
      checks: [
        { field: "id", expected: { $ref: "target.id" } },
        { field: "fieldJobPoolGroup", expected: proof.poolValue },
        { field: "ownerId", expected: integer("input.engineerId") },
        { field: "responsibleTE__c", expected: integer("input.engineerId") },
        { field: "assigner", expected: integer("input.engineerId") },
      ],
      additional: [{
        name: "serviceTeam",
        query: { apiKey: "serviceTeam", fields: ["fieldJobId", "engineerId", "teamRole", "executionStatus"], linkField: "fieldJobId" },
        checks: [
          { field: "fieldJobId", expected: integer("target.id") },
          { field: "engineerId", expected: integer("input.engineerId") },
          { field: "teamRole", expected: 1 },
        ],
      }],
    },
  };
  return { version: 1 as const, scope: { ...proof.scope }, actions: [contract] };
}

/** Narrow opt-in guard for the host's server-authorized REST test contract. */
export function isServerFieldJobSelfAssignment(contract: ActionContract, scopeSubjectId: string | undefined): boolean {
  if (!scopeSubjectId || !idSchema.safeParse(scopeSubjectId).success ||
      !Number.isSafeInteger(Number(scopeSubjectId)) ||
      contract.action !== "assign" || contract.authorization !== "server" || contract.fieldMode !== "action" || contract.probe ||
      contract.request?.host !== "api" || contract.request.method !== "POST" || contract.request.encoding !== "json" ||
      contract.request.path !== FIELDJOB_DISPATCH_PATHS.team || Object.keys(contract.request.headers ?? {}).length ||
      contract.request.successPath !== "status" || !isDeepStrictEqual(contract.request.successValues, [0]))
    return false;
  const engineer = contract.fields.engineerId, keep = contract.fields.keepGroupMember;
  if (Object.keys(contract.fields).length !== 2 || !engineer || !keep ||
      engineer.type !== "string" || !isDeepStrictEqual(engineer.enum, [scopeSubjectId]) ||
      keep.type !== "boolean" || !isDeepStrictEqual(keep.enum, [false]) ||
      !isDeepStrictEqual(contract.defaults, { engineerId: scopeSubjectId, keepGroupMember: false }) ||
      !contract.required.includes("engineerId") || !contract.required.includes("keepGroupMember"))
    return false;
  const integer = (ref: string) => ({ $ref: ref, $type: "integer" });
  if (!isDeepStrictEqual(contract.request.payload, {
    fieldJobIdList: [integer("target.id")],
    serviceTeamList: [{ userId: integer("input.engineerId"), teamRole: 1, plannedStartTime: null, plannedEndTime: null }],
    keepGroupMember: { $ref: "input.keepGroupMember" },
  })) return false;
  const conditions = contract.recordPreconditions ?? [];
  const byField = new Map(conditions.map((entry) => [entry.field, entry.expected]));
  if (byField.size !== conditions.length || !idSchema.safeParse(byField.get("id")).success ||
      contract.entityTypes?.length !== 1 || String(byField.get("entityType")) !== contract.entityTypes[0] ||
      !idSchema.safeParse(contract.entityTypes[0]).success ||
      !idSchema.safeParse(String(byField.get("fieldJobPoolGroup"))).success || byField.get("status") !== 1 ||
      byField.get("ownerId") !== Number(scopeSubjectId) || byField.get("responsibleTE__c") !== Number(scopeSubjectId) ||
      byField.get("assigner") !== null)
    return false;
  const expectedChecks = [
    { field: "id", expected: { $ref: "target.id" } },
    { field: "fieldJobPoolGroup", expected: byField.get("fieldJobPoolGroup") },
    ...["ownerId", "responsibleTE__c", "assigner"].map((field) => ({ field, expected: integer("input.engineerId") })),
  ];
  if (!expectedChecks.every((check) => contract.verify?.checks.some((actual) => isDeepStrictEqual(actual, check)))) return false;
  return (contract.verify?.additional ?? []).some((group) =>
    group.query.apiKey === "serviceTeam" && group.query.linkField === "fieldJobId" && group.query.bind !== "result" &&
    [
      { field: "fieldJobId", expected: integer("target.id") },
      { field: "engineerId", expected: integer("input.engineerId") },
      { field: "teamRole", expected: 1 },
    ].every((check) => group.checks.some((actual) => isDeepStrictEqual(actual, check))),
  );
}
