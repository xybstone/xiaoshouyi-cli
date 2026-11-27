import { ApiError } from "../api/errors.js";
import {
  object,
  fail,
  type TicketMetadata,
  type TicketField,
  type RecordData,
} from "./types.js";

export function decodeResponse(
  raw: unknown,
  bodyKey: "data" | "result",
): unknown {
  const response = object(raw);
  if (response.code !== 200 && response.code !== "200")
    throw new ApiError(
      Number(response.code) || 502,
      typeof response.msg === "string" ? response.msg : "CRM 返回无效响应",
    );
  if (!(bodyKey in response))
    fail("INVALID_RESPONSE", `CRM 响应缺少 ${bodyKey}`);
  return response[bodyKey];
}
export function normalizeMetadata(raw: unknown): TicketMetadata {
  const response = object(raw);
  const data = object(
    decodeResponse(raw, "data" in response ? "data" : "result"),
  );
  if (data.apiKey !== "fieldJob" || !Array.isArray(data.fields))
    fail("INVALID_METADATA", "fieldJob 元数据格式不符");
  const fields: TicketField[] = data.fields.map((value) => {
    const f = object(value);
    const apiKey = f.apiKey ?? f.propertyname;
    if (typeof apiKey !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(apiKey))
      fail("INVALID_METADATA", "无效字段 API Key");
    const rawOptions = f.options ?? f.selectitem;
    const options = Array.isArray(rawOptions)
      ? rawOptions
          .filter(
            (v) =>
              object(v).enabled !== false &&
              object(v).active !== false &&
              object(v).isActive !== false,
          )
          .map((v) => {
            const o = object(v);
            return {
              value: o.value ?? o.id,
              label: String(o.label ?? o.name ?? ""),
            };
          })
      : [];
    const bool = (v: unknown): boolean | undefined =>
      typeof v === "boolean" ? v : undefined;
    return {
      apiKey,
      label: String(f.label ?? apiKey),
      type: String(f.type ?? "unknown"),
      required: f.required === true,
      createable: bool(f.createable ?? f.creatable),
      updateable: bool(f.updateable ?? f.updatable),
      enabled: bool(f.enabled),
      options,
    };
  });
  const flags: RecordData = {};
  for (const key of [
    "disabled",
    "queryable",
    "createable",
    "updateable",
    "deletable",
    "permissions",
  ])
    if (key in data) flags[key] = data[key];
  return { apiKey: "fieldJob", fields, flags };
}
