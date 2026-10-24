import { BriefSchema, ReportSchema } from "../shared/models";
import { z } from "zod";
import http, { type IncomingHttpHeaders } from "node:http";
import { URL } from "node:url";

const MAX_BODY_BYTES = 1024 * 1024;
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const LEGACY_PROTOCOL_VERSIONS = new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);
const SERVER_INFO = { name: "paseo-model-fusion", version: "0.1.0" };

interface McpRequest {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: unknown;
}

interface McpResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  _meta?: { "io.modelcontextprotocol/serverInfo": typeof SERVER_INFO };
}

interface DelegateParams {
  goal: string;
  constraints?: string;
  success_criteria?: string;
  files_hint?: string[];
  lead_agent_id?: string;
}

interface ReportParams {
  delegation_id: string;
  report_token: string;
  status: "completed" | "blocked" | "needs-clarification" | "concerns";
  summary: string;
  changes?: string[];
  tests?: string[];
  concerns?: string[];
  suggested_next?: string;
}

interface McpCallContext {
  agentId: string;
  headers: IncomingHttpHeaders;
}

export class FusionMcpHttpServer {
  private server: http.Server | null = null;

  constructor(private readonly port = 31337, private readonly host = "127.0.0.1") {}

  setDelegateHandler(
    handler: (params: DelegateParams, context: McpCallContext) => Promise<{ sidekickId: string | null; error?: string }>,
  ): void {
    this.delegateHandler = handler;
  }

  setReportHandler(handler: (params: ReportParams, context: McpCallContext) => Promise<boolean>): void {
    this.reportHandler = handler;
  }

  private delegateHandler?: (
    params: DelegateParams,
    context: McpCallContext,
  ) => Promise<{ sidekickId: string | null; error?: string }>;
  private reportHandler?: (params: ReportParams, context: McpCallContext) => Promise<boolean>;

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.server?.listening) {
        resolve();
        return;
      }

      const server = http.createServer((req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
        res.setHeader(
          "Access-Control-Allow-Headers",
          "Content-Type, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Param-Lead-Agent-Id, Mcp-Param-Delegation-Id, Mcp-Param-Report-Token, Mcp-Session-Id, X-Agent-Id",
        );

        if (req.method === "OPTIONS") {
          res.writeHead(204).end();
          return;
        }

        const url = new URL(req.url || "/", "http://127.0.0.1");
        if (url.pathname !== "/mcp") {
          res.writeHead(404).end("Not found");
          return;
        }

        const origin = req.headers.origin;
        if (origin && !isLoopbackOrigin(origin)) {
          res.writeHead(403).end("Invalid origin");
          return;
        }

        if (req.method !== "POST") {
          res.setHeader("Allow", "POST, OPTIONS");
          res.writeHead(405).end("Method not allowed");
          return;
        }

        const chunks: Buffer[] = [];
        let size = 0;
        let rejected = false;
        req.on("data", (chunk: Buffer | string) => {
          if (rejected) return;
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += bytes.byteLength;
          if (size > MAX_BODY_BYTES) {
            rejected = true;
            res.writeHead(413).end("Request body too large");
            req.destroy();
            return;
          }
          chunks.push(bytes);
        });

        req.on("end", () => {
          if (rejected) return;
          let request: McpRequest;
          try {
            request = JSON.parse(Buffer.concat(chunks).toString("utf8")) as McpRequest;
          } catch {
            this.writeJson(res, 400, {
              jsonrpc: "2.0",
              id: null,
              error: { code: -32700, message: "Parse error" },
            });
            return;
          }

          if (!request || request.jsonrpc !== "2.0" || typeof request.method !== "string") {
            this.writeJson(res, 400, {
              jsonrpc: "2.0",
              id: request?.id ?? null,
              error: { code: -32600, message: "Invalid Request" },
            });
            return;
          }

          const protocolError = this.validateRequest(request, req.headers);
          if (protocolError) {
            this.writeJson(res, 400, {
              jsonrpc: "2.0",
              id: request.id ?? null,
              error: protocolError,
            });
            return;
          }

          if (request.id === undefined && request.method.startsWith("notifications/")) {
            res.writeHead(202).end();
            return;
          }

          const context: McpCallContext = {
            agentId: this.agentIdFromHeaders(req.headers),
            headers: req.headers,
          };
          const modern = req.headers["mcp-protocol-version"] === MODERN_PROTOCOL_VERSION;
          void this.handleRequest(request, context).then((response) => {
            if (modern) this.stampModernResponse(response);
            this.writeJson(res, 200, response);
          }).catch((error) => {
            console.error("[fusion-mcp] Request failed:", error);
            this.writeJson(res, 200, {
              jsonrpc: "2.0",
              id: request.id ?? null,
              error: {
                code: -32603,
                message: "Internal error",
                data: error instanceof Error ? error.message : String(error),
              },
            });
          });
        });
      });

      this.server = server;
      server.once("error", reject);
      server.listen(this.port, this.host, () => {
        server.off("error", reject);
        server.on("error", (error) => console.error("[fusion-mcp] Server error:", error));
        console.log(`[fusion-mcp] Server listening on http://${this.host}:${this.port}/mcp`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      const server = this.server;
      this.server = null;
      if (!server?.listening) {
        resolve();
        return;
      }
      server.close((error) => {
        if (error) console.error("[fusion-mcp] Error stopping server:", error);
        else console.log("[fusion-mcp] Server stopped");
        resolve();
      });
    });
  }

  private writeJson(res: http.ServerResponse, status: number, body: McpResponse): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(body));
  }

  private agentIdFromHeaders(headers: IncomingHttpHeaders): string {
    const value = headers["x-agent-id"] || headers["x-paseo-agent-id"];
    return Array.isArray(value) ? value[0] || "" : value || "";
  }

  private async handleRequest(request: McpRequest, context: McpCallContext): Promise<McpResponse> {
    const response: McpResponse = { jsonrpc: "2.0", id: request.id ?? null };

    switch (request.method) {
      case "server/discover":
        response.result = {
          supportedVersions: [MODERN_PROTOCOL_VERSION],
          capabilities: { tools: { listChanged: false } },
          ttlMs: 0,
          cacheScope: "private",
        };
        return response;

      case "initialize": {
        const params = request.params as { protocolVersion?: unknown } | undefined;
        response.result = {
          protocolVersion: typeof params?.protocolVersion === "string" &&
            LEGACY_PROTOCOL_VERSIONS.has(params.protocolVersion)
            ? params.protocolVersion
            : "2025-11-25",
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        };
        return response;
      }

      case "ping":
        response.result = {};
        return response;

      case "tools/list":
        response.result = { tools: this.tools() };
        return response;

      case "tools/call":
        response.result = await this.callTool(request.params, context);
        return response;

      default:
        response.error = { code: -32601, message: "Method not found" };
        return response;
    }
  }

  private tools() {
    return [
      {
        name: "delegate",
        description: "Delegate a task from a Fusion lead to its configured sidekick",
        inputSchema: {
          type: "object",
          properties: {
            goal: { type: "string", minLength: 1, description: "The goal of the delegation" },
            constraints: { type: "string", description: "Constraints for the sidekick" },
            success_criteria: { type: "string", description: "Success criteria" },
            files_hint: { type: "array", items: { type: "string" }, description: "Files to focus on" },
            lead_agent_id: {
              type: "string",
              description: "Optional caller ID when the provider does not forward X-Agent-Id",
              "x-mcp-header": "Lead-Agent-Id",
            },
          },
          required: ["goal"],
          additionalProperties: false,
        },
      },
      {
        name: "report",
        description: "Send the sidekick's completed delegation report to the lead",
        inputSchema: {
          type: "object",
          properties: {
            delegation_id: {
              type: "string",
              description: "The delegation ID from the brief",
              "x-mcp-header": "Delegation-Id",
            },
            report_token: {
              type: "string",
              description: "The report authorization token from the brief",
              "x-mcp-header": "Report-Token",
            },
            status: {
              type: "string",
              enum: ["completed", "blocked", "needs-clarification", "concerns"],
              description: "Status of the work",
            },
            summary: { type: "string", minLength: 1, description: "High-level summary" },
            changes: { type: "array", items: { type: "string" }, description: "Files changed" },
            tests: { type: "array", items: { type: "string" }, description: "Tests run" },
            concerns: { type: "array", items: { type: "string" }, description: "Concerns or risks" },
            suggested_next: { type: "string", description: "Suggested next action" },
          },
          required: ["delegation_id", "report_token", "status", "summary"],
          additionalProperties: false,
        },
      },
    ];
  }

  private validateRequest(request: McpRequest, headers: IncomingHttpHeaders): { code: number; message: string; data?: unknown } | null {
    const versionHeader = this.header(headers["mcp-protocol-version"]);
    const meta = (request.params as { _meta?: Record<string, unknown> } | undefined)?._meta;
    const bodyVersion = meta?.["io.modelcontextprotocol/protocolVersion"];

    if (bodyVersion === MODERN_PROTOCOL_VERSION && versionHeader !== MODERN_PROTOCOL_VERSION) {
      return { code: -32020, message: "Header mismatch: MCP-Protocol-Version is required and must match _meta" };
    }
    if (versionHeader && bodyVersion !== undefined && bodyVersion !== versionHeader) {
      return { code: -32020, message: "Header mismatch: protocol version header and body differ" };
    }

    if (versionHeader === MODERN_PROTOCOL_VERSION) {
      if (bodyVersion !== MODERN_PROTOCOL_VERSION) {
        return { code: -32020, message: "Header mismatch: protocol version header and body differ" };
      }
      const methodHeader = this.header(headers["mcp-method"]);
      if (methodHeader !== request.method) {
        return { code: -32020, message: "Header mismatch: Mcp-Method does not match the request" };
      }
      if (request.method === "tools/call") {
        const params = request.params as { name?: unknown } | undefined;
        const nameHeader = this.header(headers["mcp-name"]);
        if (nameHeader !== params?.name) {
          return { code: -32020, message: "Header mismatch: Mcp-Name does not match the tool name" };
        }
        if (params?.name === "delegate") {
          const args = (request.params as { arguments?: Record<string, unknown> }).arguments || {};
          const leadAgentId = args.lead_agent_id;
          const leadAgentHeader = this.header(headers["mcp-param-lead-agent-id"]);
          if ((typeof leadAgentId === "string" && leadAgentHeader !== leadAgentId) ||
              (leadAgentHeader !== undefined && leadAgentHeader !== leadAgentId)) {
            return { code: -32020, message: "Header mismatch: Mcp-Param-Lead-Agent-Id does not match the tool input" };
          }
        }
        if (params?.name === "report") {
          const args = (request.params as { arguments?: Record<string, unknown> }).arguments || {};
          const delegationId = args.delegation_id;
          const reportToken = args.report_token;
          const delegationHeader = this.header(headers["mcp-param-delegation-id"]);
          const tokenHeader = this.header(headers["mcp-param-report-token"]);
          if (typeof delegationId !== "string" || delegationHeader !== delegationId ||
              typeof reportToken !== "string" || tokenHeader !== reportToken) {
            return { code: -32020, message: "Header mismatch: report authorization headers do not match the tool input" };
          }
        }
      }
      return null;
    }

    if (versionHeader && !LEGACY_PROTOCOL_VERSIONS.has(versionHeader)) {
      return {
        code: -32022,
        message: "Unsupported protocol version",
        data: { supported: [MODERN_PROTOCOL_VERSION, ...LEGACY_PROTOCOL_VERSIONS], requested: versionHeader },
      };
    }
    return null;
  }

  private stampModernResponse(response: McpResponse): void {
    response._meta = { "io.modelcontextprotocol/serverInfo": SERVER_INFO };
    if (response.result && typeof response.result === "object" && !Array.isArray(response.result)) {
      response.result = { ...response.result, resultType: "complete" };
    }
  }

  private header(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
  }

  private async callTool(rawParams: unknown, context: McpCallContext): Promise<unknown> {
    if (!rawParams || typeof rawParams !== "object") {
      return { isError: true, content: [{ type: "text", text: "Invalid tool parameters" }] };
    }

    const params = rawParams as { name?: unknown; arguments?: unknown };
    const args = params.arguments && typeof params.arguments === "object"
      ? params.arguments as Record<string, unknown>
      : {};

    if (params.name === "delegate") {
      if (!BriefSchema.extend({ lead_agent_id: z.string().optional() }).strict().safeParse(args).success) {
        return { isError: true, content: [{ type: "text", text: "The goal field is required" }] };
      }
      if (!this.delegateHandler) {
        return { isError: true, content: [{ type: "text", text: "Delegate handler not available" }] };
      }

      const result = await this.delegateHandler({
        goal: args.goal as string,
        ...(typeof args.constraints === "string" ? { constraints: args.constraints } : {}),
        ...(typeof args.success_criteria === "string" ? { success_criteria: args.success_criteria } : {}),
        ...(Array.isArray(args.files_hint) && args.files_hint.every((value) => typeof value === "string")
          ? { files_hint: args.files_hint as string[] }
          : {}),
        ...(typeof args.lead_agent_id === "string" ? { lead_agent_id: args.lead_agent_id } : {}),
      }, context);

      return {
        isError: !result.sidekickId,
        content: [{
          type: "text",
          text: result.sidekickId
            ? `Delegation dispatched to sidekick ${result.sidekickId}`
            : result.error || "Delegation failed",
        }],
      };
    }

    if (params.name === "report") {
      const status = args.status;
      if (
        !ReportSchema.extend({ delegation_id: z.string().min(1), report_token: z.string().min(1), suggested_next: z.string().optional() }).strict().safeParse(args).success ||
        !["completed", "blocked", "needs-clarification", "concerns"].includes(String(status)) ||
        typeof args.delegation_id !== "string" ||
        typeof args.report_token !== "string" ||
        typeof args.summary !== "string" || !args.summary.trim()
      ) {
        return { isError: true, content: [{ type: "text", text: "The report status and summary are required" }] };
      }
      if (!this.reportHandler) {
        return { isError: true, content: [{ type: "text", text: "Report handler not available" }] };
      }

      const report: ReportParams = {
        delegation_id: args.delegation_id as string,
        report_token: args.report_token as string,
        status: status as ReportParams["status"],
        summary: args.summary,
        ...(Array.isArray(args.changes) && args.changes.every((value) => typeof value === "string")
          ? { changes: args.changes as string[] }
          : {}),
        ...(Array.isArray(args.tests) && args.tests.every((value) => typeof value === "string")
          ? { tests: args.tests as string[] }
          : {}),
        ...(Array.isArray(args.concerns) && args.concerns.every((value) => typeof value === "string")
          ? { concerns: args.concerns as string[] }
          : {}),
        ...(typeof args.suggested_next === "string" ? { suggested_next: args.suggested_next } : {}),
      };

      const accepted = await this.reportHandler(report, context);
      return {
        isError: !accepted,
        content: [{ type: "text", text: accepted ? "Report stored for delivery" : "Report rejected; the delegation token is invalid or already used" }],
      };
    }

    return { isError: true, content: [{ type: "text", text: `Unknown tool: ${String(params.name || "")}` }] };
  }
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}
