// Entirely synthetic server model. These routes, fields and rules are NOT a
// production CRM contract and may only be loaded with allowSynthetic: true.
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from "axios";
import { KNOWN_FIELDS, type RecordData, type TicketAction } from "../../../src/tickets/types.js";
import { ContractRegistry } from "../../../src/tickets/contracts.js";

export const API_ORIGIN = "https://synthetic.invalid";
// This fixture models only these explicitly implemented synthetic resources
// and transitions. Adding a production enum must not silently grant a new
// fixture contract or invent an unrelated lifecycle transition.
export const MODELED_ACTIONS = [
  "create", "submit", "assign", "reassign", "accept", "reply", "pause", "resume", "escalate",
  "resolve", "complete", "close", "reopen", "return", "void", "attachment_upload", "attachment_link", "worklog", "report",
] as const satisfies readonly TicketAction[];
const modeledActions = new Set<TicketAction>(MODELED_ACTIONS);
const evidence = {
  source: "synthetic" as const,
  reference: "stateful in-memory integration server; not a CRM endpoint",
  verifiedAt: "2026-11-24T00:00:00+08:00",
};
const transitions: Partial<Record<TicketAction, { from: string[]; to: string }>> = {
  // Synthetic labels model a draft that must enter the workflow before it can
  // be dispatched. They are deliberately not production CRM enum values.
  submit: { from: ["New"], to: "Submitted" },
  assign: { from: ["Submitted", "Processing", "Paused"], to: "Assigned" },
  reassign: { from: ["Assigned", "Processing"], to: "Assigned" },
  accept: { from: ["Assigned"], to: "Processing" },
  pause: { from: ["Processing"], to: "Paused" },
  resume: { from: ["Paused"], to: "Processing" },
  resolve: { from: ["Processing"], to: "Resolved" },
  complete: { from: ["Resolved"], to: "Completed" },
  close: { from: ["Completed"], to: "Closed" },
  reopen: { from: ["Closed"], to: "Processing" },
  return: { from: ["Resolved", "Completed"], to: "Processing" },
  void: { from: ["New", "Submitted", "Assigned", "Processing", "Paused"], to: "Voided" },
};
const inputFields: Partial<Record<TicketAction, RecordData>> = {
  create: { name: { type: "string", required: true }, entityType: { type: "string", required: true } },
  assign: { responsibleId: { type: "string", required: true } },
  reassign: { responsibleId: { type: "string", required: true } },
  reply: { body: { type: "string", required: true } },
  resolve: { solution: { type: "string", required: true } },
  worklog: { hours: { type: "number", required: true, min: 0.01, max: 24 } },
  report: { body: { type: "string", required: true } },
  attachment_upload: { filePath: { type: "string", required: true } },
  attachment_link: { attachmentId: { type: "string", required: true } },
};
function fieldsFor(action: TicketAction) {
  return inputFields[action] ?? { reason: { type: "string", required: true } };
}
function resourceChecks(action: TicketAction) {
  const resources: Partial<Record<TicketAction, { apiKey: string; field: string; input: string }>> = {
    reply: { apiKey: "syntheticReplies", field: "body", input: "body" },
    worklog: { apiKey: "syntheticWorklogs", field: "hours", input: "hours" },
    report: { apiKey: "syntheticReports", field: "body", input: "body" },
  };
  const resource = resources[action];
  if (resource) return {
    query: { apiKey: resource.apiKey, fields: [resource.field], linkField: "ticketId" },
    checks: [
      { field: "id", expected: { $ref: "result.resourceId" } },
      { field: resource.field, expected: { $ref: `input.${resource.input}` } },
    ],
  };
  if (action === "attachment_upload") return {
    query: { apiKey: "syntheticAttachments", fields: ["ticketId", "uploaded"], linkField: "id", bind: "result" },
    checks: [
      { field: "uploaded", expected: true },
      { field: "ticketId", expected: { $ref: "target.id" } },
    ],
  };
  if (action === "attachment_link") return {
    query: { apiKey: "syntheticAttachments", fields: ["linked"], linkField: "ticketId" },
    checks: [
      { field: "id", expected: { $ref: "input.attachmentId" } },
      { field: "linked", expected: true },
    ],
  };
  if (action === "escalate") return { checks: [{ field: "escalated", expected: true }] };
  const transition = transitions[action];
  if (action !== "create" && !transition)
    throw new Error(`Synthetic action ${action} needs an explicit postcondition`);
  const checks: Array<{ field: string; expected: unknown }> = [{ field: "status", expected: action === "create" ? "New" : transition!.to }];
  if (action === "submit") checks.push({ field: "customItem62__c", expected: "Processing" });
  if (["assign", "reassign"].includes(action)) checks.push({ field: "responsibleTE__c", expected: { $ref: "input.responsibleId" } });
  return { checks };
}
export function syntheticRegistry(unverified: TicketAction[] = [], withRecovery = false) {
  return new ContractRegistry({
    version: 1,
    scope: { apiBaseUrl: API_ORIGIN, crmBaseUrl: "https://crm.xiaoshouyi.com", tenantId: "synthetic-tenant", subjectId: "synthetic-user" },
    actions: MODELED_ACTIONS.map((action) => ({
      action,
      verification: unverified.includes(action) ? "unverified" : "verified",
      version: "stateful-synthetic-1",
      evidence,
      entityTypes: ["2"],
      fields: fieldsFor(action),
      fieldMode: action === "create" ? "create" : "action",
      defaults: {},
      effects: ["synthetic record/resource mutation", "synthetic immutable audit event"],
      request: {
        host: "api", method: "POST",
        path: `/synthetic/actions/${action}${action === "create" ? "" : "/:id"}`,
        encoding: action === "attachment_upload" ? "multipart" : action === "reply" ? "form" : "json",
        fileField: action === "attachment_upload" ? "file" : undefined,
        payload: withRecovery ? {
          ...Object.fromEntries(Object.keys(fieldsFor(action)).map((key) => [key, { $ref: `input.${key}` }])),
          operationKey: { $ref: "operation.operationId" },
        } : { $ref: "input" },
        successPath: "code", successValues: [200], rejectValues: [400],
        resultIdPath: ["create", "attachment_upload"].includes(action) ? "data.id" : undefined,
        outputPaths: { eventId: "data.eventId", resourceId: "data.resourceId" },
      },
      probe: {
        request: {
          host: "api", method: "GET", path: `/synthetic/probe/${action}${action === "create" ? "" : "/:id"}`,
          successPath: "code", successValues: [200],
        },
        permissionPath: "data.permission", allowedPath: "data.allowed", formPath: "data.form",
      },
      recovery: withRecovery ? {
        evidence, apiKey: "syntheticEvents", correlationField: "operationKey",
        resultIdField: action === "attachment_upload" ? "resourceId" : "ticketId",
        targetField: action === "create" ? undefined : "ticketId",
        checks: [{ field: "action", expected: action }],
        outputFields: { eventId: "id", resourceId: "resourceId" },
      } : undefined,
      verify: {
        ...resourceChecks(action),
        additional: [{
          name: "audit",
          query: { apiKey: "syntheticEvents", fields: ["action"], linkField: "ticketId" },
          checks: [
            { field: "id", expected: { $ref: "result.eventId" } },
            { field: "action", expected: action },
          ],
        }],
      },
    })),
    timeline: [{ name: "synthetic history", verification: "verified", evidence,
      query: { apiKey: "syntheticEvents", fields: ["action", "before", "after", "occurredAt"], linkField: "ticketId", timeField: "occurredAt", dateEncoding: "unix-ms" } }],
    download: {
      verification: "verified", evidence,
      request: { host: "api", method: "GET", path: "/synthetic/download/:id/:attachmentId", successPath: "code", successValues: [200] },
      probe: { request: { host: "api", method: "GET", path: "/synthetic/download-permission/:id/:attachmentId", successPath: "code", successValues: [200] }, permissionPath: "data.permission", allowedPath: "data.allowed" },
    },
  }, { allowSynthetic: true });
}

export class StatefulSyntheticCrm {
  readonly tickets = new Map<string, RecordData>();
  readonly tables: Record<string, RecordData[]> = {
    syntheticEvents: [], syntheticReplies: [], syntheticWorklogs: [], syntheticReports: [], syntheticAttachments: [],
  };
  readonly requests: Array<{ method: string; url: string; replay: unknown }> = [];
  readonly writes: Array<{ action: TicketAction; ticketId: string }> = [];
  readonly denied = new Set<TicketAction>();
  readonly reject = new Set<TicketAction>();
  readonly dropReplyAfterApply = new Set<TicketAction>();
  readonly delayAudit = new Set<TicketAction>();
  private delayed: RecordData[] = [];
  private nextId = 10000;
  private readonly uploaded = new Map<string, Uint8Array>();
  private id() { return String(++this.nextId); }
  private can(action: TicketAction, ticket?: RecordData) {
    if (!modeledActions.has(action)) return false;
    if (action === "create") return true;
    if (!ticket) return false;
    const transition = transitions[action];
    if (transition && !transition.from.includes(String(ticket.status))) return false;
    if (["reply", "worklog", "report", "escalate"].includes(action) && !["Processing", "Paused"].includes(String(ticket.status))) return false;
    if (action === "close" && (!this.tables.syntheticReports.some((r) => r.ticketId === ticket.id) || !this.tables.syntheticWorklogs.some((r) => r.ticketId === ticket.id))) return false;
    return ticket.status !== "Voided";
  }
  flushDelayedAudit() { this.tables.syntheticEvents.push(...this.delayed.splice(0)); }
  private query(sql: string) {
    const match = /^select (.+?) from ([A-Za-z0-9_]+)(?: where (.*?))?(?: order by (.*?))? limit (\d+),(\d+)$/i.exec(sql);
    if (!match) throw new Error(`Unsupported synthetic query: ${sql}`);
    const [, fields, apiKey, where, , offsetText, sizeText] = match;
    let records = apiKey === "fieldJob" ? [...this.tickets.values()] : this.tables[apiKey];
    if (!records) throw new Error(`Unknown synthetic table: ${apiKey}`);
    if (where) for (const condition of where.split(/ and /i)) {
      const equal = /^([A-Za-z0-9_]+) = '([^']*)'$/.exec(condition);
      if (!equal) throw new Error(`Unsupported synthetic predicate: ${condition}`);
      records = records.filter((r) => String(r[equal[1]]) === equal[2]);
    }
    const totalSize = records.length;
    records = [...records].sort((a, b) => Number(b.id) - Number(a.id)).slice(Number(offsetText), Number(offsetText) + Number(sizeText));
    const selected = fields.split(",");
    return { code: 200, result: { totalSize, count: records.length, records: records.map((r) => Object.fromEntries(selected.map((f) => [f, r[f] ?? null]))) } };
  }
  private response(config: InternalAxiosRequestConfig, data: unknown, status = 200, headers: Record<string, string> = {}) {
    return { data, status, statusText: status === 200 ? "OK" : "Rejected", headers, config };
  }
  adapter: AxiosAdapter = async (config) => {
    const url = String(config.url), method = String(config.method).toUpperCase();
    this.requests.push({ method, url, replay: config.xsyReplay });
    if (method === "GET" && url === "/rest/data/v2.0/xobjects/fieldJob/description") {
      const fieldNames = [...new Set([...KNOWN_FIELDS, "name", "entityType", "escalated", "solution"])];
      return this.response(config, { code: 200, data: { apiKey: "fieldJob", disabled: false, queryable: true, createable: true,
        fields: fieldNames.map((apiKey) => ({ apiKey, type: "String", required: ["name", "entityType"].includes(apiKey), enabled: true, createable: true, updateable: true })) } });
    }
    if (method === "GET" && url === "/rest/data/v2/query") return this.response(config, this.query(String(config.params.q)));
    const probe = /^\/synthetic\/probe\/([a-z_]+)(?:\/(\d+))?$/.exec(url);
    if (method === "GET" && probe) {
      const action = probe[1] as TicketAction;
      return this.response(config, { code: 200, data: {
        permission: !this.denied.has(action), allowed: this.can(action, this.tickets.get(probe[2])),
        form: { required: Object.keys(fieldsFor(action)), fields: {}, defaults: {}, version: "stateful-form-1" },
      } });
    }
    const download = /^\/synthetic\/(download|download-permission)\/(\d+)\/(\d+)$/.exec(url);
    if (method === "GET" && download) {
      const [, kind, ticketId, attachmentId] = download;
      const allowed = this.tables.syntheticAttachments.some((r) => r.id === attachmentId && r.ticketId === ticketId && r.linked === true);
      if (kind === "download-permission") return this.response(config, { code: 200, data: { permission: allowed, allowed } });
      if (!allowed) return this.response(config, { code: 403 }, 403);
      return this.response(config, Buffer.from(this.uploaded.get(attachmentId)!), 200, { "content-type": "application/octet-stream", "content-disposition": "attachment" });
    }
    const route = /^\/synthetic\/actions\/([a-z_]+)(?:\/(\d+))?$/.exec(url);
    if (method !== "POST" || !route) throw new Error(`Unexpected synthetic transport route: ${method} ${url}`);
    const action = route[1] as TicketAction;
    const input = config.data instanceof FormData
      ? Object.fromEntries([...config.data.entries()].filter(([k]) => k !== "file"))
      : action === "reply" ? Object.fromEntries(new URLSearchParams(String(config.data))) : JSON.parse(String(config.data));
    let ticketId = route[2], ticket = this.tickets.get(ticketId);
    if (this.denied.has(action) || this.reject.has(action) || !this.can(action, ticket)) return this.response(config, { code: 400 }, 400);
    if (action === "attachment_link" && !this.tables.syntheticAttachments.some((r) => r.id === input.attachmentId && r.ticketId === ticketId)) return this.response(config, { code: 400 }, 400);
    const before = ticket?.status ?? null;
    let resourceId: string | undefined;
    if (action === "create") {
      ticketId = this.id();
      ticket = { id: ticketId, name: input.name, entityType: input.entityType, status: "New", customItem62__c: "Draft", ownerId: "42", responsibleTE__c: null, fieldJobPoolGroup: "7", description: "Original immutable description" };
      this.tickets.set(ticketId, ticket);
    } else {
      const transition = transitions[action];
      if (transition) ticket!.status = transition.to;
      if (["submit", "reopen", "return"].includes(action)) ticket!.customItem62__c = "Processing";
      if (["resolve", "complete"].includes(action)) ticket!.customItem62__c = "Closing";
      if (["assign", "reassign"].includes(action)) ticket!.responsibleTE__c = input.responsibleId;
      if (action === "resolve") ticket!.solution = input.solution;
      if (action === "escalate") ticket!.escalated = true;
      if (action === "close") ticket!.customItem62__c = "Closed";
      if (action === "reply" || action === "worklog" || action === "report") {
        resourceId = this.id();
        const table = action === "reply" ? "syntheticReplies" : action === "worklog" ? "syntheticWorklogs" : "syntheticReports";
        this.tables[table].push({ id: resourceId, ticketId, ...input });
      }
      if (action === "attachment_upload") {
        resourceId = this.id();
        const blob = (config.data as FormData).get("file") as Blob;
        this.uploaded.set(resourceId, new Uint8Array(await blob.arrayBuffer()));
        this.tables.syntheticAttachments.push({ id: resourceId, ticketId, uploaded: true, linked: false });
      }
      if (action === "attachment_link") {
        resourceId = input.attachmentId;
        this.tables.syntheticAttachments.find((r) => r.id === resourceId)!.linked = true;
      }
    }
    const eventId = this.id();
    const event = { id: eventId, ticketId, action, before, after: ticket!.status,
      operationKey: input.operationKey ?? null, resourceId: resourceId ?? null,
      occurredAt: 1795500000000 + Number(eventId) };
    (this.delayAudit.has(action) ? this.delayed : this.tables.syntheticEvents).push(event);
    this.writes.push({ action, ticketId });
    if (this.dropReplyAfterApply.delete(action)) throw new AxiosError("Synthetic response lost after durable apply", "ECONNRESET", config);
    return this.response(config, { code: 200, data: { id: action === "create" ? ticketId : resourceId, eventId, resourceId } });
  };
}
