import { afterEach, describe, expect, it } from "vitest";
import { request, type Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpHttpServer, mcpHttpOptions, type McpHttpOptions } from "../../src/mcp-http.js";

const servers: Server[] = [], clients: Client[] = [];
afterEach(async () => {
  await Promise.all(clients.splice(0).map(client => client.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve()); server.closeAllConnections();
  })));
});
async function start(overrides: Partial<McpHttpOptions> = {}) {
  const server = createMcpHttpServer({ host: "127.0.0.1", port: 0, ...overrides });
  servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic loopback listener unavailable");
  return `http://127.0.0.1:${address.port}`;
}
async function connect(url: string, token?: string) {
  const client = new Client({ name: "synthetic-http-test", version: "1.0.0" });
  clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp"), token ? {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  } : undefined));
  return client;
}
const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "synthetic", version: "1.0.0" },
} };

describe("MCP HTTP configuration", () => {
  it("defaults to the loopback interface and validates environment options", () => {
    expect(mcpHttpOptions({})).toMatchObject({ host: "127.0.0.1", port: 3333 });
    expect(mcpHttpOptions({ XSY_MCP_HTTP_PORT: "12345" }).port).toBe(12345);
  });
  it.each(["abc", "3333suffix", "-1", "1.2", "65536"])("rejects invalid port %s", port => {
    expect(() => mcpHttpOptions({ XSY_MCP_HTTP_PORT: port })).toThrow();
  });
  it("requires both a private access token and an explicit Host allowlist for non-loopback binds", () => {
    expect(() => mcpHttpOptions({ XSY_MCP_HTTP_HOST: "0.0.0.0" })).toThrow(/TOKEN/);
    expect(() => mcpHttpOptions({ XSY_MCP_HTTP_HOST: "0.0.0.0", XSY_MCP_HTTP_TOKEN: "s".repeat(32) })).toThrow(/HOSTS/);
    expect(mcpHttpOptions({ XSY_MCP_HTTP_HOST: "0.0.0.0", XSY_MCP_HTTP_TOKEN: "s".repeat(32), XSY_MCP_HTTP_ALLOWED_HOSTS: "mcp.example.test:3333" }).host).toBe("0.0.0.0");
  });
  it.each(["*", "host.test/path", "user:pass@host.test", "host.test?token=secret"])("rejects invalid Host allowlist %s", allowedHosts => {
    expect(() => mcpHttpOptions({ XSY_MCP_HTTP_ALLOWED_HOSTS: allowedHosts })).toThrow();
  });
  it.each(["*", "null", "https://app.example.test/path", "https://user:pass@app.example.test"])("rejects invalid allowed Origin %s", origin => {
    expect(() => mcpHttpOptions({ XSY_MCP_HTTP_ALLOWED_ORIGINS: origin })).toThrow();
  });
});

describe("official MCP client over real loopback Streamable HTTP, synthetic tools only", () => {
  it("initializes, discovers the same tools, and calls the shared capability handler", async () => {
    const client = await connect(await start());
    expect(client.getServerVersion()?.name).toBe("xsy-sales");
    const tools = (await client.listTools()).tools;
    expect(tools).toHaveLength(19);
    expect(tools.filter(tool => tool.name.startsWith("tickets_"))).toHaveLength(11);
    expect(tools.some(tool => ["tickets_execute", "tickets_operation_review"].includes(tool.name))).toBe(false);
    const result = await client.callTool({ name: "tickets_capabilities", arguments: {} });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse((result.content as Array<{ text: string }>)[0].text);
    expect(parsed.actions).toHaveLength(23);
    expect(parsed.actions.every((action: { executable: boolean }) => !action.executable)).toBe(true);
  });
  it("returns an actual SSE response and accepts initialized notifications with HTTP202", async () => {
    const url = await start();
    const response = await fetch(url + "/mcp", { method: "POST", headers, body: JSON.stringify(initialize) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("mcp-session-id")).toBeNull();
    expect(await response.text()).toContain('"protocolVersion":"2025-06-18"');
    const notification = await fetch(url + "/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    expect(notification.status).toBe(202);
  });
  it("preserves tool validation and unverified-action results without CRM calls", async () => {
    const client = await connect(await start());
    const bad = await client.callTool({ name: "tickets_get", arguments: { id: "invalid" } });
    expect(bad.isError).toBe(true);
    expect(JSON.parse((bad.content as Array<{ text: string }>)[0].text).code).toBe("VALIDATION_FAILED");
    const blocked = await client.callTool({ name: "tickets_prepare", arguments: { action: "close", id: "1" } });
    expect(JSON.parse((blocked.content as Array<{ text: string }>)[0].text)).toMatchObject({ status: "blocked", code: "UNVERIFIED" });
    const disabled = await client.callTool({ name: "tickets_execute", arguments: {} });
    expect(disabled.isError).toBe(true);
    expect(JSON.parse((disabled.content as Array<{ text: string }>)[0].text).code).toBe("UNSUPPORTED");
  });
  it("serves independent concurrent clients", async () => {
    const url = await start();
    const connected = await Promise.all([connect(url), connect(url)]);
    const lists = await Promise.all(connected.map(client => client.listTools()));
    expect(lists.map(list => list.tools.length)).toEqual([19, 19]);
  });
  it("requires the service token on health and MCP when configured", async () => {
    const token = "synthetic-http-access-token-32-bytes-minimum";
    const url = await start({ token });
    expect((await fetch(url + "/health")).status).toBe(401);
    expect((await fetch(url + "/health", { headers: { Authorization: "Bearer invalid" } })).status).toBe(401);
    const client = await connect(url, token);
    expect((await client.listTools()).tools).toHaveLength(19);
  });
  it("rejects foreign and null browser origins before tools are called", async () => {
    const url = await start();
    for (const origin of ["https://foreign.example.test", "null"]) {
      const response = await fetch(url + "/mcp", { method: "POST", headers: { ...headers, Origin: origin }, body: JSON.stringify(initialize) });
      expect(response.status).toBe(403);
    }
  });
  it("rejects DNS rebinding Host headers on all routes", async () => {
    const url = await start();
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(url + "/health", { headers: { Host: "foreign.example.test" } }, res => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.end();
    });
    expect(status).toBe(403);
  });
  it("supports explicit browser CORS without a wildcard", async () => {
    const origin = "https://trusted.example.test", url = await start({ allowedOrigins: [origin] });
    const response = await fetch(url + "/mcp", { method: "OPTIONS", headers: { Origin: origin, "Access-Control-Request-Method": "POST" } });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("access-control-allow-headers")).toContain("MCP-Protocol-Version");
  });
  it("rejects bad media, malformed JSON and oversized fixed-length or chunked bodies", async () => {
    const url = await start();
    expect((await fetch(url + "/mcp", { method: "POST", body: "text" })).status).toBe(415);
    expect((await fetch(url + "/mcp", { method: "POST", headers, body: "{invalid" })).status).toBe(400);
    expect((await fetch(url + "/mcp", { method: "POST", headers, body: "x".repeat(1024 * 1024 + 1) })).status).toBe(413);
    const chunked = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(url + "/mcp", { method: "POST", headers }, res => { res.resume(); resolve(res.statusCode); });
      req.on("error", reject); req.write("x".repeat(700000)); req.end("x".repeat(700000));
    });
    expect(chunked).toBe(413);
  });
  it("delegates Accept and protocol-version validation to the SDK", async () => {
    const url = await start();
    expect((await fetch(url + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(initialize) })).status).toBe(406);
    expect((await fetch(url + "/mcp", { method: "POST", headers: { ...headers, "MCP-Protocol-Version": "unknown" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }) })).status).toBe(400);
  });
  it("provides health and a protocol-compliant405 for unsupported standalone SSE and DELETE", async () => {
    const url = await start();
    const health = await fetch(url + "/health");
    expect(await health.json()).toMatchObject({ status: "ok", transport: "streamable-http", sessionMode: "stateless" });
    for (const method of ["GET", "DELETE", "PUT"]) expect((await fetch(url + "/mcp", { method })).status).toBe(405);
    expect((await fetch(url + "/sse")).status).toBe(404);
  });
});
