// opportunity 语义别名命令 — list / search / get / create / update / delete + stages

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

const API_KEY = "opportunity";
const LIST_FIELDS = ["id", "opportunityName", "money", "createdAt"];
const SEARCH_FIELDS = ["opportunityName"];

interface CmdOpts {
  format: "json" | "table" | "raw";
  fields?: string;
  data?: string;
  yes?: boolean;
  page?: string;
  size?: string;
}

export function registerOpportunityCommands(parent: Command): void {
  const opp = parent.command("opportunity").description("商机操作");

  // list
  opp.command("list")
    .description("商机列表")
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
        console.log(formatOutput(resp, { format: fmt(opts), fields: parseFields(opts) }));
      } catch (e) { handleError(e); }
    }));

  // search
  opp.command("search")
    .description("商机搜索")
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
  opp.command("get")
    .description("商机详情")
    .argument("<id>", "商机 ID")
    .option("--format <format>", "输出格式", "json")
    .option("--fields <fields>", "输出字段")
    .action(withAuth(async (id: string, opts: CmdOpts) => {
      try {
        const resp = await getObject(API_KEY, id);
        console.log(formatOutput(resp, { format: fmt(opts), fields: parseFields(opts) }));
      } catch (e) { handleError(e); }
    }));

  // create
  opp.command("create")
    .description("创建商机")
    .requiredOption("--data <json>", "商机数据 JSON")
    .option("--format <format>", "输出格式", "json")
    .action(withAuth(async (opts: CmdOpts) => {
      try {
        const resp = await createObject(API_KEY, parseData(opts));
        console.log(formatOutput(resp, { format: fmt(opts) }));
      } catch (e) { handleError(e); }
    }));

  // update
  opp.command("update")
    .description("更新商机")
    .argument("<id>", "商机 ID")
    .requiredOption("--data <json>", "待更新字段 JSON")
    .option("--format <format>", "输出格式", "json")
    .action(withAuth(async (id: string, opts: CmdOpts) => {
      try {
        const resp = await updateObject(API_KEY, id, parseData(opts));
        console.log(formatOutput(resp, { format: fmt(opts) }));
      } catch (e) { handleError(e); }
    }));

  // delete
  opp.command("delete")
    .description("删除商机")
    .argument("<id>", "商机 ID")
    .option("-y, --yes", "确认删除")
    .option("--format <format>", "输出格式", "json")
    .action(withAuth(async (id: string, opts: CmdOpts) => {
      if (!opts.yes) {
        console.log(JSON.stringify({ status: "error", message: `危险操作：将删除商机 ${id}，请加 --yes 确认` }));
        process.exitCode = 1; return;
      }
      try {
        const resp = await deleteObject(API_KEY, id);
        console.log(formatOutput(resp, { format: fmt(opts) }));
      } catch (e) { handleError(e); }
    }));

  // stages
  opp.command("stages")
    .description("商机阶段定义")
    .option("--format <format>", "输出格式", "json")
    .action(withAuth(async (opts: CmdOpts) => {
      try {
        const resp = await queryObjects("select id,name from oppProcess order by id");
        console.log(formatOutput(resp, { format: fmt(opts) }));
      } catch (e) { handleError(e); }
    }));
}
