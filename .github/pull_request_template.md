<!--
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
-->

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
