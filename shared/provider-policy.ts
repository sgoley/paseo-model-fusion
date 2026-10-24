// Consumer Antigravity subscriptions stay in the standalone agy CLI.
// Google explicitly excludes third-party coding-agent wrappers, including subprocess drivers.
// https://www.antigravity.google/docs/faq/
export const ANTIGRAVITY_POLICY_MESSAGE = "Antigravity is excluded from Model Fusion. Use agy directly; choose Cursor Grok or a separately configured Gemini API provider for Fusion.";
export const RETIRED_PROFILE_IDS = ["codex-to-antigravity-flash", "antigravity-argon-to-flash", "codex-to-cursor-flash"];
export function isAntigravity(model: { provider: string; model?: string | null }): boolean {
  return [model.provider, model.model || ""].some((path) =>
    path.toLowerCase().split(/[/:]/).some((part) => ["antigravity", "google-antigravity", "agy"].includes(part.trim())),
  );
}
export function requireFusionProvider(model: { provider: string; model?: string | null }): void {
  if (isAntigravity(model)) throw new Error(ANTIGRAVITY_POLICY_MESSAGE);
}
