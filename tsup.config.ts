import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts", "src/mcp-server.ts"],
  format: ["esm"],
  target: "node22",
  dts: true,
  clean: true,
  sourcemap: true,
  shims: false,
  treeshake: true,
  splitting: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
