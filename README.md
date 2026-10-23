# Paseo Model Fusion

A Paseo plugin implementing [Local Fusion](https://cognition.com/blog/local-fusion): a frontier lead agent plus a cheaper sidekick, with separate persistent contexts exchanging only briefs and reports.

## How It Works

1. **Lead agent** (frontier model) plans and calls `delegate({ goal, constraints, success_criteria, files_hint })` via MCP
2. **Plugin** creates or reuses a **sidekick agent** (cheaper model) with the brief
3. **Sidekick** explores, implements, tests, then calls `report({ status, summary, changes, tests, concerns })` via MCP
4. **Plugin** sends the report back to the lead via the timeline
5. **Lead** reviews and either accepts, sends feedback, or takes over

## Key Features

- **Separate contexts**: Lead and sidekick each maintain their own prompt cache
- **Reusable sidekicks**: Sidekick agents are reused across briefs to preserve cache (within 24h)
- **Typed delegation**: HTTP MCP server with `delegate` and `report` tools for a narrow contract
- **Per-pair tuning**: Settings profiles for different model pairs (brief style, pushback, exploration, limits)
- **Cost tracking**: Summed `lastUsage` from both agents tracked and displayed
- **Failure handling**: Timeouts, max turns, max cost limits, error detection
- **Timeline cards**: Visual delegation status updates on the lead's timeline
- **Fenced-text fallback**: Optional fallback for providers without MCP support (parser implemented)

## Current Status

✅ **Core implementation complete** - The plugin is functional with the following implemented:

- [x] HTTP MCP server for delegate/report tools
- [x] Server-side orchestration (sidekick creation/reuse, brief delivery)
- [x] Report extraction from sidekick timeline (tool calls or fenced blocks)
- [x] Timeline card renderer for delegation status
- [x] Failure handling (timeouts, max turns, max cost, error detection)
- [x] Fenced-text protocol parser (for MCP fallback)
- [x] Cost tracking and display
- [x] Settings schema with model pair profiles

**Remaining TODOs:**

- [x] Composer pill for sidekick state, refreshed from the active delegation RPC
- [ ] Workspace panel for active sidekicks
- [ ] State persistence for crash recovery (currently in-memory only)
- [ ] Complete fenced-text protocol integration in lead turn_ended hook
- [ ] Test with actual providers (Codex, Claude, OMP, Devin, Cursor)
- [ ] Add more model pair profiles

## Installation

```bash
cd ~/.paseo/plugin-src
git clone https://github.com/sgoley/paseo-model-fusion.git
cd paseo-model-fusion
npm install
paseo plugin install .
```

## Configuration

In Paseo Settings → Plugins → Model Fusion:

- **Enabled**: Turn fusion on/off
- **Profiles**: Model pair configurations (lead model, sidekick model, brief style, etc.)
- **Default profile**: Which profile to use by default
- **Use MCP delegation**: Whether to use MCP tools (fallback to fenced-text if provider doesn't support it)
- **Fallback to fenced**: Whether to use fenced-text protocol if MCP is rejected
- **Show composer pill**: Display each Fusion lead’s latest delegation state, sidekick, and elapsed time in the composer
- **Show timeline card**: Display delegation status cards in timeline

## Usage

To use Fusion:

1. Create a lead agent with the label `fusion.role=lead` and `fusion.profile=<profile-id>`
2. The plugin will inject the MCP server with delegate/report tools
3. Lead calls the `delegate` tool with a goal, constraints, success criteria, and optional file hints
4. The plugin creates or reuses a sidekick and sends the brief
5. Sidekick works and calls `report` when done
6. Plugin sends the report to the lead via a timeline card
7. Lead reviews and responds

## Provider MCP Compatibility

| Provider | Session-scoped HTTP MCP? | Status |
| --- | --- | --- |
| Codex | ✅ Yes | Supported |
| Claude | ✅ Yes | Supported |
| OMP | ✅ Yes | Supported |
| Devin | ❓ Unknown | Needs verification |
| Cursor | ❓ Unknown | Needs verification |

If a provider doesn't support MCP, enable "Fallback to fenced" in settings to use the fenced-text protocol instead.

## Credits

Inspired by [Cognition's Local Fusion](https://cognition.com/blog/local-fusion).

References:
- [paseo-continuity](https://github.com/keefeere/paseo-continuity) - Provider failover plugin
- [paseo-exporter](https://github.com/sgoley/paseo-exporter) - Chat export plugin
