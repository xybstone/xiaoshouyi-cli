// approval 命令 — 审批待办查询与处理

import { Command } from "commander";
import { withAuth } from "../middleware/auth-check.js";
import { formatOutput } from "../api/format.js";
import { fmt, parseFields, handleError } from "./shared.js";
import { getCrmCookie, loginCrm } from "../api/crm-client.js";
import {
  queryApprovalWorkItems,
  getApprovalWorkItem,
  executeApprovalAction,
} from "../services/approval.service.js";

interface CmdOpts {
  format: "json" | "table" | "raw";
  fields?: string;
  page?: string;
  size?: string;
  status?: string;
  comment?: string;
}

export function registerApprovalCommands(parent: Command): void {
  const approval = parent.command("approval").description("审批操作");

  // ---- xsy approval list ----
  approval
    .command("list")
    .description("审批待办列表")
    .option("--format <format>", "输出格式", "json")
    .option("--fields <fields>", "输出字段")
    .option("--page <n>", "页码", "1")
    .option("--size <n>", "每页条数", "20")
    .option("--status <n>", "状态过滤：0-待审批(默认),1-已通过,2-已驳回", "0")
    .action(withAuth(async (opts: CmdOpts) => {
      try {
        const page = parseInt(opts.page || "1");
        const size = parseInt(opts.size || "20");
        const status = opts.status ? parseInt(opts.status) : 0;
        const resp = await queryApprovalWorkItems(status, page, size);
        console.log(formatOutput(resp, { format: fmt(opts), fields: parseFields(opts) }));
      } catch (e) { handleError(e); }
    }));

  // ---- xsy approval get <id> ----
  approval
    .command("get")
    .description("审批详情")
    .argument("<id>", "审批待办 ID")
    .option("--format <format>", "输出格式", "json")
    .option("--fields <fields>", "输出字段")
    .action(withAuth(async (id: string, opts: CmdOpts) => {
      try {
        const resp = await getApprovalWorkItem(id);
        console.log(formatOutput(resp, { format: fmt(opts), fields: parseFields(opts) }));
      } catch (e) { handleError(e); }
    }));

  // ---- xsy approval approve <id> ----
  approval
    .command("approve")
    .description("批准审批")
    .argument("<id>", "审批待办 ID")
    .option("--comment <text>", "审批意见")
    .option("--format <format>", "输出格式", "json")
    .action(withAuth(async (id: string, opts: CmdOpts) => {
      try {
        const resp = await executeApprovalAction(id, "approve", opts.comment);
        console.log(formatOutput(resp, { format: fmt(opts) }));
      } catch (e) { handleError(e); }
    }));

  // ---- xsy approval reject <id> ----
  approval
    .command("reject")
    .description("驳回审批")
    .argument("<id>", "审批待办 ID")
    .option("--comment <text>", "驳回意见")
    .option("--format <format>", "输出格式", "json")
    .action(withAuth(async (id: string, opts: CmdOpts) => {
      try {
        const resp = await executeApprovalAction(id, "reject", opts.comment);
        console.log(formatOutput(resp, { format: fmt(opts) }));
      } catch (e) { handleError(e); }
    }));

  // ---- xsy approval refresh-cookie ----
  approval
    .command("refresh-cookie")
    .description("自动刷新 CRM Cookie（基于已存储的凭据）")
    .option("--format <format>", "输出格式", "json")
    .action(withAuth(async (opts: CmdOpts) => {
      try {
        const cookie = await loginCrm();
        console.log(JSON.stringify({
          status: "ok",
          message: "CRM Cookie 已自动刷新",
          cookiePreview: cookie.substring(0, 50) + "...",
        }, null, 2));
      } catch (e) { handleError(e); }
    }));
}
