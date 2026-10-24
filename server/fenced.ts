import { BriefSchema, ReportSchema, type Brief, type Report } from "../shared/models";
import type { Profile } from "../shared/settings";

/** Parse a deliberately small field/list format, or JSON. This is not a YAML evaluator. */
function block(text: string, tag: string): Record<string, unknown> | null {
  const matches = [...text.replace(/\r\n/g, "\n").matchAll(new RegExp("```" + tag + "[ \\t]*\\n([\\s\\S]*?)\\n```", "g"))];
  const body = matches.at(-1)?.[1];
  if (!body) return null;
  try {
    const json: unknown = JSON.parse(body);
    if (json && typeof json === "object" && !Array.isArray(json)) return json as Record<string, unknown>;
  } catch { /* Continue with the field/list format. */ }
  const fields: Record<string, unknown> = {};
  let key = "";
  for (const line of body.split("\n")) {
    const match = line.match(/^([a-z_]+):[ \t]*(.*)$/);
    if (match) {
      key = match[1];
      const value = match[2].trim();
      fields[key] = value === "|" || value === ">" ? "" : value;
      if (/^[\["]/.test(value) || value === "null") {
        try { fields[key] = JSON.parse(value); } catch { /* Keep plain text. */ }
      }
    } else if (key && line.trim().startsWith("- ")) {
      const current = fields[key];
      const list = Array.isArray(current) ? current : typeof current === "string" && current.trim() ? [current] : [];
      list.push(line.trim().slice(2));
      fields[key] = list;
    } else if (key && line.trim()) {
      const current = fields[key];
      if (typeof current === "string") fields[key] = current + "\n" + line.trim();
    }
  }
  return fields;
}
export function parseFencedBrief(text: string): Brief | null {
  const fields = block(text, "fusion-brief");
  if (!fields) return null;
  if (typeof fields.files_hint === "string") fields.files_hint = fields.files_hint.split(",").map((s) => s.trim()).filter(Boolean);
  const parsed = BriefSchema.safeParse(fields);
  return parsed.success ? parsed.data : null;
}
export function parseFencedReport(text: string): { delegationId: string; reportToken: string; report: Report } | null {
  const fields = block(text, "report");
  if (!fields || typeof fields.delegation_id !== "string" || typeof fields.report_token !== "string") return null;
  for (const key of ["changes", "tests", "concerns"]) {
    if (typeof fields[key] === "string") fields[key] = fields[key] === "" ? [] : [fields[key]];
  }
  if (Array.isArray(fields.suggested_next)) fields.suggested_next = fields.suggested_next.join("\n");
  if (fields.suggested_next === "") fields.suggested_next = null;
  const parsed = ReportSchema.safeParse(fields);
  return parsed.success ? { delegationId: fields.delegation_id, reportToken: fields.report_token, report: parsed.data } : null;
}
export const hasFencedBrief = (text: string) => parseFencedBrief(text) !== null;
export function getFencedBriefPrompt(_profile?: Profile): string {
  return "To delegate, end your turn with a fenced block:\n\n" +
    "```fusion-brief\ngoal: <task>\nconstraints: <boundaries>\nsuccess_criteria: <expected outcome>\nfiles_hint: <comma-separated files>\n```\n\n" +
    "Wait for the sidekick report before reviewing the result. Do not repeat the same brief after receiving its report.";
}
