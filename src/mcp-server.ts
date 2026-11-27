try { process.loadEnvFile(); } catch { /* optional .env */ }

import pkg from "../package.json" with { type: "json" };
import { createInterface } from "node:readline";
import { TicketError, object } from "./tickets/types.js";
import { callMcpTool, mcpToolDefinitions } from "./mcp-tools.js";

function jsonRpc(id: unknown, result: unknown): void { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n"); }
function error(id: unknown, code: number, message: string): void { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n"); }

async function main(): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    if (Buffer.byteLength(line) > 1024 * 1024) { error(null, -32600, "请求超过 1MiB"); continue; }
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { error(null, -32700, "JSON 解析失败"); continue; }
    const request = object(parsed);
    const id = request.id;
    if (request.jsonrpc !== "2.0" || typeof request.method !== "string" || id !== undefined && id !== null && typeof id !== "number" && typeof id !== "string") {
      error(null, -32600, "无效 JSON-RPC 请求"); continue;
    }
    if (id === undefined) continue;
    const params = object(request.params);
    if (request.method === "initialize") {
      const requested = String(params.protocolVersion ?? "");
      const protocolVersion = ["2025-06-18", "2025-03-26", "2024-11-05"].includes(requested) ? requested : "2025-06-18";
      jsonRpc(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "xsy-sales", version: pkg.version } });
    } else if (request.method === "ping") jsonRpc(id, {});
    else if (request.method === "tools/list") jsonRpc(id, { tools: mcpToolDefinitions() });
    else if (request.method === "tools/call") {
      if (typeof params.name !== "string" || params.arguments !== undefined && (params.arguments === null || typeof params.arguments !== "object" || Array.isArray(params.arguments))) {
        error(id, -32602, "工具参数格式无效"); continue;
      }
      try {
        const result = await callMcpTool(params.name, object(params.arguments));
        jsonRpc(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      } catch (err) {
        jsonRpc(id, { isError: true, content: [{ type: "text", text: JSON.stringify({ code: err instanceof TicketError ? err.code : "TOOL_ERROR", message: err instanceof Error ? err.message : "工具调用失败", details: err instanceof TicketError ? err.details : undefined }) }] });
      }
    } else error(id, -32601, "不支持的方法");
  }
}
void main().catch(() => { process.stderr.write("MCP 输入流异常\n"); process.exitCode = 1; });
