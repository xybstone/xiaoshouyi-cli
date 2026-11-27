import { canonical } from "./contracts.js";
import type { ActionContract } from "./types.js";
import { idSchema, object } from "./types.js";
import { isServerFieldJobSelfAssignment } from "./fieldjob-dispatch.js";

// Server authorization is confined to these exact page-observed protocols.
// It preserves unknown permission until the actual API accepts or rejects.
export function fieldJobServerAction(contract: ActionContract, subjectId?: string): "attachment_upload" | "attachment_link" | "assign" | "activity_record" | undefined {
  if (contract.authorization !== "server" || contract.fieldMode !== "action" || contract.request?.host !== "api") return undefined;
  if (isServerFieldJobSelfAssignment(contract, subjectId)) return "assign";
  const request = contract.request;
  const parentObjectId = object(object(request.payload).data).activityRecordFrom;
  if (contract.action === "activity_record" && request.path === "/rest/data/v2.0/xobjects/activityrecord" &&
    request.method === "POST" && request.encoding === "json" && request.resultIdPath === "data.id" &&
    typeof parentObjectId === "number" && Number.isSafeInteger(parentObjectId) && parentObjectId > 0 &&
    idSchema.safeParse(contract.defaults.entityType).success &&
    canonical(contract.fields.entityType?.enum) === canonical([contract.defaults.entityType]) &&
    Object.keys(contract.fields).sort().join(",") === "content,dimDepart,entityType,startTime" &&
    canonical(request.payload) === canonical({ data: {
      content: { $ref: "input.content" }, dimDepart: { $ref: "input.dimDepart", $type: "integer" },
      entityType: { $ref: "input.entityType", $type: "integer" }, startTime: { $ref: "input.startTime" },
      ownerId: { $ref: "context.subjectId", $type: "integer" }, activityRecordFrom: parentObjectId,
      activityRecordFrom_data: { $ref: "target.id", $type: "integer" },
    } })) return "activity_record";
  if (contract.action === "attachment_upload" && contract.version === "fieldjob-files-batch-page-v1" &&
    request.path === "/rest/file/v2.0/file/batch" && request.method === "POST" &&
    request.encoding === "multipart" && request.fileField === "files" && canonical(request.payload) === "{}" &&
    Object.keys(contract.fields).sort().join(",") === "filePath") return "attachment_upload";
  if (contract.action === "attachment_link" && request.method === "PATCH" && request.encoding === "json" &&
    Object.keys(contract.fields).sort().join(",") === "uploadOperationId") {
    const legacy = contract.version === "fieldjob-doc-append-page-v1" &&
      request.path === "/rest/data/v2.0/xobjects/fieldJob/:id" &&
      canonical(request.payload) === canonical({ data: { customItem69__c: { $ref: "probe.attachmentValue" } } });
    const masterdetails = contract.version === "fieldjob-doc-append-masterdetails-page-v2" &&
      request.path === "/rest/data/v2.0/xobjects/fieldJob/masterdetails" &&
      canonical(request.payload) === canonical({ master: {
        id: { $ref: "target.id", $type: "integer" }, customItem69__c: { $ref: "probe.attachmentValue" },
      } });
    if (legacy || masterdetails) return "attachment_link";
  }
  return undefined;
}
