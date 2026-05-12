// 工具函数

import type { QueryResult, ApiResponse } from "./types/index.js";

export function isApiError(
  response: ApiResponse
): boolean {
  return response.code !== 200;
}

export function buildListQuery(
  apiKey: string,
  fields: string[],
  options?: {
    where?: string;
    order?: string;
    offset?: number;
    size?: number;
  }
): string {
  const select = fields.join(",");
  let sql = `select ${select} from ${apiKey}`;

  if (options?.where) sql += ` where ${options.where}`;
  if (options?.order) sql += ` order by ${options.order}`;
  if (options?.offset !== undefined || options?.size !== undefined) {
    const off = options.offset ?? 0;
    const size = options.size ?? 20;
    sql += ` limit ${off},${size}`;
  }

  return sql;
}

export function buildSearchQuery(
  apiKey: string,
  fields: string[],
  keyword: string,
  searchFields: string[]
): string {
  const select = fields.join(",");
  const conditions = searchFields
    .map((f) => `${f} like '${escapeSql(keyword)}%'`)
    .join(" or ");
  return `select ${select} from ${apiKey} where ${conditions}`;
}

export function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

export function extractError(response: ApiResponse): string {
  return response.msg || `API error (code: ${response.code})`;
}

export function paginateResults<T>(
  records: T[],
  page: number,
  size: number
): { data: T[]; total: number; page: number; size: number; hasMore: boolean } {
  const total = records.length;
  const start = (page - 1) * size;
  const data = records.slice(start, start + size);
  return {
    data,
    total,
    page,
    size,
    hasMore: start + size < total,
  };
}

export function formatTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "(empty)";

  const keys = Object.keys(rows[0]);
  const widths: Record<string, number> = {};

  for (const key of keys) {
    widths[key] = Math.max(
      key.length,
      ...rows.map((r) => String(r[key] ?? "").length)
    );
  }

  const header =
    "| " + keys.map((k) => k.padEnd(widths[k])).join(" | ") + " |";
  const separator =
    "|-" + keys.map((k) => "-".repeat(widths[k])).join("-|-") + "-|";
  const body = rows
    .map(
      (r) =>
        "| " +
        keys.map((k) => String(r[k] ?? "").padEnd(widths[k])).join(" | ") +
        " |"
    )
    .join("\n");

  return [header, separator, body].join("\n");
}
