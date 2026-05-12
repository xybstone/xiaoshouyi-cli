// 语义命令共享工具 — fmt / parseFields / parseData / handleError

import { classifyError } from "../api/errors.js";

interface CmdOpts {
  format: "json" | "table" | "raw";
  fields?: string;
  data?: string;
}

export function fmt(opts: CmdOpts): "json" | "table" | "raw" {
  return opts.format;
}

export function parseFields(opts: CmdOpts): string[] | undefined {
  if (!opts.fields) return undefined;
  return opts.fields.split(",").map(s => s.trim()).filter(Boolean);
}

export function parseData(opts: CmdOpts): Record<string, unknown> {
  try {
    return JSON.parse(opts.data || "{}");
  } catch {
    throw new Error("--data 格式无效，请传入合法 JSON，例如: --data '{\"name\":\"value\"}'");
  }
}

export function handleError(e: unknown): void {
  const m = classifyError(e);
  console.log(JSON.stringify({ status: "error", message: m.message }));
  process.exitCode = 1;
}
