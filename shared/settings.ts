import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const ProviderModelSchema = z.object({
  /** Paseo provider ID, e.g. "codex", "claude", "opencode". */
  provider: z.string().min(1),
  /** Model ID for that provider; null resolves the provider's default model. */
  model: z.string().min(1).nullable().default(null),
  /** Provider mode; null keeps the provider default. */
  modeId: z.string().min(1).nullable().default(null),
  thinkingOptionId: z.string().min(1).nullable().default(null),
});

export type ProviderModel = z.output<typeof ProviderModelSchema>;

export const BriefStyleSchema = z.enum(["detailed", "concise", "minimal"]);
export type BriefStyle = z.output<typeof BriefStyleSchema>;

export const ProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  lead: ProviderModelSchema,
  sidekick: ProviderModelSchema,
  brief_style: BriefStyleSchema.default("detailed"),
  allow_pushback: z.boolean().default(true),
  delegate_exploration: z.boolean().default(true),
  max_turns: z.number().int().min(1).max(50).default(10),
  max_cost: z.number().min(0).default(5.0),
  timeout_seconds: z.number().int().min(30).max(3600).default(300),
});

export type Profile = z.output<typeof ProfileSchema>;

export const FusionSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  profiles: z.array(ProfileSchema).default([
    {
      id: "codex-gpt6luna-to-gpt61sol",
      name: "Codex GPT-6 Luna → GPT-6.1 Sol",
      lead: { provider: "codex", model: "gpt-6-luna", modeId: null, thinkingOptionId: null },
      sidekick: { provider: "codex", model: "gpt-6.1-sol", modeId: null, thinkingOptionId: null },
      brief_style: "detailed",
      allow_pushback: true,
      delegate_exploration: true,
      max_turns: 10,
      max_cost: 5.0,
      timeout_seconds: 300,
    },
  ]),
  default_profile: z.string().min(1).default("codex-gpt6luna-to-gpt61sol"),
  use_mcp_delegation: z.boolean().default(true),
  fallback_to_fenced: z.boolean().default(true),
  show_composer_pill: z.boolean().default(true),
  show_timeline_card: z.boolean().default(true),
});

export type FusionSettings = z.output<typeof FusionSettingsSchema>;

export const fusionSettings = defineSettings({
  id: "config",
  scope: "host",
  version: 1,
  schema: FusionSettingsSchema,
});

export const DEFAULT_SETTINGS: FusionSettings = FusionSettingsSchema.parse({});
