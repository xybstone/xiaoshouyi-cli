import { object, type Decision, type RecordData } from "./types.js";

export const FIELDJOB_BRANCH_ACTIONS = [
  "pause", "resume", "escalate", "reopen", "return", "void",
] as const;
export type FieldJobBranchAction = (typeof FIELDJOB_BRANCH_ACTIONS)[number];

/** Static page evidence is a protocol candidate, not current tenant permission. */
export interface FieldJobBranchProtocolEvidence {
  action: FieldJobBranchAction;
  verification: "unverified";
  pageProtocol?: {
    method: "GET" | "POST";
    path: string;
    encoding: "query" | "json";
    mutation: true;
    replay: "never";
    fields: string[];
  };
  reference: string;
  missingEvidence: string[];
  semanticExclusions: string[];
}

const operationPage = "fieldJobOperation.js sha256:85be9ca7f1a7afec252ecbf84952ecb8a67d3fbfe7ecd2a2f83d3ab8e4b59223";
const branchEvidence: readonly FieldJobBranchProtocolEvidence[] = [
  {
    action: "pause", verification: "unverified",
    pageProtocol: {
      method: "GET", path: "/json/crm_458/pauseOrResume.action", encoding: "query",
      mutation: true, replay: "never",
      fields: ["fieldJobId", "pauseOrResume", "isOffline", "pauseReason"],
    },
    reference: `${operationPage}; pauseOrResume page branch`,
    missingEvidence: ["当前业务类型的暂停按钮与允许状态", "业务接口认证", "暂停原因及SLA联动规则"],
    semanticExclusions: ["taskSuspend 是审批任务暂不处理，不能自动解释为工单暂停", "不能通过更新 customItem71__c 或 status 代替业务动作"],
  },
  {
    action: "resume", verification: "unverified",
    pageProtocol: {
      method: "GET", path: "/json/crm_458/pauseOrResume.action", encoding: "query",
      mutation: true, replay: "never", fields: ["fieldJobId"],
    },
    reference: `${operationPage}; existing paused status page branch`,
    missingEvidence: ["当前业务类型的恢复按钮与允许状态", "业务接口认证", "恢复与SLA计时规则"],
    semanticExclusions: ["taskUnsuspend 不能自动解释为工单恢复", "GET 方法不证明请求只读"],
  },
  {
    action: "escalate", verification: "unverified", reference: "No tenant-specific escalation contract verified",
    missingEvidence: ["升级动作存在性", "升级目标、角色及允许状态", "通知、SLA与外部同步规则"],
    semanticExclusions: ["turn 是审批转交，不能自动解释为工单升级", "修改 priority 不能代替升级动作"],
  },
  {
    action: "reopen", verification: "unverified",
    pageProtocol: {
      method: "POST", path: "/rest/data/v2.0/xobjects/fieldJob/actions/reopen", encoding: "json",
      mutation: true, replay: "never", fields: ["fieldJobId"],
    },
    reference: `${operationPage}; reopen page handler`,
    missingEvidence: ["当前业务类型及角色允许重开", "重开原因与目标状态规则", "SLA和历史联动"],
    semanticExclusions: ["Closed/Resolved 枚举存在不证明允许重开", "不能直接把 status 改回 New"],
  },
  {
    action: "return", verification: "unverified", reference: "No tenant-specific business return contract verified",
    missingEvidence: ["业务退回动作与目标节点", "当前角色权限", "退回原因和历史规则"],
    semanticExclusions: ["returnedFieldJob/goBack.action/returnTime 表示工程师返程", "reject 不能在未核验业务语义时自动解释为退回"],
  },
  {
    action: "void", verification: "unverified", reference: "Status option is metadata evidence only",
    missingEvidence: ["工单作废真实动作", "当前业务类型与角色允许结果", "作废原因及历史保留"],
    semanticExclusions: ["已作废枚举不证明作废动作可用", "通用 delete 或其他对象的 close.action 不能代替作废"],
  },
];

export function fieldJobBranchProtocolEvidence(): FieldJobBranchProtocolEvidence[] {
  return structuredClone(branchEvidence) as FieldJobBranchProtocolEvidence[];
}

/** The observed getPermission contract uses actions.<key>.permission booleans. */
export function readFieldJobWorkflowPermission(raw: unknown, actionKey: string): Decision {
  const response = object(raw);
  if (response.code !== 200 && response.code !== "200") return "unknown";
  const permission = object(object(object(response.data).actions)[actionKey]).permission;
  return permission === true ? "allowed" : permission === false ? "denied" : "unknown";
}

export function fieldJobBranchPermissionEvidence(raw: unknown) {
  return fieldJobBranchProtocolEvidence().map((evidence) => ({
    ...evidence,
    permission: readFieldJobWorkflowPermission(raw, evidence.action),
    // A permission observation cannot verify a write protocol or its effects.
    executable: false as const,
  }));
}

function referenceId(raw: unknown): string | undefined {
  const value = object(raw).id ?? raw;
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  return typeof value === "string" && /^[1-9]\d*$/.test(value) ? value : undefined;
}

function timeState(value: unknown): "missing" | "present" | "invalid" {
  if (value === null || value === undefined) return "missing";
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? "present" : "invalid";
}

/** Summarize actual observations; successful close alone cannot prove effects. */
export function fieldJobSideEffectEvidence(record: RecordData, slaRows: readonly RecordData[]) {
  const actualStart = timeState(record.actualStartTime);
  const actualEnd = timeState(record.actualEndTime);
  const id = referenceId(record.id);
  const correlated = slaRows.filter((row) => id && referenceId(row.fieldJobId) === id);
  const ordered = actualStart === "present" && actualEnd === "present"
    ? Number(record.actualStartTime) <= Number(record.actualEndTime) : null;
  return {
    actualStart,
    actualEnd,
    actualTimeOrderValid: ordered,
    actualTimeCoverage: ordered === true ? "observed" : "unverified",
    slaMatchTimes: typeof record.slaMatchTimes === "number" &&
      Number.isSafeInteger(record.slaMatchTimes) && record.slaMatchTimes >= 0
      ? record.slaMatchTimes : null,
    slaLogCount: correlated.length,
    slaLogEvidence: correlated.length ? "observed" : "not_observed",
    pauseSlaImpact: "unverified",
    notificationDelivery: "unverified",
    externalSynchronization: "unverified",
  };
}
