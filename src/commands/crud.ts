// 通用 CRUD 命令 — query / describe / get / create / update / delete

import { Command } from "commander";
import { withAuth } from "../middleware/auth-check.js";
import { formatOutput } from "../api/format.js";
import { classifyError } from "../api/errors.js";
import {
  describeObject,
  getObject,
  createObject,
  updateObject,
  deleteObject,
  queryObjects,
} from "../services/object.service.js";

interface CrudOptions {
  format: "json" | "table" | "raw";
  fields?: string;
  data?: string;
  yes?: boolean;
}

function parseFields(opts: CrudOptions): string[] | undefined {
  if (!opts.fields) return undefined;
  return opts.fields.split(",").map((f) => f.trim()).filter(Boolean);
}

function parseData(opts: CrudOptions): Record<string, unknown> {
  if (!opts.data) {
    throw new Error("--data is required, e.g. --data '{\"name\":\"value\"}'");
  }
  return JSON.parse(opts.data);
}

function handleError(err: unknown): void {
  const errObj = classifyError(err);
  console.log(JSON.stringify({ status: "error", message: errObj.message }));
  process.exitCode = 1;
}

export function registerCrudCommands(parent: Command): void {
  // ---- xsy query "<SQL>" ----
  parent
    .command("query")
    .description("SQL 查询")
    .argument("<sql>", "SQL 查询语句")
    .option("--format <format>", "输出格式", "json")
    .option("--fields <fields>", "只输出指定字段")
    .action(
      withAuth(async (sql: string, opts: CrudOptions) => {
        try {
          const response = await queryObjects(sql);
          const fields = parseFields(opts);
          const output = formatOutput(response, { format: opts.format, fields });
          console.log(output);
        } catch (err) {
          handleError(err);
        }
      })
    );

  // ---- xsy describe <apiKey> ----
  parent
    .command("describe")
    .description("获取对象字段元数据")
    .argument("<apiKey>", "对象 apiKey")
    .option("--format <format>", "输出格式", "json")
    .option("--fields <fields>", "只输出指定字段")
    .action(
      withAuth(async (apiKey: string, opts: CrudOptions) => {
        try {
          const response = await describeObject(apiKey);
          const fields = parseFields(opts);
          const output = formatOutput(response, { format: opts.format, fields });
          console.log(output);
        } catch (err) {
          handleError(err);
        }
      })
    );

  // ---- xsy get <apiKey> <id> ----
  parent
    .command("get")
    .description("获取单条记录")
    .argument("<apiKey>", "对象 apiKey")
    .argument("<id>", "记录 ID")
    .option("--format <format>", "输出格式", "json")
    .option("--fields <fields>", "只输出指定字段")
    .action(
      withAuth(async (apiKey: string, id: string, opts: CrudOptions) => {
        try {
          const response = await getObject(apiKey, id);
          const fields = parseFields(opts);
          const output = formatOutput(response, { format: opts.format, fields });
          console.log(output);
        } catch (err) {
          handleError(err);
        }
      })
    );

  // ---- xsy create <apiKey> ----
  parent
    .command("create")
    .description("创建记录")
    .argument("<apiKey>", "对象 apiKey")
    .requiredOption("--data <json>", "记录数据 JSON")
    .option("--format <format>", "输出格式", "json")
    .action(
      withAuth(async (apiKey: string, opts: CrudOptions) => {
        try {
          const data = parseData(opts);
          const response = await createObject(apiKey, data);
          const output = formatOutput(response, { format: opts.format });
          console.log(output);
        } catch (err) {
          handleError(err);
        }
      })
    );

  // ---- xsy update <apiKey> <id> ----
  parent
    .command("update")
    .description("更新记录")
    .argument("<apiKey>", "对象 apiKey")
    .argument("<id>", "记录 ID")
    .requiredOption("--data <json>", "待更新字段 JSON")
    .option("--format <format>", "输出格式", "json")
    .action(
      withAuth(async (apiKey: string, id: string, opts: CrudOptions) => {
        try {
          const data = parseData(opts);
          const response = await updateObject(apiKey, id, data);
          const output = formatOutput(response, { format: opts.format });
          console.log(output);
        } catch (err) {
          handleError(err);
        }
      })
    );

  // ---- xsy delete <apiKey> <id> ----
  parent
    .command("delete")
    .description("删除记录（不可逆）")
    .argument("<apiKey>", "对象 apiKey")
    .argument("<id>", "记录 ID")
    .option("-y, --yes", "确认删除（必须提供）")
    .option("--format <format>", "输出格式", "json")
    .action(
      withAuth(async (apiKey: string, id: string, opts: CrudOptions) => {
        if (!opts.yes) {
          console.log(JSON.stringify({
            status: "error",
            message: `危险操作：将删除 ${apiKey}/${id}，请加 --yes 确认`,
          }));
          process.exitCode = 1;
          return;
        }
        try {
          const response = await deleteObject(apiKey, id);
          const output = formatOutput(response, { format: opts.format });
          console.log(output);
        } catch (err) {
          handleError(err);
        }
      })
    );
}
