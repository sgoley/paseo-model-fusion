// Makes tiny real-provider calls against the installed plugin. Archives only its own sessions.
require('./register-typescript.cjs');
const assert = require('node:assert/strict');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { connect } = require('./paseo-connection.cjs');
const { latestAssistantText } = require('../server/timeline.ts');
const pluginId = 'paseo-model-fusion';
const pause = (ms) => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const { driver, api } = await connect();
  const agents = new Set();
  const results = [];
  const marker = 'FUSION-E2E-' + Date.now();
  let workspaceId;
  const rpc = (method, input) => driver.invokePluginRpc(pluginId, 'fusion.' + method, input);
  const history = () => rpc('get-workspace', { workspaceId, offset: 0, limit: 100, activeOnly: false, search: marker });
  async function waitFor(check, label, timeout = 180000) {
    const until = Date.now() + timeout;
    while (Date.now() < until) { const value = await check(); if (value) return value; await pause(1000); }
    throw new Error('Timed out waiting for ' + label);
  }
  const task = (nonce) => 'Protocol verification only. Do not inspect files, use shell commands, or change anything. Delegate one brief asking the sidekick to return exactly ' + nonce + ' as its report summary, with empty changes, tests and concerns. Then stop and wait for the report. When the matching report arrives, reply exactly FUSION-REVIEW-OK ' + nonce + ' and do not delegate again.';
  async function completed(leadId, nonce) {
    const item = await waitFor(async () => {
      const data = await history();
      for (const row of data.delegations) if (row.sidekickId) agents.add(row.sidekickId);
      const row = data.delegations.find(x => x.leadId === leadId && x.report?.summary === nonce);
      if (row && ['failed', 'timeout', 'canceled', 'blocked'].includes(row.status)) throw new Error('Delegation ended ' + row.status + ': ' + row.report?.summary);
      return row?.status === 'completed' && row.reportDelivered ? row : null;
    }, 'report ' + nonce);
    await waitFor(async () => {
      const ref = api.agents.ref(leadId); const snapshot = await ref.refresh();
      if (snapshot?.agent.pendingPermissions?.length) throw new Error('Unexpected provider permission request');
      const timeline = await ref.timeline.refetch({ direction: 'tail', limit: 100 });
      return !snapshot?.agent.activeTurn && latestAssistantText(timeline.entries).includes('FUSION-REVIEW-OK ' + nonce);
    }, 'lead review ' + nonce);
    assert(!JSON.stringify(item).includes('reportToken'));
    return item;
  }
  try {
    const settings = await rpc('get-settings', {});
    assert(settings.profiles.some(p => p.id === 'codex-to-antigravity-flash'));
    const cwd = join(tmpdir(), 'paseo-model-fusion-integration', marker);
    mkdirSync(cwd, { recursive: true });
    const parent = await api.agents.create({ cwd, config: { provider: 'codex/gpt-6-luna' }, title: 'Fusion integration fixture', env: { PASEO_MODEL_FUSION_TEXT_ONLY: '1' }, labels: { 'fusion.role': 'probe' } });
    agents.add(parent.id); workspaceId = parent.workspaceId;
    assert(workspaceId);
    for (const profileId of (process.argv[2] || 'codex-to-antigravity-flash,cursor-opus-to-codex-luna').split(',')) {
      const nonce = marker + '-' + profileId;
      console.log('Checking ' + profileId);
      const { agentId } = await rpc('create-lead', { workspaceId, profileId, prompt: task(nonce) });
      agents.add(agentId);
      const first = await completed(agentId, nonce);
      const snapshot = await api.agents.ref(agentId).refresh();
      const profile = settings.profiles.find(p => p.id === profileId);
      assert.equal(snapshot.agent.provider, profile.lead.provider);
      const result = { profileId, status: first.status, reportDelivered: first.reportDelivered, leadReview: true };
      if (!results.length) {
        await api.agents.ref(agentId).send(task(nonce + '-SECOND'));
        const second = await completed(agentId, nonce + '-SECOND');
        assert.equal(second.sidekickId, first.sidekickId, 'Sidekick should be reused');
        result.reusedSidekick = true;
      }
      results.push(result); console.log(profileId + ': passed');
    }
    const before = await history();
    await assert.rejects(rpc('delegation-action', { workspaceId: 'wrong-workspace', delegationId: before.delegations[0].id, action: 'cancel' }));
    const reloaded = await driver.reloadPlugin(pluginId); assert.equal(reloaded.status, 'running');
    const after = await history();
    assert.deepEqual(after.delegations.map(x => [x.id, x.status, x.report?.summary, x.reportDelivered]), before.delegations.map(x => [x.id, x.status, x.report?.summary, x.reportDelivered]));
    const output = { verifiedAt: new Date().toISOString(), paseoVersion: '0.13.0-beta.1', results, reloadPreservedHistory: true, workspaceIsolation: true, redactedViews: true };
    mkdirSync('docs', { recursive: true }); writeFileSync('docs/integration-verification.json', JSON.stringify(output, null, 2) + '\n');
    console.log(JSON.stringify(output, null, 2));
  } finally {
    if (workspaceId) {
      try { const data = await history(); for (const row of data.delegations) if (row.sidekickId) agents.add(row.sidekickId); } catch {}
    }
    await Promise.allSettled([...agents].map(id => api.agents.ref(id).archive()));
    await api.dispose(); await driver.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
