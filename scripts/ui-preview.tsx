import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PluginRpcProvider } from "@getpaseo/plugin/client";
import { FusionWorkspacePanel } from "../client/workspace-panel";
import { DelegationTimelineCard } from "../client/timeline-card";
import { DEFAULT_SETTINGS } from "../shared/settings";

const listing = new URLSearchParams(window.location.search).has("listing");
const records = Array.from({ length: 32 }, (_, index) => ({
  id: "delegation-" + index, workspaceId: "preview-workspace", leadId: "lead-" + index,
  sidekickId: "sidekick-" + index, profileId: "codex-sol-to-luna", sidekickModel: "codex/gpt-6-luna",
  brief: { goal: index === 0 ? "Add workspace history and report review" : "Review implementation brief " + index,
    constraints: "Keep the change focused.", success_criteria: "Changes pass the requested checks.", files_hint: ["client/workspace-panel.tsx"] },
  status: index < 2 ? "running" : index === 2 ? "blocked" : "completed",
  dispatchedAt: Date.now() - index * 120000, completedAt: index < 2 ? null : Date.now() - index * 60000,
  timeoutAt: Date.now() + 300000, report: index < 2 ? null : {
    status: index === 2 ? "blocked" : "completed", summary: index === 2 ? "Need clarification about the expected output." : "Implemented the requested change and completed the review.",
    changes: ["Updated the workspace component"], tests: ["Typecheck passed"], concerns: [], suggested_next: "Review the result.",
  },
  reportDelivered: index !== 2, error: index === 2 ? "Report delivery is pending." : null,
  costLead: index === 0 ? null : 0.07, costSidekick: index === 0 ? null : 0.01,
}));
// Keep listing samples small and free of private workspace or agent data.
if (listing) {
  const active = records[0];
  const completed = records[3];
  active.profileId = "codex-to-cursor-grok";
  active.sidekickModel = "cursor/grok-4.7";
  completed.profileId = "cursor-opus-to-codex-luna";
  completed.brief.goal = "Review the delegation recovery implementation";
  completed.report!.summary = "Restored delegation history and report delivery after a plugin reload.";
  completed.report!.changes = ["Persisted brief and report state", "Retried pending report delivery"];
  records.splice(0, records.length, active, completed);
}
(globalThis as any).__fusionPreviewActions = [];
async function invoke(method: string, input: any) {
  if ((globalThis as any).__fusionPreviewError === method) throw new Error("Preview request failed");
  if (method === "fusion.get-settings") return DEFAULT_SETTINGS;
  if (method === "fusion.get-workspace") {
    const search = input.search.toLowerCase();
    const filtered = records.filter((item) => (!input.activeOnly || item.status === "running") &&
      (!search || [item.brief.goal, item.report?.summary, item.sidekickModel, item.profileId].some((text) => text?.toLowerCase().includes(search))));
    return { delegations: filtered.slice(input.offset, input.offset + input.limit), total: filtered.length,
      active: records.filter((item) => item.status === "running").length, costLead: listing ? 0.07 : 2.17, costSidekick: listing ? 0.01 : 0.31, missingCost: true };
  }
  if (method === "fusion.create-lead") {
    (globalThis as any).__fusionPreviewActions.push({ method, input });
    return { agentId: "preview-new-lead" };
  }
  if (method === "fusion.delegation-action") {
    const item = records.find((item) => item.id === input.delegationId)!;
    if (input.action === "cancel") item.status = "canceled";
    else { item.reportDelivered = true; item.error = null; }
    return { ok: true, message: input.action === "cancel" ? "Delegation canceled" : "Report delivered" };
  }
  throw new Error("Unexpected preview RPC");
}
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function Preview() {
  const [dark, setDark] = useState(!new URLSearchParams(window.location.search).has("light"));
  const [compact, setCompact] = useState(window.innerWidth < 640);
  const [action, setAction] = useState("");
  useEffect(() => {
    const resize = () => setCompact(window.innerWidth < 640);
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);
  const theme = { colors: {
    foreground: dark ? "#eef2f6" : "#17202c", foregroundMuted: dark ? "#aab5c4" : "#566274",
    surface0: dark ? "#151c28" : "#ffffff", border: dark ? "#344154" : "#cbd3df",
  } } as any;
  const host = { theme, host: { id: "preview", label: "Preview fixtures" },
    layout: { compact, platform: "web" as const }, context: "workspace" as const, workspaceId: "preview-workspace",
    navigation: { openAgent: ({ agentId }: any) => {
      (globalThis as any).__fusionPreviewActions.push({ method: "open-agent", agentId }); setAction("Opened " + agentId);
    }, openWorkspace() {} },
  };
  return <QueryClientProvider client={queryClient}><PluginRpcProvider invoke={invoke}>
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: theme.colors.surface0, color: theme.colors.foreground }}>
      {!listing && <div style={{ padding: 10, display: "flex", gap: 16, alignItems: "center", borderBottom: "1px solid " + theme.colors.border }}>
        <span>Model Fusion UI preview · fixture data</span>
        <button aria-label="Switch theme" onClick={() => setDark(!dark)}>{dark ? "Light theme" : "Dark theme"}</button><span role="status">{action}</span>
      </div>}
      {new URLSearchParams(window.location.search).has("card")
        ? <DelegationTimelineCard {...host} agentId="preview" timestamp={new Date()} item={{ type: "plugin", kind: "delegation", version: 1, data: {
          status: "completed", lead_agent_id: "lead", sidekick_agent_id: "sidekick", sidekick_model: "codex/gpt-6-luna",
          brief: records[0].brief.goal, report: records[3].report, cost_lead: 0.07, cost_sidekick: 0.01,
          at: new Date().toISOString(), updated_at: new Date().toISOString(),
        } }} />
        : <FusionWorkspacePanel {...host} />}
    </div>
  </PluginRpcProvider></QueryClientProvider>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
