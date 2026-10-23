import type { PluginServerContext } from "@getpaseo/plugin/server";
import { fusionSettings, DEFAULT_SETTINGS, type FusionSettings } from "./shared/settings";
import { delegateRpc, reportRpc, getSettingsRpc } from "./shared/contracts";
import { FusionState } from "./server/state";
import { handleDelegation, handleSidekickTurnEnded } from "./server/orchestration";
import { LABEL, isSidekick } from "./shared/labels";

export default function contribute(server: PluginServerContext) {
  const settingsHandle = server.registerSettings(fusionSettings);
  const state = new FusionState();
  let settings: FusionSettings = DEFAULT_SETTINGS;
  let stopped = false;

  void settingsHandle.read().then((current) => {
    if (current.status === "ready") {
      settings = current.values;
    } else {
      console.error("[fusion] settings invalid, using defaults:", current.error);
    }
  });

  const unsubscribe = settingsHandle.subscribe((next) => {
    if (next.status === "ready") {
      settings = next.values;
      state.clear();
    }
  });

  // Inject MCP server for delegate/report tools when creating a lead agent
  server.before("agent.create", ({ request }) => {
    if (!settings.enabled || !settings.use_mcp_delegation) {
      return request;
    }

    // Check if this is a lead agent (has fusion.role=lead in labels)
    const isLead = request.labels?.[LABEL.fusionRole] === "lead";
    if (!isLead) {
      return request;
    }

    // Inject the fusion MCP server
    // TODO: Serve an actual HTTP MCP server and inject its URL here
    // For now, this is a placeholder
    return {
      ...request,
      config: {
        ...request.config,
        mcpServers: {
          ...request.config.mcpServers,
          fusion: {
            type: "http",
            url: "http://localhost:31337/mcp", // Placeholder URL
          },
        },
      },
    };
  });

  // Handle sidekick turn ended to extract reports
  server.on("agent.turn_ended", async (event, { paseo }) => {
    if (stopped || !settings.enabled) return;
    if (event.outcome.kind === "canceled") return;

    // Check if this is a sidekick
    if (!isSidekick(event.agent.labels)) {
      return;
    }

    // Detached: report handling can outlast the 30 s hook timeout
    void handleSidekickTurnEnded(paseo, settings, state, event).catch((error) => {
      console.error("[fusion] sidekick turn_ended handler crashed", event.agent.id, error);
    });
  });

  // RPC handlers
  server.handle(delegateRpc, async ({ goal, constraints, success_criteria, files_hint }, { paseo }) => {
    if (!settings.enabled) {
      return {
        status: "error" as const,
        sidekick_agent_id: null,
        message: "Fusion is disabled in settings",
      };
    }

    // Get the current agent (the lead)
    // TODO: How to get the current agent ID from an RPC call?
    // For now, this is a placeholder
    return {
      status: "dispatched" as const,
      sidekick_agent_id: null,
      message: "Delegate RPC called (placeholder)",
    };
  });

  server.handle(reportRpc, async (input, { paseo }) => {
    // This would be called from the MCP tool
    return {
      status: "accepted" as const,
      message: "Report accepted (placeholder)",
    };
  });

  server.handle(getSettingsRpc, async () => {
    return settings;
  });

  // Periodic cleanup
  const cleanupInterval = setInterval(() => {
    state.cleanupOldDelegations();
    state.cleanupOldSidekicks();
  }, 60 * 60 * 1000); // Every hour

  return () => {
    stopped = true;
    unsubscribe();
    clearInterval(cleanupInterval);
  };
}
