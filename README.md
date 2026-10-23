# Paseo Model Fusion

A Paseo plugin implementing [Local Fusion](https://cognition.com/blog/local-fusion): a frontier lead agent plus a cheaper sidekick, with separate persistent contexts exchanging only briefs and reports.

## How It Works

1. **Lead agent** (frontier model) plans and calls `delegate({ goal, constraints, success_criteria, files_hint })`
2. **Plugin** creates or reuses a **sidekick agent** (cheaper model) with the brief
3. **Sidekick** explores, implements, tests, then calls `report({ status, summary, changes, tests, concerns })`
4. **Plugin** sends the report back to the lead via the timeline
5. **Lead** reviews and either accepts, sends feedback, or takes over

## Key Features

- **Separate contexts**: Lead and sidekick each maintain their own prompt cache
- **Reusable sidekicks**: Sidekick agents are reused across briefs to preserve cache
- **Typed delegation**: MCP-based `delegate` and `report` tools for a narrow contract
- **Per-pair tuning**: Settings profiles for different model pairs (brief style, pushback, exploration)
- **Cost tracking**: Summed `lastUsage` from both agents displayed in UI

## Current Status

🚧 **Work in progress** - This is an initial scaffold. The following are TODO:

- [ ] Implement actual HTTP MCP server for delegate/report tools
- [ ] Complete report extraction from sidekick timeline
- [ ] Add composer pill for sidekick state
- [ ] Add timeline card renderer for delegation status
- [ ] Add optional workspace panel for active sidekicks
- [ ] Implement fenced-text protocol fallback for providers without MCP support
- [ ] Add failure handling (timeouts, crashes, provider rejection)
- [ ] Implement state persistence for crash recovery
- [ ] Test with actual providers (Codex, Claude, OMP, Devin, Cursor)
- [ ] Add more model pair profiles

## Installation

```bash
cd ~/.paseo/plugin-src
git clone git@github.com:sgoley/paseo-model-fusion.git
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

## Provider MCP Compatibility

| Provider | Session-scoped HTTP MCP? | Status |
| --- | --- | --- |
| Codex | ✅ Yes | Supported |
| Claude | ✅ Yes | Supported |
| OMP | ✅ Yes | Supported |
| Devin | ❓ Unknown | Needs verification |
| Cursor | ❓ Unknown | Needs verification |

## Credits

Inspired by [Cognition's Local Fusion](https://cognition.com/blog/local-fusion).

References:
- [paseo-continuity](https://github.com/keefeere/paseo-continuity) - Provider failover plugin
- [paseo-exporter](https://github.com/sgoley/paseo-exporter) - Chat export plugin
