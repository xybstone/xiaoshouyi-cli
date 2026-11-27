import { buildListQuery, escapeSql } from "../utils/index.js";
import {
  fail, idSchema, object, parseInput,
  type ActionContract, type Evidence, type InputField, type RecordData, type RequestSpec,
} from "./types.js";

/** These are distinct CRM resources. Neither resource proves customer delivery. */
export const FIELDJOB_HISTORY = {
  activity: {
    apiKey: "activityrecord", objectField: "activityRecordFrom", parentField: "activityRecordFrom_data",
    actorField: "ownerId", timeField: "createdAt",
    fields: ["id", "activityRecordFrom", "activityRecordFrom_data", "ownerId", "createdAt", "entityType", "startTime"],
  },
  reports: {
    apiKey: "serviceReport", objectField: "relateEntity", parentField: "relateEntity_data",
    actorField: "createdBy", timeField: "createdAt",
    fields: ["id", "relateEntity", "relateEntity_data", "createdBy", "createdAt", "state", "isSignoff"],
  },
} as const;
export type FieldJobHistoryKind = keyof typeof FIELDJOB_HISTORY;
export interface FieldJobHistorySelection {
  targetId: string;
  parentObjectId: string;
  page?: number;
  size?: number;
  includeContent?: boolean;
}
function scalarId(value: unknown, label: string): string {
  const raw = value !== null && typeof value === "object" ? object(value).id : value;
  if (typeof raw === "number" && !Number.isSafeInteger(raw))
    fail("INVALID_RESPONSE", `${label} 数值不安全`);
  if (!idSchema.safeParse(String(raw)).success) fail("INVALID_RESPONSE", `${label} 不是明确ID`);
  return String(raw);
}
function selection(raw: FieldJobHistorySelection) {
  const targetId = parseInput(idSchema, raw.targetId);
  const parentObjectId = parseInput(idSchema, raw.parentObjectId);
  const page = raw.page ?? 1, size = raw.size ?? 20;
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000 ||
      !Number.isSafeInteger(size) || size < 1 || size > 100)
    fail("VALIDATION_FAILED", "历史读取需明确有界分页，size为1至100");
  return { targetId, parentObjectId, page, size, includeContent: raw.includeContent === true };
}
function responseBody(raw: unknown): unknown {
  const envelope = object(raw);
  if (envelope.code !== 200 && envelope.code !== "200")
    fail("INVALID_RESPONSE", "历史读取未返回已核验业务成功码");
  if (Object.hasOwn(envelope, "result")) return envelope.result;
  if (Object.hasOwn(envelope, "data")) return envelope.data;
  fail("INVALID_RESPONSE", "历史读取响应缺少data/result");
}
export function fieldJobHistoryReadRequest(kind: FieldJobHistoryKind, raw: FieldJobHistorySelection): RequestSpec {
  const s = selection(raw), spec = FIELDJOB_HISTORY[kind];
  if (!spec) fail("UNSUPPORTED", "未登记的工单历史来源");
  const fields = [...spec.fields, ...(kind === "activity" && s.includeContent ? ["content"] : [])];
  return {
    host: "api", method: "GET", path: "/rest/data/v2/query", encoding: "json",
    payload: { q: buildListQuery(spec.apiKey, fields, {
      where: `${spec.parentField} = '${escapeSql(s.targetId)}' and ${spec.objectField} = '${escapeSql(s.parentObjectId)}'`,
      order: "id desc", offset: (s.page - 1) * s.size, size: s.size,
    }) },
    successPath: "code", successValues: [200, "200"],
  };
}
export function decodeFieldJobHistoryPage(kind: FieldJobHistoryKind, raw: unknown, requested: FieldJobHistorySelection) {
  const s = selection(requested), spec = FIELDJOB_HISTORY[kind];
  if (!spec) fail("UNSUPPORTED", "未登记的工单历史来源");
  const body = object(responseBody(raw));
  if (!Array.isArray(body.records) || !Number.isSafeInteger(body.totalSize) || Number(body.totalSize) < 0 ||
      body.records.length > s.size || body.records.length > Number(body.totalSize) ||
      body.count !== body.records.length)
    fail("INVALID_RESPONSE", "历史读取分页计数不一致或超过限制");
  const seen = new Set<string>();
  const records = body.records.map((rawRecord: unknown) => {
    const row = object(rawRecord);
    const id = scalarId(row.id, "历史记录ID");
    if (seen.has(id)) fail("INVALID_RESPONSE", "历史读取返回重复记录");
    seen.add(id);
    if (scalarId(row[spec.parentField], "父工单ID") !== s.targetId ||
        scalarId(row[spec.objectField], "父对象类型ID") !== s.parentObjectId)
      fail("INVALID_RESPONSE", "历史记录父对象类型或父工单不匹配");
    const actorId = row[spec.actorField] === undefined || row[spec.actorField] === null
      ? null : scalarId(row[spec.actorField], "参与人ID");
    const time = row[spec.timeField];
    if (time !== undefined && time !== null &&
        (typeof time !== "number" || !Number.isSafeInteger(time) || time < 0 || time > 8640000000000000))
      fail("INVALID_RESPONSE", "历史创建时间不符合已登记unix-ms编码");
    const allowed = [...spec.fields, ...(kind === "activity" && s.includeContent ? ["content"] : [])];
    return {
      id, source: spec.apiKey, parentId: s.targetId, parentObjectId: s.parentObjectId,
      actorId, actorMeaning: kind === "activity" ? "publisher" : "creator",
      occurredAt: typeof time === "number" ? new Date(time).toISOString() : null,
      visibility: "unverified", stateTransition: "unverified",
      record: Object.fromEntries(allowed.map((field) => [field, row[field] ?? null])),
    };
  });
  return {
    records, totalSize: Number(body.totalSize), count: records.length, page: s.page, size: s.size,
    nextPage: s.page * s.size < Number(body.totalSize) ? s.page + 1 : null,
    parentEvidence: records.length ? "returned_fields_verified" : "no_rows",
    historyCoverage: "partial", coverageScope: spec.apiKey, consistency: "best_effort",
    note: "仅覆盖此来源；空结果不代表没有其他历史，活动记录不等同于客户回复，状态前后值尚未核验",
  };
}

/** Observed in the public service-report component; this GET does not generate or send a report. */
export function fieldJobLatestReportReadRequest(targetId: string): RequestSpec {
  return {
    host: "api", method: "GET", path: "/rest/data/v2.0/xobjects/serviceReport/actions/getLatestSR",
    encoding: "json", payload: { dataId: parseInput(idSchema, targetId) },
    successPath: "code", successValues: [200, "200"],
  };
}
export function decodeFieldJobLatestReport(raw: unknown, requested: Pick<FieldJobHistorySelection, "targetId" | "parentObjectId">) {
  const s = selection(requested), body = responseBody(raw);
  if (body === null) return { record: null, source: "serviceReport", parentEvidence: "no_rows", historyCoverage: "partial" };
  const row = object(body);
  if (!Object.keys(row).length) fail("INVALID_RESPONSE", "最新服务报告返回未知格式");
  // A positive response is accepted only when its returned polymorphic linkage can be checked.
  const page = decodeFieldJobHistoryPage("reports", { code: 200, result: { records: [row], count: 1, totalSize: 1 } }, s);
  return { record: page.records[0], source: "serviceReport", parentEvidence: page.parentEvidence, historyCoverage: "partial" };
}

/** Public NeoBpm flowHistory reads this endpoint; it is not the userTaskLog mutation route. */
export function fieldJobWorkflowHistoryReadRequest(targetId: string): RequestSpec {
  const parsed = parseInput(idSchema, targetId), dataId = Number(parsed);
  if (!Number.isSafeInteger(dataId) || String(dataId) !== parsed)
    fail("VALIDATION_FAILED", "流程历史工单ID不能无损编码为已核验数值格式");
  return {
    host: "api", method: "POST", path: "/rest/data/v2.0/creekflow/approval/flowInstance/taskHistory/fieldJob",
    encoding: "json", payload: { data: { xObjectApiKey: "fieldJob", dataId, srcProcInstId: -1 } },
    headers: { "biz-xsy-data-lang": "true" }, successPath: "code", successValues: [200, "200"],
  };
}
export function decodeFieldJobWorkflowHistory(raw: unknown, targetId: string, includeOpinions = false) {
  parseInput(idSchema, targetId);
  const processes = responseBody(raw);
  if (!Array.isArray(processes) || processes.length > 100)
    fail("INVALID_RESPONSE", "流程历史未返回有界流程实例数组");
  const events: Array<RecordData> = [];
  const processIds = new Set<string>(), logIds = new Set<string>();
  let taskCount = 0, logCount = 0, placeholderCount = 0;
  let returnedParents = 0;
  for (const value of processes) {
    const process = object(value), processId = scalarId(process.id, "流程实例ID");
    if (processIds.has(processId)) fail("INVALID_RESPONSE", "流程历史返回重复流程实例");
    processIds.add(processId);
    if (process.entityApikey !== "fieldJob" || !Array.isArray(process.userTaskInstances))
      fail("INVALID_RESPONSE", "流程历史父对象或任务实例数组格式不符");
    if (process.dataId !== undefined && process.dataId !== null) {
      if (scalarId(process.dataId, "流程父工单ID") !== targetId)
        fail("INVALID_RESPONSE", "流程历史返回其他工单");
      returnedParents++;
    }
    taskCount += process.userTaskInstances.length;
    if (taskCount > 500) fail("INVALID_RESPONSE", "流程历史任务实例超过本次受控读取上限");
    for (const rawTask of process.userTaskInstances) {
      const task = object(rawTask);
      if (!Array.isArray(task.usertaskLogs)) fail("INVALID_RESPONSE", "流程历史日志数组格式不符");
      if (task.procInstId !== undefined && task.procInstId !== null &&
          scalarId(task.procInstId, "任务所属流程ID") !== processId)
        fail("INVALID_RESPONSE", "历史任务所属流程不匹配");
      logCount += task.usertaskLogs.length;
      if (logCount > 500) fail("INVALID_RESPONSE", "流程历史日志超过本次受控读取上限");
      for (const rawLog of task.usertaskLogs) {
        const log = object(rawLog), assignee = object(log.assignee);
        if (!Object.keys(log).length) fail("INVALID_RESPONSE", "流程日志记录为空或格式不符");
        // The live UI response includes a future-node placeholder, not a completed audit event.
        if (task.status === 101 && log.statusExt === 109 && log.id === null &&
            log.procInstId === null && log.assignee === null && log.endAt === null &&
            log.operateType === null && log.operateApiKey === null && log.operateLabel === "") {
          placeholderCount++;
          continue;
        }
        const id = scalarId(log.id, "流程日志ID");
        if (logIds.has(id)) fail("INVALID_RESPONSE", "流程历史返回重复日志");
        logIds.add(id);
        if (scalarId(log.procInstId, "日志所属流程ID") !== processId)
          fail("INVALID_RESPONSE", "历史日志所属流程不匹配");
        const actor = assignee.uid ?? assignee.id;
        const actorId = actor === undefined || actor === null ? null : scalarId(actor, "流程参与人ID");
        const time = log.endAt;
        if (typeof time !== "number" || !Number.isSafeInteger(time) || time < 0 || time > 8640000000000000)
          fail("INVALID_RESPONSE", "流程日志时间不符合已登记unix-ms编码");
        if (log.opinion !== undefined && log.opinion !== null && typeof log.opinion !== "string")
          fail("INVALID_RESPONSE", "流程意见不是明确文本");
        if (log.operateApiKey !== undefined && log.operateApiKey !== null &&
            (typeof log.operateApiKey !== "string" || log.operateApiKey.length > 300))
          fail("INVALID_RESPONSE", "流程动作标识格式不符");
        if (log.operateLabel !== undefined && log.operateLabel !== null &&
            (typeof log.operateLabel !== "string" || log.operateLabel.length > 300))
          fail("INVALID_RESPONSE", "流程动作名称格式不符");
        if (log.operateType !== undefined && log.operateType !== null && !Number.isSafeInteger(log.operateType))
          fail("INVALID_RESPONSE", "流程动作类型格式不符");
        events.push({
          id,
          source: "creekflow_task_history", parentId: targetId, parentEvidence: "request_bound",
          actorId, occurredAt: new Date(time).toISOString(),
          actionApiKey: log.operateApiKey ?? null, actionLabel: log.operateLabel ?? null,
          workflowOperationType: log.operateType ?? null,
          workflowActionStatus: typeof log.statusExt === "number" ? log.statusExt : null,
          workflowTaskStatus: typeof task.status === "number" ? task.status : null,
          visibility: "unverified", businessStateTransition: "unverified",
          ...(includeOpinions ? { opinion: log.opinion ?? null } : {}),
        });
      }
    }
  }
  const parentEvidence = processes.length > 0 && returnedParents === processes.length
    ? "returned_fields_verified" : "request_bound";
  for (const event of events) event.parentEvidence = parentEvidence;
  return { records: events, processCount: processes.length, taskCount, placeholderCount, count: events.length,
    historyCoverage: "partial", coverageScope: "workflow_tasks", parentEvidence,
    note: "父目标绑定于已核验读取请求；返回体未证明主表状态前后值，流程意见不等于独立处理记录或客户回复" };
}

const ACTIVITY_FIELDS = ["content", "dimDepart", "entityType", "startTime", "ownerId", "activityRecordFrom", "activityRecordFrom_data"] as const;
const ACTIVITY_TYPES: Record<(typeof ACTIVITY_FIELDS)[number], readonly string[]> = {
  content: ["textarea", "text"], dimDepart: ["dimension"], entityType: ["entitytype"], startTime: ["datetime"],
  ownerId: ["owner"], activityRecordFrom: ["reference"], activityRecordFrom_data: ["reference"],
};
export function inspectActivityRecordMetadata(raw: unknown) {
  const metadata = object(responseBody(raw));
  if (metadata.apiKey !== "activityrecord" || !Array.isArray(metadata.fields))
    fail("INVALID_METADATA", "活动记录元数据格式不符");
  if (metadata.createable !== true) fail("UNVERIFIED", "活动记录对象未明确允许创建");
  const fields = new Map<string, RecordData>();
  for (const value of metadata.fields) {
    const field = object(value), key = field.apiKey;
    if (typeof key !== "string" || fields.has(key)) fail("INVALID_METADATA", "活动记录字段缺失或重复");
    fields.set(key, field);
    if (field.required === true && field.createable === true && !ACTIVITY_FIELDS.includes(key as typeof ACTIVITY_FIELDS[number]))
      fail("UNVERIFIED", "存在尚未登记的可创建必填活动记录字段");
  }
  for (const key of ACTIVITY_FIELDS) {
    const f = fields.get(key);
    if (!f || f.enabled === false || f.createable !== true || !ACTIVITY_TYPES[key].includes(String(f.type)))
      fail("UNVERIFIED", `活动记录字段类型或可写性尚未满足: ${key}`);
  }
  if (object(fields.get("activityRecordFrom")?.referTo).apiKey !== "xobject" ||
      object(fields.get("ownerId")?.referTo).apiKey !== "user" ||
      object(fields.get("dimDepart")?.referTo).apiKey !== "department")
    fail("INVALID_METADATA", "活动记录父类型、发布人或部门的引用对象不符");
  const content = fields.get("content")!;
  if (content.minLength !== undefined && content.minLength !== null &&
      (!Number.isSafeInteger(content.minLength) || Number(content.minLength) < 0))
    fail("INVALID_METADATA", "活动记录正文最小长度约束不可靠");
  if (content.maxLength !== undefined && content.maxLength !== null &&
      (!Number.isSafeInteger(content.maxLength) || Number(content.maxLength) < 1))
    fail("INVALID_METADATA", "活动记录正文长度约束不可靠");
  const inputFields: Record<string, InputField> = {
    content: { type: "string", required: true, min: Math.max(1, Number(content.minLength) || 0), max: Number(content.maxLength) || 131070 },
    dimDepart: { type: "string", required: true, min: 1, max: 32 },
    entityType: { type: "string", required: true, min: 1, max: 32 },
    startTime: { type: "number", required: true, min: 0, max: 8640000000000000 },
  };
  return { fields: inputFields, required: Object.keys(inputFields), readonlyRequired: metadata.fields
    .map(object).filter((f) => f.required === true && f.createable !== true).map((f) => String(f.apiKey)),
    flags: { createable: metadata.createable, disabled: metadata.disabled },
    visibility: "unverified", permission: "unknown", allowed: "unknown" };
}
export function activeActivityRecordTypes(raw: unknown): string[] {
  const envelope = object(raw);
  const data = Object.hasOwn(envelope, "code") ? responseBody(raw) : raw;
  const body = object(data), rows = Array.isArray(data) ? data : body.records;
  if (!Array.isArray(rows) || rows.length > 100 ||
      (body.totalSize !== undefined && body.totalSize !== rows.length) ||
      (body.count !== undefined && body.count !== rows.length))
    fail("INVALID_RESPONSE", "活动记录业务类型列表不完整");
  const ids = rows.map(object).filter((r) => r.active === true || r.isActive === true).map((r) => scalarId(r.id, "业务类型ID"));
  if (new Set(ids).size !== ids.length) fail("INVALID_RESPONSE", "活动记录活动业务类型包含重复ID");
  return ids;
}

export interface ActivityRecordContractOptions {
  parentObjectId: string;
  entityType: string;
  activeEntityTypes: string[];
  evidence: Evidence;
  version?: string;
  parentEntityTypes?: string[];
}
/** Caller explicitly chooses an active type. This factory never guesses a default or customer audience. */
export function fieldJobActivityRecordContract(options: ActivityRecordContractOptions): ActionContract {
  const parentObjectId = parseInput(idSchema, options.parentObjectId), entityType = parseInput(idSchema, options.entityType);
  const numericParentObjectId = Number(parentObjectId);
  if (!Number.isSafeInteger(numericParentObjectId) || String(numericParentObjectId) !== parentObjectId)
    fail("VALIDATION_FAILED", "父对象类型ID不能无损编码为已核验数值格式");
  if (!options.activeEntityTypes.includes(entityType)) fail("UNVERIFIED", "所选活动记录业务类型未在当前活动列表中明确出现");
  return {
    action: "activity_record", authorization: "server", verification: "verified", version: options.version ?? "fieldjob-activity-record-v1",
    evidence: options.evidence, entityTypes: options.parentEntityTypes,
    fieldMode: "action", fields: {
      content: { type: "string", required: true, min: 1, max: 131070 },
      dimDepart: { type: "string", required: true, min: 1, max: 32 },
      entityType: { type: "string", required: true, enum: [entityType] },
      startTime: { type: "number", required: true, min: 0, max: 8640000000000000 },
    }, required: ["content", "dimDepart", "entityType", "startTime"], defaults: { entityType },
    preconditionFields: ["status", "customItem62__c", "entityType", "ownerId"],
    effects: ["追加一条与此派工单关联的CRM活动记录", "发布人为当前已核验用户；共享范围遵循CRM配置，未核验私有或客户回复语义"],
    request: {
      host: "api", method: "POST", path: "/rest/data/v2.0/xobjects/activityrecord", encoding: "json",
      payload: { data: {
        content: { $ref: "input.content" }, dimDepart: { $ref: "input.dimDepart", $type: "integer" }, entityType: { $ref: "input.entityType", $type: "integer" },
        startTime: { $ref: "input.startTime" }, ownerId: { $ref: "context.subjectId", $type: "integer" },
        activityRecordFrom: numericParentObjectId, activityRecordFrom_data: { $ref: "target.id", $type: "integer" },
      } }, successPath: "code", successValues: [200, "200"], resultIdPath: "data.id",
    }, verify: {
      query: { apiKey: "activityrecord", fields: ["id", ...ACTIVITY_FIELDS], linkField: "id", bind: "result" },
      checks: [
        { field: "id", expected: { $ref: "result.id" } },
        { field: "content", expected: { $ref: "input.content" } },
        { field: "dimDepart", expected: { $ref: "input.dimDepart", $type: "integer" } },
        { field: "entityType", expected: { $ref: "input.entityType", $type: "integer" } },
        { field: "startTime", expected: { $ref: "input.startTime" } },
        { field: "ownerId", expected: { $ref: "context.subjectId", $type: "integer" } },
        { field: "activityRecordFrom", expected: numericParentObjectId },
        { field: "activityRecordFrom_data", expected: { $ref: "target.id", $type: "integer" } },
      ],
    },
  };
}
