import type { PluginServerContext } from "@getpaseo/plugin/server";
import { fusionSettings, DEFAULT_SETTINGS, type FusionSettings, type Profile } from "./shared/settings";
import { delegateRpc, reportRpc, getSettingsRpc, getDelegationRpc } from "./shared/contracts";
import { FusionState } from "./server/state";
import { handleDelegation, handleSidekickTurnEnded } from "./server/orchestration";
import { LABEL, isSidekick, isLead } from "./shared/labels";
import { FusionMcpHttpServer } from "./server/mcp-server";
import { parseFencedBrief, hasFencedBrief } from "./server/fenced";

const MCP_PORT = 31337;

export default function contribute(server: PluginServerContext) {
  const settingsHandle = server.registerSettings(fusionSettings);
  const state = new FusionState();
  let settings: FusionSettings = DEFAULT_SETTINGS;
  let stopped = false;

  // Start MCP server
  const mcpServer = new FusionMcpHttpServer(MCP_PORT);
  const mcpUrl = `http://localhost:${MCP_PORT}/mcp`;

  // Map from agent ID to lead ID for MCP calls
  const agentToLead = new Map<string, string>();

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

  // Start MCP server
  mcpServer.start().catch((error) => {
    console.error("[fusion] Failed to start MCP server:", error);
  });

  // Wire up MCP handlers
  mcpServer.setDelegateHandler(async (params, agentId) => {
    const leadId = agentToLead.get(agentId) || agentId;
    const leadAgent = await server.paseo.agents.ref(leadId).refresh().catch(() => null);
    if (!leadAgent) {
      return { sidekickId: null, error: "Lead agent not found" };
    }

    const profileId = leadAgent.agent.labels[LABEL.fusionProfile];
    if (!profileId) {
      return { sidekickId: null, error: "Lead has no fusion profile" };
    }

    const profile = settings.profiles.find((p) => p.id === profileId);
    if (!profile) {
      return { sidekickId: null, error: "Profile not found" };
    }

    const result = await handleDelegation(server.paseo, settings, state, {
      leadId,
      leadProvider: leadAgent.agent.provider,
      leadCwd: leadAgent.agent.cwd,
      profile,
      brief: params,
    });

    return result;
  });

  mcpServer.setReportHandler(async (params, agentId) => {
    const leadId = agentToLead.get(agentId);
    if (!leadId) {
      console.error("[fusion] Report from unknown agent", agentId);
      return;
    }

    // TODO: Store the report and send it to the lead
    console.log("[fusion] Report received from", agentId, "for lead", leadId, params);
  });

  // Inject MCP server for delegate/report tools when creating a lead agent
  server.before("agent.create", ({ request }) => {
    if (!settings.enabled || !settings.use_mcp_delegation) {
      return request;
    }

    // Check if this is a lead agent (has fusion.role=lead in labels)
    const isLeadAgent = request.labels?.[LABEL.fusionRole] === "lead";
    if (!isLeadAgent) {
      return request;
    }

    // Inject the fusion MCP server
    return {
      ...request,
      config: {
        ...request.config,
        mcpServers: {
          ...request.config.mcpServers,
          fusion: {
            type: "http",
            url: mcpUrl,
          },
        },
      },
    };
  });

  // Track agent creation for lead→sidekick mapping
  server.on("agent.created", async (event, { paseo }) => {
    const { agent } = event;
    if (isSidekick(agent.labels)) {
      const leadId = agent.labels[LABEL.fusionLeadId];
      if (leadId) {
        agentToLead.set(agent.id, leadId);
      }
    } else if (isLead(agent.labels)) {
      // This is a lead agent, map it to itself
      agentToLead.set(agent.id, agent.id);
    }
  });

  // Handle lead turn ended to check for fenced briefs
  server.on("agent.turn_ended", async (event, { paseo }) => {
    if (stopped || !settings.enabled) return;
    if (event.outcome.kind === "canceled") return;

    // Only process lead agents
    if (!isLead(event.agent.labels)) {
      return;
    }

    // Check if fenced-text protocol is enabled
    if (!settings.fallback_to_fenced) {
      return;
    }

    // Get the last message from the timeline
    // TODO: Extract the text and check for fenced brief
    // For now, this is a placeholder
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

    // This RPC is a fallback for when MCP is not available
    // It's called from the lead agent directly
    // We need to get the current agent ID from the context
    // For now, return an error since we expect MCP to be used
    return {
      status: "error" as const,
      sidekick_agent_id: null,
      message: "Use the MCP delegate tool instead of this RPC",
    };
  });

  server.handle(reportRpc, async (input, { paseo }) => {
    // This RPC is a fallback for when MCP is not available
    return {
      status: "error" as const,
      message: "Use the MCP report tool instead of this RPC",
    };
  });

  server.handle(getSettingsRpc, async () => {
    return settings;
  });

  server.handle(getDelegationRpc, async ({ leadAgentId }) => {
    if (!settings.enabled) return { delegation: null };
    const delegation = state.getDelegationByLead(leadAgentId);
    if (!delegation) return { delegation: null };
    const sidekick = delegation.sidekickId ? state.getSidekick(delegation.sidekickId) : null;
    const profile = sidekick ? settings.profiles.find((item) => item.id === sidekick.profileId) : null;
    return {
      delegation: {
        status: delegation.status,
        sidekick_agent_id: delegation.sidekickId,
        sidekick_model: profile ? `${profile.sidekick.provider}/${profile.sidekick.model || "default"}` : null,
        brief: delegation.brief.goal,
        dispatched_at: delegation.dispatchedAt,
      },
    };
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
    mcpServer.stop().catch((error) => {
      console.error("[fusion] Failed to stop MCP server:", error);
    });
  };
}
