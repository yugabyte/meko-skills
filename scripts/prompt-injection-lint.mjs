#!/usr/bin/env node
/**
 * prompt-injection-lint — heuristic, best-effort scanner for prompt-injection
 * vectors in the Markdown that ships in the public Meko plugin.
 *
 * IMPORTANT: this is HEURISTIC, not a guarantee. Skill markdown is loaded into
 * an agent's context, so a malicious or accidental instruction in it can steer
 * the agent. This linter raises the cost of an injection landing in the public
 * bundle; human PR review remains required. It gates (exit 1 on any finding).
 *
 * Usage: node scripts/prompt-injection-lint.mjs <dir-or-file> [more...]
 *
 * What it flags in *.md files:
 *   - Injection phrases ("ignore previous instructions", "you are now", …)
 *   - Invisible / bidi / tag Unicode (the real exfiltration vector)
 *   - Fabricated tool-call blocks (<invoke>, <function_calls>, fake fenced
 *     tool calls) that a renderer or agent might execute
 *   - URLs to non-allowlisted hosts, raw IPs, or dangerous schemes
 *
 * No external dependencies — Node built-ins only.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";

const ALLOWED_HOSTS = new Set([
  "mekodata.ai",
  "docs.mekodata.ai",
  "meko.yugabyte.com",
  "mcp.mekodata.ai",
  "yugabyte.com",
  "www.yugabyte.com",
  "github.com",
  "apache.org",
  "www.apache.org",
  "agentskills.io",
  "discord.gg",
  "json.schemastore.org",
  "support.claude.com",
  "claude.com",
  "code.claude.com",
  "help.openai.com",
  // Local-dev stack URL documented in the desktop setup README — not a host
  // anything is exfiltrated to.
  "localhost",
]);

const PHRASE_RULES = [
  { id: "ignore-previous", re: /ignore\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts?|context)/i },
  { id: "disregard-above", re: /disregard\s+(the\s+)?(above|previous|prior|system)/i },
  { id: "you-are-now", re: /\byou\s+are\s+now\b/i },
  { id: "new-instructions", re: /\b(new|updated)\s+(system\s+)?instructions?\s*:/i },
  { id: "reveal-system-prompt", re: /(reveal|print|repeat|output)\s+(your\s+)?(system\s+prompt|instructions)/i },
  { id: "developer-override", re: /\b(developer|admin|root)\s+mode\b/i },
  { id: "exfiltrate", re: /\b(exfiltrat|send\s+(all\s+)?(secrets|credentials|tokens|env))/i },
];

// Fabricated tool invocations a downstream agent could be tricked into running.
const TOOLCALL_RULES = [
  { id: "antml-invoke", re: /<\/?(invoke|function_calls|antml:invoke|antml:parameter)\b/i },
  { id: "tool-sentinel", re: /<\|[a-z_]+\|>/i },
];

// Invisible / bidirectional / tag unicode. These are near-always malicious in
// docs and are the classic hidden-instruction channel.
const INVISIBLE_RE =
  /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF]|[\u{E0000}-\u{E007F}]/u;

const URL_RE = /\bhttps?:\/\/([^\s/"'`)\]>]+)/gi;
const RAW_IP_RE = /\bhttps?:\/\/\d{1,3}(?:\.\d{1,3}){3}/i;
const DANGEROUS_SCHEME_RE = /\b(javascript|data|vbscript):/i;

function scanFile(path) {
  const findings = [];
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");

  lines.forEach((line, i) => {
    const ln = i + 1;
    for (const r of PHRASE_RULES) {
      if (r.re.test(line)) findings.push({ path, ln, rule: r.id, snippet: line.trim().slice(0, 120) });
    }
    for (const r of TOOLCALL_RULES) {
      if (r.re.test(line)) findings.push({ path, ln, rule: r.id, snippet: line.trim().slice(0, 120) });
    }
    if (INVISIBLE_RE.test(line)) {
      findings.push({ path, ln, rule: "invisible-unicode", snippet: "<invisible/bidi/tag codepoint>" });
    }
    if (DANGEROUS_SCHEME_RE.test(line)) {
      findings.push({ path, ln, rule: "dangerous-scheme", snippet: line.trim().slice(0, 120) });
    }
    if (RAW_IP_RE.test(line)) {
      findings.push({ path, ln, rule: "raw-ip-url", snippet: line.trim().slice(0, 120) });
    }
    let m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(line)) !== null) {
      // Isolate the AUTHORITY first (everything before the first path / query /
      // fragment / backslash), THEN strip userinfo. Doing it in this order
      // defeats the bypass `https://malicious.com?ignore=@mekodata.ai`: the
      // attacker-controlled real host is `malicious.com`, and the allowlisted
      // name after `@` lives in the query string, not the authority. (`\` is
      // included because browsers normalize it to `/`.)
      const authority = m[1].split(/[/?#\\]/, 1)[0];
      const host = authority.split("@").pop().split(":")[0].toLowerCase();
      // Template placeholders like https://<your-instance>.mcp.mekodev.com are
      // documentation, not live endpoints — the angle bracket marks them.
      const isPlaceholder = host.includes("<") || host.includes(">");
      // Per-tenant Meko instances live under *.mcp.mekodev.com; the host is
      // user-supplied, so allow the documented suffix rather than each subdomain.
      const isMekoInstance = /\.mcp\.mekodev\.com$/.test(host);
      if (!isPlaceholder && !isMekoInstance && !ALLOWED_HOSTS.has(host)) {
        findings.push({ path, ln, rule: "non-allowlisted-url", snippet: `${host}` });
      }
    }
  });

  return findings;
}

function walk(target, acc) {
  const st = statSync(target);
  if (st.isDirectory()) {
    for (const name of readdirSync(target)) {
      if (name === ".git" || name === "node_modules") continue;
      walk(join(target, name), acc);
    }
  } else if (extname(target) === ".md") {
    acc.push(target);
  }
}

function main() {
  const targets = process.argv.slice(2);
  if (targets.length === 0) {
    console.error("usage: prompt-injection-lint.mjs <dir-or-file> [more...]");
    process.exit(2);
  }
  const mdFiles = [];
  for (const t of targets) walk(t, mdFiles);

  const findings = mdFiles.flatMap(scanFile);
  if (findings.length) {
    console.error(`prompt-injection-lint: ${findings.length} finding(s):`);
    for (const f of findings) {
      console.error(`  ${f.path}:${f.ln} [${f.rule}] ${f.snippet}`);
    }
    console.error(
      "\nHeuristic scan — review each. If a finding is a legitimate false positive, " +
        "add the host to ALLOWED_HOSTS or narrow the rule, with justification in the PR.",
    );
    process.exit(1);
  }
  console.log(`prompt-injection-lint: scanned ${mdFiles.length} markdown file(s), no findings ✓`);
}

main();
