require("../scripts/register-typescript.cjs");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { FusionState } = require("../server/state.ts");
const { DEFAULT_SETTINGS } = require("../shared/settings.ts");
const { handleDelegation, handleSidekickReport, handleSidekickTurnEnded, recoverDelegations, finishDelegation } = require("../server/orchestration.ts");
const { parseFencedBrief, parseFencedReport } = require("../server/fenced.ts");
const { latestAssistantText } = require("../server/timeline.ts");

const report = { status: "completed", summary: "Done", changes: [], tests: [], concerns: [], suggested_next: null };
function fixture() {
  const state = new FusionState();
  const calls = { created: [], sent: [], cards: [], archived: [] };
  const snapshots = new Map();
  let rejectDelivery = false;
  const api = {
    providers: {
      listAvailable: async () => ({ providers: [{ provider: "codex", available: true }] }),
      listModels: async () => ({ models: [{ id: "gpt-6.1-sol" }, { id: "gpt-6-luna" }] }),
    },
    workspaces: { ref: () => ({ agents: { create: async (options) => {
      const id = "sidekick-" + (calls.created.length + 1);
      calls.created.push(options);
      snapshots.set(id, { agent: { id, activeTurn: null, archivedAt: null, lastUsage: { totalCostUsd: 0.2 } } });
      return { id, archive: async () => { calls.archived.push(id); } };
    } } }) },
    agents: { ref: (id) => ({
      refresh: async () => snapshots.get(id) || null,
      send: async (text) => { if (id === "lead" && rejectDelivery) throw new Error("offline"); calls.sent.push({ id, text }); },
      archive: async () => { calls.archived.push(id); return {}; },
      timeline: { append: async (item) => calls.cards.push(item), refetch: async () => ({ entries: [] }) },
    }) },
  };
  const request = { leadId: "lead", workspaceId: "workspace", leadTurnId: "lead-turn", mcpUrl: "http://127.0.0.1:31337/mcp", profile: DEFAULT_SETTINGS.profiles.find((p) => p.id === "codex-sol-to-luna"), brief: { goal: "Implement task" } };
  return { state, calls, api, request, snapshots, setOffline: (value) => { rejectDelivery = value; } };
}
test("a fresh sidekick receives one brief, then is reused only after its reporting turn ends", async () => {
  const f = fixture();
  const result = await handleDelegation(f.api, DEFAULT_SETTINGS, f.state, f.request);
  assert.equal(f.calls.created[0].prompt, undefined);
  assert.equal(f.calls.sent.length, 1);
  const item = f.state.getDelegationByLead("lead");
  const input = { briefId: item.briefId, reportToken: item.reportToken, report };
  assert.equal(await handleSidekickReport(f.api, DEFAULT_SETTINGS, f.state, { ...input, callerAgentId: "wrong" }), false);
  assert(await handleSidekickReport(f.api, DEFAULT_SETTINGS, f.state, input));
  assert(await handleSidekickReport(f.api, DEFAULT_SETTINGS, f.state, input));
  assert.equal(f.calls.sent.filter((call) => call.id === "lead").length, 1);
  assert.equal(f.state.getSidekick(result.sidekickId).status, "running");
  const event = { agent: { id: result.sidekickId }, timeline: [], turnId: "work-turn", cost: 0.2, outcome: { kind: "completed" } };
  await handleSidekickTurnEnded(f.api, DEFAULT_SETTINGS, f.state, event);
  await handleSidekickTurnEnded(f.api, DEFAULT_SETTINGS, f.state, event);
  assert.equal(f.state.getSidekick(result.sidekickId).totalCost, 0.2);
  await handleDelegation(f.api, DEFAULT_SETTINGS, f.state, { ...f.request, leadTurnId: "next-turn" });
  assert.equal(f.calls.created.length, 1);
  assert.notEqual(f.state.getDelegationByLead("lead").briefId, item.briefId);
  assert.equal(f.state.getDelegationByLead("lead").report, null);
  f.state.dispose();
});
test("delivery failure retains a report and recovery retries it once", async () => {
  const f = fixture();
  await handleDelegation(f.api, DEFAULT_SETTINGS, f.state, f.request);
  const item = f.state.getDelegationByLead("lead");
  f.setOffline(true);
  assert(await handleSidekickReport(f.api, DEFAULT_SETTINGS, f.state, { briefId: item.briefId, reportToken: item.reportToken, report }));
  assert.equal(item.reportDeliveredAt, null);
  f.setOffline(false);
  await recoverDelegations(f.api, DEFAULT_SETTINGS, f.state);
  await recoverDelegations(f.api, DEFAULT_SETTINGS, f.state);
  assert(item.reportDeliveredAt);
  assert.equal(f.calls.sent.filter((call) => call.id === "lead").length, 1);
  f.state.dispose();
});
test("timeouts stop the sidekick and cannot be overwritten by late reports", async () => {
  const f = fixture();
  await handleDelegation(f.api, DEFAULT_SETTINGS, f.state, f.request);
  const item = f.state.getDelegationByLead("lead");
  f.state.updateDelegation(item.briefId, { timeoutAt: Date.now() - 1 });
  f.snapshots.get(item.sidekickId).agent.activeTurn = { turnId: "work" };
  await recoverDelegations(f.api, DEFAULT_SETTINGS, f.state);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(item.status, "timeout");
  assert.deepEqual(f.calls.archived, [item.sidekickId]);
  assert.equal(await handleSidekickReport(f.api, DEFAULT_SETTINGS, f.state, { briefId: item.briefId, reportToken: item.reportToken, report }), false);
  f.state.dispose();
});
test("fenced profiles omit MCP config and accept a token-scoped multiline report", async () => {
  const f = fixture();
  const settings = { ...DEFAULT_SETTINGS, use_mcp_delegation: false };
  await handleDelegation(f.api, settings, f.state, f.request);
  assert.equal(f.calls.created[0].config.mcpServers, undefined);
  const item = f.state.getDelegationByLead("lead");
  const text = "```report\r\ndelegation_id: " + item.briefId + "\r\nreport_token: " + item.reportToken +
    "\r\nstatus: blocked\r\nsummary: Need access\r\n  to a missing file.\r\nchanges:\r\ntests:\r\nconcerns:\r\n- Missing file\r\n```";
  await handleSidekickTurnEnded(f.api, settings, f.state, { agent: { id: item.sidekickId }, timeline: [{ type: "assistant_message", text }], turnId: "work", cost: null, outcome: { kind: "completed" } });
  assert.equal(item.status, "blocked");
  assert.equal(item.report.summary, "Need access\nto a missing file.");
  assert.equal(item.costSidekick, null);
  f.state.dispose();
});
test("older assistant fences are ignored and malformed status is rejected", () => {
  const text = latestAssistantText([
    { type: "assistant_message", text: "```fusion-brief\ngoal: old\n```" },
    { type: "user_message", text: "New brief" },
    { type: "assistant_message", text: "No delegation here" },
  ]);
  assert.equal(parseFencedBrief(text), null);
  assert.deepEqual(parseFencedBrief("```fusion-brief\ngoal: new\nconstraints: first\n  second\nfiles_hint:\n- a.ts\n- b.ts\n```").files_hint, ["a.ts", "b.ts"]);
  assert.equal(parseFencedReport('```report\n{"delegation_id":"a","report_token":"b","status":"garbage","summary":"Hi"}\n```'), null);
  assert.equal(parseFencedReport("```report\nstatus: completed\nsummary: Missing identity\n```"), null);
});

test("canceling while creation is pending archives the late session without sending a brief", async () => {
  const f = fixture();
  const begun = Promise.withResolvers();
  const release = Promise.withResolvers();
  const ref = f.api.workspaces.ref;
  f.api.workspaces.ref = (...args) => {
    const workspace = ref(...args);
    const create = workspace.agents.create;
    workspace.agents.create = async (options) => { begun.resolve(); await release.promise; return create(options); };
    return workspace;
  };
  const dispatched = handleDelegation(f.api, DEFAULT_SETTINGS, f.state, f.request);
  await begun.promise;
  const item = f.state.getDelegationByLead("lead");
  await finishDelegation(f.api, DEFAULT_SETTINGS, f.state, item, "canceled", "Canceled by user");
  release.resolve();
  assert.equal((await dispatched).sidekickId, null);
  assert.equal(item.status, "canceled");
  assert.equal(f.calls.sent.some((call) => call.id.startsWith("sidekick")), false);
  assert.deepEqual(f.calls.archived, [item.sidekickId]);
  f.state.dispose();
});
test("recovery accounts for a reported sidekick turn that finished while the plugin was stopped", async () => {
  const f = fixture();
  await handleDelegation(f.api, DEFAULT_SETTINGS, f.state, f.request);
  const item = f.state.getDelegationByLead("lead");
  f.state.updateSidekick(item.sidekickId, { turnId: "finished-offline" });
  await handleSidekickReport(f.api, DEFAULT_SETTINGS, f.state, { briefId: item.briefId, reportToken: item.reportToken, report });
  await recoverDelegations(f.api, DEFAULT_SETTINGS, f.state);
  await recoverDelegations(f.api, DEFAULT_SETTINGS, f.state);
  assert.equal(item.costSidekick, 0.2);
  assert.equal(f.state.getSidekick(item.sidekickId).turnCount, 1);
  f.state.dispose();
});

test("fenced reports accept next-step lists, quoted statuses and inline arrays", () => {
  const text = '```report\ndelegation_id: id\nreport_token: token\nstatus: "completed"\nsummary: |\n  Reported result\nchanges: []\ntests: No checks requested\nconcerns:\nsuggested_next:\n- Review the result\n- Accept the work\n```';
  const parsed = parseFencedReport(text);
  assert.equal(parsed.report.status, "completed");
  assert.equal(parsed.report.summary.trim(), "Reported result");
  assert.deepEqual(parsed.report.changes, []);
  assert.deepEqual(parsed.report.tests, ["No checks requested"]);
  assert.equal(parsed.report.suggested_next, "Review the result\nAccept the work");
});
