# Model Fusion

Pair a lead coding model with an implementation sidekick in Paseo. The lead plans and reviews; the sidekick works in a separate conversation and returns a structured report. Follow-up briefs can reuse the sidekick's context.

Open Model Fusion from the Command Center in a workspace. Start a lead with a model-pair preset, browse active and past delegations, inspect reports and usage, open either agent, cancel work, or retry report delivery. Composer pills and timeline cards show progress.

Requires Paseo 0.13.0-beta.1 or newer and authenticated providers. Presets include Codex 6.1 Sol at high effort with Cursor Grok 4.7 at medium effort, and Cursor Opus 5.5 at high effort with Codex 6 Luna at medium effort. Provider, model, effort, brief style, transport, timeout, reuse budget, and history retention are configurable.

The plugin sends briefs and reports to the selected providers through their Paseo sessions. It saves delegation state and usage receipts on the daemon host and restores them after reload. MCP tools use a loopback HTTP endpoint and per-delegation report tokens. Cursor and Devin use fenced text automatically; native Claude requires its own login and awaits live verification.

Antigravity subscriptions are excluded from this plugin. Use the official agy CLI separately. Cursor models use Cursor authentication, and Google's current consumer-plan FAQ does not support wrapping agy inside third-party coding agents.

Usage totals include reported lead and sidekick prices; some providers omit prices. Reuse limits apply between briefs, and report delivery can repeat after a crash. Native desktop and mobile visual verification remains outstanding.
