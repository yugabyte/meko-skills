## Skill name and maintainer

<!-- e.g. meko-mcp-tools / maintainer: meko -->
<!-- New community skill: set maintainer: community in your SKILL.md frontmatter -->

## What changed

<!-- Brief description of the skill addition or change -->

## Why

<!-- What failure mode does this fix? Link to the issue. -->

## How to verify

```
<test prompt here>
```

**Expected agent behavior after this change:**
<!-- What should the agent do? Be specific about which MCP tools it calls or avoids. -->

**Verified against:**
- Meko MCP endpoint: `mcp.mekodata.ai` (or your own instance)
- Agent harness: <!-- Cursor / Claude Code / Claude Desktop / other -->

## Checklist

- [ ] Issue linked above
- [ ] `maintainer` field set correctly in SKILL.md frontmatter (`meko` or `community`)
- [ ] `SKILL.md` version bumped (if behavioral change to existing skill)
- [ ] Reference files updated (if tool parameters or error handling changed)
- [ ] Apache 2.0 source header on all new files
- [ ] Tested against a live MCP server
