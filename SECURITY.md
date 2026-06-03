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

# Security Policy

## Reporting a Vulnerability

Please report security concerns for Meko skills, plugins, hooks, or connector configuration to `security@yugabyte.com`.

Do not open public GitHub issues for suspected credential leaks, data exposure, authentication bypasses, or other sensitive vulnerabilities. Include enough detail for us to reproduce the issue, including affected files, plugin version, MCP endpoint, and a minimal reproduction when possible.

For non-sensitive product support, use [GitHub Issues](https://github.com/yugabyte/meko-skills/issues) or the Meko community Discord.

## Supported Scope

This repository contains public skills, Claude plugin packaging, hook scripts, and verification scripts for the Meko connector. Server-side vulnerabilities in the hosted MCP service should also be reported to `security@yugabyte.com`.
