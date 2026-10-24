import { homedir } from "node:os";
import { join } from "node:path";
import type { PaseoApi } from "./server/protocol-types";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { fusionSettings, DEFAULT_SETTINGS, BUILTIN_PROFILES, type FusionSettings } from "./shared/settings";
import { delegateRpc, reportRpc, getSettingsRpc, getDelegationRpc, getWorkspaceRpc, createLeadRpc, delegationActionRpc } from "./shared/contracts";
import { FusionState } from "./server/state";
import { handleDelegation, handleSidekickReport, handleSidekickTurnEnded, recoverDelegations, publishDelegation, deliverReport, finishDelegation, checkProvider, modelConfig, markFinished, usesMcp, mcpToolPolicy } from "./server/orchestration";
import { isAntigravity, requireFusionProvider, RETIRED_PROFILE_IDS } from "./shared/provider-policy";
import { LABEL, isSidekick, isLead } from "./shared/labels";
import { FusionMcpHttpServer } from "./server/mcp-server";
import { getFencedBriefPrompt, parseFencedBrief } from "./server/fenced";
import { latestAssistantText, isMcpProviderRejection, timelineItem } from "./server/timeline";

const MCP_PORT = Number(process.env.PASEO_MODEL_FUSION_PORT || 31337);
const MCP_URL = "http://127.0.0.1:" + MCP_PORT + "/mcp";
function withPresets(values: FusionSettings): FusionSettings {
  const allowed = values.profiles.filter((profile) => !isAntigravity(profile.lead) && !isAntigravity(profile.sidekick));
  const profiles = [...new Map([...BUILTIN_PROFILES, ...allowed].map((profile) => [profile.id, profile])).values()];
  return { ...values, profiles, default_profile: !RETIRED_PROFILE_IDS.includes(values.default_profile) && profiles.some((profile) => profile.id === values.default_profile) ? values.default_profile : DEFAULT_SETTINGS.default_profile };
}
export default function contribute(server: PluginServerContext) {
  const settingsHandle = server.registerSettings(fusionSettings);
  const state = new FusionState({ filePath: process.env.PASEO_MODEL_FUSION_STATE_PATH ||
    join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "paseo-model-fusion", "state.json") });
  let settings = DEFAULT_SETTINGS;
  let paseoApi: PaseoApi | null = null;
  let stopped = false;
  let recovery: Promise<void> | null = null;
  const prompted = new Set<string>();
  const settingsReady = settingsHandle.read().then((current) => {
    if (current.status !== "ready") throw new Error("Invalid Fusion settings: " + current.error);
    settings = withPresets(current.values);
  });
  const unsubscribeSettings = settingsHandle.subscribe((next) => {
    if (next.status === "ready") settings = withPresets(next.values);
  });
  function capture(paseo: PaseoApi) {
    paseoApi = paseo;
    if (!recovery) {
      recovery = settingsReady.then(() => recoverDelegations(paseo, settings, state));
      void recovery.catch((error) => { console.error("[fusion] Recovery failed", error); recovery = null; });
    }
  }
  async function ready(paseo: PaseoApi) {
    capture(paseo); await settingsReady; await recovery;
    if (stopped) throw new Error("Fusion is stopping");
  }
  const mcpServer = new FusionMcpHttpServer(MCP_PORT);
  void settingsReady.then(() => {
    if (stopped) return;
    for (const item of state.getDelegations()) state.armTimer(item.briefId, () => {
      if (paseoApi) return finishDelegation(paseoApi, settings, state, item, "timeout", "The delegation deadline elapsed.");
      markFinished(state, item, "timeout", "The delegation deadline elapsed while disconnected.");
    });
    return mcpServer.start();
  }).catch((error) => console.error("[fusion] Startup failed", error));
  async function delegate(paseo: PaseoApi, callerId: string, explicitId: string | undefined, brief: Parameters<typeof handleDelegation>[3]["brief"]) {
    await ready(paseo);
    const lead = await resolveLeadAgent(paseo, callerId, explicitId);
    requireFusionProvider({ provider: lead.provider, model: lead.model });
    const profile = settings.profiles.find((item) => item.id === (lead.labels[LABEL.fusionProfile] || settings.default_profile));
    if (!profile || !lead.workspaceId) return { sidekickId: null, error: "The lead needs a workspace and Fusion profile" };
    return handleDelegation(paseo, lead.labels["fusion.transport"] === "fenced" ? { ...settings, use_mcp_delegation: false } : settings, state, {
      leadId: lead.id, workspaceId: lead.workspaceId, leadTurnId: lead.activeTurn?.turnId ?? null,
      mcpUrl: MCP_URL, profile, brief,
    });
  }
  mcpServer.setDelegateHandler(async (params, context) => {
    if (!paseoApi) return { sidekickId: null, error: "Paseo is not ready yet" };
    if (!settings.enabled || !settings.use_mcp_delegation) return { sidekickId: null, error: "MCP delegation is disabled" };
    try { return await delegate(paseoApi, context.agentId, params.lead_agent_id, params); }
    catch (error) { return { sidekickId: null, error: String(error) }; }
  });
  mcpServer.setReportHandler(async (params, context) => {
    if (!paseoApi) return false;
    await ready(paseoApi);
    return handleSidekickReport(paseoApi, settings, state, {
      briefId: params.delegation_id, reportToken: params.report_token, callerAgentId: context.agentId,
      report: { status: params.status, summary: params.summary, changes: params.changes || [], tests: params.tests || [],
        concerns: params.concerns || [], suggested_next: params.suggested_next ?? null },
    });
  });
  const cleanups = [
    server.before("agent.create", async ({ request }, { paseo }) => {
      capture(paseo); await settingsReady;
      if (!settings.enabled || !settings.use_mcp_delegation || request.config.internal || isAntigravity({ provider: request.config.provider, model: request.config.model }) ||
        request.env?.PASEO_MODEL_FUSION_SIDEKICK === "1" || request.env?.PASEO_MODEL_FUSION_TEXT_ONLY === "1") return request;
      return { ...request, config: { ...request.config, mcpServers: {
        ...request.config.mcpServers, fusion: { type: "http", url: MCP_URL, alwaysLoad: true },
      } } };
    }),
    server.on("agent.created", async (_event, { paseo }) => { capture(paseo); }),
    server.on("agent.turn_started", async (event, { paseo }) => {
      capture(paseo);
      if (state.getSidekick(event.agent.id)) state.updateSidekick(event.agent.id, { turnId: event.turnId });
    }),
    server.on("agent.turn_ended", async (event, { paseo }) => {
      if (stopped) return;
      capture(paseo); await settingsReady;
      const snapshot = await paseo.agents.ref(event.agent.id).refresh();
      if (!snapshot) return;
      const agent = snapshot.agent;
      if ((!isLead(agent.labels) && !isSidekick(agent.labels)) || isAntigravity({ provider: agent.provider, model: agent.model })) return;
      const history = await paseo.agents.ref(agent.id).timeline.refetch({ direction: "tail", limit: 100 });
      const timeline = history.entries;
      const turnId = event.turnId || "timeline:" + history.epoch + ":" + history.entries.at(-1)?.seqEnd;
      if (isLead(agent.labels)) {
        if (settings.enabled && settings.fallback_to_fenced && event.outcome.kind !== "canceled") {
          const brief = parseFencedBrief(latestAssistantText(timeline, event.turnId));
          if (brief && !state.hasDelegationForTurn(agent.id, turnId)) {
            const profile = settings.profiles.find((item) => item.id === (agent.labels[LABEL.fusionProfile] || settings.default_profile));
            if (profile && agent.workspaceId) await handleDelegation(paseo, agent.labels["fusion.transport"] === "fenced" ? { ...settings, use_mcp_delegation: false } : settings, state, {
              leadId: agent.id, workspaceId: agent.workspaceId, leadTurnId: turnId, mcpUrl: MCP_URL, profile, brief,
            });
          } else if (event.outcome.kind === "failed" && !prompted.has(agent.id) &&
            isMcpProviderRejection(event.outcome.error.message, timeline) && agent.workspaceId) {
            prompted.add(agent.id);
            const profile = settings.profiles.find((item) => item.id === (agent.labels[LABEL.fusionProfile] || settings.default_profile));
            if (profile) {
              const context = timeline.map(timelineItem).map((item) => {
                return (item.type === "user_message" || item.type === "assistant_message") && item.text ? item.type + ": " + item.text : "";
              }).filter(Boolean).join("\n").slice(-24000);
              await paseo.workspaces.ref(agent.workspaceId).agents.create({
                config: modelConfig(profile.lead), env: { PASEO_MODEL_FUSION_TEXT_ONLY: "1" },
                title: "Fusion lead: text fallback", labels: { ...agent.labels, "fusion.transport": "fenced", "fusion.replaces": agent.id },
                prompt: "Continue using text delegation. The previous session rejected MCP.\n\n" + context + "\n\n" + getFencedBriefPrompt(profile),
              });
            }
          }
        }
        state.recordUsage(agent.id, turnId, agent.lastUsage?.totalCostUsd ?? null, "lead");
        const matching = state.getDelegations().filter((item) => item.leadId === agent.id && item.leadTurnId === turnId);
        const latest = state.getDelegationByLead(agent.id);
        for (const item of matching.length ? matching : latest ? [latest] : []) await publishDelegation(paseo, settings, item);
      } else {
        await handleSidekickTurnEnded(paseo, settings, state, {
          agent: { id: agent.id }, timeline, turnId, cost: agent.lastUsage?.totalCostUsd ?? null, outcome: event.outcome,
        });
      }
    }),
  ];
  server.handle(delegateRpc, async ({ leadAgentId, ...brief }, { paseo }) => {
    try {
      const result = await delegate(paseo, "", leadAgentId, brief);
      return { status: result.sidekickId ? "dispatched" as const : "error" as const, sidekick_agent_id: result.sidekickId, message: result.error || "Delegation dispatched" };
    } catch (error) { return { status: "error" as const, sidekick_agent_id: null, message: String(error) }; }
  });
  server.handle(reportRpc, async (input, { paseo }) => {
    await ready(paseo);
    const accepted = await handleSidekickReport(paseo, settings, state, { briefId: input.delegation_id, reportToken: input.report_token, report: input });
    return { status: accepted ? "accepted" as const : "error" as const, message: accepted ? "Report stored for delivery" : "Report rejected" };
  });
  server.handle(getSettingsRpc, async (_input, { paseo }) => { await ready(paseo); return settings; });
  server.handle(getDelegationRpc, async ({ leadAgentId }, { paseo }) => {
    await ready(paseo);
    const item = state.getDelegationByLead(leadAgentId);
    return { delegation: item ? { status: item.status, sidekick_agent_id: item.sidekickId, sidekick_model: item.sidekickModel, brief: item.brief.goal, dispatched_at: item.dispatchedAt } : null };
  });
  server.handle(getWorkspaceRpc, async (input, { paseo }) => { await ready(paseo); return state.workspace(input); });
  server.handle(createLeadRpc, async ({ workspaceId, profileId, prompt }, { paseo }) => {
    await ready(paseo);
    if (!settings.enabled) throw new Error("Fusion is disabled");
    const profile = settings.profiles.find((item) => item.id === profileId);
    if (!profile) throw new Error("Profile not found");
    await checkProvider(paseo, profile.lead); await checkProvider(paseo, profile.sidekick);
    const useMcp = usesMcp(profile.lead, profile, settings);
    if ((!useMcp || !usesMcp(profile.sidekick, profile, settings)) && !settings.fallback_to_fenced) throw new Error("This pair requires fenced delegation; enable Fallback to fenced or choose MCP transport.");
    const agent = await paseo.workspaces.ref(workspaceId).agents.create({
      config: { ...modelConfig(profile.lead), ...(useMcp ? mcpToolPolicy(profile.lead, "delegate") : {}), ...(useMcp ? { mcpServers: { fusion: { type: "http" as const, url: MCP_URL, alwaysLoad: true } } } : {}) },
      env: { PASEO_MODEL_FUSION_TEXT_ONLY: useMcp ? "0" : "1" }, title: "Fusion lead: " + profile.name,
      labels: { [LABEL.fusionRole]: "lead", [LABEL.fusionProfile]: profile.id, "fusion.transport": useMcp ? "mcp" : "fenced" },
      prompt: "You are the Fusion lead. Plan, delegate implementation, and review the sidekick report. " +
        (useMcp ? "Use Fusion's delegate tool, then wait for its report. If unavailable, " : "") + getFencedBriefPrompt(profile) + "\n\nTask:\n" + prompt,
    });
    return { agentId: agent.id };
  });
  server.handle(delegationActionRpc, async ({ workspaceId, delegationId, action }, { paseo }) => {
    await ready(paseo);
    const item = state.getDelegation(delegationId);
    if (!item || item.workspaceId !== workspaceId) throw new Error("Delegation not found in this workspace");
    if (action === "cancel" && item.status !== "dispatched" && item.status !== "running") return { ok: false, message: "Delegation already finished" };
    if (action === "cancel") await finishDelegation(paseo, settings, state, item, "canceled", "Canceled from the Fusion workspace panel.");
    else await deliverReport(paseo, state, item);
    return { ok: true, message: action === "cancel" ? "Delegation canceled" : item.reportDeliveredAt !== null ? "Report delivered" : "Delivery is still pending" };
  });
  const maintenance = setInterval(() => {
    if (stopped) return;
    state.prune(settings.history_retention_days);
    if (paseoApi) void recoverDelegations(paseoApi, settings, state).catch((error) => console.error("[fusion] Maintenance failed", error));
  }, 60_000);
  return async () => {
    stopped = true; unsubscribeSettings(); cleanups.forEach((cleanup) => cleanup());
    clearInterval(maintenance); state.dispose(); await mcpServer.stop();
  };
}
async function resolveLeadAgent(paseo: PaseoApi, callerId: string, explicitId?: string) {
  if (callerId || explicitId) {
    const snapshot = await paseo.agents.ref(callerId || explicitId!).refresh();
    if (!snapshot || !isLead(snapshot.agent.labels)) throw new Error("Only a labeled Fusion lead can delegate");
    return snapshot.agent;
  }
  const agents = await paseo.agents.list();
  const leads = agents.entries.filter(({ agent }) => agent.activeTurn && isLead(agent.labels));
  if (leads.length !== 1) throw new Error("Pass lead_agent_id unless exactly one Fusion lead is active");
  return leads[0].agent;
}
