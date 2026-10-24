import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useMutation, useQuery, keepPreviousData } from "@tanstack/react-query";
import { useRpc, type PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { createLeadRpc, delegationActionRpc, getSettingsRpc, getWorkspaceRpc } from "../shared/contracts";
import { isActive, type DelegationView } from "../shared/models";

const money = (cost: number | null) => cost === null ? "not reported" : "$" + cost.toFixed(4);
type RowProps = { item: DelegationView; host: PluginWorkspacePanelProps; refresh: () => void };

function DelegationRow({ item, host, refresh }: RowProps) {
  const { theme, navigation } = host;
  const [expanded, setExpanded] = useState(false);
  const actionRpc = useRpc(delegationActionRpc);
  const action = useMutation({
    mutationFn: (value: "cancel" | "retry-report") => actionRpc({ workspaceId: item.workspaceId, delegationId: item.id, action: value }),
    onSuccess: refresh,
  });
  const text = { color: theme.colors.foreground, fontSize: 13 };
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  return (
    <View style={{ padding: 14, gap: 10, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8 }}>
      <Text style={{ ...muted, fontWeight: "600" }}>{item.status.toUpperCase()} · {new Date(item.dispatchedAt).toLocaleString()}</Text>
      <Text style={{ ...text, fontWeight: "600", fontSize: 15 }}>{item.brief.goal}</Text>
      <Text style={muted}>{item.sidekickModel} · {item.profileId}</Text>
      <Text style={muted}>Lead {money(item.costLead)} · Sidekick {money(item.costSidekick)}</Text>
      {item.report && <Text style={text}>{item.report.summary}</Text>}
      {item.error && <Text accessibilityRole="alert" style={text}>{item.error}</Text>}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 14 }}>
        <Pressable accessibilityRole="button" onPress={() => setExpanded(!expanded)}><Text style={text}>{expanded ? "Hide details" : "Show details"}</Text></Pressable>
        {navigation && <Pressable accessibilityRole="button" onPress={() => navigation.openAgent({ agentId: item.leadId })}><Text style={text}>Open lead</Text></Pressable>}
        {navigation && item.sidekickId && <Pressable accessibilityRole="button" onPress={() => navigation.openAgent({ agentId: item.sidekickId! })}><Text style={text}>Open sidekick</Text></Pressable>}
        {isActive(item.status) && <Pressable accessibilityRole="button" disabled={action.isPending} onPress={() => action.mutate("cancel")}><Text style={text}>{action.isPending ? "Canceling…" : "Cancel delegation"}</Text></Pressable>}
        {item.report && !item.reportDelivered && <Pressable accessibilityRole="button" disabled={action.isPending} onPress={() => action.mutate("retry-report")}><Text style={text}>{action.isPending ? "Sending…" : "Retry report delivery"}</Text></Pressable>}
      </View>
      {action.error && <Text accessibilityRole="alert" style={text}>{String(action.error)}</Text>}
      {action.data && <Text style={muted}>{action.data.message}</Text>}
      {expanded && (
        <View style={{ gap: 8 }}>
          <Text selectable style={muted}>Delegation {item.id}{"\n"}Lead {item.leadId}{"\n"}Sidekick {item.sidekickId || "not created"}</Text>
          {item.brief.constraints && <Text style={text}>Constraints: {item.brief.constraints}</Text>}
          {item.brief.success_criteria && <Text style={text}>Success criteria: {item.brief.success_criteria}</Text>}
          {!!item.brief.files_hint?.length && <Text style={text}>Files: {item.brief.files_hint.join(", ")}</Text>}
          {item.report && (["changes", "tests", "concerns"] as const).map((section) => item.report![section].length > 0 && <Text key={section} style={text}>{section.toUpperCase()}{"\n"}{item.report![section].map((value) => "• " + value).join("\n")}</Text>)}
          {item.report?.suggested_next && <Text style={text}>Next: {item.report.suggested_next}</Text>}
          <Text style={muted}>Deadline: {new Date(item.timeoutAt).toLocaleString()}{"\n"}{item.completedAt ? "Finished: " + new Date(item.completedAt).toLocaleString() : "Work is in progress."}</Text>
          {item.report && <Text style={muted}>Report {item.reportDelivered ? "delivered to lead" : "saved; delivery pending"}</Text>}
        </View>
      )}
    </View>
  );
}

export function FusionWorkspacePanel(props: PluginWorkspacePanelProps) {
  const { theme, layout, workspaceId, navigation } = props;
  const [offset, setOffset] = useState(0);
  const [activeOnly, setActiveOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [profileId, setProfileId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const workspaceRpc = useRpc(getWorkspaceRpc);
  const settingsRpc = useRpc(getSettingsRpc);
  const leadRpc = useRpc(createLeadRpc);
  const settings = useQuery({ queryKey: ["fusion", "settings"], queryFn: () => settingsRpc({}), refetchInterval: 10_000 });
  const query = useQuery({
    queryKey: ["fusion", "workspace", workspaceId, offset, activeOnly, search],
    queryFn: () => workspaceRpc({ workspaceId, offset, limit: 25, activeOnly, search }),
    refetchInterval: 5_000, placeholderData: keepPreviousData,
  });
  useEffect(() => {
    if (!query.isPlaceholderData && query.data && offset >= query.data.total && offset > 0) setOffset(Math.max(0, Math.floor((query.data.total - 1) / 25) * 25));
  }, [query.data?.total, query.isPlaceholderData, offset]);
  const selectedProfile = settings.data?.profiles.find((profile) => profile.id === (profileId || settings.data.default_profile));
  const create = useMutation({
    mutationFn: () => leadRpc({ workspaceId, profileId: profileId || settings.data!.default_profile, prompt }),
    onSuccess: ({ agentId }) => { setPrompt(""); setShowCreate(false); setOffset(0); navigation?.openAgent({ agentId }); void query.refetch(); },
  });
  const text = { color: theme.colors.foreground, fontSize: 13 };
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 };
  const button = { padding: 10, borderRadius: 6, borderWidth: 1, borderColor: theme.colors.border };
  const input = { ...text, ...button, minHeight: 42 };
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 12 : 24, gap: 16 }}>
      <View style={{ flexDirection: layout.compact ? "column" : "row", justifyContent: "space-between", gap: 12 }}>
        <View style={{ gap: 6 }}>
          <Text style={{ ...text, fontSize: 22, fontWeight: "600" }}>Model Fusion</Text>
          <Text style={muted}>{query.data?.active ?? 0} active · Lead {money(query.data?.costLead ?? 0)} · Sidekick {money(query.data?.costSidekick ?? 0)}</Text>
          {query.data?.missingCost && <Text style={muted}>Costs include reported usage only. Some provider turns do not include a price.</Text>}
        </View>
        <Pressable accessibilityRole="button" style={button} onPress={() => setShowCreate(!showCreate)}><Text style={text}>{showCreate ? "Close new lead" : "Start a Fusion lead"}</Text></Pressable>
      </View>
      {showCreate && (
        <View style={{ gap: 12 }}>
          <Text style={text}>Choose a model pair</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {settings.data?.profiles.map((profile) => (
              <Pressable key={profile.id} accessibilityRole="button" accessibilityState={{ selected: (profileId || settings.data.default_profile) === profile.id }} style={button} onPress={() => setProfileId(profile.id)}>
                <Text style={{ ...text, fontWeight: (profileId || settings.data.default_profile) === profile.id ? "700" : "400" }}>{profile.name}</Text>
              </Pressable>
            ))}
          </View>
          {selectedProfile && <Text style={muted}>Lead: {selectedProfile.lead.provider}/{selectedProfile.lead.model || "default"} · effort {selectedProfile.lead.thinkingOptionId || "provider default"}{"\n"}Sidekick: {selectedProfile.sidekick.provider}/{selectedProfile.sidekick.model || "default"} · effort {selectedProfile.sidekick.thinkingOptionId || (selectedProfile.sidekick.model?.endsWith("-low") ? "low (model variant)" : "provider default")}</Text>}
          <TextInput accessibilityLabel="Task for Fusion lead" multiline placeholder="What should the lead and sidekick work on?" placeholderTextColor={theme.colors.foregroundMuted} style={{ ...input, minHeight: 90, textAlignVertical: "top" }} value={prompt} onChangeText={setPrompt} />
          <Pressable accessibilityRole="button" style={button} disabled={!prompt.trim() || !settings.data?.enabled || create.isPending} onPress={() => create.mutate()}><Text style={text}>{create.isPending ? "Starting…" : "Start lead"}</Text></Pressable>
          {settings.data && !settings.data.enabled && <Text style={text}>Enable Model Fusion in plugin settings to start a lead.</Text>}
          {create.error && <Text accessibilityRole="alert" style={text}>{String(create.error)}</Text>}
          {settings.error && <Text accessibilityRole="alert" style={text}>{String(settings.error)}</Text>}
        </View>
      )}
      <TextInput accessibilityLabel="Search delegation history" style={input} placeholder="Search goals, reports, models or profiles" placeholderTextColor={theme.colors.foregroundMuted} value={search} onChangeText={(value) => { setSearch(value); setOffset(0); }} />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        <Pressable accessibilityRole="button" style={button} onPress={() => { setActiveOnly(!activeOnly); setOffset(0); }}><Text style={text}>{activeOnly ? "Show all history" : "Show active only"}</Text></Pressable>
        <Pressable accessibilityRole="button" style={button} onPress={() => void query.refetch()}><Text style={text}>{query.isFetching ? "Refreshing…" : "Refresh"}</Text></Pressable>
      </View>
      {query.error && <Text accessibilityRole="alert" style={text}>Could not load history: {String(query.error)}</Text>}
      {query.isPending && <Text style={muted}>Loading delegations…</Text>}
      {query.data?.delegations.length === 0 && <Text style={muted}>{search || activeOnly ? "No delegations match these filters." : "No delegations yet. Start a lead to send your first brief."}</Text>}
      {query.data?.delegations.map((item) => <DelegationRow key={item.id} item={item} host={props} refresh={() => void query.refetch()} />)}
      {query.data && query.data.total > 25 && (
        <View style={{ flexDirection: "row", gap: 16, alignItems: "center" }}>
          <Pressable accessibilityRole="button" style={button} disabled={offset === 0 || query.isPlaceholderData} onPress={() => setOffset(Math.max(0, offset - 25))}><Text style={text}>Previous</Text></Pressable>
          <Text style={muted}>{offset + 1}–{Math.min(offset + 25, query.data.total)} of {query.data.total}</Text>
          <Pressable accessibilityRole="button" style={button} disabled={offset + 25 >= query.data.total || query.isPlaceholderData} onPress={() => setOffset(offset + 25)}><Text style={text}>Next</Text></Pressable>
        </View>
      )}
    </ScrollView>
  );
}
