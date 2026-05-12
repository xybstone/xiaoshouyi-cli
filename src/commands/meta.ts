// meta / schema 命令 — Agent 发现接口

import { Command } from "commander";
import { API_KEY_MAP } from "../config.js";

// 收集所有已注册的命令信息
function collectCommands(cmd: Command): { name: string; description: string; subcommands: ReturnType<typeof collectCommands>[] }[] {
  const result: ReturnType<typeof collectCommands>[] = [];
  for (const c of (cmd as unknown as { commands: Command[] }).commands || []) {
    result.push({
      name: c.name(),
      description: c.description(),
      subcommands: collectCommands(c),
    });
  }
  return result;
}

export function registerMetaCommands(parent: Command): void {
  const meta = parent.command("meta").description("元数据");

  // ---- xsy meta ls ----
  meta
    .command("ls")
    .description("列出所有常用业务对象 apiKey 及其中文名")
    .action(() => {
      const entries = Object.entries(API_KEY_MAP).map(([key, val]) => ({
        name: key,
        label: val.label,
        apiKey: val.apiKey,
      }));
      console.log(JSON.stringify(entries, null, 2));
    });

  // ---- xsy schema ----
  // 顶层 schema 命令，列出所有已注册命令
  parent
    .command("schema")
    .description("列出所有命令（JSON 格式，供 Agent 发现）")
    .argument("[path]", "命令路径（预留）")
    .action((path?: string) => {
      if (path) {
        console.log(JSON.stringify({
          message: `Schema for '${path}' not yet implemented. Use 'xsy <command> --help' for option details.`,
        }));
        return;
      }

      const commands = collectCommands(parent);
      // 过滤掉 help 命令
      const filtered = commands.filter((c) => c.name !== "help");
      console.log(JSON.stringify(filtered, null, 2));
    });
}
