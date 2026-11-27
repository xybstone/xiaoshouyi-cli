import { fail, idSchema, object, parseInput, type ActionContract, type Evidence, type RecordData, type RequestSpec } from "./types.js";

export interface ServiceReportContext {
  targetId: string;
  parentObjectId: string;
  parentEntityType: string;
}
export interface ServiceReportTemplateChoice { id?: string; name?: string }
interface Template {
  id: string;
  name: string;
  signatureSwitch: unknown;
  pushConfiguration: unknown;
  advancedCodePresent: boolean;
}
const ROOT = "/rest/data/v2.0/xobjects/serviceReport";
function id(value: unknown, label: string): string {
  const raw = value !== null && typeof value === "object" ? object(value).id : value;
  if (typeof raw === "number" && !Number.isSafeInteger(raw)) fail("INVALID_RESPONSE", `${label}数值不安全`);
  if (!idSchema.safeParse(String(raw)).success) fail("INVALID_RESPONSE", `${label}不是明确ID`);
  return String(raw);
}
function numberId(value: string): number {
  const key = parseInput(idSchema, value), n = Number(key);
  if (!Number.isSafeInteger(n) || String(n) !== key) fail("VALIDATION_FAILED", "报告关联ID不能无损编码为安全整数");
  return n;
}
function context(raw: ServiceReportContext) {
  return {
    targetId: parseInput(idSchema, raw.targetId), parentObjectId: parseInput(idSchema, raw.parentObjectId),
    parentEntityType: parseInput(idSchema, raw.parentEntityType),
  };
}
function body(raw: unknown, accepted: Array<number | string>): unknown {
  const e = object(raw);
  if (!accepted.some((code) => e.code === code)) fail("INVALID_RESPONSE", "服务报告读取未返回该接口的已核验成功码");
  if (e.errorInfo !== undefined && e.errorInfo !== null &&
      !(Array.isArray(e.errorInfo) && e.errorInfo.length === 0) &&
      !(typeof e.errorInfo === "object" && Object.keys(object(e.errorInfo)).length === 0))
    fail("INVALID_RESPONSE", "服务报告读取同时包含错误信息");
  if (Object.hasOwn(e, "data")) return e.data;
  if (Object.hasOwn(e, "result")) return e.result;
  fail("INVALID_RESPONSE", "服务报告读取响应缺少data/result");
}
function read(action: string, payload: RecordData, accepted: Array<number | string>): RequestSpec {
  return { host: "api", method: "POST", path: `${ROOT}/actions/${action}`, encoding: "json", payload,
    successPath: "code", successValues: accepted };
}
export function serviceReportTemplateListReadRequest(raw: ServiceReportContext): RequestSpec {
  const c = context(raw);
  return read("listByData", { dataId: numberId(c.targetId), objectId: numberId(c.parentObjectId), busiTypeId: numberId(c.parentEntityType) }, [0, "0"]);
}
export function serviceReportFormsReadRequest(raw: ServiceReportContext, templateId: string): RequestSpec {
  const c = context(raw);
  return read("forms", { dataId: numberId(c.targetId), objectId: numberId(c.parentObjectId), templateId: numberId(templateId) }, [200, "200"]);
}
export function serviceReportRulesReadRequest(raw: ServiceReportContext, templateId: string): RequestSpec {
  const c = context(raw);
  return read("getParsedRules", { dataId: numberId(c.targetId), objectId: numberId(c.parentObjectId), templateId: numberId(templateId), entityType: numberId(c.parentEntityType) }, [200, "200"]);
}
export function serviceReportRecordReadRequest(reportId: string): RequestSpec {
  return { host: "api", method: "GET", path: `${ROOT}/${parseInput(idSchema, reportId)}`, encoding: "json",
    successPath: "code", successValues: [200, "200"] };
}
function templates(raw: unknown): Template[] {
  const d = object(body(raw, [0, "0"]));
  if (!Array.isArray(d.records) || d.records.length > 100 ||
      d.count !== d.records.length || d.totalSize !== d.records.length)
    fail("INVALID_RESPONSE", "可用服务报告模板未完整返回");
  const seen = new Set<string>();
  return d.records.map(object).filter((r) => r.status === 1 || r.status === "1").map((r) => {
    const key = id(r.id, "模板ID");
    if (seen.has(key)) fail("INVALID_RESPONSE", "服务报告模板ID重复");
    seen.add(key);
    if (typeof r.name !== "string" || !r.name || r.name.length > 500)
      fail("INVALID_RESPONSE", "服务报告模板名称不可靠");
    return { id: key, name: r.name, signatureSwitch: r.signatureSwitch,
      pushConfiguration: r.onPushRules, advancedCodePresent: !!r.advancedCode || r.openAdvancedFormula === true };
  });
}
export function selectServiceReportTemplate(raw: unknown, choice: ServiceReportTemplateChoice = {}) {
  if (choice.id !== undefined && choice.name !== undefined) fail("VALIDATION_FAILED", "模板需明确按ID或名称选择一种方式");
  if (choice.id) parseInput(idSchema, choice.id);
  const available = templates(raw);
  const selected = choice.id ? available.filter((t) => t.id === choice.id)
    : choice.name !== undefined ? available.filter((t) => t.name === choice.name) : available;
  if (selected.length !== 1)
    return { status: "blocked" as const, code: selected.length ? "AMBIGUOUS_TEMPLATE" : "NO_AVAILABLE_TEMPLATE",
      availableCount: available.length, candidates: available.map(({ id, name }) => ({ id, name })) };
  return { status: "selected" as const, template: selected[0], availableCount: available.length };
}
function emptyConfiguration(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (typeof value === "string") {
    if (value.length > 65536) fail("INVALID_RESPONSE", "模板推送配置超出受控上限");
    try { return emptyConfiguration(JSON.parse(value)); } catch { return false; }
  }
  return Array.isArray(value) && value.length === 0;
}
export interface ServiceReportPreflightInput {
  context: ServiceReportContext;
  templateList: unknown;
  choice?: ServiceReportTemplateChoice;
  forms: unknown;
  parsedRules: unknown;
}
export function inspectServiceReportPreflight(input: ServiceReportPreflightInput) {
  const c = context(input.context), selected = selectServiceReportTemplate(input.templateList, input.choice);
  if (selected.status !== "selected") return selected;
  const template = selected.template;
  const form = object(body(input.forms, [200, "200"]));
  const rules = body(input.parsedRules, [200, "200"]);
  if (!Array.isArray(form.formTemplate) || form.formTemplate.length > 100 || !Array.isArray(rules) || rules.length > 100)
    fail("INVALID_RESPONSE", "服务报告表单或发送规则形状尚未核验");
  const ruleCount = rules.length;
  const recipientCount = rules.reduce((sum, raw) => {
    const rule = object(raw);
    if (rule.receiver !== undefined && !Array.isArray(rule.receiver))
      fail("INVALID_RESPONSE", "服务报告收件规则无法安全解释");
    return sum + (Array.isArray(rule.receiver) ? rule.receiver.length : 0);
  }, 0);
  const common = { context: c, template: { id: template.id, name: template.name },
    formCount: form.formTemplate.length, ruleCount, recipientCount,
    delivery: "not_authorized" as const, signatureRequired: template.signatureSwitch !== 0 };
  if (template.signatureSwitch !== 0)
    return { ...common, status: "blocked" as const, code: "SERVICE_REPORT_SIGNATURE_UNVERIFIED", reason: "当前生成契约仅适用于明确无签字的模板" };
  if (template.advancedCodePresent)
    return { ...common, status: "blocked" as const, code: "SERVICE_REPORT_TEMPLATE_CODE_UNVERIFIED", reason: "模板启用了尚未核验的自定义执行逻辑" };
  if (form.formTemplate.length)
    return { ...common, status: "blocked" as const, code: "SERVICE_REPORT_FORMS_UNVERIFIED", reason: "报告还需要独立表单实例，不能省略或猜填" };
  if (ruleCount || recipientCount || !emptyConfiguration(template.pushConfiguration))
    return { ...common, status: "blocked" as const, code: "SERVICE_REPORT_DELIVERY_UNVERIFIED",
      reason: "模板存在发送规则、收件人或无法明确排除的推送配置，生成请求没有已核验的禁用发送开关" };
  return { ...common, status: "ready" as const, code: "NO_DELIVERY_CONFIGURED" as const };
}

type GenerationContract = Omit<ActionContract, "action"> & { action: "service_report" };
export function serviceReportGenerationContract(options: ServiceReportPreflightInput & { evidence: Evidence; version?: string }): GenerationContract {
  const proof = inspectServiceReportPreflight(options);
  if (proof.status !== "ready") fail(proof.code, "reason" in proof ? proof.reason : "服务报告模板尚未明确选择");
  const c = proof.context, templateId = numberId(proof.template.id), parentObjectId = numberId(c.parentObjectId);
  return {
    action: "service_report", authorization: "server", verification: "verified", evidence: options.evidence,
    version: options.version ?? "fieldjob-service-report-generate-v1", fieldMode: "action", entityTypes: [c.parentEntityType],
    fields: { serviceReportName: { type: "string", required: true, min: 1, max: 100 } },
    required: ["serviceReportName"], defaults: {}, preconditionFields: ["id", "status", "customItem62__c", "entityType", "ownerId"],
    recordPreconditions: [{ field: "id", expected: c.targetId }],
    effects: ["为此工单生成一份独立服务报告；仅适用刚核验为无表单、无签字、无发送配置的指定模板"],
    request: { host: "api", method: "POST", path: `${ROOT}/actions/generate`, encoding: "json",
      payload: { dataId: { $ref: "target.id", $type: "integer" }, objectId: parentObjectId, templateId,
        serviceReportName: { $ref: "input.serviceReportName" } }, successPath: "code", successValues: [200, "200"], resultIdPath: "data.id" },
    verify: { query: { apiKey: "serviceReport", fields: ["id", "name", "templateId", "relateEntity", "relateEntity_data", "state", "createdBy", "createdAt"], linkField: "id", bind: "result" },
      checks: [
        { field: "id", expected: { $ref: "result.id" } }, { field: "name", expected: { $ref: "input.serviceReportName" } },
        { field: "templateId", expected: templateId }, { field: "relateEntity", expected: parentObjectId },
        { field: "relateEntity_data", expected: { $ref: "target.id", $type: "integer" } },
        { field: "createdBy", expected: { $ref: "context.subjectId", $type: "integer" } }, { field: "state", expected: 3 },
      ] },
  };
}

export function decodeServiceReportGeneration(raw: unknown, expected: ServiceReportContext & { reportId: string; templateId: string; name: string }) {
  const c = context(expected), row = object(body(raw, [200, "200"]));
  if (id(row.id, "报告ID") !== parseInput(idSchema, expected.reportId) ||
      id(row.relateEntity, "父对象类型ID") !== c.parentObjectId ||
      id(row.relateEntity_data, "父工单ID") !== c.targetId ||
      id(row.templateId, "报告模板ID") !== parseInput(idSchema, expected.templateId) || row.name !== expected.name)
    fail("INVALID_RESPONSE", "生成报告的ID、模板、名称或双父关联不匹配");
  const state = typeof row.state === "number" ? row.state : typeof row.state === "string" && /^[1-5]$/.test(row.state) ? Number(row.state) : NaN;
  if (![1, 2, 3, 4, 5].includes(state)) fail("INVALID_RESPONSE", "报告生成状态不是已核验枚举");
  const status = ({ 1: "generating", 2: "cancelled", 3: "completed", 4: "delivery_observed", 5: "failed" } as const)[state as 1 | 2 | 3 | 4 | 5];
  const file = row.fileId;
  const hasFileId = (typeof file === "number" && Number.isSafeInteger(file) && file > 0) || (typeof file === "string" && idSchema.safeParse(file).success);
  return { id: expected.reportId, source: "serviceReport", status, state, parentEvidence: "returned_fields_verified",
    generated: state === 3, deliveryObserved: state === 4,
    artifactAcknowledged: hasFileId || (typeof row.fileLink === "string" && row.fileLink.length > 0) || (typeof row.formLink === "string" && row.formLink.length > 0),
    actorId: row.createdBy === undefined || row.createdBy === null ? null : id(row.createdBy, "生成参与人ID"),
    note: "状态3表示已完成；状态4表示已经发送，不能当作仅生成成功。文件内容、签字与客户送达需另行核验" };
}
