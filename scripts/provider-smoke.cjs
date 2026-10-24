require("./register-typescript.cjs");
const { mkdirSync, writeFileSync, readFileSync, existsSync } = require("node:fs");
const { randomUUID } = require("node:crypto");
const { join } = require("node:path");
const { tmpdir } = require("node:os");
const { connect } = require("./paseo-connection.cjs");
const { FusionMcpHttpServer } = require("../server/mcp-server.ts");
const { parseFencedBrief, parseFencedReport } = require("../server/fenced.ts");
const { latestAssistantText } = require("../server/timeline.ts");

async function main() {
  if (process.argv[2]?.split(",").some((provider) => /antigravity|^agy$/i.test(provider))) throw new Error("Antigravity checks are excluded. Use agy directly outside Fusion.");
  const { driver, api } = await connect();
  const server = new FusionMcpHttpServer(0);
  const calls = new Map();
  server.setDelegateHandler(async (params) => {
    calls.set(params.goal, { ...(calls.get(params.goal) || {}), delegate: true });
    return { sidekickId: "probe-sidekick" };
  });
  server.setReportHandler(async (params) => {
    calls.set(params.delegation_id, { ...(calls.get(params.delegation_id) || {}), report: params.report_token === params.delegation_id });
    return params.report_token === params.delegation_id;
  });
  const agents = [];
  const previousDoc = existsSync("docs/provider-verification.json") ? JSON.parse(readFileSync("docs/provider-verification.json", "utf8")) : {};
  const previous = previousDoc.results || [];
  const results = process.argv[2] ? previous.filter((item) => !process.argv[2].split(",").includes(item.provider)) : [];
  const cwd = join(tmpdir(), "paseo-model-fusion-provider-check");
  mkdirSync(cwd, { recursive: true });
  try {
    await server.start();
    const mcpUrl = "http://127.0.0.1:" + server.server.address().port + "/mcp";
    const available = await api.providers.listAvailable();
    const parent = await api.agents.create({
      cwd, config: { provider: "codex/gpt-6-luna" }, title: "Model Fusion verification",
      env: { PASEO_MODEL_FUSION_TEXT_ONLY: "1" }, labels: { "fusion.role": "probe" },
    });
    agents.push(parent);
    const pairs = [
      ["codex", "gpt-6-luna"], ["omp", "cursor/gemini-3.8-flash"],
      ["devin", "swe-1-6"], ["cursor", "grok-4.7"], ["claude", "claude-sonnet-5-5"],
    ];
    for (const [provider, model] of pairs) {
      if (process.argv[2] && !process.argv[2].split(",").includes(provider)) continue;
      if (!available.providers.some((item) => item.provider === provider && item.available)) {
        results.push({ provider, model, mcp: "unavailable", fenced: "unavailable", reason: "Provider is not enabled and available on this daemon." });
        console.log(provider + ": unavailable");
        continue;
      }
      const result = { ...(previous.find((item) => item.provider === provider) || {}), provider, model };
      delete result.reason;
      for (const transport of process.argv[3] ? [process.argv[3]] : ["mcp", "fenced"]) {
        console.log(provider + ": checking " + transport);
        result[transport] = "failed";
        const nonce = "fusion-probe-" + randomUUID();
        const report = { delegation_id: nonce, report_token: nonce, status: "completed", summary: "Protocol verified", changes: [], tests: [], concerns: [] };
        const prompt = transport === "mcp"
          ? "This is a protocol check. Use only the Fusion MCP tools; do not run shell commands or HTTP requests. First call delegate with goal " + JSON.stringify(nonce) + ". Then call report with exactly this JSON: " + JSON.stringify(report) + ". Finally reply OK. Do not do implementation work."
          : "This is a text protocol check. Do not call any tools. Reply with exactly these two fenced blocks:\n" +
            "```fusion-brief\n" + JSON.stringify({ goal: nonce, constraints: "No changes", files_hint: [] }) + "\n```\n" +
            "```report\n" + JSON.stringify(report) + "\n```";
        let agent;
        try {
          agent = await api.agents.create({
            cwd, parent: parent.id, config: {
              provider: provider + (model ? "/" + model : ""),
              ...(["codex", "claude", "opencode"].includes(provider) && transport === "mcp" ? { toolPolicy: { preapproved: [{ kind: "mcp", server: "fusion", tool: "delegate" }, { kind: "mcp", server: "fusion", tool: "report" }] } } : {}),
              ...(transport === "mcp" ? { mcpServers: { fusion: { type: "http", url: mcpUrl, alwaysLoad: true } } } : {}),
            },
            env: { PASEO_MODEL_FUSION_TEXT_ONLY: "1" },
            labels: { "fusion.role": "probe" }, title: "Fusion check: " + provider + " " + transport,
          });
          agents.push(agent);
          let run = await agent.run(prompt, { timeoutMs: 90000 });
          for (let attempt = 0; run.status === "permission" && attempt < 8; attempt++) {
            const snapshot = await agent.refresh();
            const pending = snapshot?.agent.pendingPermissions || [];
            for (const permission of pending) {
              const description = JSON.stringify(permission);
              const detail = permission.detail?.input;
              const exactFusionTool = detail?.providerIdentifier === "fusion" && ["delegate", "report"].includes(detail?.toolName);
              const namedFusionTool = /mcp|fusion|dynamic.?tools/i.test(permission.name) && /fusion/i.test(description);
              if (permission.kind !== "tool" || (!exactFusionTool && !namedFusionTool)) {
                throw new Error("Probe stopped at an unexpected permission: " + permission.name);
              }
              await agent.respondToPermission({ requestId: permission.id, response: { behavior: "allow", selectedActionId: permission.actions?.find((action) => action.behavior === "allow" && /once/i.test(action.id))?.id } });
            }
            run = await agent.waitForFinish(90000);
          }
          const history = await agent.timeline.refetch({ direction: "tail", limit: 100 });
          const text = latestAssistantText(history.entries);
          const observed = calls.get(nonce);
          const passed = transport === "mcp" ? observed?.delegate && observed?.report :
            parseFencedBrief(text)?.goal === nonce && parseFencedReport(text)?.delegationId === nonce;
          result[transport] = passed ? "passed" : "failed";
          if (passed) delete result[transport + "Reason"];
          if (!passed) result[transport + "Reason"] = "status=" + run.status + "; observed=" + JSON.stringify(observed || {}) + "; " + (run.error || run.final?.lastError?.message || run.lastMessage || "Expected protocol exchange was not observed").slice(0, 500);
          console.log(provider + " " + transport + ": " + result[transport]);
        } catch (error) {
          result[transport + "Reason"] = String(error).slice(0, 500);
          console.log(provider + " " + transport + ": " + String(error).slice(0, 180));
        } finally {
          if (agent) await agent.archive().catch(() => {});
        }
      }
      results.push(result);
    }
  } finally {
    await Promise.allSettled(agents.map((agent) => agent.archive()));
    await server.stop(); await api.dispose(); await driver.close();
  }
  const output = { verifiedAt: new Date().toISOString(), paseoVersion: "0.13.0-beta.1", scope: "Native MCP delegate/report and independent fenced brief/report provider sessions; not a guarantee for every model or account.", results,
    ...(previousDoc.policyReviewedAt ? { policyReviewedAt: previousDoc.policyReviewedAt, policySource: previousDoc.policySource } : {}) };
  mkdirSync("docs", { recursive: true });
  writeFileSync("docs/provider-verification.json", JSON.stringify(output, null, 2) + "\n");
  console.log(JSON.stringify(output, null, 2));
  if (results.some((item) => item.mcp === "failed" || item.fenced === "failed")) process.exitCode = 1;
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
