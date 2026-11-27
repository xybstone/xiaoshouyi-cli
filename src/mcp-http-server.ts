try { process.loadEnvFile(); } catch { /* optional .env */ }
import { createMcpHttpServer, mcpHttpOptions } from "./mcp-http.js";

try {
  const options = mcpHttpOptions();
  const server = createMcpHttpServer(options);
  server.on("error", error => {
    const code = "code" in error ? String(error.code) : "START_FAILED";
    process.stderr.write(`MCP HTTP启动失败（${code}）\n`); process.exitCode = 1;
  });
  server.listen(options.port, options.host, () => {
    const address = server.address();
    const port = address && typeof address !== "string" ? address.port : options.port;
    const host = options.host.includes(":") ? `[${options.host}]` : options.host;
    process.stderr.write(`MCP Streamable HTTP: http://${host}:${port}/mcp\n`);
  });
  const shutdown = () => { server.close(); server.closeAllConnections(); };
  process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "MCP HTTP配置无效"}\n`);
  process.exitCode = 1;
}
