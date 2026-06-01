#!/usr/bin/env node
/**
 * publish-verify — token-free, source-free self-check that ships INTO the
 * public meko-skills repo (copied verbatim by the publish generator).
 *
 * The public repo cannot reach the private source repo and holds no tokens, so
 * it cannot re-run the full generator. Instead this script re-derives the
 * PUBLICATION INVARIANTS that the generator guarantees and asserts they hold
 * across the committed public tree. It is defense-in-depth: if a human edits a
 * published file in a way that breaks an invariant (strips the license header,
 * reverts the Apache tag, or swaps the connector placeholder for a real URL),
 * this fails the PR.
 *
 * Run from the public repo root: `node scripts/publish-verify.mjs`
 * No external dependencies — Node built-ins only.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";

const ROOT = process.cwd();

const LICENSE_HEADER = `<!--
Licensed to YugabyteDB, Inc. under one or more contributor license agreements.
See the NOTICE file distributed with this work for additional information
regarding copyright ownership. YugabyteDB licenses this file to you under
the Apache License, Version 2.0 (the "License"); you may not use this file
except in compliance with the License. You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software distributed
under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND, either express or implied. See the License for the
specific language governing permissions and limitations under the License.
-->`;

const CONNECTOR_URL_PLACEHOLDER = "MEKO_CONNECTOR_URL_PLACEHOLDER";

const errors = [];

function listMarkdown(dir, acc) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listMarkdown(p, acc);
    else if (extname(p) === ".md") acc.push(p);
  }
}

// 1. Every published markdown file carries the exact canonical header.
const mdFiles = [];
listMarkdown(join(ROOT, "skills"), mdFiles);
for (const f of mdFiles) {
  const text = readFileSync(f, "utf8");
  if (!text.startsWith(LICENSE_HEADER + "\n")) {
    errors.push(`missing/altered license header: ${f}`);
  }
}

// 2. Every SKILL.md frontmatter declares Apache-2.0 (never MIT).
for (const f of mdFiles.filter((p) => p.endsWith("SKILL.md"))) {
  const text = readFileSync(f, "utf8");
  if (/^license:\s*MIT\s*$/m.test(text)) {
    errors.push(`license reverted to MIT: ${f}`);
  }
  if (!/^license:\s*Apache-2\.0\s*$/m.test(text)) {
    errors.push(`SKILL.md missing 'license: Apache-2.0': ${f}`);
  }
}

// 3. plugin.json connector URL is still the placeholder (not a real URL yet).
const pluginJsonPath = join(ROOT, ".claude-plugin", "plugin.json");
if (!existsSync(pluginJsonPath)) {
  errors.push("missing .claude-plugin/plugin.json");
} else {
  const pj = JSON.parse(readFileSync(pluginJsonPath, "utf8"));
  if (pj?.metadata?.connectorUrl !== CONNECTOR_URL_PLACEHOLDER) {
    errors.push(
      `connector URL is not the expected placeholder (got: ${pj?.metadata?.connectorUrl})`,
    );
  }
}

// 4. Desktop skill's referenced files actually exist (the historical 404 bug).
const desktopSkill = join(ROOT, "skills", "meko-mcp-tools-desktop", "SKILL.md");
if (existsSync(desktopSkill)) {
  const text = readFileSync(desktopSkill, "utf8");
  const refDir = join(ROOT, "skills", "meko-mcp-tools-desktop", "references");
  for (const m of text.matchAll(/`(tools-[a-z0-9-]+\.md)`/g)) {
    if (!existsSync(join(refDir, m[1]))) {
      errors.push(`desktop SKILL.md references missing file: references/${m[1]}`);
    }
  }
}

if (errors.length) {
  console.error(`publish-verify: ${errors.length} invariant violation(s):`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(
  `publish-verify: ${mdFiles.length} markdown files OK, manifest + desktop refs OK ✓`,
);
