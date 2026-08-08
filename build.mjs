/**
 * Alpha API — production build script
 *
 * Usage: node build.mjs
 *
 * Compiles TypeScript to dist/ using the project tsconfig.
 * better-sqlite3 native bindings are kept as-is (no bundling needed).
 */

import { execSync } from "node:child_process";

console.log("Building Alpha API…");
// npx ensures tsc is found whether run standalone or from a monorepo.
execSync("npx --yes tsc -p tsconfig.json", { stdio: "inherit" });
console.log("Build complete → dist/");
