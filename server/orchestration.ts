import { randomUUID } from "node:crypto";
import { isAntigravity, requireFusionProvider, ANTIGRAVITY_POLICY_MESSAGE } from "../shared/provider-policy";
import type { PaseoApi } from "./protocol-types";
import type { FusionSettings, Profile, ProviderModel } from "../shared/settings";
import { BriefSchema, ReportSchema, isActive, type Brief, type Report } from "../shared/models";
import { FusionState, type DelegationState } from "./state";
import { LABEL } from "../shared/labels";
import { DELEGATION_KIND, DELEGATION_VERSION, DELEGATION_ROW_ID } from "../shared/contracts";
import { parseFencedReport } from "./fenced";
import { latestAssistantText } from "./timeline";

const dispatches = new Map<string, Promise<unknown>>();
const deliveries = new Map<string, Promise<void>>();
export function modelConfig(model: ProviderModel) {
  requireFusionProvider(model);
  return {
    provider: model.provider + (model.model ? "/" + model.model : ""),
    ...(model.modeId ? { modeId: model.modeId } : {}),
    ...(model.thinkingOptionId ? { thinkingOptionId: model.thinkingOptionId } : {}),
  };
}
export function usesMcp(model: ProviderModel, profile: Profile, settings: FusionSettings): boolean {
  return settings.use_mcp_delegation && profile.transport !== "fenced" &&
    (profile.transport === "mcp" || !["devin", "cursor", "antigravity"].includes(model.provider));
}
export function mcpToolPolicy(model: ProviderModel, tool: string) {
  return ["codex", "claude", "opencode"].includes(model.provider)
    ? { toolPolicy: { preapproved: [{ kind: "mcp" as const, server: "fusion", tool }] } } : {};
}
export async function checkProvider(paseo: PaseoApi, model: ProviderModel): Promise<void> {
  requireFusionProvider(model);
  const available = await paseo.providers.listAvailable();
  const provider = available.providers.find((item) => item.provider === model.provider);
  if (!provider || !provider.available) throw new Error("Provider is unavailable: " + model.provider);
  if (model.model) {
    const result = await paseo.providers.listModels(model.provider);
    if (!result.models?.some((item) => item.id === model.model)) throw new Error("Model is unavailable: " + model.provider + "/" + model.model);
  }
}
export async function publishDelegation(paseo: PaseoApi, settings: FusionSettings, item: DelegationState): Promise<void> {
  if (!settings.show_timeline_card) return;
  try {
    const lead = paseo.agents.ref(item.leadId);
    const snapshot = await lead.refresh();
    if (!snapshot || snapshot.agent.archivedAt) return;
    await lead.timeline.append({
      type: "plugin", id: DELEGATION_ROW_ID + ":" + item.briefId,
      kind: DELEGATION_KIND, version: DELEGATION_VERSION,
      data: {
        status: item.status, lead_agent_id: item.leadId, sidekick_agent_id: item.sidekickId,
        sidekick_model: item.sidekickModel, brief: item.brief.goal.slice(0, 1000),
        // Timeline rows have a 64 KiB cap. The workspace panel retains the full report.
        report: item.report ? { ...item.report,
          summary: item.report.summary.length > 4000 ? item.report.summary.slice(0, 4000) + "…" : item.report.summary,
          changes: [], tests: [], concerns: item.report.concerns.slice(0, 5).map((value) => value.slice(0, 500)), suggested_next: null,
        } : null,
        cost_lead: item.costLead, cost_sidekick: item.costSidekick,
        at: new Date(item.dispatchedAt).toISOString(), updated_at: new Date().toISOString(),
      },
    });
  } catch (error) { console.error("[fusion] Card update failed", item.briefId, error); }
}
export async function deliverReport(paseo: PaseoApi, state: FusionState, item: DelegationState): Promise<void> {
  if (!item.report || item.reportDeliveredAt !== null) return;
  const existing = deliveries.get(item.briefId);
  if (existing) return existing;
  const pending = (async () => {
    try {
      const lead = await paseo.agents.ref(item.leadId).refresh();
      if (lead) requireFusionProvider({ provider: lead.agent.provider, model: lead.agent.model });
      const report = item.report!;
      const message = [
        "## Sidekick report [" + item.briefId + "]",
        "Goal: " + item.brief.goal, "Status: " + item.status + " (" + report.status + ")", report.summary,
        ...(["changes", "tests", "concerns"] as const).filter((key) => report[key].length)
          .map((key) => key + ":\n" + report[key].map((value) => "- " + value).join("\n")),
        report.suggested_next ? "Suggested next: " + report.suggested_next : "",
        "Review the result, send a new brief for feedback, or take over. This report may be redelivered after a crash; use its ID to recognize duplicates.",
      ].filter(Boolean).join("\n\n");
      await paseo.agents.ref(item.leadId).send(message, { activeTurnBehavior: "steer" });
      state.updateDelegation(item.briefId, { reportDeliveredAt: Date.now(), error: null });
    } catch (error) {
      state.updateDelegation(item.briefId, { error: "Report delivery failed: " + String(error) });
    }
  })();
  deliveries.set(item.briefId, pending);
  try { await pending; } finally { deliveries.delete(item.briefId); }
}
export function markFinished(state: FusionState, item: DelegationState, status: "failed" | "timeout" | "canceled" | "blocked", message: string): boolean {
  if (!isActive(item.status)) return false;
  state.clearTimer(item.briefId);
  state.updateDelegation(item.briefId, {
    status, error: message,
    report: { status: "blocked", summary: message, changes: [], tests: [], concerns: [message], suggested_next: "Review, retry, or take over." },
  });
  if (item.sidekickId) state.updateSidekick(item.sidekickId, { status: "failed", lastUsedAt: Date.now() });
  return true;
}
export async function finishDelegation(
  paseo: PaseoApi, settings: FusionSettings, state: FusionState, item: DelegationState,
  status: "failed" | "timeout" | "canceled" | "blocked", message: string,
): Promise<void> {
  if (!markFinished(state, item, status, message)) return;
  if ((status === "timeout" || status === "canceled") && item.sidekickId) {
    try {
      await paseo.agents.ref(item.sidekickId).archive();
      state.updateDelegation(item.briefId, { stopConfirmed: true });
    } catch (error) { console.error("[fusion] Could not stop sidekick", error); }
  }
  await deliverReport(paseo, state, item);
  await publishDelegation(paseo, settings, item);
}
function armTimeout(paseo: PaseoApi, settings: FusionSettings, state: FusionState, item: DelegationState) {
  state.armTimer(item.briefId, () => finishDelegation(paseo, settings, state, item, "timeout", "The sidekick exceeded its delegation deadline."));
}

export async function handleDelegation(
  paseo: PaseoApi, settings: FusionSettings, state: FusionState,
  request: { leadId: string; workspaceId: string; leadTurnId: string | null; mcpUrl: string; profile: Profile; brief: Brief },
): Promise<{ sidekickId: string | null; error?: string }> {
  const previous = dispatches.get(request.leadId) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    if (!settings.enabled) return { sidekickId: null, error: "Fusion is disabled" };
    const brief = BriefSchema.parse(request.brief);
    const profile = request.profile;
    if (isAntigravity(profile.lead) || isAntigravity(profile.sidekick)) return { sidekickId: null, error: ANTIGRAVITY_POLICY_MESSAGE };
    if (!usesMcp(profile.sidekick, profile, settings) && !settings.fallback_to_fenced) return { sidekickId: null, error: "This sidekick requires fenced delegation; enable Fallback to fenced or choose MCP transport." };
    if (profile.max_cost <= 0) return { sidekickId: null, error: "The sidekick cost budget is zero" };
    const signature = JSON.stringify(profile);
    const briefId = randomUUID();
    let sidekick = state.findReusableSidekick(request.leadId, signature, profile.max_turns, profile.max_cost);
    if (sidekick) {
      const snapshot = await paseo.agents.ref(sidekick.sidekickId).refresh().catch(() => null);
      if (!snapshot || snapshot.agent.archivedAt || snapshot.agent.activeTurn) {
        state.updateSidekick(sidekick.sidekickId, { status: "failed" });
        sidekick = null;
      }
    }
    const now = Date.now();
    const item = state.recordDelegation({
      briefId, reportToken: randomUUID(), leadId: request.leadId, workspaceId: request.workspaceId,
      profileId: profile.id, sidekickModel: modelConfig(profile.sidekick).provider,
      sidekickId: sidekick?.sidekickId ?? null, leadTurnId: request.leadTurnId,
      brief, status: "dispatched", dispatchedAt: now, timeoutAt: now + profile.timeout_seconds * 1000,
    });
    armTimeout(paseo, settings, state, item);
    try {
      if (!sidekick) {
        await checkProvider(paseo, profile.sidekick);
        if (!isActive(item.status)) return { sidekickId: null, error: "Delegation closed before launch" };
        const agent = await paseo.workspaces.ref(request.workspaceId).agents.create({
          idempotencyKey: "fusion:" + briefId, parent: request.leadId,
          config: {
            ...modelConfig(profile.sidekick),
            systemPrompt: buildSidekickSystemPrompt(profile),
            ...(usesMcp(profile.sidekick, profile, settings) ? mcpToolPolicy(profile.sidekick, "report") : {}),
            ...(usesMcp(profile.sidekick, profile, settings) ? { mcpServers: { fusion: { type: "http" as const, url: request.mcpUrl, alwaysLoad: true } } } : {}),
          },
          env: { PASEO_MODEL_FUSION_SIDEKICK: "1" }, title: "Fusion sidekick: " + profile.name,
          labels: { [LABEL.fusionRole]: "sidekick", [LABEL.fusionProfile]: profile.id, [LABEL.fusionLeadId]: request.leadId },
        });
        state.updateDelegation(briefId, { sidekickId: agent.id });
        if (!isActive(item.status)) {
          await agent.archive();
          state.updateDelegation(briefId, { stopConfirmed: true });
          return { sidekickId: null, error: "Delegation closed during launch" };
        }
        sidekick = {
          sidekickId: agent.id, leadId: request.leadId, workspaceId: request.workspaceId, profileId: profile.id,
          profileSignature: signature, briefId, createdAt: now, lastUsedAt: now, status: "running",
          turnCount: 0, totalCost: 0, turnId: null,
        };
        state.registerSidekick(sidekick);
        state.updateDelegation(briefId, { sidekickId: agent.id });
      } else {
        state.updateSidekick(sidekick.sidekickId, { briefId, status: "running", lastUsedAt: now, turnId: null });
      }
      armTimeout(paseo, settings, state, item);
      await paseo.agents.ref(sidekick.sidekickId).send(buildBriefPrompt(item, profile, settings));
      if (isActive(item.status)) state.updateDelegation(briefId, { status: "running" });
      await publishDelegation(paseo, settings, item);
      return { sidekickId: sidekick.sidekickId };
    } catch (error) {
      await finishDelegation(paseo, settings, state, item, "failed", "Could not dispatch brief: " + String(error));
      return { sidekickId: null, error: String(error) };
    }
  });
  dispatches.set(request.leadId, current);
  try { return await current; } finally { if (dispatches.get(request.leadId) === current) dispatches.delete(request.leadId); }
}

export async function handleSidekickReport(
  paseo: PaseoApi, settings: FusionSettings, state: FusionState,
  input: { briefId: string; reportToken: string; report: Report; callerAgentId?: string },
): Promise<boolean> {
  const parsed = ReportSchema.safeParse(input.report);
  const current = state.getDelegation(input.briefId);
  if (!parsed.success || !current?.sidekickId || (input.callerAgentId && input.callerAgentId !== current.sidekickId)) return false;
  const item = state.acceptReport(input.briefId, input.reportToken, parsed.data);
  if (!item) return false;
  await deliverReport(paseo, state, item);
  await publishDelegation(paseo, settings, item);
  return true;
}
export async function handleSidekickTurnEnded(
  paseo: PaseoApi, settings: FusionSettings, state: FusionState,
  event: { agent: { id: string }; timeline: readonly unknown[]; turnId: string; cost: number | null; outcome: { kind: "completed" | "failed" | "canceled" } },
): Promise<void> {
  const sidekick = state.getSidekick(event.agent.id);
  const item = state.getDelegationBySidekick(event.agent.id);
  if (!sidekick || !item || (sidekick.turnId && sidekick.turnId !== event.turnId)) return;
  state.recordUsage(event.agent.id, event.turnId, event.cost, "sidekick");
  if (item.report || !isActive(item.status)) {
    state.updateSidekick(event.agent.id, { status: item.status === "completed" || item.status === "blocked" ? "idle" : "failed", lastUsedAt: Date.now() });
    await publishDelegation(paseo, settings, item);
    return;
  }
  const report = settings.fallback_to_fenced ? parseFencedReport(latestAssistantText(event.timeline, event.turnId)) : null;
  if (report && report.delegationId === item.briefId && report.reportToken === item.reportToken) {
    const accepted = await handleSidekickReport(paseo, settings, state, { briefId: report.delegationId, reportToken: report.reportToken, report: report.report });
    if (accepted) { state.updateSidekick(event.agent.id, { status: "idle", lastUsedAt: Date.now() }); return; }
  }
  const status = event.outcome.kind === "canceled" ? "canceled" : event.outcome.kind === "failed" ? "failed" : "blocked";
  await finishDelegation(paseo, settings, state, item, status,
    status === "blocked" ? "The sidekick finished without a valid report." : "The sidekick turn " + event.outcome.kind + ".");
}
export async function recoverDelegations(paseo: PaseoApi, settings: FusionSettings, state: FusionState): Promise<void> {
  for (const item of state.getDelegations()) {
    try {
      if (isActive(item.status) && isAntigravity({ provider: item.sidekickModel })) {
        await finishDelegation(paseo, settings, state, item, "canceled", ANTIGRAVITY_POLICY_MESSAGE);
        continue;
      }
      if (isActive(item.status)) {
        if (dispatches.has(item.leadId) && item.status === "dispatched") continue;
        if (!item.sidekickId) {
          await finishDelegation(paseo, settings, state, item, "failed", "The plugin stopped before sidekick creation completed. Review before retrying.");
          continue;
        }
        const snapshot = await paseo.agents.ref(item.sidekickId).refresh();
        if (!snapshot || snapshot.agent.archivedAt) {
          await finishDelegation(paseo, settings, state, item, "failed", "The sidekick is no longer available.");
        } else if (snapshot.agent.activeTurn) {
          state.updateSidekick(item.sidekickId, { status: "running", turnId: snapshot.agent.activeTurn.turnId });
          armTimeout(paseo, settings, state, item);
        } else {
          const history = await paseo.agents.ref(item.sidekickId).timeline.refetch({ direction: "tail", limit: 100 });
          const knownTurn = state.getSidekick(item.sidekickId)?.turnId;
          const completedReport = parseFencedReport(latestAssistantText(history.entries));
          if (!knownTurn && (!completedReport || completedReport.delegationId !== item.briefId || completedReport.reportToken !== item.reportToken)) {
            armTimeout(paseo, settings, state, item);
            continue;
          }
          const turnId = knownTurn || history.entries.at(-1)?.turnId || "recovered:" + history.entries.at(-1)?.seqEnd;
          await handleSidekickTurnEnded(paseo, settings, state, {
            agent: { id: item.sidekickId }, timeline: history.entries, turnId,
            cost: snapshot.agent.lastUsage?.totalCostUsd ?? null,
            outcome: { kind: snapshot.agent.lastError ? "failed" : "completed" },
          });
        }
      } else if (item.sidekickId && (state.getSidekick(item.sidekickId)?.status === "running" || ((item.status === "timeout" || item.status === "canceled") && !item.stopConfirmed))) {
        const snapshot = await paseo.agents.ref(item.sidekickId).refresh();
        if (!snapshot || snapshot.agent.archivedAt) {
          state.updateSidekick(item.sidekickId, { status: "failed" });
          if (item.status === "timeout" || item.status === "canceled") state.updateDelegation(item.briefId, { stopConfirmed: true });
        }
        if (snapshot && (item.status === "timeout" || item.status === "canceled") && !item.stopConfirmed) {
          if (!snapshot.agent.archivedAt) await paseo.agents.ref(item.sidekickId).archive();
          state.updateDelegation(item.briefId, { stopConfirmed: true });
        }
        if (snapshot && !snapshot.agent.archivedAt && !snapshot.agent.activeTurn) {
          const turnId = state.getSidekick(item.sidekickId)?.turnId;
          if (turnId) state.recordUsage(item.sidekickId, turnId, snapshot.agent.lastUsage?.totalCostUsd ?? null, "sidekick");
          state.updateSidekick(item.sidekickId, { status: item.status === "completed" || item.status === "blocked" ? "idle" : "failed" });
        }
      }
      await deliverReport(paseo, state, item);
    } catch (error) {
      console.error("[fusion] Recovery deferred", item.briefId, error);
      if (isActive(item.status)) armTimeout(paseo, settings, state, item);
    }
  }
  for (const leadId of new Set(state.getDelegations().map((item) => item.leadId))) {
    const latest = state.getDelegationByLead(leadId);
    if (latest) await publishDelegation(paseo, settings, latest);
  }
}

export function buildBriefPrompt(item: DelegationState, profile: Profile, settings: FusionSettings): string {
  const brief = item.brief;
  const reportFields = "delegation_id: " + item.briefId + "\nreport_token: " + item.reportToken +
    "\nstatus: completed\nsummary: <result>\nchanges:\n- <change>\ntests:\n- <check and result>\nconcerns:\nsuggested_next:";
  return [
    "## Delegation from lead", "Goal: " + brief.goal,
    brief.constraints ? "Constraints:\n" + brief.constraints : "",
    brief.success_criteria ? "Success criteria:\n" + brief.success_criteria : "",
    brief.files_hint?.length ? "Files:\n" + brief.files_hint.join("\n") : "",
    { detailed: "Explain decisions and every success criterion.", concise: "Keep the work and report concise.", minimal: "Report essential facts only." }[profile.brief_style],
    usesMcp(profile.sidekick, profile, settings) ? "When done, call Fusion's report tool with the fields below. Use arrays for changes, tests and concerns." : "When done, finish with the fenced report below.",
    reportFields,
    settings.fallback_to_fenced ? "If the report tool is unavailable, finish with:\n```report\n" + reportFields + "\n```" : "",
    profile.allow_pushback ? "Report blocked or needs-clarification when needed." : "Work within the brief and report concerns.",
    "Do not delegate further. Do not claim checks you did not run.",
  ].filter(Boolean).join("\n\n");
}
function buildSidekickSystemPrompt(profile: Profile): string {
  return "You are a Fusion implementation sidekick. Follow the lead's brief and return a structured report. " +
    (profile.delegate_exploration ? "Explore as needed to meet the brief. " : "Limit exploration to the supplied files and task. ") +
    "Your context is separate from the lead. Ask for clarification through your report when needed.";
}
