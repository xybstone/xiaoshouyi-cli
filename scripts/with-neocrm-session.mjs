// Reuse the approved NeoCRM adapter's session in this process only.
// No credential decryption implementation, file copy or HOME/XDG override.
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

class BridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function validateReadOnlyArgs(args) {
  let index = 0;
  while (index < args.length && args[index] !== "ticket") {
    if (
      ["--fields", "--format", "--timeout"].includes(args[index]) &&
      index + 1 < args.length
    )
      index += 2;
    else if (/^--(?:fields|format|timeout)=.+$/.test(args[index])) index++;
    else
      throw new BridgeError(
        "READ_ONLY_REQUIRED",
        "Only bounded ticket read commands and their output/timeout options are allowed.",
      );
  }
  if (
    !["search", "get", "capabilities", "timeline", "resolve"].includes(args[index + 1])
  ) {
    throw new BridgeError(
      "READ_ONLY_REQUIRED",
      "Allowed ticket commands: search, get, capabilities, timeline, resolve. CRM writes are disabled.",
    );
  }
  return args;
}

async function main() {
  const [source, ...args] = process.argv.slice(2);
  if (!source || source === "--help") {
    console.log(
      "Usage: node scripts/with-neocrm-session.mjs <approved-neocrm-project> ([--fields ...] ticket <search|get|capabilities|timeline|resolve> [options] | --mcp)",
    );
    process.exitCode = source ? 0 : 2;
    return;
  }
  const mcp = args.length === 1 && args[0] === "--mcp";
  if (!mcp) validateReadOnlyArgs(args);
  const root = realpathSync(path.resolve(source));
  const packageFile = path.join(root, "package.json");
  const packageStat = lstatSync(packageFile);
  if (!packageStat.isFile() || packageStat.isSymbolicLink() || packageStat.size > 1024 * 1024)
    throw new BridgeError("SOURCE_UNSUPPORTED", "Use the approved isolated NeoCRM adapter project.");
  const manifest = JSON.parse(
    readFileSync(packageFile, "utf8"),
  );
  if (manifest.name !== "neocrm-cli-test")
    throw new BridgeError(
      "SOURCE_UNSUPPORTED",
      "Use the approved isolated NeoCRM adapter project.",
    );
  // CLI and long-running MCP now use the same refreshing provider. The source
  // library alone reads/refreshes its isolated store; no token is persisted here.
  process.env.XSY_NEOCRM_PROJECT = root;
  delete process.env.XSY_ACCESS_TOKEN;
  delete process.env.XSY_API_BASE_URL;
  process.env.XSY_TICKET_CONTRACTS = "";
  process.env.XSY_TICKET_WRITES = "";
  process.env.XSY_TICKET_APPROVAL_SECRET = "";
  const target = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    mcp ? "../dist/mcp-server.js" : "../dist/cli.js",
  );
  process.argv = [process.execPath, target, ...(mcp ? [] : args)];
  await import(pathToFileURL(target).href);
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    // Upstream failures may contain authentication material; never echo them.
    process.stderr.write(
      JSON.stringify({
        status: "error",
        code:
          error instanceof BridgeError
            ? error.code
            : "NEOCRM_SESSION_UNAVAILABLE",
        message:
          error instanceof BridgeError
            ? error.message
            : "Cannot reuse the isolated session. Check neocrm auth verify in the approved source environment.",
      }) + "\n",
    );
    process.exitCode = 1;
  });
}
