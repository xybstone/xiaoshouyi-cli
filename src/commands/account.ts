// account 语义别名命令 — list / search / get / create / update / delete

import { Command } from "commander";
import { withAuth } from "../middleware/auth-check.js";
import { formatOutput } from "../api/format.js";
import { classifyError } from "../api/errors.js";
import {
  getObject,
  createObject,
  updateObject,
  deleteObject,
  queryObjects,
} from "../services/object.service.js";
import { buildListQuery, buildSearchQuery, escapeSql } from "../utils/index.js";

const API_KEY = "account";
const LIST_FIELDS = ["id", "accountName", "phone", "industry", "createdAt"];
const SEARCH_FIELDS = ["accountName"];

interface CmdOpts {
  format: "json" | "table" | "raw";
  fields?: string;
  data?: string;
  yes?: boolean;
  page?: string;
  size?: string;
  sort?: string;
  order?: string;
}

function fmt(opts: CmdOpts) { return opts.format; }
function fld(opts: CmdOpts) { return opts.fields?.split(",").map(s => s.trim()).filter(Boolean); }
function data(opts: CmdOpts) { return JSON.parse(opts.data || "{}"); }
function err(e: unknown) { const m = classifyError(e); console.log(JSON.stringify({ status: "error", message: m.message })); process.exitCode = 1; }

export function registerAccountCommands(parent: Command): void {
  const acct = parent.command("account").description("客户操作");

  // list
  acct.command("list")
    .description("客户列表")
    .option("--format <format>", "输出格式", "json")
    .option("--fields <fields>", "输出字段")
    .option("--page <n>", "页码", "1")
    .option("--size <n>", "每页条数", "20")
    .option("--sort <field>", "排序字段")
    .option("--order <asc|desc>", "排序方向")
    .action(withAuth(async (opts: CmdOpts) => {
      try {
        const page = parseInt(opts.page || "1");
        const size = parseInt(opts.size || "20");
        const offset = (page - 1) * size;
        const orderBy = opts.sort ? `order by ${opts.sort}` : undefined;
        const orderDir = opts.order ? ` ${opts.order}` : "";
        const sql = buildListQuery(API_KEY, LIST_FIELDS, { offset, size, order: orderBy ? `${orderBy}${orderDir}` : undefined });
        const resp = await queryObjects(sql);
        console.log(formatOutput(resp, { format: fmt(opts), fields: fld(opts) }));
      } catch (e) { err(e); }
    }));

  // search
  acct.command("search")
    .description("客户搜索")
    .argument("<keyword>", "搜索关键词")
    .option("--format <format>", "输出格式", "json")
    .option("--fields <fields>", "输出字段")
    .action(withAuth(async (kw: string, opts: CmdOpts) => {
      try {
        const sql = buildSearchQuery(API_KEY, LIST_FIELDS, kw, SEARCH_FIELDS);
        const resp = await queryObjects(sql);
        console.log(formatOutput(resp, { format: fmt(opts), fields: fld(opts) }));
      } catch (e) { err(e); }
    }));

  // get
  acct.command("get")
    .description("客户详情")
    .argument("<id>", "客户 ID")
    .option("--format <format>", "输出格式", "json")
    .option("--fields <fields>", "输出字段")
    .action(withAuth(async (id: string, opts: CmdOpts) => {
      try {
        const resp = await getObject(API_KEY, id);
        console.log(formatOutput(resp, { format: fmt(opts), fields: fld(opts) }));
      } catch (e) { err(e); }
    }));

  // create
  acct.command("create")
    .description("创建客户")
    .requiredOption("--data <json>", "客户数据 JSON")
    .option("--format <format>", "输出格式", "json")
    .action(withAuth(async (opts: CmdOpts) => {
      try {
        const resp = await createObject(API_KEY, data(opts));
        console.log(formatOutput(resp, { format: fmt(opts) }));
      } catch (e) { err(e); }
    }));

  // update
  acct.command("update")
    .description("更新客户")
    .argument("<id>", "客户 ID")
    .requiredOption("--data <json>", "待更新字段 JSON")
    .option("--format <format>", "输出格式", "json")
    .action(withAuth(async (id: string, opts: CmdOpts) => {
      try {
        const resp = await updateObject(API_KEY, id, data(opts));
        console.log(formatOutput(resp, { format: fmt(opts) }));
      } catch (e) { err(e); }
    }));

  // delete
  acct.command("delete")
    .description("删除客户")
    .argument("<id>", "客户 ID")
    .option("-y, --yes", "确认删除")
    .option("--format <format>", "输出格式", "json")
    .action(withAuth(async (id: string, opts: CmdOpts) => {
      if (!opts.yes) {
        console.log(JSON.stringify({ status: "error", message: `危险操作：将删除客户 ${id}，请加 --yes 确认` }));
        process.exitCode = 1; return;
      }
      try {
        const resp = await deleteObject(API_KEY, id);
        console.log(formatOutput(resp, { format: fmt(opts) }));
      } catch (e) { err(e); }
    }));
}
