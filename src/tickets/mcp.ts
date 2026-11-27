import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  createTicketService,
  operationSummary,
} from "../services/ticket.service.js";
import {
  fail,
  fieldSchema,
  idSchema,
  parseInput,
  searchSchema,
} from "./types.js";
import { prepareWithReferencesSchema, referenceInputSchema } from "./references.js";
import { operationReviewFingerprint } from "./actions.js";
import type { OperationReview } from "./types.js";

const schemas = {
  tickets_search: searchSchema,
  tickets_reference_resolve: referenceInputSchema,
  tickets_get: z
    .object({
      id: idSchema,
      fields: z.array(fieldSchema).min(1).max(50).optional(),
      includeContext: z.boolean().default(false),
    })
    .strict(),
  tickets_capabilities: z
    .object({ id: idSchema.optional(), refresh: z.boolean().default(false) })
    .strict(),
  tickets_workflow: z.object({
    id: idSchema, includeSubmitChooser: z.boolean().default(false),
  }).strict(),
  tickets_service_report_preflight: z.object({
    id: idSchema, templateId: idSchema.optional(), templateName: z.string().min(1).max(500).optional(),
  }).strict(),
  tickets_timeline: z
    .object({
      id: idSchema,
      page: z.number().int().min(1).default(1),
      size: z.number().int().min(1).max(100).default(20),
    })
    .strict(),
  tickets_prepare: prepareWithReferencesSchema,
  tickets_operation_get: z
    .object({ operationId: z.uuid(), reconcile: z.boolean().default(false) })
    .strict(),
  tickets_attachment_download: z
    .object({ id: idSchema, attachmentId: idSchema })
    .strict(),
  tickets_attachment_download_uploaded: z.object({ uploadOperationId: z.uuid(), verifyAssociation: z.boolean().default(true) }).strict(),
  tickets_execute: z
    .object({
      planId: z.uuid(),
      fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
      approval: z.string().max(16000),
    })
    .strict(),
  tickets_operation_review: z.object({
    operationId: z.uuid(),
    fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    approval: z.string().max(16000),
    review: z.object({
      outcome: z.enum(["applied", "not_applied", "inconclusive"]),
      reviewedBy: z.string().min(1).max(200),
      evidenceReferences: z.array(z.string().min(1).max(1000)).min(1).max(20),
      resultId: idSchema.optional(),
    }).strict(),
  }).strict(),
};
const descriptions: Record<keyof typeof schemas, string> = {
  tickets_search:
    "按明确字段分页查询 fieldJob 技服工单，只读；不默认读取全部记录。",
  tickets_reference_resolve:
    "按已核验对象/读取协议解析客户、处理人、派工池、部门、业务类型或资产；同名返回候选并阻止自动选择。",
  tickets_get: "读取 fieldJob 工单详情。客户资料按当前账号权限读取。",
  tickets_capabilities:
    "查询工单动作契约、权限与当前允许动作。默认离线报告未核验边界；refresh 才读取元数据。",
  tickets_workflow:
    "只读发现 fieldJob 当前流程任务、服务器允许动作及可选提交候选；不调用流程预处理或执行业务动作。",
  tickets_service_report_preflight:
    "只读核验独立服务报告模板、条件表单及发送规则；不生成、不发送，不返回收件信息。",
  tickets_timeline:
    "读取已核验来源的工单时间线；未核验来源明确标出，不用本地日志替代 CRM 历史。",
  tickets_prepare:
    "准备工单动作的最终请求和私有计划，不写 CRM。未核验动作返回 blocked。指纹不代表用户授权。",
  tickets_operation_get:
    "读取本地工单操作状态；reconcile 仅回读验证，不重放写入。",
  tickets_attachment_download:
    "按已核验协议下载附件到本地私有文件，不修改 CRM。",
  tickets_attachment_download_uploaded:
    "按本地已核验上传操作下载并核对大小/SHA-256；默认还要求已验证工单关联。verifyAssociation=false仅验证本人上传文件，不证明关联，不修改CRM。",
  tickets_execute:
    "执行已由可信宿主确认的不可变工单计划；需要宿主签名授权及显式启用写工具。",
  tickets_operation_review:
    "由可信宿主确认后记录人工核对结论与证据；仅更新本地操作账本，applied仍需正常业务回读，不重发CRM写入。",
};
export function ticketToolDefinitions() {
  const names = Object.keys(schemas) as Array<keyof typeof schemas>;
  return names
    .filter(
      (name) => {
        const approvalConfigured = Buffer.byteLength(process.env.XSY_TICKET_APPROVAL_SECRET ?? "") >= 32;
        return name === "tickets_execute"
          ? process.env.XSY_TICKET_WRITES === "1" && approvalConfigured
          : name === "tickets_operation_review" ? approvalConfigured : true;
      },
    )
    .map((name) => {
      const readOnly = [
        "tickets_search",
        "tickets_reference_resolve",
        "tickets_get",
        "tickets_capabilities",
        "tickets_workflow",
        "tickets_service_report_preflight",
        "tickets_timeline",
      ].includes(name);
      return {
        name,
        description: descriptions[name],
        inputSchema: z.toJSONSchema(schemas[name]),
        annotations: {
          readOnlyHint: readOnly,
          destructiveHint: name === "tickets_execute",
          idempotentHint: readOnly,
        },
      };
    });
}
const approvalSchema = z
  .object({
    planId: z.uuid(),
    fingerprint: z.string(),
    purpose: z.enum(["execute", "operation_review"]).default("execute"),
    reviewFingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
    expiresAt: z.iso.datetime({ offset: true }),
    approvedBy: z.string().min(1).max(200),
    reference: z.string().min(1).max(500),
  })
  .strict();
function readHostApproval(
  token: string,
  planId: string,
  fingerprint: string,
) {
  const secret = process.env.XSY_TICKET_APPROVAL_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32)
    fail("CONFIRMATION_REQUIRED", "可信宿主确认未配置（密钥至少 32 字节）");
  const parts = token.split(".");
  if (parts.length !== 2) fail("CONFIRMATION_REQUIRED", "无效宿主确认");
  const expected = createHmac("sha256", secret).update(parts[0]).digest();
  const signature = Buffer.from(parts[1], "base64url");
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(signature, expected)
  )
    fail("CONFIRMATION_REQUIRED", "宿主确认签名不符");
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    fail("CONFIRMATION_REQUIRED", "宿主确认内容无效");
  }
  const approval = parseInput(approvalSchema, raw);
  if (
    approval.planId !== planId ||
    approval.fingerprint !== fingerprint ||
    Date.parse(approval.expiresAt) <= Date.now()
  )
    fail("CONFIRMATION_MISMATCH", "宿主确认目标、指纹不符或已过期");
  return approval;
}
export function verifyHostApproval(token: string, planId: string, fingerprint: string) {
  const approval = readHostApproval(token, planId, fingerprint);
  if (approval.purpose !== "execute" || approval.reviewFingerprint !== undefined)
    fail("CONFIRMATION_MISMATCH", "此宿主授权不能用于执行工单动作");
  return { fingerprint, purpose: "execute" as const, source: "host" as const,
    reference: `${approval.approvedBy}: ${approval.reference}` };
}
export function verifyHostReviewApproval(
  token: string, planId: string, fingerprint: string, review: OperationReview,
) {
  const approval = readHostApproval(token, planId, fingerprint);
  const reviewFingerprint = operationReviewFingerprint(fingerprint, review);
  if (approval.purpose !== "operation_review" || approval.reviewFingerprint !== reviewFingerprint)
    fail("CONFIRMATION_MISMATCH", "人工核对授权用途或核对内容与签名不符");
  return { fingerprint, purpose: "operation_review" as const, reviewFingerprint,
    source: "host" as const, reference: `${approval.approvedBy}: ${approval.reference}` };
}
export async function callTicketTool(
  name: string,
  raw: unknown,
): Promise<unknown> {
  if (!ticketToolDefinitions().some((t) => t.name === name))
    fail("UNSUPPORTED", "该工单工具不存在或未启用");
  const service = createTicketService();
  switch (name) {
    case "tickets_search":
      return service.search(parseInput(schemas.tickets_search, raw));
    case "tickets_reference_resolve":
      return service.resolveReference(parseInput(schemas.tickets_reference_resolve, raw));
    case "tickets_get": {
      const a = parseInput(schemas.tickets_get, raw);
      return service.get(a.id, a.fields, a.includeContext);
    }
    case "tickets_capabilities":
      return service.capabilities(
        parseInput(schemas.tickets_capabilities, raw),
      );
    case "tickets_workflow": {
      const a = parseInput(schemas.tickets_workflow, raw);
      return service.workflow(a.id, a.includeSubmitChooser);
    }
    case "tickets_service_report_preflight": {
      const a = parseInput(schemas.tickets_service_report_preflight, raw);
      return service.serviceReportPreflight(a.id, { id: a.templateId, name: a.templateName });
    }
    case "tickets_timeline": {
      const a = parseInput(schemas.tickets_timeline, raw);
      return service.timeline(a.id, a.page, a.size);
    }
    case "tickets_prepare":
      return service.prepare(parseInput(schemas.tickets_prepare, raw));
    case "tickets_operation_get": {
      const a = parseInput(schemas.tickets_operation_get, raw);
      return operationSummary(
        await service.operation(a.operationId, a.reconcile),
      );
    }
    case "tickets_attachment_download": {
      const a = parseInput(schemas.tickets_attachment_download, raw);
      return service.download(a.id, a.attachmentId);
    }
    case "tickets_attachment_download_uploaded": {
      const a = parseInput(schemas.tickets_attachment_download_uploaded, raw);
      return service.downloadUploadedAttachment(a.uploadOperationId, undefined, a.verifyAssociation);
    }
    case "tickets_execute": {
      const a = parseInput(schemas.tickets_execute, raw);
      return operationSummary(
        await service.execute(
          a.planId,
          verifyHostApproval(a.approval, a.planId, a.fingerprint),
        ),
      );
    }
    case "tickets_operation_review": {
      const a = parseInput(schemas.tickets_operation_review, raw);
      return operationSummary(await service.review(
        a.operationId, verifyHostReviewApproval(a.approval, a.operationId, a.fingerprint, a.review), a.review,
      ));
    }
    default:
      fail("UNSUPPORTED", "未知工单工具");
  }
}
