// visit 语义别名命令 — list / get / create

import { Command } from "commander";
import { formatOutput } from "../api/format.js";
import { fmt, parseFields, parseData, handleError } from "./shared.js";
import { fetchActivityRecords } from "../api/crm-client.js";
import {
  getObject,
  createObject,
} from "../services/object.service.js";
import { withAuth } from "../middleware/auth-check.js";

const API_KEY = "visitRecord";

interface CmdOpts {
  format: "json" | "table" | "raw";
  fields?: string;
  data?: string;
  page?: string;
  size?: string;
}

export function registerVisitCommands(parent: Command): void {
  const visit = parent.command("visit").description("跟进操作");

  // list — 使用 CRM 域接口，需要 itemId
  visit.command("list")
    .description("跟进列表（用于特定客户或商机）")
    .argument("<itemId>", "客户或商机 ID")
    .option("--format <format>", "输出格式", "json")
    .option("--fields <fields>", "输出字段")
    .option("--page <n>", "页码", "1")
    .option("--size <n>", "每页条数", "20")
    .action(async (itemId: string, opts: CmdOpts) => {
      try {
        const page = parseInt(opts.page || "1");
        const size = parseInt(opts.size || "20");
        const resp = await fetchActivityRecords(1, itemId, page, size);
        console.log(formatOutput(resp, { format: fmt(opts), fields: parseFields(opts) }));
      } catch (e) { handleError(e); }
    });

  // get
  visit.command("get")
    .description("跟进详情")
    .argument("<id>", "跟进 ID")
    .option("--format <format>", "输出格式", "json")
    .option("--fields <fields>", "输出字段")
    .action(withAuth(async (id: string, opts: CmdOpts) => {
      try {
        const resp = await getObject(API_KEY, id);
        console.log(formatOutput(resp, { format: fmt(opts), fields: parseFields(opts) }));
      } catch (e) { handleError(e); }
    }));

  // create
  visit.command("create")
    .description("创建跟进")
    .requiredOption("--data <json>", "跟进数据 JSON")
    .option("--format <format>", "输出格式", "json")
    .action(withAuth(async (opts: CmdOpts) => {
      try {
        const resp = await createObject(API_KEY, parseData(opts));
        console.log(formatOutput(resp, { format: fmt(opts) }));
      } catch (e) { handleError(e); }
    }));
}
