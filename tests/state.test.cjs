require("../scripts/register-typescript.cjs");
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { FusionState } = require("../server/state.ts");
const report = { status: "completed", summary: "Done", changes: [], tests: [], concerns: [], suggested_next: null };
const delegation = (patch = {}) => ({
  briefId: "brief", reportToken: "secret", leadId: "lead", workspaceId: "workspace",
  profileId: "profile", sidekickModel: "provider/model", sidekickId: "sidekick", leadTurnId: "lead-turn",
  brief: { goal: "Fix the task" }, status: "running", dispatchedAt: Date.now(), timeoutAt: Date.now() + 60000, ...patch,
});
const sidekick = (patch = {}) => ({
  sidekickId: "sidekick", leadId: "lead", workspaceId: "workspace", profileId: "profile",
  profileSignature: "signature", briefId: "brief", createdAt: Date.now(), lastUsedAt: Date.now(),
  status: "running", turnCount: 0, totalCost: 0, turnId: "sidekick-turn", ...patch,
});

test("restart preserves reports, tokens, usage deduplication and private file permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "fusion-state-"));
  try {
    const path = join(dir, "private", "state.json");
    const state = new FusionState({ filePath: path });
    state.registerSidekick(sidekick());
    state.recordDelegation(delegation());
    state.recordUsage("lead", "lead-turn", 0.4, "lead");
    state.recordUsage("sidekick", "sidekick-turn", 0.1, "sidekick");
    state.acceptReport("brief", "secret", report);
    state.dispose();
    const restored = new FusionState({ filePath: path });
    assert.equal(restored.getDelegation("brief").reportToken, "secret");
    assert.equal(restored.getDelegation("brief").reportDeliveredAt, null);
    assert.equal(restored.recordUsage("lead", "lead-turn", 999, "lead"), false);
    assert.equal(restored.getDelegation("brief").costLead, 0.4);
    assert.equal(restored.getDelegation("brief").costSidekick, 0.1);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, "private")).mode & 0o777, 0o700);
    const view = restored.workspace({ workspaceId: "workspace", offset: 0, limit: 10, activeOnly: false, search: "" });
    assert.equal(JSON.stringify(view).includes("secret"), false);
    assert.equal(JSON.parse(readFileSync(path)).version, 1);
    restored.dispose();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("invalid snapshots are quarantined; unknown versions are never overwritten", () => {
  const dir = mkdtempSync(join(tmpdir(), "fusion-corrupt-"));
  try {
    const path = join(dir, "state.json");
    writeFileSync(path, "{bad");
    const state = new FusionState({ filePath: path, now: () => 100 });
    assert.equal(state.getDelegations().length, 0);
    assert(readdirSync(dir).includes("state.json.corrupt-100"));
    writeFileSync(path, '{"version":2}');
    assert.throws(() => new FusionState({ filePath: path }), /Unsupported/);
    assert.equal(readFileSync(path, "utf8"), '{"version":2}');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("lead cost is split across briefs from one turn and review usage is counted once", () => {
  const state = new FusionState();
  state.recordDelegation(delegation());
  state.recordDelegation(delegation({ briefId: "second" }));
  state.recordUsage("lead", "lead-turn", 2, "lead");
  assert.equal(state.getDelegation("brief").costLead, 1);
  assert.equal(state.getDelegation("second").costLead, 1);
  state.recordUsage("lead", "review-turn", 0.5, "lead");
  state.recordUsage("lead", "review-turn", 0.5, "lead");
  assert.equal(state.getDelegation("second").costLead, 1.5);
  state.recordUsage("lead", "unknown-price", null, "lead");
  assert.equal(state.getDelegation("second").costLead, 1.5);
});
test("reports are scoped, idempotent, and cannot resurrect expired work", () => {
  const state = new FusionState();
  state.recordDelegation(delegation());
  assert.equal(state.acceptReport("brief", "wrong", report), null);
  assert(state.acceptReport("brief", "secret", report));
  assert(state.acceptReport("brief", "secret", report));
  assert.equal(state.acceptReport("brief", "secret", { ...report, summary: "Different" }), null);
  state.recordDelegation(delegation({ briefId: "expired", status: "timeout" }));
  assert.equal(state.acceptReport("expired", "secret", report), null);
});
test("reuse respects profile changes, budgets, active status and age", () => {
  let now = Date.now();
  const state = new FusionState({ now: () => now });
  state.registerSidekick(sidekick({ status: "idle" }));
  assert(state.findReusableSidekick("lead", "signature", 2, 1));
  assert.equal(state.findReusableSidekick("lead", "changed", 2, 1), null);
  assert.equal(state.findReusableSidekick("lead", "signature", 0, 1), null);
  state.updateSidekick("sidekick", { totalCost: 1 });
  assert.equal(state.findReusableSidekick("lead", "signature", 2, 1), null);
  now += 86400001;
  assert.equal(state.findReusableSidekick("lead", "signature", 2, 2), null);
});
test("pruning keeps active and undelivered work, and workspace search and pagination stay scoped", () => {
  const now = Date.now();
  const state = new FusionState({ now: () => now });
  state.recordDelegation(delegation({ briefId: "old", status: "completed", completedAt: 1, reportDeliveredAt: 1 }));
  state.recordDelegation(delegation({ briefId: "pending", status: "completed", completedAt: 1, report }));
  state.recordDelegation(delegation({ briefId: "active", dispatchedAt: 1 }));
  state.recordDelegation(delegation({ briefId: "other", workspaceId: "elsewhere" }));
  state.prune(1);
  assert.equal(state.getDelegation("old"), null);
  assert(state.getDelegation("pending"));
  assert(state.getDelegation("active"));
  const page = state.workspace({ workspaceId: "workspace", offset: 0, limit: 1, activeOnly: true, search: "task" });
  assert.equal(page.total, 1);
  assert.equal(page.delegations[0].id, "active");
});
test("expired deadlines execute after restoring a snapshot", async () => {
  const state = new FusionState();
  state.recordDelegation(delegation({ timeoutAt: Date.now() - 100 }));
  let expired = false;
  state.armTimer("brief", () => { expired = true; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert(expired);
  state.dispose();
});
module.exports = { delegation, sidekick, report };
