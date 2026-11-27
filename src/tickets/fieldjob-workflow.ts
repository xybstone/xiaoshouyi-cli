import { canonical, digest } from "./contracts.js";
import {
  fail, fieldSchema, idSchema, object,
  type ActionContract, type Decision, type Evidence, type Inspection,
  type RecordData, type RecordPrecondition, type RequestSpec,
  type Submission, type TicketContext, type TicketOperation,
} from "./types.js";

const PREFIX = "/rest/data/v2.0/creekflow";
const VERSION = "fieldjob-workflow-v1";
export type FieldJobWorkflowAction = "submit" | "advance" | "close" | "workflow_preprocess";
export interface FieldJobWorkflowReader {
  context(): Promise<TicketContext>;
  get(id: string, fields?: string[]): Promise<RecordData>;
  readRequest(request: RequestSpec, bindings: RecordData): Promise<unknown>;
}
export interface WorkflowCandidate { id: string; name?: string }
export interface WorkflowNextTask {
  key: string; name?: string; candidates: WorkflowCandidate[];
  userTaskType: number | null; adjustAssignee: boolean | null; optionalChooseApprover: boolean | null;
}
export interface FieldJobNextTransition {
  processDefinitionId: string;
  key: string | null;
  name?: string;
  type: string;
  terminal: boolean;
  showAgreeFields: boolean;
  candidates: WorkflowCandidate[];
  tasks: WorkflowNextTask[];
}
export interface FieldJobWorkflowDiscovery {
  objectApiKey: "fieldJob";
  targetId: string;
  record: RecordData;
  task: { id: string | null; editableFields: Array<{ field: string; editable: boolean; required: boolean }> };
  actions: Record<string, Decision>;
  allowedActions: string[];
  chooser: { status: "ready"; transition: FieldJobNextTransition } |
    { status: "already_submitted" | "ended" | "not_requested" };
  state: "draft" | "active" | "ended" | "unverified";
  coverage: { permission: "verified"; submitChooser: "verified" | "unverified"; nextTransition: "verified" | "unverified" };
  note: string;
}
export interface FieldJobPreprocessingReceipt {
  operationId: string;
  contextKey: string;
  targetId: string;
  taskId: string;
  expiresAt: string;
  recordSnapshot: RecordData;
  transition: FieldJobNextTransition;
}
export interface FieldJobWorkflowProfileOptions {
  scope: { apiBaseUrl: string; crmBaseUrl: string; tenantId: string; subjectId?: string };
  entityTypes: string[];
  evidence: Evidence;
  version?: string;
  snapshotFields?: string[];
  guards?: Partial<Record<FieldJobWorkflowAction, RecordPrecondition[]>>;
  verify?: Partial<Record<"submit" | "advance" | "close", NonNullable<ActionContract["verify"]>>>;
}

const ref = (path: string) => ({ $ref: path });
const integer = (path: string) => ({ $ref: path, $type: "integer" });
const permissionPath = `${PREFIX}/task/actions/getPermission`;
const chooserPath = `${PREFIX}/approval/objectData/submitChooser/fieldJob`;
const preprocessingPath = `${PREFIX}/task/actions/preProcessor`;
const writePath = `${PREFIX}/approval/userTaskLog/fieldJob`;
const projection = {
  workflowProcessId: "data.procdefId", workflowNextTaskKey: "data.nextTaskDefKey",
  workflowNextTaskName: "data.nextTaskDefName", workflowNextTaskType: "data.nextTaskType",
  workflowEndNode: "data.nextEndNodeFlag", workflowShowFields: "data.showAgreeFields",
  workflowApprovers: "data.chooseApprover", workflowNextTasks: "data.nextUserTasks",
};
function request(path: string, payload: unknown): RequestSpec {
  return { host: "api", method: "POST", path, encoding: "json", payload, successPath: "code", successValues: [200, "200"] };
}
export function fieldJobPermissionRequest(): RequestSpec {
  return request(permissionPath, { data: { entityApiKey: "fieldJob", dataId: integer("target.id") } });
}
export function fieldJobSubmitChooserRequest(diagnostics = false): RequestSpec {
  const result = request(chooserPath, { data: { xObjectApiKey: "fieldJob", dataId: ref("target.id") } });
  // These two codes are diagnostic read results, never successful transitions.
  if (diagnostics) result.successValues = [...result.successValues, 1602002, "1602002", 1602004, "1602004"];
  return result;
}
function id(value: unknown, nullable = false): string | null {
  if (nullable && (value === null || value === undefined)) return null;
  if ((typeof value !== "string" && typeof value !== "number") ||
    (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0)) ||
    !idSchema.safeParse(String(value)).success)
    fail("INVALID_RESPONSE", "工作流引用不是可无损读取的正整数ID");
  return String(value);
}
function text(value: unknown, optional = false): string | undefined {
  if (optional && (value === undefined || value === null)) return undefined;
  if (typeof value !== "string" || !value || value.length > 1000 || /[\u0000-\u001f\u007f]/.test(value))
    fail("INVALID_RESPONSE", "工作流节点文本格式不符");
  return value;
}
function data(raw: unknown): RecordData {
  const envelope = object(raw);
  if (envelope.code !== 200 && envelope.code !== "200") fail("INVALID_RESPONSE", "工作流读取未返回已核验成功业务码");
  const result = object(envelope.data);
  if (!Object.keys(result).length) fail("INVALID_RESPONSE", "工作流响应缺少明确data结构");
  return result;
}
function candidates(raw: unknown): WorkflowCandidate[] {
  if (raw === null || raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 100) fail("INVALID_RESPONSE", "工作流候选列表不是有界数组");
  const values = raw.map((entry) => {
    const value = object(entry);
    return { id: id(value.id ?? entry)!, ...(value.name !== undefined || value.label !== undefined
      ? { name: text(value.name ?? value.label)! } : {}) };
  });
  if (new Set(values.map((candidate) => candidate.id)).size !== values.length)
    fail("INVALID_RESPONSE", "工作流候选包含重复ID");
  return values;
}
function intersect(a: WorkflowCandidate[], b: WorkflowCandidate[]): WorkflowCandidate[] {
  const allowed = new Set(b.map((candidate) => candidate.id));
  return a.filter((candidate) => allowed.has(candidate.id));
}
function transition(raw: RecordData): FieldJobNextTransition {
  if (typeof raw.nextEndNodeFlag !== "boolean" || typeof raw.showAgreeFields !== "boolean")
    fail("UNVERIFIED", "下一节点的终结标记或动态必填开关尚未明确");
  const topCandidates = candidates(raw.chooseApprover);
  const rows = raw.nextUserTasks === null || raw.nextUserTasks === undefined ? [] : raw.nextUserTasks;
  if (!Array.isArray(rows) || rows.length > 20) fail("INVALID_RESPONSE", "下一任务列表结构不符或超过限制");
  const tasks = rows.map((entry) => {
    const task = object(entry), names = candidates(task.chooseApprover), ids = candidates(task.candidates);
    const members = names.length && ids.length ? intersect(names, ids) : names.length ? names : ids;
    return { key: text(task.nextTaskDefKey)!, name: text(task.nextTaskDefName, true), candidates: members,
      userTaskType: typeof task.nextUsertaskType === "number" && Number.isSafeInteger(task.nextUsertaskType) ? task.nextUsertaskType : null,
      adjustAssignee: typeof task.nextAdjustAssigneeFlag === "boolean" ? task.nextAdjustAssigneeFlag : null,
      optionalChooseApprover: typeof task.optionalChooseApprover === "boolean" ? task.optionalChooseApprover : null,
    };
  });
  if (new Set(tasks.map((task) => task.key)).size !== tasks.length) fail("INVALID_RESPONSE", "下一任务包含重复节点");
  const key = raw.nextTaskDefKey === null || raw.nextTaskDefKey === undefined ? null : text(raw.nextTaskDefKey)!;
  const result: FieldJobNextTransition = {
    processDefinitionId: id(raw.procdefId)!, key, name: text(raw.nextTaskDefName, true),
    type: text(raw.nextTaskType)!, terminal: raw.nextEndNodeFlag,
    showAgreeFields: raw.showAgreeFields, candidates: topCandidates, tasks,
  };
  if (result.terminal && (result.type !== "EndNoneEvent" || key !== null || tasks.length || topCandidates.length))
    fail("INVALID_RESPONSE", "终结节点与下一任务或候选矛盾");
  if (!result.terminal && (!key || !tasks.length)) fail("INVALID_RESPONSE", "非终结节点缺少明确下一任务");
  return result;
}
function projectedTransition(output: RecordData): FieldJobNextTransition {
  return transition({ procdefId: output.workflowProcessId, nextTaskDefKey: output.workflowNextTaskKey,
    nextTaskDefName: output.workflowNextTaskName, nextTaskType: output.workflowNextTaskType,
    nextEndNodeFlag: output.workflowEndNode, showAgreeFields: output.workflowShowFields,
    chooseApprover: output.workflowApprovers, nextUserTasks: output.workflowNextTasks });
}

export async function discoverFieldJobWorkflow(
  reader: FieldJobWorkflowReader,
  targetId: string,
  options: { includeSubmitChooser?: boolean } = {},
): Promise<FieldJobWorkflowDiscovery> {
  if (!idSchema.safeParse(targetId).success) fail("VALIDATION_FAILED", "需要明确工单ID");
  const context = await reader.context();
  if (!context.identityVerified) fail("IDENTITY_UNVERIFIED", "工作流读取的当前身份尚未核验");
  const record = await reader.get(targetId, ["id", "entityType", "status", "customItem62__c"]);
  if (id(record.id) !== targetId) fail("INVALID_RESPONSE", "工作流读取目标不匹配");
  const bindings = { context, target: { id: targetId }, input: {}, record };
  const permission = data(await reader.readRequest(fieldJobPermissionRequest(), bindings));
  const task = object(permission.task), actionMap = object(permission.actions);
  if (!Object.hasOwn(permission, "task") || !Object.hasOwn(permission, "actions"))
    fail("INVALID_RESPONSE", "工作流权限响应缺少task/actions");
  const actions = Object.fromEntries(Object.entries(actionMap).map(([key, value]) => {
    if (!fieldSchema.safeParse(key).success) fail("INVALID_RESPONSE", "工作流动作键格式不符");
    const allowed = object(value).permission;
    return [key, allowed === true ? "allowed" : allowed === false ? "denied" : "unknown"];
  })) as Record<string, Decision>;
  const editable = task.editableFields;
  if (!Array.isArray(editable) || editable.length > 200) fail("INVALID_RESPONSE", "任务字段规则不是有界数组");
  const editableFields = editable.map((entry) => {
    const field = object(entry);
    if (!fieldSchema.safeParse(field.itemApiKey).success || typeof field.editable !== "boolean" || typeof field.required !== "boolean")
      fail("INVALID_RESPONSE", "任务字段规则缺少明确API键或布尔约束");
    return { field: String(field.itemApiKey), editable: field.editable, required: field.required };
  });
  const taskId = id(task.taskId, true), allowedActions = Object.keys(actions).filter((key) => actions[key] === "allowed").sort();
  let chooser: FieldJobWorkflowDiscovery["chooser"] = { status: "not_requested" };
  if (options.includeSubmitChooser !== false) {
    const raw = object(await reader.readRequest(fieldJobSubmitChooserRequest(true), bindings));
    if (raw.code === 1602002 || raw.code === "1602002") chooser = { status: "ended" };
    else if (raw.code === 1602004 || raw.code === "1602004") chooser = { status: "already_submitted" };
    else chooser = { status: "ready", transition: transition(data(raw)) };
  }
  if ((await reader.context()).key !== context.key) fail("CONTEXT_MISMATCH", "工作流读取过程中身份已变化");
  const ended = chooser.status === "ended" && taskId === null && allowedActions.length === 0 &&
    Object.values(actions).every((permission) => permission === "denied");
  return {
    objectApiKey: "fieldJob", targetId, record, task: { id: taskId, editableFields }, actions, allowedActions, chooser,
    state: ended ? "ended" : taskId !== null ? "active" : actions.submit === "allowed" && chooser.status === "ready" ? "draft" : "unverified",
    coverage: { permission: "verified", submitChooser: chooser.status === "not_requested" ? "unverified" : "verified", nextTransition: chooser.status === "ready" ? "verified" : "unverified" },
    note: "allowedActions是服务器流程权限，不替代业务类型/状态约束；agree只代表处理当前任务。preProcessor不是自动只读发现，结束工作流也不等于status=Closed。",
  };
}

function actionRequest(action: FieldJobWorkflowAction): RequestSpec {
  if (action === "workflow_preprocess") return {
    ...request(preprocessingPath, {
      data: { action: "agree", entityApiKey: "fieldJob", dataId: integer("target.id"), usertaskLogId: integer("probe.workflowTaskId") },
    }),
    outputPaths: { workflowResponseCode: "code", ...projection },
  };
  if (action === "submit") return request(writePath, { data: {
    action: "submit", xObjectApiKey: "fieldJob", dataId: integer("target.id"),
    procdefId: integer("probe.workflowProcessId"), nextTaskDefKey: ref("probe.workflowNextTaskKey"),
    ccs: [], comment: ref("input.comment"), priority: 50,
    nextUserTasks: [{ nextTaskDefKey: ref("probe.workflowNextTaskKey"), nextAssignees: [integer("input.assigneeId")] }],
  } });
  return request(writePath, { data: {
    action: "agree", xObjectApiKey: "fieldJob", dataId: integer("target.id"), usertaskLogId: integer("probe.workflowTaskId"),
    comment: ref("input.comment"), ...(action === "advance" ? {
      nextTaskDefKey: ref("probe.workflowNextTaskKey"),
      nextUserTasks: [{ nextTaskDefKey: ref("probe.workflowNextTaskKey"), nextAssignees: [integer("input.assigneeId")] }],
    } : { nextUserTasks: [] }),
  } });
}
function workflowKind(contract: ActionContract): FieldJobWorkflowAction | undefined {
  if (typeof contract.version !== "string" || !contract.version.startsWith(`${VERSION}:`)) return undefined;
  const kind = contract.action as FieldJobWorkflowAction;
  if (!["submit", "advance", "close", "workflow_preprocess"].includes(kind) ||
    !contract.version.startsWith(`${VERSION}:${kind}:`) || contract.authorization === "server" || contract.fieldMode !== "action" ||
    canonical(contract.request) !== canonical(actionRequest(kind)))
    fail("INVALID_CONTRACT", "工作流合同的固定业务请求被更改");
  const probe = contract.probe, verb = kind === "submit" ? "submit" : "agree";
  if (!probe || canonical(probe.request) !== canonical(fieldJobPermissionRequest()) ||
    probe.permissionPath !== `data.actions.${verb}.permission` || probe.allowedPath !== `data.actions.${verb}.permission` ||
    canonical(probe.outputPaths ?? {}) !== canonical({ workflowTaskId: "data.task.taskId" }))
    fail("INVALID_CONTRACT", "工作流合同缺少固定的当前权限与任务探测");
  const reads = kind === "submit" ? [{ request: fieldJobSubmitChooserRequest(), outputPaths: projection }] : [];
  if (canonical(probe.reads ?? []) !== canonical(reads)) fail("INVALID_CONTRACT", "工作流探测不能增加预处理或其他未声明请求");
  return kind;
}

/** A new scope-bound profile; IDs belong to runtime input, never this protocol. */
export function createFieldJobWorkflowProfile(options: FieldJobWorkflowProfileOptions) {
  if (!options.scope.tenantId || !options.entityTypes.length || options.entityTypes.some((value) => !idSchema.safeParse(value).success))
    fail("INVALID_CONTRACT", "工作流profile需明确身份范围及已核验业务类型");
  const fields = [...new Set(["id", "entityType", "status", "customItem62__c", ...(options.snapshotFields ?? [])])];
  if (fields.length > 40 || fields.some((field) => !fieldSchema.safeParse(field).success))
    fail("INVALID_CONTRACT", "工作流快照字段必须为有界API字段");
  const actions = (["submit", "advance", "close", "workflow_preprocess"] as const).map((kind): ActionContract => {
    const verb = kind === "submit" ? "submit" : "agree", preprocess = kind === "workflow_preprocess";
    const contract: ActionContract = {
      action: kind, verification: preprocess || (options.guards?.[kind]?.length && options.verify?.[kind]) ? "verified" : "unverified",
      version: `${VERSION}:${kind}:${options.version ?? "1"}`, evidence: options.evidence,
      entityTypes: [...options.entityTypes], fieldMode: "action", required: [], defaults: {}, effects: [preprocess
        ? "单次执行可能触发业务校验的工作流预处理；不自动重试，不代表推进或关闭"
        : kind === "close" ? "按已核验终结预处理证据完成当前任务，并验证业务终态" : "按服务器当前节点和明确候选提交或推进任务，不等同于派工或解决"],
      fields: preprocess ? { workflowRecord: { type: "object", required: true } } : {
        comment: { type: "string", required: true, min: 1, max: 2000 },
        ...(kind !== "close" ? { assigneeId: { type: "string" as const, required: true } } : {}),
        ...(kind !== "submit" ? { preprocessingOperationId: { type: "string" as const, required: true } } : {}),
      },
      preconditionFields: fields,
      ...(options.guards?.[kind] ? { recordPreconditions: options.guards[kind] } : {}),
      probe: { request: fieldJobPermissionRequest(), permissionPath: `data.actions.${verb}.permission`, allowedPath: `data.actions.${verb}.permission`,
        outputPaths: { workflowTaskId: "data.task.taskId" },
        ...(kind === "submit" ? { reads: [{ request: fieldJobSubmitChooserRequest(), outputPaths: projection }] } : {}),
      },
      request: actionRequest(kind),
      verify: preprocess ? { checks: fields.map((field) => ({ field, expected: ref(`input.workflowRecord.${field}`) })) } : options.verify?.[kind],
    };
    if (preprocess) contract.request!.outputPaths = { workflowResponseCode: "code", ...projection };
    return contract;
  });
  return { version: 1 as const, scope: { ...options.scope }, actions };
}

function putTransition(output: RecordData, value: FieldJobNextTransition): RecordData {
  return { ...output, workflowProcessId: value.processDefinitionId, workflowNextTaskKey: value.key,
    workflowNextTaskName: value.name, workflowNextTaskType: value.type, workflowEndNode: value.terminal,
    workflowShowFields: value.showAgreeFields, workflowApprovers: value.candidates,
    workflowNextTasks: value.tasks.map((task) => ({ nextTaskDefKey: task.key, nextTaskDefName: task.name,
      candidates: task.candidates.map((candidate) => candidate.id), chooseApprover: task.candidates,
      nextUsertaskType: task.userTaskType, nextAdjustAssigneeFlag: task.adjustAssignee, optionalChooseApprover: task.optionalChooseApprover })),
  };
}
export function guardFieldJobWorkflowInspection(
  contract: ActionContract,
  inspection: Inspection,
  input: RecordData,
  options: { trustedPreprocessing?: FieldJobPreprocessingReceipt; now?: number } = {},
): Inspection {
  const kind = workflowKind(contract);
  if (!kind || inspection.permission !== "allowed" || inspection.allowed !== "allowed" || !inspection.identityVerified) return inspection;
  const record = inspection.record;
  if (!record) fail("UNVERIFIED", "工作流动作需要明确父工单");
  if (kind === "workflow_preprocess") {
    if (!id(inspection.output?.workflowTaskId, true)) fail("ACTION_NOT_ALLOWED", "当前没有可处理任务");
    const snapshot = Object.fromEntries(contract.preconditionFields.map((field) => {
      if (!Object.hasOwn(record, field) || record[field] === undefined) fail("UNVERIFIED", "预处理父记录快照字段不可读取");
      return [field, record[field]];
    }));
    return { ...inspection, defaults: { ...inspection.defaults, workflowRecord: snapshot },
      fields: { ...inspection.fields, workflowRecord: { type: "object", required: true, enum: [snapshot] } } };
  }
  let next: FieldJobNextTransition;
  if (kind === "submit") {
    if (id(inspection.output?.workflowTaskId, true) !== null) fail("ACTION_NOT_ALLOWED", "已有活动任务，不能再次当草稿提交");
    next = projectedTransition(inspection.output ?? {});
  } else {
    const receipt = options.trustedPreprocessing;
    if (!receipt || input.preprocessingOperationId !== receipt.operationId) fail("UNVERIFIED", "需提供本地已执行且验证通过的单次预处理操作");
    if (receipt.targetId !== id(record.id) || receipt.taskId !== id(inspection.output?.workflowTaskId, true))
      fail("PLAN_STALE", "预处理证据不属于当前工单或当前任务");
    if (!Number.isFinite(Date.parse(receipt.expiresAt)) || Date.parse(receipt.expiresAt) <= (options.now ?? Date.now()))
      fail("PLAN_EXPIRED", "预处理证据已过期，不能自动重放");
    if (Object.entries(receipt.recordSnapshot).some(([field, value]) => !Object.hasOwn(record, field) || canonical(record[field]) !== canonical(value)))
      fail("PLAN_STALE", "父记录已在预处理后变化");
    next = receipt.transition;
  }
  if (next.showAgreeFields) fail("UNVERIFIED", "下一步存在尚未适配的动态必填表单");
  if (kind === "close") {
    if (!next.terminal || next.type !== "EndNoneEvent" || next.tasks.length || next.key !== null || next.candidates.length)
      fail("ACTION_NOT_ALLOWED", "预处理没有确认终结节点，不能关闭");
    return { ...inspection, output: putTransition(inspection.output ?? {}, next) };
  }
  if (next.terminal || next.type !== "UserTask" || !next.key || next.tasks.length !== 1 || next.tasks[0].key !== next.key ||
    next.tasks[0].userTaskType !== 1 || next.tasks[0].adjustAssignee !== false || next.tasks[0].optionalChooseApprover !== false)
    fail("UNVERIFIED", "当前仅支持明确的单一下一任务，不能猜测分支或终结语义");
  const allowed = intersect(next.candidates, next.tasks[0].candidates);
  if (!allowed.length) fail("UNVERIFIED", "下一任务没有可明确选择的已核验候选人");
  if (input.assigneeId !== undefined && (typeof input.assigneeId !== "string" || !allowed.some((candidate) => candidate.id === input.assigneeId)))
    fail("FORBIDDEN", "所选处理人不在当前下一任务的已核验候选集合");
  return { ...inspection,
    fields: { ...inspection.fields, assigneeId: { type: "string", required: true, enum: allowed.map((candidate) => candidate.id) } },
    output: putTransition(inspection.output ?? {}, next),
  };
}

/** Called after a write response is projected, before it can become verified. */
export function validateFieldJobWorkflowSubmission(contract: ActionContract, submission: Submission): Submission {
  if (contract.action !== "workflow_preprocess" || !contract.version.startsWith(`${VERSION}:workflow_preprocess:`)) return submission;
  // Output mappings are part of this fixed protocol too.
  const expected = actionRequest("workflow_preprocess");
  if (canonical(contract.request) !== canonical(expected)) fail("INVALID_CONTRACT", "预处理的业务请求或输出映射被更改");
  try {
    if (submission.output.workflowResponseCode !== 200 && submission.output.workflowResponseCode !== "200") throw new Error();
    projectedTransition(submission.output);
  } catch {
    fail("OUTCOME_UNKNOWN", "预处理响应缺少已核验下一步结构；保留结果，不重发");
  }
  return submission;
}

/** Only trusted host code loads this from OperationStore; never from tool args. */
export function trustedPreprocessingFromOperation(
  operation: TicketOperation,
  currentContext: TicketContext,
  targetId: string,
): FieldJobPreprocessingReceipt {
  const plan = operation.plan;
  if (!currentContext.identityVerified || plan.contextKey !== currentContext.key || plan.targetId !== targetId ||
    operation.state !== "verified" || plan.action !== "workflow_preprocess" ||
    !plan.contractVersion.startsWith(`${VERSION}:workflow_preprocess:`) || !operation.submission)
    fail("UNVERIFIED", "不是当前身份/目标下已验证的预处理操作");
  const { fingerprint, ...unsigned } = plan;
  if (fingerprint !== `sha256:${digest(unsigned)}`) fail("INVALID_PLAN", "预处理操作计划内容已变化");
  const payload = object(object(plan.payload).data), taskId = id(plan.probeOutput?.workflowTaskId)!;
  if (payload.action !== "agree" || payload.entityApiKey !== "fieldJob" || id(payload.dataId) !== targetId ||
    id(payload.usertaskLogId) !== taskId || Object.keys(payload).sort().join(",") !== "action,dataId,entityApiKey,usertaskLogId")
    fail("INVALID_PLAN", "预处理操作没有绑定当前父记录和明确任务");
  const recordSnapshot = object(plan.input.workflowRecord);
  if (!Object.keys(recordSnapshot).length || id(recordSnapshot.id) !== targetId) fail("INVALID_PLAN", "预处理缺少明确父记录快照");
  if (operation.submission.output.workflowResponseCode !== 200 && operation.submission.output.workflowResponseCode !== "200")
    fail("UNVERIFIED", "预处理操作没有成功业务响应");
  return { operationId: plan.operationId, contextKey: plan.contextKey, targetId, taskId,
    expiresAt: plan.expiresAt, recordSnapshot, transition: projectedTransition(operation.submission.output) };
}
