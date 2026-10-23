import type { PluginServerContext } from "@getpaseo/plugin/server";
import { fusionSettings, DEFAULT_SETTINGS, type FusionSettings, type Profile } from "./shared/settings";
import { delegateRpc, reportRpc, getSettingsRpc, getDelegationRpc } from "./shared/contracts";
import { FusionState } from "./server/state";
import { handleDelegation, handleSidekickTurnEnded } from "./server/orchestration";
import { LABEL, isSidekick, isLead } from "./shared/labels";
import { FusionMcpHttpServer } from "./server/mcp-server";
import { parseFencedBrief, getFencedBriefPrompt } from "./server/fenced";

const MCP_PORT = 31337;

export default function contribute(server: PluginServerContext) {
  const settingsHandle = server.registerSettings(fusionSettings);
  const state = new FusionState();
  let settings: FusionSettings = DEFAULT_SETTINGS;
  let stopped = false;
  const fencedPromptedAgents = new Set<string>();

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

  // Handle lead turn ended for fenced delegation fallback and MCP rejection recovery.
  server.on("agent.turn_ended", async (event, { paseo }) => {
    if (stopped || !settings.enabled || !settings.fallback_to_fenced || !isLead(event.agent.labels)) return;

    const profileId = event.agent.labels[LABEL.fusionProfile] || settings.default_profile;
    const profile = settings.profiles.find((item) => item.id === profileId);
    if (!profile) return;

    if (event.outcome.kind !== "failed") fencedPromptedAgents.delete(event.agent.id);
    const assistantText = latestAssistantText(event.timeline);
    const brief = parseFencedBrief(assistantText);
    if (brief) {
      fencedPromptedAgents.delete(event.agent.id);
      void handleDelegation(paseo, settings, state, {
        leadId: event.agent.id,
        leadProvider: event.agent.provider,
        leadCwd: event.agent.cwd,
        profile,
        brief,
      }).then((result) => {
        if (result.error) console.error("[fusion] fenced delegation failed", event.agent.id, result.error);
      }).catch((error) => {
        console.error("[fusion] fenced delegation crashed", event.agent.id, error);
      });
      return;
    }

    if (event.outcome.kind !== "failed" || fencedPromptedAgents.has(event.agent.id) || !isMcpProviderRejection(event)) return;
    fencedPromptedAgents.add(event.agent.id);
    try {
      await paseo.agents.ref(event.agent.id).send(
        `The provider rejected or could not start the Fusion MCP tools. Continue using this text protocol instead.\n\n${getFencedBriefPrompt(profile)}`,
      );
      console.warn("[fusion] MCP rejected by provider; requested fenced-text fallback", event.agent.id);
    } catch (error) {
      fencedPromptedAgents.delete(event.agent.id);
      console.error("[fusion] Could not request fenced-text fallback", event.agent.id, error);
    }
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
    fencedPromptedAgents.clear();
    mcpServer.stop().catch((error) => {
      console.error("[fusion] Failed to stop MCP server:", error);
    });
  };
}

function latestAssistantText(timeline: readonly unknown[]): string {
  let start = 0;
  for (let index = timeline.length - 1; index >= 0; index--) {
    const item = timeline[index] as { type?: string };
    if (item.type === "user_message") {
      start = index + 1;
      break;
    }
  }

  const chunks: string[] = [];
  for (let index = timeline.length - 1; index >= start; index--) {
    const item = timeline[index] as { type?: string; text?: string; data?: { content?: string } };
    if (item.type === "assistant_message" && typeof item.text === "string") chunks.unshift(item.text);
    else if (item.type === "assistant" && typeof item.data?.content === "string") chunks.unshift(item.data.content);
    else if (chunks.length > 0 && item.type !== "reasoning") break;
  }
  return chunks.join("").trim();
}

function isMcpProviderRejection(event: { outcome: { kind: string; error?: { code?: string; message?: string } }; timeline: readonly unknown[] }): boolean {
  const evidence: string[] = [];
  if (event.outcome.error) evidence.push(`${event.outcome.error.code || ""} ${event.outcome.error.message || ""}`);
  let turnStart = 0;
  for (let index = event.timeline.length - 1; index >= 0; index--) {
    if ((event.timeline[index] as { type?: string }).type === "user_message") {
      turnStart = index + 1;
      break;
    }
  }
  for (const raw of event.timeline.slice(turnStart)) {
    const item = raw as { type?: string; message?: string };
    if ((item.type === "error" || item.type === "notification") && item.message) evidence.push(item.message);
  }
  const text = evidence.join("\n");
  return /(?:mcp|model context protocol|fusion).{0,120}(?:reject|unsupported|not supported|not available|failed|failure|invalid|connect|connection|start)|(?:reject|unsupported|not supported|not available|failed|failure|invalid|connect|connection|start).{0,120}(?:mcp|model context protocol|fusion)/is.test(text);
}
