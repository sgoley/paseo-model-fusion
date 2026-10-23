import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const DELEGATION_KIND = "delegation";
export const DELEGATION_VERSION = 1;
export const DELEGATION_ROW_ID = "delegation";

export const DelegationStatusSchema = z.enum([
  "dispatched",
  "running",
  "completed",
  "blocked",
  "failed",
  "timeout",
  "canceled",
]);
export type DelegationStatus = z.output<typeof DelegationStatusSchema>;

export const ReportStatusSchema = z.enum([
  "completed",
  "blocked",
  "needs-clarification",
  "concerns",
]);
export type ReportStatus = z.output<typeof ReportStatusSchema>;

export const DelegationCardSchema = z.object({
  status: DelegationStatusSchema,
  lead_agent_id: z.string(),
  sidekick_agent_id: z.string().nullable(),
  sidekick_model: z.string().nullable(),
  brief: z.string(),
  report: z
    .object({
      status: ReportStatusSchema,
      summary: z.string(),
      changes: z.array(z.string()),
      tests: z.array(z.string()),
      concerns: z.array(z.string()),
      suggested_next: z.string().nullable(),
    })
    .nullable(),
  cost_lead: z.number().nullable(),
  cost_sidekick: z.number().nullable(),
  at: z.string(),
  updated_at: z.string(),
});
export type DelegationCard = z.output<typeof DelegationCardSchema>;

export const delegateRpc = defineRpc({
  name: "fusion.delegate",
  input: z.object({
    goal: z.string().min(1),
    constraints: z.string().optional(),
    success_criteria: z.string().optional(),
    files_hint: z.array(z.string()).optional(),
  }),
  output: z.object({
    status: z.enum(["dispatched", "error"]),
    sidekick_agent_id: z.string().nullable(),
    message: z.string(),
  }),
});

export const reportRpc = defineRpc({
  name: "fusion.report",
  input: z.object({
    status: ReportStatusSchema,
    summary: z.string().min(1),
    changes: z.array(z.string()).default([]),
    tests: z.array(z.string()).default([]),
    concerns: z.array(z.string()).default([]),
    suggested_next: z.string().optional(),
  }),
  output: z.object({
    status: z.enum(["accepted", "error"]),
    message: z.string(),
  }),
});

export const getSettingsRpc = defineRpc({
  name: "fusion.get-settings",
  input: z.object({}),
  output: z.any(), // FusionSettings, but avoiding circular dep
});
