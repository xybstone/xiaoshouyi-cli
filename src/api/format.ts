// 响应格式化输出 — json / table / raw

import { formatTable } from "../utils/index.js";
import type { ApiResponse } from "../types/index.js";

type OutputFormat = "json" | "table" | "raw";

interface FormatOptions {
  format: OutputFormat;
  fields?: string[];
  jq?: string; // 留作扩展
}

// 主格式化入口
export function formatOutput(
  response: ApiResponse,
  options: FormatOptions
): string {
  if (response.code !== 200) {
    // 错误响应统一 JSON 输出
    return JSON.stringify({ code: response.code, msg: response.msg }, null, 2);
  }

  const result = response.result;

  switch (options.format) {
    case "json":
      return JSON.stringify(result, null, 2);
    case "table":
      return formatAsTable(result, options.fields);
    case "raw":
      if (typeof result === "string") return result;
      if (Array.isArray(result)) return result.map(String).join("\n");
      return JSON.stringify(result);
    default:
      return JSON.stringify(result, null, 2);
  }
}

// 将 result 转为表格字符串
function formatAsTable(
  result: unknown,
  fields?: string[]
): string {
  // 列表查询结果: { totalSize, count, records: [...] }
  if (result && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    if (Array.isArray(obj.records)) {
      return formatTableRows(obj.records as Record<string, unknown>[], fields)
        + `\n(${obj.count ?? 0} of ${obj.totalSize ?? 0} records)`;
    }
  }

  // 单条记录: { id, field1, field2, ... }
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;
    if (Object.keys(obj).length > 0) {
      return formatTableRows([obj], fields);
    }
  }

  // 数组
  if (Array.isArray(result)) {
    return formatTableRows(result as Record<string, unknown>[], fields);
  }

  // fallback
  return String(result);
}

function formatTableRows(
  rows: Record<string, unknown>[],
  fields?: string[]
): string {
  if (fields && fields.length > 0) {
    rows = rows.map((row) => {
      const filtered: Record<string, unknown> = {};
      for (const f of fields) filtered[f] = row[f];
      return filtered;
    });
  }
  return formatTable(rows);
}
