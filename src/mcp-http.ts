import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import pkg from "../package.json" with { type: "json" };
import { callMcpTool, mcpToolDefinitions } from "./mcp-tools.js";
import { TicketError } from "./tickets/types.js";

export interface McpHttpOptions {
  host: string;
  port: number;
  token?: string;
  allowedHosts?: string[];
  allowedOrigins?: string[];
}
const loopbacks = new Set(["127.0.0.1", "localhost", "::1"]);
const MAX_BODY = 1024 * 1024;

export function mcpHttpOptions(env: NodeJS.ProcessEnv = process.env): McpHttpOptions {
  const value = env.XSY_MCP_HTTP_PORT || "3333";
  if (!/^\d+$/.test(value)) throw new Error("XSY_MCP_HTTP_PORT 必须为整数");
  const options: McpHttpOptions = {
    host: env.XSY_MCP_HTTP_HOST || "127.0.0.1", port: Number(value),
    token: env.XSY_MCP_HTTP_TOKEN || undefined,
    allowedHosts: env.XSY_MCP_HTTP_ALLOWED_HOSTS?.split(",").map(v => v.trim()).filter(Boolean),
    allowedOrigins: env.XSY_MCP_HTTP_ALLOWED_ORIGINS?.split(",").map(v => v.trim()).filter(Boolean),
  };
  validateOptions(options);
  return options;
}

function validateOptions(options: McpHttpOptions) {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
    throw new Error("XSY_MCP_HTTP_PORT 必须在0至65535之间");
  if (!loopbacks.has(options.host)) {
    if (Buffer.byteLength(options.token ?? "") < 32)
      throw new Error("非回环监听需要至少32字节的 XSY_MCP_HTTP_TOKEN");
    if (!options.allowedHosts?.length)
      throw new Error("非回环监听需要 XSY_MCP_HTTP_ALLOWED_HOSTS（域名或IP及端口）");
  }
  for (const authority of options.allowedHosts ?? []) {
    try {
      const url = new URL(`http://${authority}`);
      if (url.hostname.includes("*") || url.host !== authority.toLowerCase() || url.pathname !== "/" || url.username || url.password || url.search || url.hash)
        throw new Error();
    } catch { throw new Error("无效 XSY_MCP_HTTP_ALLOWED_HOSTS；须使用明确的主机及端口"); }
  }
  for (const origin of options.allowedOrigins ?? []) {
    try {
      const url = new URL(origin);
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin || url.username || url.password)
        throw new Error();
    } catch { throw new Error("无效 XSY_MCP_HTTP_ALLOWED_ORIGINS；须使用明确的HTTP origin"); }
  }
}

function jsonError(res: ServerResponse, status: number, message: string, code = -32000) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }));
}

class BodyError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (Number(req.headers["content-length"]) > MAX_BODY) {
    req.resume(); throw new BodyError(413, "请求超过1MiB");
  }
  const raw = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) { chunks.length = 0; reject(new BodyError(413, "请求超过1MiB")); }
      else chunks.push(chunk);
    });
    req.once("end", () => resolve(Buffer.concat(chunks)));
    req.once("error", () => reject(new BodyError(400, "读取请求失败")));
    req.once("aborted", () => reject(new BodyError(400, "请求已中断")));
  });
  try { return JSON.parse(raw.toString("utf8")); }
  catch { throw new BodyError(400, "JSON解析失败"); }
}

function protocolServer() {
  const server = new Server({ name: "xsy-sales", version: pkg.version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpToolDefinitions() }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    try {
      const result = await callMcpTool(request.params.name, request.params.arguments ?? {});
      return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({
        code: error instanceof TicketError ? error.code : "TOOL_ERROR",
        message: error instanceof Error ? error.message : "工具调用失败",
        details: error instanceof TicketError ? error.details : undefined,
      }) }] };
    }
  });
  return server;
}

// Stateless Streamable HTTP: each POST has its own SDK transport and SSE reply.
// Tool state and write confirmation remain in the shared service/operation store.
export function createMcpHttpServer(options: McpHttpOptions) {
  validateOptions(options);
  const expectedToken = options.token ? createHash("sha256").update(`Bearer ${options.token}`).digest() : undefined;
  const http = createServer((req, res) => { void handle(req, res).catch(() => {
    if (!res.headersSent && !res.destroyed) jsonError(res, 500, "MCP请求处理失败", -32603);
    else res.end();
  }); });
  http.requestTimeout = 60_000;
  http.headersTimeout = 15_000;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const address = http.address();
    const port = address && typeof address !== "string" ? address.port : options.port;
    const defaults = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    const hosts = new Set([...(loopbacks.has(options.host) ? defaults : []), ...(options.allowedHosts ?? []).map(v => v.toLowerCase())]);
    if (!req.headers.host || !hosts.has(req.headers.host.toLowerCase())) {
      jsonError(res, 403, "Host不在允许范围"); return;
    }
    const origins = new Set([...hosts].map(host => `http://${host}`).concat(options.allowedOrigins ?? []));
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin)) { jsonError(res, 403, "Origin不在允许范围"); return; }
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Expose-Headers", "MCP-Session-Id, MCP-Protocol-Version");
    }
    if (req.method === "OPTIONS" && req.url === "/mcp") {
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID",
      }).end(); return;
    }
    if (expectedToken) {
      const supplied = createHash("sha256").update(req.headers.authorization ?? "").digest();
      if (!timingSafeEqual(supplied, expectedToken)) {
        res.setHeader("WWW-Authenticate", "Bearer"); jsonError(res, 401, "需要有效的服务访问令牌"); return;
      }
    }
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: "xsy-sales", transport: "streamable-http", sessionMode: "stateless", version: pkg.version })); return;
    }
    if (req.url !== "/mcp") { jsonError(res, 404, "接口不存在"); return; }
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST, OPTIONS"); jsonError(res, 405, "此无状态MCP端点使用POST请求；响应可为SSE流"); return;
    }
    if (req.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
      jsonError(res, 415, "Content-Type须为application/json"); return;
    }
    let parsed: unknown;
    try { parsed = await body(req); }
    catch (error) {
      if (error instanceof BodyError && !res.destroyed) jsonError(res, error.status, error.message, error.status === 400 ? -32700 : -32000);
      return;
    }
    const server = protocolServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.once("close", () => { void server.close().catch(() => {}); });
    try { await server.connect(transport); await transport.handleRequest(req, res, parsed); }
    catch {
      await server.close().catch(() => {});
      if (!res.headersSent) jsonError(res, 500, "MCP请求处理失败", -32603);
      else res.end();
    }
  }
  return http;
}
