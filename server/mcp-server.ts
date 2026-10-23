import http from "http";
import { URL } from "url";

/**
 * Simple HTTP MCP server for delegate/report tools.
 * This follows the MCP HTTP transport specification.
 */

interface McpRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

interface McpResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface DelegateParams {
  goal: string;
  constraints?: string;
  success_criteria?: string;
  files_hint?: string[];
}

interface ReportParams {
  status: "completed" | "blocked" | "needs-clarification" | "concerns";
  summary: string;
  changes?: string[];
  tests?: string[];
  concerns?: string[];
  suggested_next?: string;
}

export class FusionMcpHttpServer {
  private server: http.Server | null = null;
  private port: number;
  private delegateHandler?: (params: DelegateParams, agentId: string) => Promise<{ sidekickId: string | null; error?: string }>;
  private reportHandler?: (params: ReportParams, agentId: string) => Promise<void>;

  constructor(port: number = 31337) {
    this.port = port;
  }

  setDelegateHandler(handler: (params: DelegateParams, agentId: string) => Promise<{ sidekickId: string | null; error?: string }>) {
    this.delegateHandler = handler;
  }

  setReportHandler(handler: (params: ReportParams, agentId: string) => Promise<void>) {
    this.reportHandler = handler;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer(async (req, res) => {
        // Set CORS headers
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        if (req.method !== "POST") {
          res.writeHead(405);
          res.end("Method not allowed");
          return;
        }

        const url = new URL(req.url || "", `http://${req.headers.host}`);
        if (url.pathname !== "/mcp") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        let body = "";
        req.on("data", (chunk) => {
          body += chunk.toString();
        });

        req.on("end", async () => {
          try {
            const request: McpRequest = JSON.parse(body);
            const response = await this.handleRequest(request, req.headers["x-agent-id"] as string);
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(response));
          } catch (error) {
            console.error("[fusion-mcp] Error handling request:", error);
            const errorResponse: McpResponse = {
              jsonrpc: "2.0",
              id: 0,
              error: {
                code: -32603,
                message: "Internal error",
                data: error instanceof Error ? error.message : String(error),
              },
            };
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify(errorResponse));
          }
        });
      });

      this.server.listen(this.port, () => {
        console.log(`[fusion-mcp] Server listening on port ${this.port}`);
        resolve();
      });

      this.server.on("error", (error) => {
        console.error("[fusion-mcp] Server error:", error);
        reject(error);
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log("[fusion-mcp] Server stopped");
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private async handleRequest(request: McpRequest, agentId: string = "unknown"): Promise<McpResponse> {
    const response: McpResponse = {
      jsonrpc: "2.0",
      id: request.id,
    };

    try {
      switch (request.method) {
        case "tools/list":
          response.result = {
            tools: [
              {
                name: "delegate",
                description: "Delegate a task to the fusion sidekick",
                inputSchema: {
                  type: "object",
                  properties: {
                    goal: { type: "string", description: "The goal of the delegation" },
                    constraints: { type: "string", description: "Constraints for the sidekick" },
                    success_criteria: { type: "string", description: "Success criteria" },
                    files_hint: { type: "array", items: { type: "string" }, description: "Files to focus on" },
                  },
                  required: ["goal"],
                },
              },
              {
                name: "report",
                description: "Report back to the fusion lead",
                inputSchema: {
                  type: "object",
                  properties: {
                    status: {
                      type: "string",
                      enum: ["completed", "blocked", "needs-clarification", "concerns"],
                      description: "Status of the work",
                    },
                    summary: { type: "string", description: "High-level summary" },
                    changes: { type: "array", items: { type: "string" }, description: "Files changed" },
                    tests: { type: "array", items: { type: "string" }, description: "Tests run" },
                    concerns: { type: "array", items: { type: "string" }, description: "Concerns or risks" },
                    suggested_next: { type: "string", description: "Suggested next action" },
                  },
                  required: ["status", "summary"],
                },
              },
            ],
          };
          break;

        case "tools/call":
          const params = request.params as { name: string; arguments?: unknown };
          if (params.name === "delegate") {
            if (!this.delegateHandler) {
              throw new Error("Delegate handler not set");
            }
            const delegateParams = params.arguments as DelegateParams;
            const result = await this.delegateHandler(delegateParams, agentId);
            response.result = {
              content: [
                {
                  type: "text",
                  text: result.sidekickId
                    ? `Delegation dispatched to sidekick ${result.sidekickId}`
                    : result.error || "Delegation failed",
                },
              ],
            };
          } else if (params.name === "report") {
            if (!this.reportHandler) {
              throw new Error("Report handler not set");
            }
            const reportParams = params.arguments as ReportParams;
            await this.reportHandler(reportParams, agentId);
            response.result = {
              content: [
                {
                  type: "text",
                  text: "Report accepted",
                },
              ],
            };
          } else {
            throw new Error(`Unknown tool: ${params.name}`);
          }
          break;

        default:
          response.error = {
            code: -32601,
            message: "Method not found",
          };
      }
    } catch (error) {
      response.error = {
        code: -32603,
        message: "Internal error",
        data: error instanceof Error ? error.message : String(error),
      };
    }

    return response;
  }
}
