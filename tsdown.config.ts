import { defineConfig } from "tsdown";

export default defineConfig({
  name: "tether",
  clean: true,
  dts: {
    enabled: true,
  },
  entry: ["src/index.ts"],
  exports: true,
  failOnWarn: true,
  format: ["esm"],
  minify: true,
  outDir: "dist",
  report: true,
  treeshake: true,
});
