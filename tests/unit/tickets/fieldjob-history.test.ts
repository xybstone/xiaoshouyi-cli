import { describe, expect, it } from "vitest";
import {
  activeActivityRecordTypes, decodeFieldJobHistoryPage, decodeFieldJobLatestReport,
  fieldJobActivityRecordContract, fieldJobHistoryReadRequest, fieldJobLatestReportReadRequest,
  inspectActivityRecordMetadata, fieldJobWorkflowHistoryReadRequest, decodeFieldJobWorkflowHistory,
} from "../../../src/tickets/fieldjob-history.js";
import { template } from "../../../src/tickets/contracts.js";

const requested = { targetId: "1", parentObjectId: "10", page: 1, size: 2 };
const time = 1795737600000;
function activity(overrides = {}) {
  return { id: 2, activityRecordFrom: 10, activityRecordFrom_data: 1, ownerId: 3, createdAt: time,
    entityType: 4, startTime: time, content: "synthetic internal CRM activity", extraSecret: "must-not-appear", ...overrides };
}
const page = (records: unknown[], overrides = {}) => ({ code: 200, result: { records, count: records.length, totalSize: records.length, ...overrides } });
function metadata() {
  const fields = [
    { apiKey: "content", type: "textarea", minLength: 0, maxLength: 131070, required: true },
    { apiKey: "dimDepart", type: "dimension", referTo: { apiKey: "department" }, required: true },
    { apiKey: "entityType", type: "entitytype", required: true },
    { apiKey: "startTime", type: "datetime", required: true },
    { apiKey: "ownerId", type: "owner", referTo: { apiKey: "user" } },
    { apiKey: "activityRecordFrom", type: "reference", referTo: { apiKey: "xobject" } },
    { apiKey: "activityRecordFrom_data", type: "reference" },
  ].map((f) => ({ enabled: true, createable: true, ...f }));
  return { code: 200, data: { apiKey: "activityrecord", createable: true, disabled: true,
    fields: [...fields, { apiKey: "createdAt", type: "datetime", required: true, enabled: true, createable: false }] } };
}
const evidence = { source: "synthetic" as const, reference: "offline metadata and DTO fixture; not live validation", verifiedAt: "2026-11-27T00:00:00+08:00" };
const options = { parentObjectId: "10", entityType: "4", activeEntityTypes: ["4", "5"], evidence };

describe("fieldJob polymorphic history read protocols", () => {
  it("binds both parent object type and record ID, with explicit bounded fields", () => {
    const request = fieldJobHistoryReadRequest("activity", requested);
    expect(request).toMatchObject({ host: "api", method: "GET", path: "/rest/data/v2/query" });
    expect(request.payload).toEqual({ q: "select id,activityRecordFrom,activityRecordFrom_data,ownerId,createdAt,entityType,startTime from activityrecord where activityRecordFrom_data = '1' and activityRecordFrom = '10' order by id desc limit 0,2" });
    expect(String((request.payload as { q: string }).q)).not.toContain("content");
    expect((fieldJobHistoryReadRequest("activity", { ...requested, includeContent: true }).payload as { q: string }).q).toContain(",content from activityrecord");
  });
  it("report linkage uses its own polymorphic fields and never downloads file URLs", () => {
    const q = (fieldJobHistoryReadRequest("reports", requested).payload as { q: string }).q;
    expect(q).toContain("relateEntity_data = '1' and relateEntity = '10'");
    expect(q).not.toContain("fileLink");
    expect(q).not.toContain("formLink");
  });
  it.each([{ size: 101 }, { size: 0 }, { page: 0 }, { targetId: "1' or 1=1" }, { parentObjectId: "fieldJob" }])("rejects unbounded or unverified IDs %#", (overrides) => {
    expect(() => fieldJobHistoryReadRequest("activity", { ...requested, ...overrides })).toThrow();
  });
  it("verifies returned linkage and provides publisher/time without inferring audience or state changes", () => {
    const result = decodeFieldJobHistoryPage("activity", page([activity()]), requested);
    expect(result).toMatchObject({ count: 1, parentEvidence: "returned_fields_verified", historyCoverage: "partial", coverageScope: "activityrecord" });
    expect(result.records[0]).toMatchObject({ id: "2", parentId: "1", parentObjectId: "10", actorId: "3", actorMeaning: "publisher",
      occurredAt: new Date(time).toISOString(), visibility: "unverified", stateTransition: "unverified" });
    expect(JSON.stringify(result)).not.toContain("must-not-appear");
    expect(JSON.stringify(result)).not.toContain("synthetic internal CRM activity");
  });
  it("content is returned only after explicit selection", () => {
    const result = decodeFieldJobHistoryPage("activity", page([activity()]), { ...requested, includeContent: true });
    expect(result.records[0].record.content).toBe("synthetic internal CRM activity");
  });
  it.each([
    { activityRecordFrom: 99 }, { activityRecordFrom_data: 99 }, { activityRecordFrom_data: undefined },
    { id: Number.MAX_SAFE_INTEGER + 1 }, { createdAt: "2026-11-27" },
  ])("rejects foreign parents, unsafe IDs and guessed timestamp formats %#", (overrides) => {
    expect(() => decodeFieldJobHistoryPage("activity", page([activity(overrides)]), requested)).toThrow();
  });
  it("does not accept another object with the same numeric parent ID", () => {
    expect(() => decodeFieldJobHistoryPage("activity", page([activity({ activityRecordFrom: 11, activityRecordFrom_data: 1 })]), requested))
      .toThrow(/父对象类型/);
  });
  it.each([
    { count: 3 }, { count: undefined }, { totalSize: 0 }, { totalSize: "1" }, { totalSize: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects conflicting or unreliable counts %#", (overrides) => {
    expect(() => decodeFieldJobHistoryPage("activity", page([activity()], overrides), requested)).toThrow();
  });
  it("rejects duplicate rows and server ignoring the requested limit", () => {
    expect(() => decodeFieldJobHistoryPage("activity", page([activity(), activity()]), requested)).toThrow();
    expect(() => decodeFieldJobHistoryPage("activity", page([activity(), activity({ id: 3 }), activity({ id: 4 })]), requested)).toThrow();
  });
  it("empty results do not claim a positive link or complete CRM history", () => {
    expect(decodeFieldJobHistoryPage("activity", page([]), requested)).toMatchObject({ count: 0, parentEvidence: "no_rows", historyCoverage: "partial" });
  });
  it("preserves bounded paging and marks missing actor/time as unknown", () => {
    const result = decodeFieldJobHistoryPage("activity", page([activity({ ownerId: null, createdAt: null })], { totalSize: 3 }), requested);
    expect(result.nextPage).toBe(2);
    expect(result.records[0]).toMatchObject({ actorId: null, occurredAt: null });
  });
  it("latest report is a read-only endpoint; null is a known empty response", () => {
    expect(fieldJobLatestReportReadRequest("1")).toMatchObject({ method: "GET", path: "/rest/data/v2.0/xobjects/serviceReport/actions/getLatestSR", payload: { dataId: "1" } });
    expect(decodeFieldJobLatestReport({ code: "200", data: null }, requested)).toMatchObject({ record: null, parentEvidence: "no_rows", historyCoverage: "partial" });
  });
  it("positive latest reports need returned linkage; template/files alone cannot prove the parent", () => {
    expect(() => decodeFieldJobLatestReport({ code: 200, data: { id: 2, fileLink: "https://private.example/secret" } }, requested)).toThrow();
    const result = decodeFieldJobLatestReport({ code: 200, data: { id: 2, relateEntity: 10, relateEntity_data: 1, createdBy: 3, createdAt: time, state: 1, fileLink: "https://private.example/secret" } }, requested);
    expect(result.record).toMatchObject({ actorId: "3", actorMeaning: "creator" });
    expect(JSON.stringify(result)).not.toContain("https://private");
  });
});

describe("workflow audit read protocol", () => {
  const log = (overrides = {}) => ({ id: 2, procInstId: 20, assignee: { uid: 3, name: "synthetic user" }, endAt: time,
    opinion: "synthetic private workflow opinion", statusExt: 6, operateApiKey: null,
    operateLabel: "synthetic completed action", operateType: 2, extraPrivate: "redact", ...overrides });
  const workflow = (logs = [log()], processOverrides = {}, taskOverrides = {}) => ({ code: 200, data: [
    { id: 20, entityApikey: "fieldJob", dataId: null, userTaskInstances: [
      { id: 30, procInstId: 20, status: 2, usertaskLogs: logs, ...taskOverrides },
    ], ...processOverrides },
  ] });
  it("constructs the public history request without a mutation action or caller-selected process instance", () => {
    const request = fieldJobWorkflowHistoryReadRequest("1");
    expect(request).toMatchObject({ method: "POST", path: "/rest/data/v2.0/creekflow/approval/flowInstance/taskHistory/fieldJob",
      payload: { data: { xObjectApiKey: "fieldJob", dataId: 1, srcProcInstId: -1 } }, headers: { "biz-xsy-data-lang": "true" } });
    expect(JSON.stringify(request.payload)).not.toContain("action");
  });
  it("rejects workflow request IDs that cannot use the verified integer wire encoding losslessly", () => {
    expect(() => fieldJobWorkflowHistoryReadRequest("9007199254740993")).toThrow(/无损/);
    expect(() => fieldJobWorkflowHistoryReadRequest("01")).toThrow();
  });
  it("keeps empty workflow history partial and request-bound", () => {
    expect(decodeFieldJobWorkflowHistory({ code: "200", data: [] }, "1"))
      .toMatchObject({ records: [], processCount: 0, taskCount: 0, count: 0, parentEvidence: "request_bound", historyCoverage: "partial" });
  });
  it("projects participant, time and operation codes without treating them as business before/after status", () => {
    const response = workflow();
    const result = decodeFieldJobWorkflowHistory(response, "1");
    expect(result.records[0]).toMatchObject({ id: "2", actorId: "3", occurredAt: new Date(time).toISOString(), actionApiKey: null,
      actionLabel: "synthetic completed action", workflowOperationType: 2,
      workflowActionStatus: 6, workflowTaskStatus: 2, businessStateTransition: "unverified", visibility: "unverified" });
    expect(result).toMatchObject({ processCount: 1, taskCount: 1, placeholderCount: 0, count: 1 });
    expect(JSON.stringify(result)).not.toContain("synthetic user");
    expect(JSON.stringify(result)).not.toContain("workflow opinion");
    expect(JSON.stringify(result)).not.toContain("redact");
    expect(decodeFieldJobWorkflowHistory(response, "1", true).records[0].opinion).toBe("synthetic private workflow opinion");
  });
  it("accepts returned API keys when present without guessing from action labels", () => {
    expect(decodeFieldJobWorkflowHistory(workflow([log({ operateApiKey: "synthetic.agree" })]), "1").records[0].actionApiKey)
      .toBe("synthetic.agree");
  });
  it("filters the exact future-node placeholder returned alongside real logs", () => {
    const response = workflow();
    response.data[0].userTaskInstances.push({ id: null as unknown as number, procInstId: null as unknown as number,
      status: 101, usertaskLogs: [log({ id: null, procInstId: null, assignee: null, endAt: null, statusExt: 109,
        operateType: null, operateApiKey: null, operateLabel: "" })] });
    expect(decodeFieldJobWorkflowHistory(response, "1"))
      .toMatchObject({ count: 1, taskCount: 2, placeholderCount: 1 });
  });
  it("does not turn an unfamiliar missing-event shape into a placeholder or audit event", () => {
    expect(() => decodeFieldJobWorkflowHistory(workflow([log({ id: null, endAt: null })]), "1")).toThrow();
  });
  it("checks any returned parent ID and only upgrades evidence when every process repeats it", () => {
    const result = decodeFieldJobWorkflowHistory(workflow([log()], { dataId: 1 }), "1");
    expect(result.parentEvidence).toBe("returned_fields_verified");
    expect(result.records[0].parentEvidence).toBe("returned_fields_verified");
    expect(() => decodeFieldJobWorkflowHistory(workflow([log()], { dataId: 99 }), "1")).toThrow(/其他工单/);
    expect(() => decodeFieldJobWorkflowHistory(workflow([log()], { entityApikey: "serviceCase" }), "1")).toThrow();
  });
  it("keeps absent participants unknown and never substitutes submitter or process owner", () => {
    expect(decodeFieldJobWorkflowHistory(workflow([log({ assignee: null })]), "1").records[0].actorId).toBeNull();
  });
  it("checks nested process linkage and duplicate log identities", () => {
    expect(() => decodeFieldJobWorkflowHistory(workflow([log({ procInstId: 21 })]), "1")).toThrow(/不匹配/);
    expect(() => decodeFieldJobWorkflowHistory(workflow([log()], {}, { procInstId: 21 }), "1")).toThrow(/不匹配/);
    expect(() => decodeFieldJobWorkflowHistory(workflow([log(), log()]), "1")).toThrow(/重复日志/);
    const response = workflow(); response.data.push(response.data[0]);
    expect(() => decodeFieldJobWorkflowHistory(response, "1")).toThrow(/重复流程实例/);
  });
  it.each([
    { code: 200, data: {} },
    { code: 0, data: [] },
    workflow([log()], { userTaskInstances: {} }),
    workflow([log()], {}, { usertaskLogs: {} }),
    workflow([log({ assignee: { uid: Number.MAX_SAFE_INTEGER + 1 } })]),
    workflow([log({ endAt: "2026-11-27" })]),
    workflow([log({ opinion: { body: "unverified" } })]),
    workflow([log({ operateApiKey: {} })]),
    workflow([log({ operateLabel: {} })]),
    workflow([log({ operateType: "2" })]),
  ])("rejects unknown envelopes, identity loss or guessed field shapes %#", (response) => {
    expect(() => decodeFieldJobWorkflowHistory(response, "1")).toThrow();
  });
  it("rejects oversized task/log arrays instead of silently truncating audit history", () => {
    expect(() => decodeFieldJobWorkflowHistory({ code: 200, data: Array.from({ length: 101 }, () => ({})) }, "1")).toThrow();
    expect(() => decodeFieldJobWorkflowHistory(workflow(Array.from({ length: 501 }, () => log())), "1")).toThrow();
    expect(() => decodeFieldJobWorkflowHistory(workflow([], { userTaskInstances: Array.from({ length: 501 }, () => ({})) }), "1")).toThrow();
  });
});

describe("CRM activity-record creation contract construction", () => {
  it("checks writable required fields and leaves read-only createdAt to the server", () => {
    expect(inspectActivityRecordMetadata(metadata())).toMatchObject({ required: ["content", "dimDepart", "entityType", "startTime"], readonlyRequired: ["createdAt"], permission: "unknown", allowed: "unknown", visibility: "unverified" });
    expect(inspectActivityRecordMetadata(metadata()).fields.content).toMatchObject({ type: "string", min: 1, max: 131070 });
  });
  it("new mandatory writable fields block the known DTO until their contract is verified", () => {
    const raw = metadata(); raw.data.fields.push({ apiKey: "unexpectedRequired", type: "text", required: true, createable: true, enabled: true });
    expect(() => inspectActivityRecordMetadata(raw)).toThrow(/必填/);
  });
  it.each(["content", "dimDepart", "entityType", "startTime", "ownerId", "activityRecordFrom", "activityRecordFrom_data"])("rejects missing or readonly field %s", (key) => {
    const raw = metadata(); raw.data.fields = raw.data.fields.filter((f) => f.apiKey !== key);
    expect(() => inspectActivityRecordMetadata(raw)).toThrow();
  });
  it("does not accept a different parent/owner/reference semantic", () => {
    const raw = metadata(); const parent = raw.data.fields.find((f) => f.apiKey === "activityRecordFrom")!;
    Object.assign(parent, { referTo: { apiKey: "account" } });
    expect(() => inspectActivityRecordMetadata(raw)).toThrow(/引用对象/);
  });
  it("requires explicit active business type and never picks the first option", () => {
    expect(activeActivityRecordTypes({ totalSize: 2, count: 2, records: [{ id: 4, active: true }, { id: 5, active: false }] })).toEqual(["4"]);
    expect(() => fieldJobActivityRecordContract({ ...options, entityType: "8" })).toThrow(/业务类型/);
    expect(fieldJobActivityRecordContract({ ...options, entityType: "5" }).defaults.entityType).toBe("5");
    expect(() => activeActivityRecordTypes({ totalSize: 3, count: 2, records: [{ id: 4, active: true }, { id: 5, active: true }] })).toThrow(/不完整/);
  });
  it("pins owner to verified context and both parent fields to the target; no customer messaging fields", () => {
    const c = fieldJobActivityRecordContract(options);
    const payload = template(c.request!.payload, { input: { content: "synthetic", dimDepart: "6", entityType: "4", startTime: time }, target: { id: "1" }, context: { subjectId: "3" } });
    expect(c).toMatchObject({ action: "activity_record", authorization: "server", fieldMode: "action", required: ["content", "dimDepart", "entityType", "startTime"] });
    expect(c.request).toMatchObject({ host: "api", method: "POST", path: "/rest/data/v2.0/xobjects/activityrecord", resultIdPath: "data.id" });
    expect(payload).toEqual({ data: { content: "synthetic", dimDepart: 6, entityType: 4, startTime: time, ownerId: 3, activityRecordFrom: 10, activityRecordFrom_data: 1 } });
    expect(c.fields).not.toHaveProperty("ownerId");
    expect(c.fields).not.toHaveProperty("visibility");
    expect(c.verify!.checks.map((check) => check.field)).toEqual(expect.arrayContaining(["id", "content", "ownerId", "activityRecordFrom", "activityRecordFrom_data"]));
    expect(c.verify!.query).toMatchObject({ apiKey: "activityrecord", linkField: "id", bind: "result" });
  });
});
