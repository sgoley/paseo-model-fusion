type Item = { type?: string; text?: string; message?: string; turnId?: string; data?: { content?: string } };
export function timelineItem(value: unknown): Item {
  if (!value || typeof value !== "object") return {};
  const entry = value as { item?: unknown; turnId?: string };
  const item = (entry.item && typeof entry.item === "object" ? entry.item : value) as Item;
  return { ...item, turnId: entry.turnId || item.turnId };
}
/** Restrict parsing to the current prompt so an older cached report cannot complete a new brief. */
export function latestAssistantText(timeline: readonly unknown[], turnId?: string | null): string {
  let start = 0;
  for (let index = timeline.length - 1; index >= 0; index--) {
    if (timelineItem(timeline[index]).type === "user_message") { start = index + 1; break; }
  }
  return timeline.slice(start).map(timelineItem)
    .filter((item) => !turnId || !item.turnId || item.turnId === turnId)
    .map((item) => item.type === "assistant_message" ? item.text : item.type === "assistant" ? item.data?.content : "")
    .filter(Boolean).join("\n").trim();
}
export function isMcpProviderRejection(error: string, timeline: readonly unknown[]): boolean {
  const text = [error, ...timeline.map(timelineItem).filter((item) => item.type === "error" || item.type === "notification").map((item) => item.message || "")].join("\n");
  return /(?:mcp|fusion).{0,120}(?:reject|unsupported|not supported|failed|invalid|connect|start)|(?:reject|unsupported|not supported|failed|invalid|connect|start).{0,120}(?:mcp|fusion)/is.test(text);
}
