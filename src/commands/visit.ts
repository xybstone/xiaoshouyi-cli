// visit 语义别名命令 — list / get / create

import { Command } from "commander";
import { withAuth } from "../middleware/auth-check.js";
import { formatOutput } from "../api/format.js";
import { classifyError } from "../api/errors.js";
import {
  getObject,
  createObject,
  queryObjects,
} from "../services/object.service.js";
import { buildListQuery } from "../utils/index.js";

const API_KEY = "visitRecord";
const LIST_FIELDS = ["id", "content", "visitDate", "customerId", "creator"];

interface CmdOpts {
  format: "json" | "table" | "raw";
  fields?: string;
  data?: string;
  page?: string;
  size?: string;
}

function fmt(opts: CmdOpts) { return opts.format; }
function fld(opts: CmdOpts) { return opts.fields?.split(",").map(s => s.trim()).filter(Boolean); }
function data(opts: CmdOpts) { return JSON.parse(opts.data || "{}"); }
function err(e: unknown) { const m = classifyError(e); console.log(JSON.stringify({ status: "error", message: m.message })); process.exitCode = 1; }

export function registerVisitCommands(parent: Command): void {
  const visit = parent.command("visit").description("跟进操作");

  // list
  visit.command("list")
    .description("跟进列表")
    .option("--format <format>", "输出格式", "json")
    .option("--fields <fields>", "输出字段")
    .option("--page <n>", "页码", "1")
    .option("--size <n>", "每页条数", "20")
    .action(withAuth(async (opts: CmdOpts) => {
      try {
        const page = parseInt(opts.page || "1");
        const size = parseInt(opts.size || "20");
        const offset = (page - 1) * size;
        const sql = buildListQuery(API_KEY, LIST_FIELDS, { offset, size });
        const resp = await queryObjects(sql);
        console.log(formatOutput(resp, { format: fmt(opts), fields: fld(opts) }));
      } catch (e) { err(e); }
    }));

  // get
  visit.command("get")
    .description("跟进详情")
    .argument("<id>", "跟进 ID")
    .option("--format <format>", "输出格式", "json")
    .option("--fields <fields>", "输出字段")
    .action(withAuth(async (id: string, opts: CmdOpts) => {
      try {
        const resp = await getObject(API_KEY, id);
        console.log(formatOutput(resp, { format: fmt(opts), fields: fld(opts) }));
      } catch (e) { err(e); }
    }));

  // create
  visit.command("create")
    .description("创建跟进")
    .requiredOption("--data <json>", "跟进数据 JSON")
    .option("--format <format>", "输出格式", "json")
    .action(withAuth(async (opts: CmdOpts) => {
      try {
        const resp = await createObject(API_KEY, data(opts));
        console.log(formatOutput(resp, { format: fmt(opts) }));
      } catch (e) { err(e); }
    }));
}
