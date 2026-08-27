import { defineConfig } from "tsdown";

export default defineConfig({
  name: "tether",
  entry: ["src/index.ts"],
  // A CLI, not a library: no dts/exports (src/index.ts runs main() on import),
  // and no minify so crash stack traces stay readable.
  failOnWarn: true,
  report: true,
});
