/*
 * Licensed to YugabyteDB, Inc. under one or more contributor license agreements.
 * See the NOTICE file distributed with this work for additional information
 * regarding copyright ownership. YugabyteDB licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may not use this file
 * except in compliance with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed
 * under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
 * CONDITIONS OF ANY KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations under the License.
 */

// verify-extension — token-free, self-contained validator for the Meko for
// BMad extension. Runs against extensions/bmad only; it does not read, and must
// not affect, the root skills/, .claude-plugin/, or plugins/ trees. Node
// built-ins only (no package.json / npm install).

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE); // extensions/bmad
const errors = [];
const fail = (m) => errors.push(m);

// Canonical Apache markdown header (byte-for-byte, matches the root repo).
const APACHE_HEADER = `<!--
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

const HELP_HEADER =
  "module,skill,display-name,menu-code,description,action,args,phase,preceded-by,followed-by,required,output-location,outputs";

const MODULE_CODE = "mkb";
const MODULE_DISPLAY = "Meko for BMad";
const PLUGIN_NAME = "meko-bmad";
const SKILLS = ["meko-bmad-setup", "meko-bmad-context", "meko-bmad-publish"];

const read = (p) => readFileSync(p, "utf8");

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// Count CSV columns respecting double-quoted fields (which may contain commas).
function csvColumnCount(line) {
  let count = 1;
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (c === "," && !inQuotes) count++;
  }
  return count;
}

// --- 1. No parent-dir escapes: the extension must be self-contained.
// Markdown is excluded here (links are validated in check 4, and prose may
// legitimately mention "../../"); config/code must never reach outside. -------
for (const f of walk(ROOT)) {
  if (f === fileURLToPath(import.meta.url)) continue;
  if (!/\.(json|ya?ml|toml|csv|mjs|js)$/.test(f)) continue;
  const body = read(f);
  if (body.includes("../../")) fail(`parent-dir escape (../../) in ${f}`);
}

// --- 2. Apache header on every markdown file. -------------------------------
for (const f of walk(ROOT)) {
  if (!f.endsWith(".md")) continue;
  const body = read(f);
  const isSkill = basename(f) === "SKILL.md";
  if (isSkill) {
    if (!body.startsWith("---"))
      fail(`SKILL.md must start with frontmatter on line 1: ${f}`);
    if (!body.includes(APACHE_HEADER))
      fail(`missing canonical Apache header (after frontmatter): ${f}`);
  } else if (!body.startsWith(APACHE_HEADER)) {
    fail(`markdown file must start with the canonical Apache header: ${f}`);
  }
}

// --- 3. Skill frontmatter schema. -------------------------------------------
for (const skill of SKILLS) {
  const p = join(ROOT, "skills", skill, "SKILL.md");
  if (!existsSync(p)) {
    fail(`missing skill: ${p}`);
    continue;
  }
  const body = read(p);
  const fm = body.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) {
    fail(`no frontmatter block in ${p}`);
    continue;
  }
  const front = fm[1];
  if (!new RegExp(`name:\\s*${skill}\\b`).test(front))
    fail(`frontmatter name must equal "${skill}" in ${p}`);
  if (!/description:\s*>-/.test(front))
    fail(`frontmatter description should use a ">-" block scalar in ${p}`);
  if (!/license:\s*Apache-2\.0/.test(front))
    fail(`frontmatter must declare license: Apache-2.0 in ${p}`);
  if (/MIT/.test(front)) fail(`MIT license is not allowed in ${p}`);
  if (!/metadata:/.test(front)) fail(`frontmatter missing metadata block in ${p}`);
  if (!/version:\s*"[0-9]+\.[0-9]+\.[0-9]+"/.test(front))
    fail(`metadata.version must be a quoted semver string in ${p}`);
}

// --- 4. Local markdown links resolve. ---------------------------------------
for (const f of walk(ROOT)) {
  if (!f.endsWith(".md")) continue;
  const body = read(f);
  const linkRe = /\]\(([^)]+)\)/g;
  let m;
  while ((m = linkRe.exec(body))) {
    let target = m[1].trim();
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    target = target.split("#")[0];
    if (!target) continue;
    const resolved = join(dirname(f), target);
    if (!existsSync(resolved)) fail(`broken local link "${m[1]}" in ${f}`);
  }
}

// --- 5. marketplace.json shape. ---------------------------------------------
const mkPath = join(ROOT, ".claude-plugin", "marketplace.json");
if (!existsSync(mkPath)) {
  fail(`missing ${mkPath}`);
} else {
  let mk;
  try {
    mk = JSON.parse(read(mkPath));
  } catch (e) {
    fail(`marketplace.json is not valid JSON: ${e.message}`);
  }
  if (mk) {
    if (mk.name !== PLUGIN_NAME)
      fail(`marketplace name must be "${PLUGIN_NAME}" (got "${mk.name}")`);
    if ("pluginRoot" in (mk.metadata || {}))
      fail("marketplace metadata must not set pluginRoot");
    const plugins = mk.plugins || [];
    if (plugins.length !== 1) fail("marketplace must declare exactly one plugin");
    const plugin = plugins[0] || {};
    if (plugin.name !== PLUGIN_NAME)
      fail(`plugin name must be "${PLUGIN_NAME}"`);
    if (plugin.strict === false)
      fail("plugin entry must not set strict:false");
    const skillDirs = (plugin.skills || []).map((s) => s.replace(/^\.\//, ""));
    for (const skill of SKILLS) {
      const rel = `skills/${skill}`;
      if (!skillDirs.includes(rel))
        fail(`marketplace plugin.skills missing "${rel}"`);
      const sp = join(ROOT, rel, "SKILL.md");
      if (!existsSync(sp)) fail(`marketplace references missing skill ${sp}`);
    }
    // Manifest version must match the changelog's top entry.
    const clPath = join(ROOT, "CHANGELOG.md");
    if (existsSync(clPath)) {
      const cl = read(clPath);
      const clVer = cl.match(/^##\s*\[([0-9]+\.[0-9]+\.[0-9]+)\]/m);
      const mkVer = mk.metadata?.version;
      if (clVer && mkVer && clVer[1] !== mkVer)
        fail(
          `version mismatch: marketplace ${mkVer} vs changelog ${clVer[1]}`
        );
      if (plugin.version && mkVer && plugin.version !== mkVer)
        fail(`plugin.version ${plugin.version} != marketplace ${mkVer}`);
    }
  }
}

// --- 6. module.yaml + module-help.csv. --------------------------------------
const modYaml = join(ROOT, "skills", "meko-bmad-setup", "assets", "module.yaml");
if (!existsSync(modYaml)) fail(`missing ${modYaml}`);
else {
  const y = read(modYaml);
  if (!new RegExp(`code:\\s*${MODULE_CODE}\\b`).test(y))
    fail(`module.yaml code must be "${MODULE_CODE}"`);
  for (const k of ["name:", "description:", "module_version:"])
    if (!y.includes(k)) fail(`module.yaml missing required field "${k}"`);
}

const helpCsv = join(
  ROOT,
  "skills",
  "meko-bmad-setup",
  "assets",
  "module-help.csv"
);
if (!existsSync(helpCsv)) fail(`missing ${helpCsv}`);
else {
  const lines = read(helpCsv).trim().split(/\r?\n/);
  if (lines[0] !== HELP_HEADER)
    fail(`module-help.csv header must be the canonical 13-column header`);
  const dataRows = lines.slice(1).filter((l) => l.trim());
  if (dataRows.length !== 3)
    fail(`module-help.csv must have exactly 3 mkb rows (got ${dataRows.length})`);
  for (const row of lines.slice(1)) {
    if (!row.trim()) continue;
    const n = csvColumnCount(row);
    if (n !== 13) fail(`module-help.csv row has ${n} columns, expected 13: ${row}`);
    if (!row.startsWith(`${MODULE_DISPLAY},`))
      fail(`module-help.csv row must start with module display name "${MODULE_DISPLAY}": ${row}`);
  }
  const codes = dataRows.map((r) => r.split(",")[3]);
  for (const mc of ["MS", "MR", "MP"])
    if (!codes.includes(mc)) fail(`module-help.csv missing menu-code "${mc}"`);
}

// --- 7. Presence of packaging files. ----------------------------------------
for (const req of ["README.md", "CHANGELOG.md", "LICENSE", "NOTICE"]) {
  if (!existsSync(join(ROOT, req))) fail(`missing packaging file: ${req}`);
}

// --- Report. ----------------------------------------------------------------
if (errors.length) {
  console.error(`verify-extension: ${errors.length} problem(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("verify-extension: OK — Meko for BMad extension is valid.");
