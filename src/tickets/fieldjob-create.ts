import type { ActionContract, InputField } from "./types.js";

const text = (max: number): InputField => ({ type: "string", min: 1, max });
const reference: InputField = { type: "string", min: 1, max: 128 };
const option: InputField = { type: "number" };

// Protocol reused from crm-ticket-service's create_field_job implementation.
// Object metadata and server validation supply current tenant constraints; this
// does not assert user permissions or guess a business type, pool or defaults.
export const FIELDJOB_CREATE: ActionContract = {
  action: "create",
  verification: "verified",
  version: "fieldjob-rest-create-v1",
  authorization: "server",
  evidence: {
    source: "implementation",
    reference: "crm-ticket-service/crm_ticket_service/crm_client.py:create_field_job; fieldJob description; docs/fieldjob-contract-evidence-2026-11-24.md",
    verifiedAt: "2026-11-26T00:00:00+08:00",
  },
  fieldMode: "create",
  fields: {
    name: text(200),
    entityType: reference,
    fieldJobPoolGroup: reference,
    dimDepart: reference,
    fieldJobAccountId: reference,
    fieldJobAssetId: reference,
    responsibleTE__c: reference,
    ownerId: reference,
    address: text(300),
    description: text(20000),
    problemDescription__c: text(20000),
    productVersion__c: text(200),
    reportText__c: text(20000),
    remark: text(2000),
    priority: option,
    products__c: option,
    isBug__c: option,
    status: { type: "number", enum: [1] },
  },
  required: ["name", "entityType", "fieldJobPoolGroup", "dimDepart", "address", "status"],
  defaults: {},
  preconditionFields: [],
  effects: ["创建一张 fieldJob 派工单；业务类型和条件必填由服务器最终校验"],
  request: {
    host: "api",
    method: "POST",
    path: "/rest/data/v2.0/xobjects/fieldJob",
    encoding: "json",
    payload: { data: { $ref: "input" } },
    successPath: "code",
    successValues: [200, "200", 0, "0"],
    resultIdPath: "data.id",
  },
  verify: {
    checks: [
      { field: "id", expected: { $ref: "result.id" } },
      { field: "name", expected: { $ref: "input.name" } },
      { field: "status", expected: { $ref: "input.status" } },
    ],
  },
};
