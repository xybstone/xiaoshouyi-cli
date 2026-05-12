// 工具函数

import type { ApiResponse } from "../types/index.js";

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

export function charWidth(str: string): number {
  let w = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0)!;
    // CJK Unified Ideographs, CJK Extension A, CJK Compatibility Ideographs,
    // and fullwidth forms (FF01-FF60, FFE0-FFE6)
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xff01 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

function padEndCJK(str: string, width: number): string {
  const need = width - charWidth(str);
  return str + " ".repeat(Math.max(0, need));
}

export function formatTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "(empty)";

  const keys = Object.keys(rows[0]);
  const widths: Record<string, number> = {};

  for (const key of keys) {
    widths[key] = Math.max(
      charWidth(key),
      ...rows.map((r) => charWidth(String(r[key] ?? "")))
    );
  }

  const header =
    "| " + keys.map((k) => padEndCJK(k, widths[k])).join(" | ") + " |";
  const separator =
    "|-" + keys.map((k) => "-".repeat(widths[k])).join("-|-") + "-|";
  const body = rows
    .map(
      (r) =>
        "| " +
        keys.map((k) => padEndCJK(String(r[k] ?? ""), widths[k])).join(" | ") +
        " |"
    )
    .join("\n");

  return [header, separator, body].join("\n");
}
