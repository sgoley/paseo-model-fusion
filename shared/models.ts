import { z } from "zod";

export const BriefSchema = z.object({
  goal: z.string().trim().min(1).max(16000),
  constraints: z.string().max(16000).optional(),
  success_criteria: z.string().max(16000).optional(),
  files_hint: z.array(z.string().max(2048)).max(100).optional(),
});
export const ReportStatusSchema = z.enum(["completed", "blocked", "needs-clarification", "concerns"]);
export const ReportSchema = z.object({
  status: ReportStatusSchema,
  summary: z.string().trim().min(1).max(16000),
  changes: z.array(z.string().max(2048)).max(100).default([]),
  tests: z.array(z.string().max(2048)).max(100).default([]),
  concerns: z.array(z.string().max(2048)).max(100).default([]),
  suggested_next: z.string().max(4096).nullable().default(null),
});
export const DelegationStatusSchema = z.enum(["dispatched", "running", "completed", "blocked", "failed", "timeout", "canceled"]);
export type Brief = z.output<typeof BriefSchema>;
export type Report = z.output<typeof ReportSchema>;
export type DelegationStatus = z.output<typeof DelegationStatusSchema>;
export const isActive = (status: DelegationStatus) => status === "dispatched" || status === "running";

export const DelegationViewSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  leadId: z.string(),
  sidekickId: z.string().nullable(),
  profileId: z.string(),
  sidekickModel: z.string(),
  brief: BriefSchema,
  status: DelegationStatusSchema,
  dispatchedAt: z.number(),
  completedAt: z.number().nullable(),
  timeoutAt: z.number(),
  report: ReportSchema.nullable(),
  reportDelivered: z.boolean(),
  error: z.string().nullable(),
  costLead: z.number().nullable(),
  costSidekick: z.number().nullable(),
});
export type DelegationView = z.output<typeof DelegationViewSchema>;
