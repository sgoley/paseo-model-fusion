import type { PluginButtonContentProps, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import { Text, View } from "@getpaseo/plugin/client/ui";
import { getDelegationRpc, getSettingsRpc } from "./shared/contracts";
import { LABEL } from "./shared/labels";
import type { FusionSettings } from "./shared/settings";
import { DelegationTimelineCard } from "./client/timeline-card";

type LeadAgent = { id: string; workspaceId?: string | null; labels: Record<string, string> };
type PillEntry = { pill: PluginButtonRegistration; workspaceId: string };
type DelegationView = {
  status: string;
  sidekick_agent_id: string | null;
  sidekick_model: string | null;
  brief: string;
  dispatched_at: number;
} | null;

function FusionStatusPopover({ theme, layout }: PluginButtonContentProps) {
  return (
    <View style={{ width: layout.compact ? "100%" : 300, padding: 12, gap: 8 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>Model Fusion</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        This pill shows the lead’s latest sidekick delegation. Status refreshes every five seconds.
      </Text>
    </View>
  );
}

export default function contribute(client: PluginClientContext) {
  client.registerTimelineItemRenderer({
    kind: "delegation",
    version: 1,
    Component: DelegationTimelineCard,
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
    if (refreshing || lifetime.signal.aborted || !settings?.enabled || !settings.show_composer_pill) return;
    refreshing = true;
    try {
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
                button: { ...next, icon: "GitBranch", behavior: { kind: "popover", Content: FusionStatusPopover } },
              }),
            });
          }
        } catch (error) {
          if (!lifetime.signal.aborted) console.error("[fusion] delegation status refresh failed", lead.id, error);
        }
      }));
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
    clearInterval(timer);
    lifetime.abort();
    for (const id of pills.keys()) removePill(id);
    leads.clear();
  };
}
