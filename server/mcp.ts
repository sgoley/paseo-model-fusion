import type { PaseoApi } from "./protocol-types";
import { delegateRpc, reportRpc } from "../shared/contracts";

/**
 * Simple in-memory MCP server implementation.
 * For now, this is a placeholder that will be expanded to a full HTTP MCP server.
 * The actual HTTP endpoint will be served by the plugin's contribute function.
 */

interface DelegationRequest {
  goal: string;
  constraints?: string;
  success_criteria?: string;
  files_hint?: string[];
}

interface ReportRequest {
  status: "completed" | "blocked" | "needs-clarification" | "concerns";
  summary: string;
  changes?: string[];
  tests?: string[];
  concerns?: string[];
  suggested_next?: string;
}

export class FusionMcpServer {
  private delegations = new Map<string, { leadId: string; brief: DelegationRequest }>();

  handleDelegate(agentId: string, request: DelegationRequest) {
    this.delegations.set(agentId, { leadId: agentId, brief: request });
    return {
      status: "dispatched" as const,
      sidekick_agent_id: null,
      message: "Delegation dispatched; sidekick will be created",
    };
  }

  handleReport(agentId: string, request: ReportRequest) {
    const delegation = this.delegations.get(agentId);
    if (!delegation) {
      return {
        status: "error" as const,
        message: "No active delegation for this agent",
      };
    }
    return {
      status: "accepted" as const,
      message: "Report accepted",
    };
  }

  // This will be called when the plugin contributes the MCP server
  // to register the tools with Paseo's MCP infrastructure
  registerTools(paseo: PaseoApi) {
    // TODO: Register delegate and report as MCP tools
    // This requires understanding how to contribute an HTTP MCP server from a plugin
  }
}
