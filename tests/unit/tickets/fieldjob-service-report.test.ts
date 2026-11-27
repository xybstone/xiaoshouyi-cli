import { describe, expect, it } from "vitest";
import {
  decodeServiceReportGeneration, inspectServiceReportPreflight, selectServiceReportTemplate,
  serviceReportFormsReadRequest, serviceReportGenerationContract, serviceReportRecordReadRequest,
  serviceReportRulesReadRequest, serviceReportTemplateListReadRequest,
} from "../../../src/tickets/fieldjob-service-report.js";
import { template } from "../../../src/tickets/contracts.js";

const context = { targetId: "1", parentObjectId: "10", parentEntityType: "7" };
const selected = { id: 2, name: "Synthetic generic report", status: 1, signatureSwitch: 0, onPushRules: "", advancedCode: "" };
const templateList = (rows = [selected]) => ({ code: "0", errorInfo: null, data: { records: rows, count: rows.length, totalSize: rows.length } });
const forms = { code: "200", data: { formTemplate: [] } };
const parsedRules = { code: "200", data: [] };
const evidence = { source: "synthetic" as const, reference: "offline generation preflight fixture, not live generation acceptance", verifiedAt: "2026-11-27T00:00:00+08:00" };
const input = (overrides = {}) => ({ context, templateList: templateList(), forms, parsedRules, ...overrides });
const report = (overrides = {}) => ({ code: "200", data: { id: 8, name: "Synthetic generated report", templateId: 2,
  relateEntity: 10, relateEntity_data: 1, state: 3, createdBy: 3, fileId: 9, fileLink: "https://private.example/report", ...overrides } });
const expected = { ...context, reportId: "8", templateId: "2", name: "Synthetic generated report" };

describe("service report readonly preflight and scoped generation", () => {
  it("uses the observed success code and exact body for each distinct read endpoint", () => {
    expect(serviceReportTemplateListReadRequest(context)).toMatchObject({ method: "POST", path: "/rest/data/v2.0/xobjects/serviceReport/actions/listByData", payload: { dataId: 1, objectId: 10, busiTypeId: 7 }, successValues: [0, "0"] });
    expect(serviceReportFormsReadRequest(context, "2")).toMatchObject({ payload: { dataId: 1, objectId: 10, templateId: 2 }, successValues: [200, "200"] });
    expect(serviceReportRulesReadRequest(context, "2")).toMatchObject({ payload: { dataId: 1, objectId: 10, templateId: 2, entityType: 7 }, successValues: [200, "200"] });
    expect(serviceReportRecordReadRequest("8")).toMatchObject({ method: "GET", path: "/rest/data/v2.0/xobjects/serviceReport/8" });
  });
  it("never picks the first of several applicable templates", () => {
    const list = templateList([selected, { ...selected, id: 4, name: "Synthetic alternate" }]);
    expect(selectServiceReportTemplate(list)).toMatchObject({ status: "blocked", code: "AMBIGUOUS_TEMPLATE", availableCount: 2 });
    expect(selectServiceReportTemplate(list, { name: "Synthetic alternate" })).toMatchObject({ status: "selected", template: { id: "4", name: "Synthetic alternate" } });
  });
  it("duplicate names remain ambiguous and a missing explicit choice does not fall back", () => {
    const list = templateList([selected, { ...selected, id: 4 }]);
    expect(selectServiceReportTemplate(list, { name: selected.name })).toMatchObject({ status: "blocked", code: "AMBIGUOUS_TEMPLATE" });
    expect(selectServiceReportTemplate(list, { id: "99" })).toMatchObject({ status: "blocked", code: "NO_AVAILABLE_TEMPLATE" });
  });
  it("requires complete template counts, active status, and unique identities", () => {
    expect(selectServiceReportTemplate(templateList([{ ...selected, status: 0 }]))).toMatchObject({ status: "blocked", code: "NO_AVAILABLE_TEMPLATE" });
    expect(() => selectServiceReportTemplate({ code: "0", data: { records: [selected], count: 1, totalSize: 3 } })).toThrow();
    expect(() => selectServiceReportTemplate(templateList([selected, selected]))).toThrow();
    expect(() => selectServiceReportTemplate(templateList(), { id: "2", name: selected.name })).toThrow();
  });
  it("a rule with a real receiver blocks generation without disclosing the address or message", () => {
    const rawRules = { code: "200", data: [{ id: 9, sendChannel: 1, receiver: [{ value: "do-not-send@example.test" }], content: "PRIVATE-MESSAGE" }] };
    const result = inspectServiceReportPreflight(input({ parsedRules: rawRules }));
    expect(result).toMatchObject({ status: "blocked", code: "SERVICE_REPORT_DELIVERY_UNVERIFIED", ruleCount: 1, recipientCount: 1, delivery: "not_authorized" });
    expect(JSON.stringify(result)).not.toMatch(/do-not-send|PRIVATE-MESSAGE/);
    expect(() => serviceReportGenerationContract({ ...input({ parsedRules: rawRules }), evidence })).toThrow();
  });
  it("even an empty current receiver list cannot override configured push rules", () => {
    expect(inspectServiceReportPreflight(input({ parsedRules: { code: 200, data: [{ id: 9, receiver: [] }] } })))
      .toMatchObject({ status: "blocked", code: "SERVICE_REPORT_DELIVERY_UNVERIFIED" });
    expect(inspectServiceReportPreflight(input({ templateList: templateList([{ ...selected, onPushRules: "1" }]) })))
      .toMatchObject({ status: "blocked", code: "SERVICE_REPORT_DELIVERY_UNVERIFIED" });
  });
  it("does not treat absent or malformed forms/rules as empty safe configuration", () => {
    expect(() => inspectServiceReportPreflight(input({ forms: { code: 200, data: {} } }))).toThrow();
    expect(() => inspectServiceReportPreflight(input({ parsedRules: { code: 200, data: null } }))).toThrow();
    expect(() => inspectServiceReportPreflight(input({ parsedRules: { code: 200, data: [{ receiver: "unknown-shape" }] } }))).toThrow();
  });
  it("blocks signature, extra forms and custom execution logic", () => {
    expect(inspectServiceReportPreflight(input({ templateList: templateList([{ ...selected, signatureSwitch: 1 }]) })))
      .toMatchObject({ status: "blocked", code: "SERVICE_REPORT_SIGNATURE_UNVERIFIED" });
    expect(inspectServiceReportPreflight(input({ forms: { code: 200, data: { formTemplate: [{ id: 1 }] } } })))
      .toMatchObject({ status: "blocked", code: "SERVICE_REPORT_FORMS_UNVERIFIED" });
    expect(inspectServiceReportPreflight(input({ templateList: templateList([{ ...selected, advancedCode: "unverified custom operation" }]) })))
      .toMatchObject({ status: "blocked", code: "SERVICE_REPORT_TEMPLATE_CODE_UNVERIFIED" });
  });
  it("only builds the generation action after explicit no-send preflight and exact-parent binding", () => {
    const proof = inspectServiceReportPreflight(input());
    expect(proof).toMatchObject({ status: "ready", code: "NO_DELIVERY_CONFIGURED", ruleCount: 0, formCount: 0 });
    const c = serviceReportGenerationContract({ ...input(), evidence });
    expect(c).toMatchObject({ action: "service_report", authorization: "server", recordPreconditions: [{ field: "id", expected: "1" }] });
    expect(c.fields).toEqual({ serviceReportName: { type: "string", required: true, min: 1, max: 100 } });
    expect(template(c.request!.payload, { input: { serviceReportName: "Synthetic generated report" }, target: { id: "1" } }))
      .toEqual({ dataId: 1, objectId: 10, templateId: 2, serviceReportName: "Synthetic generated report" });
    expect(JSON.stringify(c.request)).not.toMatch(/confirmAndSend|receiver|recipient|sendChannel|instanceIds/);
    expect(c.verify!.checks).toContainEqual({ field: "state", expected: 3 });
  });
  it("completed, sent, failed and cancelled are different outcomes, not interchangeable success", () => {
    expect(decodeServiceReportGeneration(report(), expected)).toMatchObject({ status: "completed", generated: true, deliveryObserved: false, artifactAcknowledged: true });
    expect(decodeServiceReportGeneration(report({ state: 4 }), expected)).toMatchObject({ status: "delivery_observed", generated: false, deliveryObserved: true });
    expect(decodeServiceReportGeneration(report({ state: 5 }), expected)).toMatchObject({ status: "failed", generated: false });
    expect(decodeServiceReportGeneration(report({ state: 2 }), expected)).toMatchObject({ status: "cancelled", generated: false });
    expect(decodeServiceReportGeneration(report({ state: 1 }), expected)).toMatchObject({ status: "generating", generated: false });
  });
  it.each([{ id: 9 }, { relateEntity: 11 }, { relateEntity_data: 2 }, { templateId: 4 }, { name: "another report" }, { state: 99 }])("rejects mismatched generated result %#", (changes) => {
    expect(() => decodeServiceReportGeneration(report(changes), expected)).toThrow();
  });
  it("does not expose file URLs or infer file contents and delivery from a completed record", () => {
    const result = decodeServiceReportGeneration(report(), expected);
    expect(JSON.stringify(result)).not.toContain("https://private");
    expect(result).toMatchObject({ actorId: "3", parentEvidence: "returned_fields_verified" });
  });
});
