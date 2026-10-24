import type { PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { DelegationCardSchema, getDelegationRpc, getSettingsRpc } from "./shared/contracts";
import { LABEL } from "./shared/labels";
import type { FusionSettings } from "./shared/settings";
import { DelegationTimelineCard } from "./client/timeline-card";
import { FusionWorkspacePanel } from "./client/workspace-panel";

type LeadAgent = { id: string; workspaceId?: string | null; labels: Record<string, string> };
type PillEntry = { pill: PluginButtonRegistration; workspaceId: string };
type DelegationView = {
  status: string;
  sidekick_agent_id: string | null;
  sidekick_model: string | null;
  brief: string;
  dispatched_at: number;
} | null;

export default function contribute(client: PluginClientContext) {
  const removeRenderer = client.addTimelineRenderer({
    kind: "delegation",
    version: 1,
    schema: DelegationCardSchema,
    Component: DelegationTimelineCard,
  });

  const removePanel = client.addWorkspacePanel({
    id: "fusion", title: "Model Fusion", icon: "GitBranch", context: "workspace", Component: FusionWorkspacePanel,
  });
  const removeCommand = client.addCommandCenterItem({
    id: "open-fusion", title: "Open Model Fusion", icon: "GitBranch", context: "workspace",
    onSelect({ openPanel }) { openPanel("fusion"); },
  });
  const lifetime = new AbortController();
  const pills = new Map<string, PillEntry>();
  const leads = new Map<string, LeadAgent>();
  let settings: FusionSettings | null = null;
  let refreshing = false;

  const removePill = (agentId: string) => {
    pills.get(agentId)?.pill.remove();
    pills.delete(agentId);
  };

  const presentation = (delegation: DelegationView) => {
    if (!delegation) return { label: "Fusion idle", title: "No active Fusion delegation" };
    const age = Math.max(0, Math.floor((Date.now() - delegation.dispatched_at) / 60_000));
    const sidekick = delegation.sidekick_agent_id ? ` · ${delegation.sidekick_agent_id.slice(0, 8)}` : "";
    return {
      label: `Fusion ${delegation.status}${sidekick}`,
      title: `${delegation.sidekick_model || "Sidekick"} · ${age}m · ${delegation.brief}`,
    };
  };

  const refresh = async () => {
    if (refreshing || lifetime.signal.aborted) return;
    refreshing = true;
    try {
      settings = await client.rpc(getSettingsRpc, {});
      if (lifetime.signal.aborted) return;
      if (!settings.enabled || !settings.show_composer_pill) {
        for (const id of pills.keys()) removePill(id);
        return;
      }
      await Promise.all([...leads.values()].map(async (lead) => {
        if (!lead.workspaceId) return;
        try {
          const result = await client.rpc(getDelegationRpc, { leadAgentId: lead.id });
          if (lifetime.signal.aborted) return;
          const next = presentation(result.delegation);
          const current = pills.get(lead.id);
          if (current) current.pill.update({ label: next.label, title: next.title, visible: true });
          else {
            pills.set(lead.id, {
              workspaceId: lead.workspaceId,
              pill: client.addComposerPill({
                id: "fusion-sidekick-state",
                workspaceId: lead.workspaceId,
                agentId: lead.id,
                button: { ...next, icon: "GitBranch", behavior: { kind: "action", onPress() { client.openPanel("fusion", { workspaceId: lead.workspaceId! }); } } },
              }),
            });
          }
        } catch (error) {
          if (!lifetime.signal.aborted) console.error("[fusion] delegation status refresh failed", lead.id, error);
        }
      }));
    } catch (error) {
      if (!lifetime.signal.aborted) console.error("[fusion] settings refresh failed", error);
    } finally {
      refreshing = false;
    }
  };

  const syncLead = (agent: LeadAgent) => {
    if (agent.labels?.[LABEL.fusionRole] !== "lead" || !agent.workspaceId) {
      leads.delete(agent.id);
      removePill(agent.id);
      return;
    }
    leads.set(agent.id, agent);
    void refresh();
  };

  void client.rpc(getSettingsRpc, {}).then((value) => {
    if (lifetime.signal.aborted) return;
    settings = value as FusionSettings;
    if (!settings.enabled || !settings.show_composer_pill) {
      for (const id of pills.keys()) removePill(id);
      return;
    }
    void refresh();
  }).catch((error) => console.error("[fusion] settings load failed", error));

  void client.paseo.agents.list({ subscribe: {}, signal: lifetime.signal }).then(({ subscription }) => {
    if (lifetime.signal.aborted) { void subscription.release(); return; }
    subscription.subscribe({
      snapshot: ({ entries }) => {
        leads.clear();
        for (const { agent } of entries) syncLead(agent as LeadAgent);
        for (const id of pills.keys()) if (!leads.has(id)) removePill(id);
      },
      update: (message) => {
        if (message.type !== "agent_update") return;
        const update = message.payload;
        if (update.kind === "upsert") syncLead(update.agent as LeadAgent);
        else {
          leads.delete(update.agentId);
          removePill(update.agentId);
        }
      },
    });
  }).catch((error) => {
    if (!lifetime.signal.aborted) console.error("[fusion] agent observation failed", error);
  });

  const timer = setInterval(() => void refresh(), 5_000);
  return () => {
    removeRenderer(); removePanel(); removeCommand();
    clearInterval(timer);
    lifetime.abort();
    for (const id of pills.keys()) removePill(id);
    leads.clear();
  };
}
