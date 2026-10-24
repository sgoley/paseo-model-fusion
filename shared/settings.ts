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
  transport: z.enum(["auto", "mcp", "fenced"]).default("auto"),
  allow_pushback: z.boolean().default(true),
  delegate_exploration: z.boolean().default(true),
  max_turns: z.number().int().min(1).max(50).default(10),
  max_cost: z.number().min(0).default(5.0),
  timeout_seconds: z.number().int().min(30).max(3600).default(300),
});

export type Profile = z.output<typeof ProfileSchema>;

const pair = (id: string, name: string, leadProvider: string, leadModel: string | null, sidekickProvider: string, sidekickModel: string | null, leadEffort: string | null = null, sidekickEffort: string | null = null) => ProfileSchema.parse({
  id, name,
  lead: { provider: leadProvider, model: leadModel, thinkingOptionId: leadEffort },
  sidekick: { provider: sidekickProvider, model: sidekickModel, thinkingOptionId: sidekickEffort },
  brief_style: "concise",
});

export const BUILTIN_PROFILES: Profile[] = [
  pair("codex-to-antigravity-flash", "Codex 6.1 Sol → Antigravity Gemini 3.8 Flash", "codex", "gpt-6.1-sol", "antigravity", "gemini-3.8-flash-low", "high"),
  pair("cursor-opus-to-codex-luna", "Cursor Opus 5.5 → Codex 6 Luna", "cursor", "claude-opus-5-5", "codex", "gpt-6-luna", "high", "medium"),
  pair("codex-gpt6luna-to-gpt61sol", "Codex Luna → Sol (existing profile)", "codex", "gpt-6-luna", "codex", "gpt-6.1-sol"),
  pair("codex-sol-to-luna", "Codex Sol → Luna", "codex", "gpt-6.1-sol", "codex", "gpt-6-luna"),
  pair("codex-to-omp-flash", "Codex Sol → OMP Flash", "codex", "gpt-6.1-sol", "omp", "cursor/gemini-3.8-flash"),
  pair("omp-sol-to-flash", "OMP Sol → Flash", "omp", "openai-codex/gpt-6-sol", "omp", "cursor/gemini-3.8-flash"),
  pair("cursor-to-devin", "Cursor Grok → Devin SWE", "cursor", "grok-4.7", "devin", "swe-1-6-slow"),
  pair("antigravity-argon-to-flash", "Antigravity Argon → Flash", "antigravity", "gemini-4-argon-medium", "antigravity", "gemini-3.8-flash-low"),
  pair("claude-defaults", "Claude default models (configure your pair)", "claude", null, "claude", null),
];

export const FusionSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  profiles: z.array(ProfileSchema).min(1).default(BUILTIN_PROFILES),
  default_profile: z.string().min(1).default("codex-to-antigravity-flash"),
  use_mcp_delegation: z.boolean().default(true),
  fallback_to_fenced: z.boolean().default(true),
  show_composer_pill: z.boolean().default(true),
  show_timeline_card: z.boolean().default(true),
  history_retention_days: z.number().int().min(1).max(365).default(30),
}).superRefine((values, context) => {
  const ids = values.profiles.map((profile) => profile.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", path: ["profiles"], message: "Profile IDs must be unique" });
  if (![...ids, ...BUILTIN_PROFILES.map((profile) => profile.id)].includes(values.default_profile)) context.addIssue({
    code: "custom", path: ["default_profile"], message: "The default profile must exist",
  });
  if (values.enabled && !values.use_mcp_delegation && !values.fallback_to_fenced) context.addIssue({
    code: "custom", path: ["fallback_to_fenced"], message: "Enable at least one delegation transport",
  });
  if (values.enabled && !values.fallback_to_fenced && values.profiles.some((profile) => profile.transport === "fenced")) context.addIssue({
    code: "custom", path: ["fallback_to_fenced"], message: "Fenced profiles require fenced delegation",
  });
});

export type FusionSettings = z.output<typeof FusionSettingsSchema>;

export const fusionSettings = defineSettings({
  id: "config",
  scope: "host",
  version: 1,
  schema: FusionSettingsSchema,
});

export const DEFAULT_SETTINGS: FusionSettings = FusionSettingsSchema.parse({});
