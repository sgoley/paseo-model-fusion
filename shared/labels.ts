export const LABEL = {
  fusionRole: "fusion.role",
  fusionProfile: "fusion.profile",
  fusionLeadId: "fusion.leadId",
  fusionBriefId: "fusion.briefId",
} as const;

export function isSidekick(labels: Record<string, string>): boolean {
  return labels[LABEL.fusionRole] === "sidekick";
}

export function isLead(labels: Record<string, string>): boolean {
  return labels[LABEL.fusionRole] === "lead";
}

export function getLeadId(labels: Record<string, string>): string | null {
  return labels[LABEL.fusionLeadId] ?? null;
}

export function getProfileId(labels: Record<string, string>): string | null {
  return labels[LABEL.fusionProfile] ?? null;
}
