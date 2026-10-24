import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { FusionSettingsSchema } from "./settings";
import { BriefSchema, ReportSchema, DelegationStatusSchema, DelegationViewSchema } from "./models";
export { DelegationStatusSchema, ReportStatusSchema } from "./models";
export type { DelegationStatus } from "./models";
export type ReportStatus = z.output<typeof import("./models").ReportStatusSchema>;

export const DELEGATION_KIND = "delegation";
export const DELEGATION_VERSION = 1;
export const DELEGATION_ROW_ID = "delegation";
export const DelegationCardSchema = z.object({
  status: DelegationStatusSchema, lead_agent_id: z.string(),
  sidekick_agent_id: z.string().nullable(), sidekick_model: z.string().nullable(),
  brief: z.string(), report: ReportSchema.nullable(),
  cost_lead: z.number().nullable(), cost_sidekick: z.number().nullable(),
  at: z.string(), updated_at: z.string(),
});
export type DelegationCard = z.output<typeof DelegationCardSchema>;

export const delegateRpc = defineRpc({
  name: "fusion.delegate",
  input: BriefSchema.extend({ leadAgentId: z.string().min(1) }),
  output: z.object({ status: z.enum(["dispatched", "error"]), sidekick_agent_id: z.string().nullable(), message: z.string() }),
});
export const reportRpc = defineRpc({
  name: "fusion.report",
  input: ReportSchema.extend({ delegation_id: z.string(), report_token: z.string() }),
  output: z.object({ status: z.enum(["accepted", "error"]), message: z.string() }),
});
export const getSettingsRpc = defineRpc({
  name: "fusion.get-settings", input: z.object({}), output: FusionSettingsSchema,
});
export const getDelegationRpc = defineRpc({
  name: "fusion.get-delegation",
  input: z.object({ leadAgentId: z.string().min(1) }),
  output: z.object({
    delegation: z.object({
      status: DelegationStatusSchema, sidekick_agent_id: z.string().nullable(),
      sidekick_model: z.string().nullable(), brief: z.string(), dispatched_at: z.number(),
    }).nullable(),
  }),
});
export const getWorkspaceRpc = defineRpc({
  name: "fusion.get-workspace",
  input: z.object({
    workspaceId: z.string().min(1), offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(100).default(25),
    activeOnly: z.boolean().default(false), search: z.string().max(200).default(""),
  }),
  output: z.object({
    delegations: z.array(DelegationViewSchema), total: z.number(), active: z.number(),
    costLead: z.number(), costSidekick: z.number(), missingCost: z.boolean(),
  }),
});
export const createLeadRpc = defineRpc({
  name: "fusion.create-lead",
  input: z.object({ workspaceId: z.string().min(1), profileId: z.string().min(1), prompt: z.string().trim().min(1).max(16000) }),
  output: z.object({ agentId: z.string() }),
});
export const delegationActionRpc = defineRpc({
  name: "fusion.delegation-action",
  input: z.object({ workspaceId: z.string().min(1), delegationId: z.string().min(1), action: z.enum(["cancel", "retry-report"]) }),
  output: z.object({ ok: z.boolean(), message: z.string() }),
});
