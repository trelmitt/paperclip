#!/usr/bin/env node
// Guard: the browser-shared package barrels must not VALUE-re-export a Node-only module.
//
// Why: the UI (Vite) imports these barrels. A runtime `export { x } from "./node-only.js"`
// pulls that module's whole graph (node:child_process / fs / net ...) into the browser
// bundle, and Vite fails with the cryptic `"execFile" is not exported by
// "__vite-browser-external"`. It PASSES `tsc` — only the bundler catches it — so this is a
// fast, clear tripwire that runs BEFORE the full build and names the exact offending line.
// `export type { ... }` / `import type` are erased at build and always browser-safe, so
// they are allowed.
//
// This recurred twice (barrel re-added `export { checkShellCommandSafety } from
// "./execution-target.js"`). See vault: "A browser-shared package barrel must not
// runtime-export Node-only code". The durable fix is to extract the pure symbol into a
// Node-free module and re-export THAT.
//
// Scope: one hop. It flags a barrel value-export whose target module DIRECTLY imports a
// Node builtin. Deeper transitive leaks (barrel -> A -> B -> node:*) are left to the
// pre-push `pnpm build` gate. ponytail: one-hop scan, extend to a graph walk only if a
// deeper leak ever slips through.
import ts from "typescript";
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BARRELS = [
  "packages/adapter-utils/src/index.ts",
  "packages/shared/src/index.ts",
];

// Bare specifiers that are unambiguously Node builtins and break the browser bundle.
// `node:`-prefixed imports are caught separately (that is what this repo uses).
const BARE_BUILTINS = new Set([
  "child_process", "fs", "fs/promises", "net", "tls", "dns", "os",
  "worker_threads", "cluster", "http", "https", "http2", "vm", "module",
]);

function parse(file) {
  return ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
}

// Resolve a relative specifier ("./execution-target.js") from `fromFile` to an on-disk source file.
function resolveLocal(spec, fromFile) {
  if (!spec.startsWith(".")) return null; // bare package import — out of scope for a one-hop guard
  const base = resolve(dirname(fromFile), spec.replace(/\.js$/, ""));
  for (const cand of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (existsSync(cand)) return cand;
  }
  return null;
}

// Does `file` statically import a Node builtin? Returns the offending specifier or null.
function nodeBuiltinImportedBy(file) {
  const sf = parse(file);
  let hit = null;
  sf.forEachChild((node) => {
    if (hit) return;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const text = node.moduleSpecifier.text;
      if (text.startsWith("node:") || BARE_BUILTINS.has(text)) hit = text;
    }
  });
  return hit;
}

const violations = [];
for (const rel of BARRELS) {
  const barrelPath = resolve(REPO, rel);
  if (!existsSync(barrelPath)) continue;
  const sf = parse(barrelPath);
  sf.forEachChild((node) => {
    if (!(ts.isImportDeclaration(node) || ts.isExportDeclaration(node))) return;
    if (node.isTypeOnly) return; // `export type` / `import type` is erased — always browser-safe
    const spec = node.moduleSpecifier;
    if (!spec || !ts.isStringLiteral(spec)) return;
    const target = resolveLocal(spec.text, barrelPath);
    if (!target) return;
    const nodeImport = nodeBuiltinImportedBy(target);
    if (nodeImport) {
      const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
      violations.push({ barrel: rel, line: line + 1, spec: spec.text, target, nodeImport });
    }
  });
}

if (violations.length) {
  console.error("✗ browser-safe barrel guard: value re-export of a Node-only module\n");
  for (const v of violations) {
    console.error(`  ${v.barrel}:${v.line}  →  ${v.spec}`);
    console.error(`    ${v.target.replace(REPO + "/", "")} imports "${v.nodeImport}" — this pulls Node into the UI (Vite) bundle.`);
  }
  console.error("\n  Fix: extract the pure symbol into a Node-free module and re-export THAT,");
  console.error("       or make the barrel line `export type { ... }` if it is type-only.");
  console.error("  Vault: \"A browser-shared package barrel must not runtime-export Node-only code\".");
  process.exit(1);
}
console.log(`✓ browser-safe barrel guard: no Node-only value re-exports in ${BARRELS.length} barrels`);
