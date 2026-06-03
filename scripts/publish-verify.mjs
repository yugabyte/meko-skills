#!/usr/bin/env node
/**
 * publish-verify — token-free, source-free self-check that ships INTO the
 * public meko-skills repo.
 *
 * It enforces the public repo invariants needed by Claude Code plugin
 * marketplaces and Anthropic Connector Directory review: marketplace sources
 * resolve correctly, plugins are self-contained, public connector metadata is
 * present, generated skill links resolve, and public docs do not point at
 * private source repos or dev hosts.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";

const ROOT = process.cwd();
const PUBLIC_CONNECTOR_URL = "https://mcp.mekodata.ai/mcp";
const PLUGIN_NAME = "meko-agent-skills";

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

const errors = [];

function rel(path) {
  return relative(ROOT, path) || ".";
}

function listFiles(dir, acc) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) listFiles(p, acc);
    else acc.push(p);
  }
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    errors.push(`${label} is not valid JSON: ${err.message}`);
    return null;
  }
}

function hasAncestor(child, parent) {
  const relPath = relative(resolve(parent), resolve(child));
  return relPath === "" || (!relPath.startsWith("..") && !relPath.startsWith("/"));
}

function resolvePluginSource(source, pluginRoot) {
  if (typeof source !== "string") return null;
  // metadata.pluginRoot is prepended to relative plugin sources. With
  // pluginRoot="./plugins" and source="./meko-agent-skills", the plugin root
  // resolves to <repo>/plugins/meko-agent-skills.
  const base = join(ROOT, pluginRoot || ".");
  return resolve(base, source);
}

const allFiles = [];
listFiles(ROOT, allFiles);
const mdFiles = allFiles.filter((p) => extname(p) === ".md");
const publishedMdFiles = mdFiles.filter(
  (p) => hasAncestor(p, join(ROOT, "skills")) || hasAncestor(p, join(ROOT, "plugins", PLUGIN_NAME, "skills")),
);

// 1. Every published skill markdown file carries the exact canonical header.
for (const f of publishedMdFiles) {
  const text = readFileSync(f, "utf8");
  if (!text.startsWith(LICENSE_HEADER + "\n")) {
    errors.push(`missing/altered license header: ${rel(f)}`);
  }
}

// 2. Every SKILL.md frontmatter declares Apache-2.0 (never MIT).
for (const f of mdFiles.filter((p) => p.endsWith("SKILL.md"))) {
  const text = readFileSync(f, "utf8");
  if (/^license:\s*MIT\s*$/m.test(text)) {
    errors.push(`license reverted to MIT: ${rel(f)}`);
  }
  if (!/^license:\s*Apache-2\.0\s*$/m.test(text)) {
    errors.push(`SKILL.md missing 'license: Apache-2.0': ${rel(f)}`);
  }
}

// 3. Root marketplace catalog points at a self-contained plugin under /plugins.
const marketplacePath = join(ROOT, ".claude-plugin", "marketplace.json");
let pluginRoot = ".";
let pluginDir = null;
if (!existsSync(marketplacePath)) {
  errors.push("missing .claude-plugin/marketplace.json");
} else {
  const marketplace = readJson(marketplacePath, ".claude-plugin/marketplace.json");
  pluginRoot = marketplace?.metadata?.pluginRoot || ".";
  if (pluginRoot !== "./plugins") {
    errors.push(`marketplace metadata.pluginRoot must be './plugins' (got: ${pluginRoot})`);
  }
  const entry = (marketplace?.plugins || []).find((p) => p?.name === PLUGIN_NAME);
  if (!entry) {
    errors.push(`marketplace missing ${PLUGIN_NAME} plugin entry`);
  } else {
    if (entry.strict === false) {
      errors.push(`${PLUGIN_NAME} must not set strict:false because plugin.json declares components`);
    }
    if (entry.source !== `./${PLUGIN_NAME}`) {
      errors.push(`${PLUGIN_NAME} source must be './${PLUGIN_NAME}' when pluginRoot is './plugins' (got: ${entry.source})`);
    }
    pluginDir = resolvePluginSource(entry.source, pluginRoot);
    if (!pluginDir || !hasAncestor(pluginDir, join(ROOT, "plugins"))) {
      errors.push(`${PLUGIN_NAME} source must resolve under /plugins`);
    }
    if (pluginDir && !existsSync(join(pluginDir, ".claude-plugin", "plugin.json"))) {
      errors.push(`marketplace source does not contain .claude-plugin/plugin.json: ${entry.source}`);
    }
  }
}

// 4. The plugin is self-contained: no root plugin manifest/hooks, and all plugin
// runtime assets live under /plugins/meko-agent-skills.
const forbiddenRootPluginPaths = [
  join(ROOT, ".claude-plugin", "plugin.json"),
  join(ROOT, ".mcp.json"),
  join(ROOT, "hooks"),
  join(ROOT, "hooks-handlers"),
];
for (const p of forbiddenRootPluginPaths) {
  if (existsSync(p)) errors.push(`plugin runtime artifact must live under plugins/${PLUGIN_NAME}, not ${rel(p)}`);
}

const requiredPluginPaths = [
  ".claude-plugin/plugin.json",
  ".mcp.json",
  "skills/meko-mcp-tools/SKILL.md",
  "skills/meko-mcp-tools-desktop/SKILL.md",
  "hooks/hooks.json",
  "hooks-handlers/lib/capture.js",
];
for (const p of requiredPluginPaths) {
  if (!pluginDir || !existsSync(join(pluginDir, p))) {
    errors.push(`self-contained plugin missing ${p}`);
  }
}

// 5. Plugin and MCP connector config point at the public Meko MCP endpoint.
const pluginJsonPath = pluginDir ? join(pluginDir, ".claude-plugin", "plugin.json") : null;
if (pluginJsonPath && existsSync(pluginJsonPath)) {
  const pj = readJson(pluginJsonPath, `${rel(pluginJsonPath)}`);
  if (pj?.metadata?.connectorUrl !== PUBLIC_CONNECTOR_URL) {
    errors.push(`connector URL is not the public endpoint (got: ${pj?.metadata?.connectorUrl})`);
  }
  if (pj?.skills !== "./skills") {
    errors.push(`plugin skills path must be './skills' (got: ${pj?.skills})`);
  }
}

const mcpJsonPath = pluginDir ? join(pluginDir, ".mcp.json") : null;
if (mcpJsonPath && existsSync(mcpJsonPath)) {
  const mcp = readJson(mcpJsonPath, `${rel(mcpJsonPath)}`);
  const url = mcp?.mcpServers?.meko?.url;
  if (url !== PUBLIC_CONNECTOR_URL) {
    errors.push(`${rel(mcpJsonPath)} mcpServers.meko.url must be ${PUBLIC_CONNECTOR_URL} (got: ${url})`);
  }
}



// 6. Root community skills and plugin-contained skills are generated from the
// same source and must not drift.
if (pluginDir) {
  const rootSkillsDir = join(ROOT, "skills");
  const pluginSkillsDir = join(pluginDir, "skills");
  const rootSkillFiles = [];
  const pluginSkillFiles = [];
  listFiles(rootSkillsDir, rootSkillFiles);
  listFiles(pluginSkillsDir, pluginSkillFiles);
  const rootRel = new Set(rootSkillFiles.map((p) => relative(rootSkillsDir, p)));
  const pluginRel = new Set(pluginSkillFiles.map((p) => relative(pluginSkillsDir, p)));
  for (const file of rootRel) {
    if (!pluginRel.has(file)) errors.push(`plugin skills copy missing ${file}`);
  }
  for (const file of pluginRel) {
    if (!rootRel.has(file)) errors.push(`plugin skills copy has extra ${file}`);
  }
  for (const file of rootRel) {
    if (!pluginRel.has(file)) continue;
    const rootText = readFileSync(join(rootSkillsDir, file), "utf8");
    const pluginText = readFileSync(join(pluginSkillsDir, file), "utf8");
    if (rootText !== pluginText) errors.push(`plugin skills copy drifted from root skills: ${file}`);
  }
}

// 7. Every local markdown link in every SKILL.md resolves, and every backticked
// tools-*.md reference in a SKILL.md points to an existing sibling reference.
for (const skill of mdFiles.filter((p) => p.endsWith("SKILL.md"))) {
  const text = readFileSync(skill, "utf8");
  for (const m of text.matchAll(/\[[^\]]+\]\(([^)]+\.md)(?:#[^)]+)?\)/g)) {
    const target = m[1];
    if (/^[a-z]+:/i.test(target)) continue;
    const targetPath = join(dirname(skill), target);
    if (!existsSync(targetPath)) {
      errors.push(`${rel(skill)} links missing markdown file: ${target}`);
    }
  }
  const refDir = join(dirname(skill), "references");
  for (const m of text.matchAll(/`(tools-[a-z0-9-]+\.md)`/g)) {
    if (!existsSync(join(refDir, m[1]))) {
      errors.push(`${rel(skill)} references missing file: references/${m[1]}`);
    }
  }
}

// 8. Public bundle must not link to private source repos or dev hosts.
const urlRe = /https?:\/\/[^\s)`"<>]+/g;
for (const f of allFiles.filter((p) => [".md", ".json", ".yml", ".yaml"].includes(extname(p)))) {
  const text = readFileSync(f, "utf8");
  for (const m of text.matchAll(urlRe)) {
    let url;
    try {
      url = new URL(m[0]);
    } catch {
      continue;
    }
    if (url.hostname === "github.com" && url.pathname.startsWith("/yugabyte/")) {
      const repo = (url.pathname.split("/").filter(Boolean)[1] || "").replace(/\.git$/, "");
      if (repo && repo !== "meko-skills") {
        errors.push(`${rel(f)} links non-public Yugabyte repo: ${m[0]}`);
      }
    }
    if (url.hostname === "mekodev.com" || url.hostname.endsWith(".mekodev.com")) {
      errors.push(`${rel(f)} links dev host: ${m[0]}`);
    }
  }
}


// 9. Public directory-policy documentation required for remote services and data collection.
const reviewDoc = join(ROOT, "DIRECTORY_REVIEW.md");
const securityDoc = join(ROOT, "SECURITY.md");
if (!existsSync(reviewDoc)) {
  errors.push("missing DIRECTORY_REVIEW.md");
} else {
  const text = readFileSync(reviewDoc, "utf8");
  const requiredSnippets = [
    "https://www.yugabyte.com/privacy-policy/",
    "conversation_add_message",
    "https://mcp.mekodata.ai/mcp",
    "Standard Testing Account",
    "Working Review Examples",
    "SECURITY.md",
  ];
  for (const snippet of requiredSnippets) {
    if (!text.includes(snippet)) errors.push(`DIRECTORY_REVIEW.md missing required disclosure: ${snippet}`);
  }
  const exampleCount = (text.match(/Expected behavior:/g) || []).length;
  if (exampleCount < 3) errors.push(`DIRECTORY_REVIEW.md must include at least three working examples (found ${exampleCount})`);
}
if (!existsSync(securityDoc)) {
  errors.push("missing SECURITY.md");
} else {
  const text = readFileSync(securityDoc, "utf8");
  if (!text.includes("security@yugabyte.com")) errors.push("SECURITY.md missing security contact");
}

if (errors.length) {
  console.error(`publish-verify: ${errors.length} invariant violation(s):`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(
  `publish-verify: ${mdFiles.length} markdown files OK, self-contained plugin + connector + links OK`,
);
