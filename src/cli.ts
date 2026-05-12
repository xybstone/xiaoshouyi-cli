// xiaoshouyi-cli 主入口 — Commander CLI 组装

import { Command } from "commander";
import { registerAuthCommands } from "./commands/auth.js";
import { registerCrudCommands } from "./commands/crud.js";
import { registerAccountCommands } from "./commands/account.js";
import { registerOpportunityCommands } from "./commands/opportunity.js";
import { registerVisitCommands } from "./commands/visit.js";

const program = new Command();

program
  .name("xsy")
  .description("销售易 CRM 命令行工具")
  .version("0.1.0")
  .option("--format <format>", "输出格式: json | table | raw", "json")
  .option("--jq <expr>", "jq 表达式过滤 JSON 输出")
  .option("--fields <fields>", "只输出指定字段，逗号分隔")
  .option("-v, --verbose", "详细输出")
  .option("--debug", "调试输出")
  .option("-y, --yes", "跳过确认（危险操作必须）")
  .option("--dry-run", "预览不执行")
  .option("--timeout <seconds>", "HTTP 超时（秒）", "30");

// ---- Phase 2: 认证 ----
registerAuthCommands(program);

// ---- Phase 4: 通用 CRUD ----
registerCrudCommands(program);

// ---- Phase 5: 语义别名 ----
registerAccountCommands(program);
registerOpportunityCommands(program);
registerVisitCommands(program);

program.parse();
