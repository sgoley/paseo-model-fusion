import type { PaseoApi } from "./protocol-types";
import type { FusionSettings, Profile } from "../shared/settings";
import { FusionState } from "./state";
import { LABEL, isSidekick, getLeadId, getProfileId } from "../shared/labels";
import {
  DELEGATION_KIND,
  DELEGATION_VERSION,
  DELEGATION_ROW_ID,
  type DelegationCard,
  type DelegationStatus,
  type ReportStatus,
} from "../shared/contracts";

interface DelegationRequest {
  leadId: string;
  leadProvider: string;
  leadCwd: string;
  profile: Profile;
  brief: {
    goal: string;
    constraints?: string;
    success_criteria?: string;
    files_hint?: string[];
  };
}

interface SidekickReport {
  status: ReportStatus;
  summary: string;
  changes: string[];
  tests: string[];
  concerns: string[];
  suggested_next?: string;
}

const log = (...args: unknown[]) => console.log("[fusion]", ...args);

export async function handleDelegation(
  paseo: PaseoApi,
  settings: FusionSettings,
  state: FusionState,
  request: DelegationRequest,
): Promise<{ sidekickId: string | null; error?: string }> {
  const { leadId, leadProvider, leadCwd, profile, brief } = request;

  log("Delegation requested", { leadId, profileId: profile.id });

  // Check if we can reuse an existing sidekick
  const existingSidekick = state.findReusableSidekick(leadId, profile.id);
  let sidekickId: string;
  const briefId = `${leadId}-${Date.now()}`;

  if (existingSidekick) {
    log("Reusing existing sidekick", existingSidekick.sidekickId);
    sidekickId = existingSidekick.sidekickId;

    // Check limits
    if (state.hasExceededMaxTurns(sidekickId, profile.max_turns)) {
      log("Sidekick exceeded max turns", sidekickId);
      state.setSidekickFailed(sidekickId);
      return { sidekickId: null, error: "Sidekick exceeded max turns" };
    }

    if (state.hasExceededMaxCost(sidekickId, profile.max_cost)) {
      log("Sidekick exceeded max cost", sidekickId);
      state.setSidekickFailed(sidekickId);
      return { sidekickId: null, error: "Sidekick exceeded max cost" };
    }

    state.setSidekickRunning(sidekickId);
  } else {
    // Create a new sidekick
    log("Creating new sidekick");
    const sidekick = await createSidekick(paseo, leadId, leadCwd, profile, briefId);
    if (!sidekick) {
      return { sidekickId: null, error: "Failed to create sidekick" };
    }
    sidekickId = sidekick.id;

    state.registerSidekick({
      sidekickId,
      leadId,
      profileId: profile.id,
      briefId,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      status: "running",
      turnCount: 0,
      totalCost: 0,
    });
  }

  // Record the delegation
  state.recordDelegation({
    leadId,
    sidekickId,
    briefId,
    brief,
    status: "dispatched",
    dispatchedAt: Date.now(),
  });

  // Set timeout for the delegation
  state.setDelegationTimeout(briefId, profile.timeout_seconds * 1000, async () => {
    log("Delegation timeout", briefId);
    state.updateDelegationStatus(briefId, "timeout");
    state.setSidekickIdle(sidekickId);
    await updateDelegationCard(paseo, leadId, {
      status: "timeout",
      lead_agent_id: leadId,
      sidekick_agent_id: sidekickId,
      sidekick_model: `${profile.sidekick.provider}/${profile.sidekick.model || "default"}`,
      brief: brief.goal,
      report: {
        status: "blocked",
        summary: "Sidekick timed out",
        changes: [],
        tests: [],
        concerns: ["Delegation exceeded timeout"],
        suggested_next: "Take over or retry with a longer timeout",
      },
      cost_lead: null,
      cost_sidekick: null,
      at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  });

  // Send the brief to the sidekick
  const briefPrompt = buildBriefPrompt(brief, profile);
  try {
    await paseo.agents.ref(sidekickId).send(briefPrompt);
    log("Brief sent to sidekick", sidekickId);
  } catch (error) {
    log("Failed to send brief to sidekick", sidekickId, error);
    state.clearDelegationTimeout(briefId);
    state.setSidekickFailed(sidekickId);
    state.updateDelegationStatus(briefId, "failed");
    return { sidekickId: null, error: "Failed to send brief to sidekick" };
  }

  // Update timeline card on the lead
  await updateDelegationCard(paseo, leadId, {
    status: "dispatched",
    lead_agent_id: leadId,
    sidekick_agent_id: sidekickId,
    sidekick_model: `${profile.sidekick.provider}/${profile.sidekick.model || "default"}`,
    brief: brief.goal,
    report: null,
    cost_lead: null,
    cost_sidekick: null,
    at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  return { sidekickId };
}

async function createSidekick(
  paseo: PaseoApi,
  leadId: string,
  cwd: string,
  profile: Profile,
  briefId: string,
) {
  try {
    const workspace = await paseo.workspaces.open(cwd);
    const created = await workspace.agents.create({
      idempotencyKey: `fusion:sidekick:${leadId}:${briefId}`,
      config: {
        provider: `${profile.sidekick.provider}/${profile.sidekick.model || ""}`,
        ...(profile.sidekick.modeId ? { modeId: profile.sidekick.modeId } : {}),
        ...(profile.sidekick.thinkingOptionId ? { thinkingOptionId: profile.sidekick.thinkingOptionId } : {}),
        systemPrompt: buildSidekickSystemPrompt(profile),
      },
      title: `Fusion Sidekick (${profile.name})`,
      prompt: "Waiting for brief from lead...",
      labels: {
        [LABEL.fusionRole]: "sidekick",
        [LABEL.fusionProfile]: profile.id,
        [LABEL.fusionLeadId]: leadId,
        [LABEL.fusionBriefId]: briefId,
      },
    });
    log("Sidekick created", created.id);
    return created;
  } catch (error) {
    log("Failed to create sidekick", error);
    return null;
  }
}

function buildBriefPrompt(
  brief: { goal: string; constraints?: string; success_criteria?: string; files_hint?: string[] },
  profile: Profile,
): string {
  let prompt = `## Delegation from Lead\n\n`;
  prompt += `**Goal:** ${brief.goal}\n\n`;

  if (brief.constraints) {
    prompt += `**Constraints:**\n${brief.constraints}\n\n`;
  }

  if (brief.success_criteria) {
    prompt += `**Success Criteria:**\n${brief.success_criteria}\n\n`;
  }

  if (brief.files_hint && brief.files_hint.length > 0) {
    prompt += `**Files to focus on:**\n${brief.files_hint.join(", ")}\n\n`;
  }

  prompt += `Please explore, implement, and test. When done, call the \`report\` tool with:\n`;
  prompt += `- status: "completed", "blocked", "needs-clarification", or "concerns"\n`;
  prompt += `- summary: 1-2 paragraph high-level summary\n`;
  prompt += `- changes: list of files edited or services configured\n`;
  prompt += `- tests: list of tests run and their results\n`;
  prompt += `- concerns: any risks, trade-offs, or things the lead should review\n`;
  prompt += `- suggested_next: optional suggestion for what the lead should do next\n\n`;

  if (profile.allow_pushback) {
    prompt += `Note: You may push back if the brief is unclear or the constraints are unreasonable.\n`;
  } else {
    prompt += `Note: Do not push back. Work within the given constraints and report any concerns.\n`;
  }

  return prompt;
}

function buildSidekickSystemPrompt(profile: Profile): string {
  let prompt = `You are a focused implementation agent (Fusion Sidekick).\n\n`;
  prompt += `Your role is to explore, implement, and test according to the brief from the lead agent.\n`;
  prompt += `You do not make architectural decisions without asking.\n\n`;

  if (profile.delegate_exploration) {
    prompt += `You are expected to explore the codebase, try different approaches, and run tests.\n`;
  } else {
    prompt += `Stick to the brief and do not explore beyond what is explicitly requested.\n`;
  }

  prompt += `When you complete your work, call the \`report\` tool to send your results back to the lead.\n`;
  prompt += `Keep your responses focused and actionable.\n`;

  return prompt;
}

async function updateDelegationCard(paseo: PaseoApi, leadId: string, card: DelegationCard) {
  try {
    await paseo.agents.ref(leadId).timeline.append({
      type: "plugin",
      id: DELEGATION_ROW_ID,
      kind: DELEGATION_KIND,
      version: DELEGATION_VERSION,
      data: card,
    });
  } catch (error) {
    log("Failed to update delegation card", leadId, error);
  }
}

export async function handleSidekickTurnEnded(
  paseo: PaseoApi,
  settings: FusionSettings,
  state: FusionState,
  event: {
    agent: { id: string; labels: Record<string, string>; parentAgentId: string | null };
    timeline: readonly unknown[];
    outcome: { kind: string };
  },
) {
  const { agent } = event;

  if (!isSidekick(agent.labels)) {
    return;
  }

  const leadId = getLeadId(agent.labels);
  if (!leadId) {
    log("Sidekick has no lead ID", agent.id);
    return;
  }

  const profileId = getProfileId(agent.labels);
  if (!profileId) {
    log("Sidekick has no profile ID", agent.id);
    return;
  }

  const profile = settings.profiles.find((p) => p.id === profileId);
  if (!profile) {
    log("Sidekick profile not found", profileId);
    return;
  }

  log("Sidekick turn ended", agent.id, event.outcome.kind);

  // Increment turn count
  state.incrementSidekickTurns(agent.id);

  // Try to get cost from agent
  try {
    const agentHandle = await paseo.agents.ref(agent.id).refresh();
    if (agentHandle?.agent.lastUsage) {
      const cost = agentHandle.agent.lastUsage.totalCost || 0;
      state.addSidekickCost(agent.id, cost);
    }
  } catch (error) {
    log("Failed to get sidekick cost", agent.id, error);
  }

  // Check if the turn ended with an error
  if (event.outcome.kind === "error") {
    log("Sidekick ended with error", agent.id);
    state.setSidekickFailed(agent.id);
    await updateDelegationCard(paseo, leadId, {
      status: "failed",
      lead_agent_id: leadId,
      sidekick_agent_id: agent.id,
      sidekick_model: `${profile.sidekick.provider}/${profile.sidekick.model || "default"}`,
      brief: "Brief text",
      report: {
        status: "blocked",
        summary: "Sidekick encountered an error",
        changes: [],
        tests: [],
        concerns: ["Sidekick crashed or failed"],
        suggested_next: "Take over or retry",
      },
      cost_lead: null,
      cost_sidekick: state.getSidekick(agent.id)?.totalCost || null,
      at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return;
  }

  // Clear timeout since the sidekick completed
  const sidekickState = state.getSidekick(agent.id);
  if (sidekickState) {
    state.clearDelegationTimeout(sidekickState.briefId);
  }

  // Mark sidekick as idle
  state.setSidekickIdle(agent.id);

  // Try to extract a report from the timeline
  const report = await extractReport(paseo, agent.id, event.timeline);
  if (!report) {
    log("No report found in sidekick timeline", agent.id);
    // Still update the card to show completion
    await updateDelegationCard(paseo, leadId, {
      status: "completed",
      lead_agent_id: leadId,
      sidekick_agent_id: agent.id,
      sidekick_model: `${profile.sidekick.provider}/${profile.sidekick.model || "default"}`,
      brief: "No brief text available",
      report: {
        status: "completed",
        summary: "Sidekick completed work but did not call report tool",
        changes: [],
        tests: [],
        concerns: ["Report tool was not called"],
        suggested_next: null,
      },
      cost_lead: null,
      cost_sidekick: state.getSidekick(agent.id)?.totalCost || null,
      at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return;
  }

  // Send the report to the lead
  const reportMessage = buildReportMessage(report);
  try {
    await paseo.agents.ref(leadId).send(reportMessage);
    log("Report sent to lead", leadId);
  } catch (error) {
    log("Failed to send report to lead", leadId, error);
  }

  // Update the delegation card
  await updateDelegationCard(paseo, leadId, {
    status: "completed",
    lead_agent_id: leadId,
    sidekick_agent_id: agent.id,
    sidekick_model: `${profile.sidekick.provider}/${profile.sidekick.model || "default"}`,
    brief: "Brief text",
    report,
    cost_lead: null,
    cost_sidekick: state.getSidekick(agent.id)?.totalCost || null,
    at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
}

async function extractReport(
  paseo: PaseoApi,
  sidekickId: string,
  timeline: readonly unknown[],
): Promise<SidekickReport | null> {
  // Try to find a report tool call in the timeline
  for (const entry of timeline) {
    const item = entry as { item?: { type?: string; data?: unknown } };
    if (item.item?.type === "tool_use" && item.item.data) {
      const data = item.item.data as { name?: string; input?: unknown };
      if (data.name === "report" && data.input) {
        const reportInput = data.input as SidekickReport;
        // Validate the report input
        if (
          reportInput.status &&
          reportInput.summary &&
          Array.isArray(reportInput.changes) &&
          Array.isArray(reportInput.tests) &&
          Array.isArray(reportInput.concerns)
        ) {
          log("Extracted report from tool call", sidekickId);
          return reportInput;
        }
      }
    }
  }

  // If no tool call found, try to parse the final message
  // Look for a fenced report block in the last assistant message
  for (let i = timeline.length - 1; i >= 0; i--) {
    const entry = timeline[i] as { item?: { type?: string; data?: unknown } };
    if (entry.item?.type === "assistant" && entry.item.data) {
      const data = entry.item.data as { content?: string };
      if (data.content) {
        const report = parseReportFromText(data.content);
        if (report) {
          log("Extracted report from message", sidekickId);
          return report;
        }
      }
    }
  }

  return null;
}

function parseReportFromText(text: string): SidekickReport | null {
  // Look for a fenced report block
  const reportMatch = text.match(/```report\n([\s\S]*?)\n```/);
  if (!reportMatch) {
    return null;
  }

  const reportText = reportMatch[1];
  const lines = reportText.split("\n");

  const report: SidekickReport = {
    status: "completed",
    summary: "",
    changes: [],
    tests: [],
    concerns: [],
  };

  let currentSection: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("status:")) {
      const status = trimmed.slice(7).trim();
      if (["completed", "blocked", "needs-clarification", "concerns"].includes(status)) {
        report.status = status as SidekickReport["status"];
      }
    } else if (trimmed.startsWith("summary:")) {
      currentSection = "summary";
      report.summary = trimmed.slice(8).trim();
    } else if (trimmed.startsWith("changes:")) {
      currentSection = "changes";
    } else if (trimmed.startsWith("tests:")) {
      currentSection = "tests";
    } else if (trimmed.startsWith("concerns:")) {
      currentSection = "concerns";
    } else if (trimmed.startsWith("suggested_next:")) {
      report.suggested_next = trimmed.slice(15).trim();
    } else if (trimmed.startsWith("-") && currentSection) {
      const item = trimmed.slice(1).trim();
      if (currentSection === "changes") {
        report.changes.push(item);
      } else if (currentSection === "tests") {
        report.tests.push(item);
      } else if (currentSection === "concerns") {
        report.concerns.push(item);
      }
    } else if (currentSection === "summary" && trimmed) {
      report.summary += " " + trimmed;
    }
  }

  // Validate that we have at least a summary
  if (!report.summary) {
    return null;
  }

  return report;
}

function buildReportMessage(report: SidekickReport): string {
  let message = `## Sidekick Report\n\n`;
  message += `**Status:** ${report.status}\n\n`;
  message += `**Summary:**\n${report.summary}\n\n`;

  if (report.changes.length > 0) {
    message += `**Changes:**\n${report.changes.map((c) => `- ${c}`).join("\n")}\n\n`;
  }

  if (report.tests.length > 0) {
    message += `**Tests:**\n${report.tests.map((t) => `- ${t}`).join("\n")}\n\n`;
  }

  if (report.concerns.length > 0) {
    message += `**Concerns:**\n${report.concerns.map((c) => `- ${c}`).join("\n")}\n\n`;
  }

  if (report.suggested_next) {
    message += `**Suggested next:** ${report.suggested_next}\n\n`;
  }

  message += `Please review and either accept, send feedback, or take over.\n`;

  return message;
}
