import type { FusionSettings, Profile } from "../shared/settings";
import { LABEL } from "../shared/labels";

interface FencedBrief {
  goal: string;
  constraints?: string;
  success_criteria?: string;
  files_hint?: string[];
}

const log = (...args: unknown[]) => console.log("[fusion-fenced]", ...args);

/**
 * Parse a fenced brief block from the lead's final message.
 * Format:
 * ```fusion-brief
 * goal: ...
 * constraints: ...
 * success_criteria: ...
 * files_hint: file1, file2, ...
 * ```
 */
export function parseFencedBrief(text: string): FencedBrief | null {
  const briefMatch = text.match(/```fusion-brief\n([\s\S]*?)\n```/);
  if (!briefMatch) {
    return null;
  }

  const briefText = briefMatch[1];
  const lines = briefText.split("\n");

  const brief: FencedBrief = {
    goal: "",
    constraints: undefined,
    success_criteria: undefined,
    files_hint: undefined,
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith("goal:")) {
      brief.goal = trimmed.slice(5).trim();
    } else if (trimmed.startsWith("constraints:")) {
      brief.constraints = trimmed.slice(12).trim();
    } else if (trimmed.startsWith("success_criteria:")) {
      brief.success_criteria = trimmed.slice(17).trim();
    } else if (trimmed.startsWith("files_hint:")) {
      const filesStr = trimmed.slice(11).trim();
      brief.files_hint = filesStr.split(",").map((f) => f.trim()).filter((f) => f);
    }
  }

  // Validate that we have at least a goal
  if (!brief.goal) {
    log("Fenced brief missing goal");
    return null;
  }

  log("Parsed fenced brief", brief);
  return brief;
}

/**
 * Check if the lead's message contains a fenced brief.
 */
export function hasFencedBrief(text: string): boolean {
  return /```fusion-brief\n/.test(text);
}

/**
 * Generate a prompt for the lead to use the fenced-text protocol.
 */
export function getFencedBriefPrompt(profile: Profile): string {
  let prompt = "To delegate to your sidekick, end your turn with a fenced brief block:\n\n";
  prompt += "```fusion-brief\n";
  prompt += "goal: <what you want the sidekick to do>\n";
  prompt += "constraints: <any constraints or boundaries>\n";
  prompt += "success_criteria: <how to know when the work is done>\n";
  prompt += "files_hint: <file1, file2, ...>\n";
  prompt += "```\n\n";

  prompt += "The sidekick will then explore, implement, and test, then report back.\n";
  prompt += "When you receive the report, you can accept, send feedback, or take over.\n";

  return prompt;
}
