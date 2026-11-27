import { describe, expect, it } from "vitest";
import {
  assessFieldJobDispatchEligibility,
  buildFieldJobAcceptance,
  buildFieldJobTeamAssignment,
  buildFieldJobTransfer,
  buildSingleFieldJobAssignment,
  createScopedFieldJobSelfAssignment,
  decodeFieldJobDispatchCandidates,
  decodeFieldJobDispatchResponse,
  decodeFieldJobDispatchStaff,
  decodeFieldJobDistribution,
  isServerFieldJobSelfAssignment,
  type DispatchEligibility,
} from "../../../src/tickets/fieldjob-dispatch.js";

const fixtureProof = () => ({
  scope: { apiBaseUrl: "https://crm.example.test", crmBaseUrl: "https://crm.example.test", tenantId: "synthetic", subjectId: "7" },
  fieldJobId: "11", entityType: "2", entityTypeValue: 2, poolId: "3", poolValue: 3,
  actorId: "7", candidateId: "7", candidateIsOnlyReturnedActor: true as const,
  initialTeamCount: 0 as const, initialTeamComplete: true as const,
  evidence: { source: "synthetic" as const, reference: "offline dispatch fixture; not a live permission proof", verifiedAt: "2026-11-27T00:00:00+08:00" },
});
const eligibility = (): DispatchEligibility => ({
  action: "assign", protocol: "verified", identityVerified: true,
  expectedFieldJobId: "11", observedFieldJobId: "11", expectedPoolId: "3", observedPoolId: "3",
  actionPermission: "allowed", currentActionAllowed: "allowed", candidateInPool: "allowed", candidateRoleEligible: "allowed",
});

describe("专用派工的已观察协议与预览", () => {
  it("单人分配保留真实FormData字段，不能伪装成工作流路由或负责人PATCH", () => {
    const request = buildSingleFieldJobAssignment({ fieldJobId: "11", targetId: "7" });
    expect(request).toMatchObject({ method: "POST", path: "/json/crm_458/assign.action", encoding: "multipart-fields", verification: "unverified" });
    expect(request.payload).toEqual({ fieldJobIds: "11", target: "7", keepOwnerAsGroupMember: "0" });
    expect(request.payload).not.toHaveProperty("responsibleTE__c"); expect(request.payload).not.toHaveProperty("nextAssignees");
  });
  it("转移使用fieldJob页面实际映射的customize命名空间和权限保留字段", () => {
    const request = buildFieldJobTransfer({ fieldJobId: "11", targetId: "8", keepOwnerAsGroupMember: true, retainedOwnerPermission: "edit" });
    expect(request.path).toBe("/json/crm_customize/transfer.action");
    expect(request.payload).toEqual({ customizeIds: "11", belongId: "458", target: "8", keepOwnerAsGroupMember: "1", keepAsMember: "1", keepAsOwner: "1" });
  });
  it("保留修改权限不能脱离保留团队成员条件", () => {
    expect(() => buildFieldJobTransfer({ fieldJobId: "11", targetId: "8", retainedOwnerPermission: "edit" })).toThrow();
  });
  it("接受派工由服务器身份操作，不接受另一个接收人或任意operation", () => {
    expect(buildFieldJobAcceptance({ fieldJobId: "11" })).toMatchObject({ path: "/json/crm_458/acceptOrReject.action", encoding: "form", payload: { fieldJobIds: "11", operation: "accept" } });
    expect(() => buildFieldJobAcceptance({ fieldJobId: "11", receiverId: "8" } as never)).toThrow();
    expect(() => buildFieldJobAcceptance({ fieldJobId: "11", operation: "agree" } as never)).toThrow();
  });
  it("团队分派使用真实REST结构且明确主/辅工程师", () => {
    const request = buildFieldJobTeamAssignment({ fieldJobId: "11", members: [{ userId: "7", teamRole: 1 }, { userId: "8", teamRole: 2 }] });
    expect(request).toMatchObject({ path: "/rest/data/v2.0/xobjects/fieldJob/actions/changeServiceTeamMember", encoding: "json", verification: "unverified" });
    expect(request.payload).toEqual({ fieldJobIdList: [11], serviceTeamList: [
      { userId: 7, teamRole: 1, plannedStartTime: null, plannedEndTime: null },
      { userId: 8, teamRole: 2, plannedStartTime: null, plannedEndTime: null },
    ], keepGroupMember: false });
    expect(request.requiredReadback).toEqual(expect.arrayContaining(["assigner", "ownerId", "responsibleTE__c", "fieldJobPoolGroup", "serviceTeamMembers"]));
  });
  it.each([
    [{ userId: "7", teamRole: 2 }],
    [{ userId: "7", teamRole: 1 }, { userId: "8", teamRole: 1 }],
    [{ userId: "7", teamRole: 1 }, { userId: "7", teamRole: 2 }],
    [{ userId: "9007199254740993", teamRole: 1 }],
    [{ userId: "7", teamRole: 1, plannedStartTime: 20, plannedEndTime: 10 }],
    [{ userId: "7", teamRole: 1, plannedEndTime: 10 }],
  ])("拒绝角色冲突、重复、不安全ID和无效计划时间", (members) => {
    expect(() => buildFieldJobTeamAssignment({ fieldJobId: "11", members } as never)).toThrow();
  });
  it("页面锁定的已执行成员不能被删除或改成其他角色", () => {
    const old = [{ userId: "7", teamRole: 1 as const, executionStatus: 2, plannedStartTime: null, plannedEndTime: null }];
    expect(() => buildFieldJobTeamAssignment({ fieldJobId: "11", members: [{ userId: "8", teamRole: 1 }] }, old)).toThrow();
    expect(() => buildFieldJobTeamAssignment({ fieldJobId: "11", members: [{ userId: "7", teamRole: 2 }, { userId: "8", teamRole: 1 }] }, old)).toThrow();
    expect(() => buildFieldJobTeamAssignment({ fieldJobId: "11", members: [{ userId: "7", teamRole: 1 }, { userId: "8", teamRole: 2 }] }, old)).not.toThrow();
  });
  it("输入不能夹带状态、部门、所有人或额外工单", () => {
    expect(() => buildSingleFieldJobAssignment({ fieldJobId: "11", targetId: "7", status: 3 } as never)).toThrow();
    expect(() => buildFieldJobTeamAssignment({ fieldJobId: "11", members: [{ userId: "7", teamRole: 1 }], ownerId: "8" } as never)).toThrow();
  });
});

describe("派工资格的独立证据", () => {
  it("候选在池内不代替角色、当前动作或执行权限", () => {
    expect(assessFieldJobDispatchEligibility({ ...eligibility(), actionPermission: "unknown", candidateRoleEligible: "unknown" })).toMatchObject({ decision: "unknown", reasons: ["ACTION_PERMISSION_UNKNOWN", "CANDIDATE_ROLE_UNKNOWN"] });
    expect(assessFieldJobDispatchEligibility({ ...eligibility(), protocol: "unverified" }).decision).toBe("unknown");
  });
  it("身份、目标或派工池变化阻断预检", () => {
    expect(assessFieldJobDispatchEligibility({ ...eligibility(), observedPoolId: "4" }).decision).toBe("denied");
    expect(assessFieldJobDispatchEligibility({ ...eligibility(), observedFieldJobId: "12" }).decision).toBe("denied");
    expect(assessFieldJobDispatchEligibility({ ...eligibility(), identityVerified: false }).decision).toBe("denied");
  });
  it("接受动作另外要求当前本人确为派工成员", () => {
    expect(assessFieldJobDispatchEligibility({ ...eligibility(), action: "accept", actorIsAssignedMember: "unknown" }).decision).toBe("unknown");
    expect(assessFieldJobDispatchEligibility({ ...eligibility(), action: "accept", actorIsAssignedMember: "denied" }).decision).toBe("denied");
    expect(assessFieldJobDispatchEligibility({ ...eligibility(), action: "accept", actorIsAssignedMember: "allowed" }).decision).toBe("allowed");
  });
  it("配置返回302表示会话未具备，不能误称当前账号没有派工权限", () => {
    expect(decodeFieldJobDistribution({ httpStatus: 302, body: null })).toEqual({ availability: "session_required", allowMultiAssign: undefined, permission: "unknown" });
    expect(decodeFieldJobDispatchStaff({ httpStatus: 302, body: null })).toEqual({ availability: "session_required", members: [], permission: "unknown" });
  });
  it("多人配置开关不是派工权限，当前服务成员不是候选清单", () => {
    expect(decodeFieldJobDistribution({ httpStatus: 200, body: { status: 0, data: { allowMultiAssign: true } } })).toEqual({ availability: "observed", allowMultiAssign: true, permission: "unknown" });
    expect(decodeFieldJobDispatchStaff({ httpStatus: 200, body: { multiAssignInfo: { serviceTeamInfo: [{ userId: 7, isMain: true, executionStatus: 1 }] } } })).toEqual({ availability: "observed", permission: "unknown", members: [{ userId: "7", teamRole: 1, executionStatus: 1, plannedStartTime: null, plannedEndTime: null }] });
  });
  it("REST技能候选实际为顶层batchData，只投影ID且不虚构teamRole", () => {
    const result = decodeFieldJobDispatchCandidates({ httpStatus: 200, body: { code: "200", batchData: [{ code: "200", data: { id: 7, name: "private name", enterpriseWechatAccount: "private", parents: [] } }] } }, "7");
    expect(result).toEqual({ availability: "observed", candidates: [{ id: "7" }], currentActorIsOnlyReturnedCandidate: true, roleEligibility: "unknown" });
    expect(JSON.stringify(result)).not.toContain("private");
  });
  it("同名候选有多条时不选择第一条，也不推断当前本人唯一", () => {
    const result = decodeFieldJobDispatchCandidates({ httpStatus: 200, body: { code: "200", batchData: [{ code: "200", data: { id: 7 } }, { code: "200", data: { id: 8 } }] } }, "7");
    expect(result.currentActorIsOnlyReturnedCandidate).toBe(false);
  });
});

describe("记录级派工响应", () => {
  it("HTTP200和顶层status0不能掩盖单条失败", () => {
    expect(decodeFieldJobDispatchResponse({ httpStatus: 200, body: { status: 0, data: { failedObjects: [{}] } } })).toEqual({ status: "rejected", failedCount: 1, readbackRequired: true });
  });
  it("无失败记录仍需回读，不能直接宣称派工副作用完整", () => {
    expect(decodeFieldJobDispatchResponse({ httpStatus: 200, body: { status: 0, data: { total: 1, succeed: 1, failedObjects: [] } } })).toEqual({ status: "accepted", failedCount: 0, readbackRequired: true });
  });
  it.each([
    { status: 0, data: {} }, { status: 0, data: { total: 2, failedObjects: [] } }, { status: 0, data: { succeed: 0, failedObjects: [] } }, { code: 9033, data: {} },
  ])("缺少可靠记录级结果或数量冲突时保持unknown", (body) => {
    expect(decodeFieldJobDispatchResponse({ httpStatus: 200, body }).status).toBe("outcome_unknown");
  });
});

describe("仅本人新测试单的服务器授权白名单", () => {
  it("配置绑定同源、账号、业务类型、池、草稿和空分配人，写后核对真实服务团队", () => {
    const config = createScopedFieldJobSelfAssignment(fixtureProof());
    const contract = config.actions[0];
    expect(isServerFieldJobSelfAssignment(contract, "7")).toBe(true);
    expect(contract.authorization).toBe("server"); expect(contract.probe).toBeUndefined();
    expect(contract.recordPreconditions).toEqual(expect.arrayContaining([{ field: "id", expected: "11" }, { field: "fieldJobPoolGroup", expected: 3 }, { field: "assigner", expected: null }]));
    expect(contract.verify?.additional?.[0].query).toMatchObject({ apiKey: "serviceTeam", linkField: "fieldJobId" });
  });
  it("其他账号、候选、非空旧团队或跨域不能复用本人草稿证明", () => {
    expect(() => createScopedFieldJobSelfAssignment({ ...fixtureProof(), candidateId: "8" })).toThrow();
    expect(() => createScopedFieldJobSelfAssignment({ ...fixtureProof(), initialTeamCount: 1 } as never)).toThrow();
    expect(() => createScopedFieldJobSelfAssignment({ ...fixtureProof(), scope: { ...fixtureProof().scope, crmBaseUrl: "https://other.example.test" } })).toThrow();
    expect(isServerFieldJobSelfAssignment(createScopedFieldJobSelfAssignment(fixtureProof()).actions[0], "8")).toBe(false);
  });
  it.each([
    (c: ReturnType<typeof createScopedFieldJobSelfAssignment>["actions"][number]) => { c.request!.path = "/rest/data/v2.0/xobjects/fieldJob/11"; },
    (c: ReturnType<typeof createScopedFieldJobSelfAssignment>["actions"][number]) => { (c.request!.payload as Record<string, unknown>).status = 3; },
    (c: ReturnType<typeof createScopedFieldJobSelfAssignment>["actions"][number]) => { c.fields.engineerId.enum = ["8"]; },
    (c: ReturnType<typeof createScopedFieldJobSelfAssignment>["actions"][number]) => { c.recordPreconditions = c.recordPreconditions!.filter((entry) => entry.field !== "fieldJobPoolGroup"); },
    (c: ReturnType<typeof createScopedFieldJobSelfAssignment>["actions"][number]) => { c.verify!.additional = []; },
    (c: ReturnType<typeof createScopedFieldJobSelfAssignment>["actions"][number]) => { c.request!.successPath = "code"; },
  ])("更换协议、人员、约束或省略关联回读不能得到窄白名单豁免", (change) => {
    const contract = createScopedFieldJobSelfAssignment(fixtureProof()).actions[0]; change(contract);
    expect(isServerFieldJobSelfAssignment(contract, "7")).toBe(false);
  });
});
