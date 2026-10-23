import type { PluginClientContext } from "@getpaseo/plugin/client";
import { DelegationTimelineCard } from "./client/timeline-card";

export default function contribute(client: PluginClientContext) {
  // Register timeline card renderer for delegation status
  client.registerTimelineItemRenderer({
    kind: "delegation",
    version: 1,
    Component: DelegationTimelineCard,
  });

  // TODO: Add composer pill for sidekick state
  // This requires:
  // - Tracking active delegations via RPC or MCP
  // - Adding a pill per agent when there's an active sidekick
  // - Updating the pill state as the sidekick progresses

  // TODO: Add optional workspace panel for active sidekicks
  // This would show all active sidekicks in the workspace with their status

  return () => {};
}
