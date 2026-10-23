import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "@getpaseo/plugin/client/ui";
import { DELEGATION_KIND, DELEGATION_VERSION, type DelegationCard } from "../shared/contracts";

export function DelegationTimelineCard({ item }: PluginTimelineItemProps) {
  if (item.kind !== DELEGATION_KIND || item.version !== DELEGATION_VERSION) {
    return null;
  }

  const data = item.data as DelegationCard;

  const statusColor = {
    dispatched: "#3b82f6",
    running: "#f59e0b",
    completed: "#10b981",
    blocked: "#ef4444",
    failed: "#ef4444",
    timeout: "#f97316",
    canceled: "#6b7280",
  }[data.status] || "#6b7280";

  return (
    <View style={{ padding: 12, backgroundColor: "#f9fafb", borderRadius: 8, borderLeftWidth: 4, borderLeftColor: statusColor }}>
      <Text style={{ fontWeight: "600", fontSize: 14, marginBottom: 4 }}>
        Fusion Delegation
      </Text>
      <Text style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>
        Status: {data.status.toUpperCase()}
      </Text>
      {data.sidekick_agent_id && (
        <Text style={{ fontSize: 12, color: "#374151", marginBottom: 4 }}>
          Sidekick: {data.sidekick_agent_id.slice(0, 8)}
        </Text>
      )}
      {data.sidekick_model && (
        <Text style={{ fontSize: 12, color: "#374151", marginBottom: 4 }}>
          Model: {data.sidekick_model}
        </Text>
      )}
      {data.brief && (
        <Text style={{ fontSize: 12, color: "#374151", marginBottom: 8 }}>
          Goal: {data.brief.slice(0, 100)}{data.brief.length > 100 ? "..." : ""}
        </Text>
      )}
      {data.report && (
        <View style={{ marginTop: 8, padding: 8, backgroundColor: "#ffffff", borderRadius: 4 }}>
          <Text style={{ fontWeight: "500", fontSize: 12, marginBottom: 4 }}>
            Report: {data.report.status}
          </Text>
          <Text style={{ fontSize: 12, color: "#374151", marginBottom: 4 }}>
            {data.report.summary}
          </Text>
          {data.report.concerns.length > 0 && (
            <Text style={{ fontSize: 11, color: "#ef4444" }}>
              Concerns: {data.report.concerns.join(", ")}
            </Text>
          )}
        </View>
      )}
      {(data.cost_lead !== null || data.cost_sidekick !== null) && (
        <Text style={{ fontSize: 11, color: "#6b7280", marginTop: 8 }}>
          Cost: ${((data.cost_lead || 0) + (data.cost_sidekick || 0)).toFixed(4)}
        </Text>
      )}
    </View>
  );
}
