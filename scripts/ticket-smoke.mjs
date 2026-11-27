// 验证已构建入口。固定使用非真实 Token 和回环 API 地址，不连接 CRM。
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = mkdtempSync(path.join(os.tmpdir(), "xsy-ticket-smoke-"));
const env = {
  ...process.env,
  XSY_NEOCRM_PROJECT: "",
  XSY_ACCESS_TOKEN: "synthetic-smoke-token-not-valid",
  XSY_API_BASE_URL: "https://127.0.0.1:1",
  XSY_CRM_COOKIE: "",
  XSY_TICKET_CONTRACTS: "",
  XSY_TICKET_WRITES: "",
  XSY_TICKET_APPROVAL_SECRET: "",
  XSY_TICKET_STATE_DIR: path.join(temporary, "operations"),
};
function cli(args, expectedStatus = 0) {
  const result = spawnSync(process.execPath, ["dist/cli.js", ...args], {
    cwd: root,
    env,
    encoding: "utf8",
    timeout: 20000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(result.error);
  assert.equal(result.status, expectedStatus, result.stderr);
  return result;
}
try {
  const help = cli(["ticket", "--help"]).stdout;
  for (const command of ["prepare", "workflow", "service-report-preflight", "attachment-download-upload"])
    assert(help.includes(command));
  const capabilities = JSON.parse(
    cli(["ticket", "capabilities"]).stdout,
  ).result;
  assert.deepEqual(capabilities.actions.map((action) => action.action), [
    "create", "submit", "advance", "workflow_preprocess", "assign", "reassign", "accept", "reply",
    "activity_record", "pause", "resume", "escalate", "resolve", "complete", "close", "reopen", "return",
    "void", "attachment_upload", "attachment_link", "worklog", "report", "service_report",
  ]);
  const createCapability = capabilities.actions.find((action) => action.action === "create");
  assert.equal(createCapability.contract, "verified");
  assert.equal(createCapability.executable, false);
  assert(capabilities.actions.filter((action) => action.action !== "create")
    .every((action) => action.contract === "unverified" && !action.executable));
  assert.equal(capabilities.read.permission, "unknown");
  // Built-in creation reaches input validation instead of the old unverified
  // gate. An existing ID is invalid for create and never needs a CRM request.
  const invalidCreate = cli(["ticket", "prepare", "create", "--id", "1"], 1);
  assert.equal(invalidCreate.stdout, "");
  assert.equal(JSON.parse(invalidCreate.stderr).code, "VALIDATION_FAILED");
  for (const args of [["close", "--id", "1"]]) {
    const blockedResult = cli(["ticket", "prepare", ...args], 1);
    assert.equal(blockedResult.stdout, "");
    const blocked = JSON.parse(blockedResult.stderr);
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.code, "UNVERIFIED");
    assert.equal(blocked.action, args[0]);
  }
  const invalid = cli(["ticket", "search", "--size", "101"], 1);
  assert.equal(JSON.parse(invalid.stderr).code, "VALIDATION_FAILED");
  assert.equal(
    JSON.parse(cli(["--timeout", "0", "ticket", "capabilities"], 1).stderr)
      .code,
    "VALIDATION_FAILED",
  );
  const schema = JSON.parse(
    cli(["--format", "raw", "ticket", "contract-schema"]).stdout,
  );
  assert.equal(schema.type, "object");
  assert(schema.properties.actions);
  assert.equal(
    JSON.parse(
      cli([
        "ticket",
        "contract-validate",
        "skill/references/tickets/contracts.unverified.json",
      ]).stdout,
    ).result.valid,
    true,
  );

  const rpc = (id, method, params) =>
    JSON.stringify({ jsonrpc: "2.0", id, method, params });
  const input =
    [
      "{invalid-json",
      rpc(1, "initialize", { protocolVersion: "2025-06-18" }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      rpc(2, "tools/list"),
      rpc(3, "tools/call", { name: "tickets_capabilities", arguments: {} }),
      rpc(4, "tools/call", {
        name: "tickets_prepare",
        arguments: { action: "close", id: "1" },
      }),
      rpc(5, "tools/call", {
        name: "tickets_get",
        arguments: { id: "invalid" },
      }),
      rpc(6, "ping"),
    ].join("\n") + "\n";
  const server = spawnSync(process.execPath, ["dist/mcp-server.js"], {
    cwd: root,
    env,
    input,
    encoding: "utf8",
    timeout: 20000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(server.error);
  assert.equal(server.status, 0, server.stderr);
  const responses = server.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(responses.length, 7);
  assert.equal(responses[0].error.code, -32700);
  const byId = new Map(
    responses.filter((r) => r.id !== null).map((r) => [r.id, r]),
  );
  const tools = byId.get(2).result.tools;
  assert(tools.some((t) => t.name === "sales_order_detail"));
  assert(tools.some((t) => t.name === "tickets_search"));
  for (const name of ["tickets_workflow", "tickets_service_report_preflight", "tickets_attachment_download_uploaded"])
    assert(tools.some((tool) => tool.name === name));
  assert(!tools.some((t) => t.name === "tickets_execute"));
  assert.equal(
    JSON.parse(byId.get(4).result.content[0].text).status,
    "blocked",
  );
  assert.equal(byId.get(5).result.isError, true);
  assert.deepEqual(byId.get(6).result, {});

  // Inherited host secrets must not expose ledger modification through the
  // quick read-only bridge. Listing tools does not load a credential library.
  const source = path.join(temporary, "isolated-source");
  mkdirSync(source, { mode: 0o700 });
  writeFileSync(path.join(source, "package.json"), JSON.stringify({ name: "neocrm-cli-test" }), { mode: 0o600 });
  const bridge = spawnSync(process.execPath, ["scripts/with-neocrm-session.mjs", source, "--mcp"], {
    cwd: root,
    env: { ...env, XSY_TICKET_WRITES: "1", XSY_TICKET_APPROVAL_SECRET: "synthetic-host-secret-".repeat(3) },
    input: rpc(1, "tools/list") + "\n",
    encoding: "utf8",
    timeout: 20000,
    maxBuffer: 4 * 1024 * 1024,
  });
  assert.ifError(bridge.error);
  assert.equal(bridge.status, 0, bridge.stderr);
  const bridgeTools = JSON.parse(bridge.stdout.trim()).result.tools;
  assert(bridgeTools.some((t) => t.name === "tickets_search"));
  assert(!bridgeTools.some((t) => ["tickets_execute", "tickets_operation_review"].includes(t.name)));
  assert(!existsSync(env.XSY_TICKET_STATE_DIR));
  console.log(
    "CLI/MCP smoke passed: command registration, built-in create validation, contract schema, default write gates, JSON-RPC error recovery, read-only bridge isolation; no CRM calls or plans created.",
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
