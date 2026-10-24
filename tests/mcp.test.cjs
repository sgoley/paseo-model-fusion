require("../scripts/register-typescript.cjs");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { FusionMcpHttpServer } = require("../server/mcp-server.ts");

test("HTTP rejects foreign origins and invalid input, and supports both protocol generations", async () => {
  const server = new FusionMcpHttpServer(0);
  let calls = 0;
  server.setDelegateHandler(async () => { calls++; return { sidekickId: "test-sidekick" }; });
  server.setReportHandler(async (params) => params.report_token === "valid");
  await server.start();
  const url = "http://127.0.0.1:" + server.server.address().port + "/mcp";
  const post = (body, headers = {}) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const request = (method, params = {}) => ({ jsonrpc: "2.0", id: 1, method, params });
  try {
    assert.equal((await post(request("ping"), { Origin: "https://foreign.example" })).status, 403);
    const invalid = await fetch(url, { method: "POST", body: "{invalid" });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error.code, -32700);
    const initialized = await post(request("initialize", { protocolVersion: "2025-11-25" }));
    assert.equal((await initialized.json()).result.protocolVersion, "2025-11-25");
    assert.equal((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
    const tools = (await (await post(request("tools/list"))).json()).result.tools;
    assert.equal(tools.length, 2);
    const bad = await post(request("tools/call", { name: "delegate", arguments: { goal: "Task", files_hint: 42 } }));
    assert.equal((await bad.json()).result.isError, true);
    assert.equal(calls, 0);
    const good = await post(request("tools/call", { name: "delegate", arguments: { goal: "Task" } }));
    assert.equal((await good.json()).result.isError, false);
    assert.equal(calls, 1);
    const params = { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } };
    const headers = { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "server/discover" };
    const discovered = (await (await post(request("server/discover", params), headers)).json()).result;
    assert(discovered.supportedVersions.includes("2026-07-28"));
    assert.equal(discovered.resultType, "complete");
    assert.equal((await post(request("ping", params), headers)).status, 400);
    const reportParams = { ...params, name: "report", arguments: { delegation_id: "brief", report_token: "valid", status: "completed", summary: "Done" } };
    const reportHeaders = { ...headers, "Mcp-Method": "tools/call", "Mcp-Name": "report", "Mcp-Param-Delegation-Id": "brief", "Mcp-Param-Report-Token": "wrong" };
    assert.equal((await post(request("tools/call", reportParams), reportHeaders)).status, 400);
    reportHeaders["Mcp-Param-Report-Token"] = "valid";
    assert.equal((await (await post(request("tools/call", reportParams), reportHeaders)).json()).result.isError, false);
  } finally { await server.stop(); }
});
