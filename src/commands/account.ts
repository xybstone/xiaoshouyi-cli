// account 语义别名命令 — list / search / get / create / update / delete

import { Command } from "commander";
import { withAuth } from "../middleware/auth-check.js";
import { formatOutput } from "../api/format.js";
import { fmt, parseFields, parseData, handleError } from "./shared.js";
import {
  getObject,
  createObject,
  updateObject,
  deleteObject,
  queryObjects,
} from "../services/object.service.js";
import { buildListQuery, buildSearchQuery } from "../utils/index.js";
import { fetchActivityRecords } from "../api/crm-client.js";

const API_KEY = "account";
const LIST_FIELDS = ["id", "accountName", "phone", "createdAt"];
const SEARCH_FIELDS = ["accountName"];
const SORTABLE_FIELDS = ["id", "accountName", "createdAt"];

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

function resolveSort(sort?: string, order?: string): string | undefined {
  if (!sort || !SORTABLE_FIELDS.includes(sort)) return undefined;
  const dir = order === "asc" ? "asc" : "desc";
  return `${sort} ${dir}`;
}

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
    .option("--order <asc|desc>", "排序方向", "desc")
    .action(withAuth(async (opts: CmdOpts) => {
      try {
        const page = parseInt(opts.page || "1");
        const size = parseInt(opts.size || "20");
        const offset = (page - 1) * size;
        const orderBy = resolveSort(opts.sort, opts.order);
        const sql = buildListQuery(API_KEY, LIST_FIELDS, {
          offset, size,
          order: orderBy,  // e.g. "id desc" — buildListQuery 会加 order by
        });
        const resp = await queryObjects(sql);
        console.log(formatOutput(resp, { format: fmt(opts), fields: parseFields(opts) }));
      } catch (e) { handleError(e); }
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
        console.log(formatOutput(resp, { format: fmt(opts), fields: parseFields(opts) }));
      } catch (e) { handleError(e); }
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
        console.log(formatOutput(resp, { format: fmt(opts), fields: parseFields(opts) }));
      } catch (e) { handleError(e); }
    }));

  // create
  acct.command("create")
    .description("创建客户")
    .requiredOption("--data <json>", "客户数据 JSON")
    .option("--format <format>", "输出格式", "json")
    .action(withAuth(async (opts: CmdOpts) => {
      try {
        const resp = await createObject(API_KEY, parseData(opts));
        console.log(formatOutput(resp, { format: fmt(opts) }));
      } catch (e) { handleError(e); }
    }));

  // update
  acct.command("update")
    .description("更新客户")
    .argument("<id>", "客户 ID")
    .requiredOption("--data <json>", "待更新字段 JSON")
    .option("--format <format>", "输出格式", "json")
    .action(withAuth(async (id: string, opts: CmdOpts) => {
      try {
        const resp = await updateObject(API_KEY, id, parseData(opts));
        console.log(formatOutput(resp, { format: fmt(opts) }));
      } catch (e) { handleError(e); }
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
      } catch (e) { handleError(e); }
    }));

  // follows — 客户下的跟进记录
  acct.command("follows")
    .description("客户的跟进记录")
    .argument("<id>", "客户 ID")
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
}
