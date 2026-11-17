'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const { createStressFixture, profiles } = require('./helpers/planet-notes-stress-fixtures');
const { createReleaseReport, assessRelease, markdownReport } = require('./helpers/planet-notes-release-report');
const { runDomainCase, faultAdapter, runSyncRaces } = require('./helpers/planet-notes-stress-scenarios');
const { options, plan, worker, execute, writeReport } = require('./planet-notes-stress');
const { validateIndex } = require('../planet-notes'); const { visibleTree, pathTo } = require('../planet-notes-organization');
test('synthetic stress fixtures are deterministic, valid and include distinct case labels', () => {
  const config = { seed: 72, noteCount: 80, groupCount: 10, depth: 4 }; const a = createStressFixture(config);
  assert.deepEqual(a, createStressFixture(config)); assert.notDeepEqual(a, createStressFixture({ ...config, seed: 73 }));
  assert.equal(validateIndex(a.index).status, 'ok'); assert.deepEqual(a.index.labels.slice(0,2).map(l => l.name), ['plot','Plot']);
  assert.ok(a.index.notes.some(n => n.title === '')); assert.ok(a.index.notes.filter(n => n.title === 'Shared title').length > 1);
  assert.equal(new Set(Object.values(a.bodies).map(b => b.marker)).size, 80);
});
test('deep fixture hierarchy has the requested depth and reaches its leaf without recursion', () => {
  const a = createStressFixture({ noteCount: 1, groupCount: 15, depth: 15 });
  assert.equal(pathTo(a.index, a.index.notes[0].parentId).length, 15);
  const rows = visibleTree(a.index, new Set(a.index.groups.map(g => g.id)), 'en');
  assert.equal(rows.length, 16); assert.equal(rows.at(-1).depth, 15); assert.equal(validateIndex(a.index).status, 'ok');
});
test('invalid fixture arguments reject rather than clamp to invented product limits', () => {
  for (const config of [{ noteCount: -1 }, { seed: NaN }, { depth: 3, groupCount: 2 }, { groupCount: 0.1 }]) assert.throws(() => createStressFixture(config));
  assert.ok(profiles.full.some(c => c.noteCount === 10000)); assert.ok(profiles.full.some(c => c.depth === 5000));
});
test('a planned full campaign performs no stress work and cannot report release readiness', async () => {
  let called = false; const config = options(['--plan','--profile','full']);
  const report = await execute(config, async () => { called = true; });
  assert.equal(called, false); assert.equal(report.execution, 'not-run'); assert.equal(report.releaseReady, false);
  assert.ok(report.gates.every(g => g.status === 'not-run')); assert.equal(report.fixtureSizesAreProductLimits, false);
});
test('gate assessment requires every required gate, evidence and resolved/reviewed findings', () => {
  const report = createReleaseReport({ seed: 1, profile: 'full' });
  assert.equal(assessRelease(report).releaseReady, false);
  for (const gate of report.gates) { gate.status = 'passed'; gate.evidence = ['Synthetic unit-test evidence only']; }
  assert.equal(assessRelease(report).releaseReady, true);
  report.findings.push({ id: 'unresolved', status: 'open', evidence: 'Must review' }); assert.equal(assessRelease(report).releaseReady, false);
  report.findings[0].status = 'reviewed'; assert.equal(assessRelease(report).releaseReady, true);
  report.gates.find(g => g.id === 'native-ios').status = 'not-run'; assert.equal(assessRelease(report).releaseReady, false);
});
test('Node campaign results never pass UI, native or performance-review gates', async () => {
  const report = await execute(options(['--run','--profile','full']), async job => ({ id: job.id, status: 'passed', scope: 'Synthetic runner test' }));
  assert.equal(report.gates.find(g => g.id === 'domain-stress').status, 'passed');
  for (const id of ['desktop-ui','pocket-ui','native-ios','native-android','fonts-themes','performance-review']) assert.equal(report.gates.find(g => g.id === id).status, 'not-run');
  assert.equal(report.releaseReady, false);
});
test('failed cases remain open findings and a failed domain gate', async () => {
  const report = await execute(options(['--run','--profile','smoke']), async job => ({ id: job.id, status: 'failed', error: 'Injected runner failure' }));
  assert.equal(report.gates.find(g => g.id === 'domain-stress').status, 'failed'); assert.ok(report.findings.every(f => f.status === 'open'));
  assert.equal(assessRelease(report).releaseReady, false);
});
test('smoke domain measurement captures real outcomes without mutating metadata', async () => {
  const result = await runDomainCase(profiles.smoke[0], { seed: 42, runs: 2 });
  assert.equal(result.status, 'passed'); assert.equal(result.samples.length, 2);
  for (const sample of result.samples) for (const key of ['validationMs','treeMs','searchBuildMs','queryMs','scheduledTimerDelayMs']) assert.ok(Number.isFinite(sample[key]) && sample[key] >= 0);
});
test('fault harness distinguishes unavailable data and injects exactly one interrupted write', async () => {
  const d = faultAdapter(new Map([['n-one.html','Known words']])); d.unavailable.add('n-one.html');
  assert.deepEqual(await d.adapter.read('n-one.html'), { status: 'unavailable' }); d.arm(1);
  await assert.rejects(d.adapter.writeDurable('n-one.html','New words'), { code: 'EIO' }); assert.equal(d.files.get('n-one.html'), 'Known words');
  await d.adapter.writeDurable('n-one.html','Retry words'); assert.equal(d.files.get('n-one.html'), 'Retry words');
});
test('two-round external-edit smoke scenario exercises the real recovery service', async () => { assert.equal((await runSyncRaces(2)).rounds, 2); });
test('reports start unrun, write JSON/Markdown to a fresh path and cannot overwrite evidence', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'neo-stress-report-')); t.after(() => fs.rmSync(dir,{recursive:true,force:true}));
  const report = plan(options([]), { node: process.version }); const files = writeReport(report,path.join(dir,'report.json'));
  assert.deepEqual(JSON.parse(fs.readFileSync(files.json,'utf8')), report);
  assert.match(fs.readFileSync(files.markdown,'utf8'), /Release ready: no/); assert.match(markdownReport(report), /not product limits/);
  assert.throws(() => writeReport(report,path.join(dir,'report.json')), /exists/);
});
test('stress CLI requires explicit execution and rejects invalid options', () => {
  assert.equal(options([]).run, false); assert.equal(options(['--run']).run, true);
  for (const args of [['--profile','unknown'],['--runs','0'],['--timeout-ms','-1'],['--seed','nope'],['--out'],['--unknown']]) assert.throws(() => options(args));
});

test('stress worker transports a tiny real case without certifying any release gate', async () => {
  const result = await worker({ id: 'worker-smoke', type: 'domain', definition: { id: 'worker-smoke', noteCount: 3, groupCount: 1, depth: 1 }, seed: 42, runs: 1 }, 10000);
  assert.equal(result.status, 'passed', result.error); assert.equal(result.id, 'worker-smoke');
  assert.equal(result.samples.length, 1); assert.match(result.scope, /not UI\/native/);
});
test('stress worker failures return findings rather than a false pass', async () => {
  const result = await worker({ id: 'invalid-case', type: 'unknown' }, 10000);
  assert.equal(result.id, 'invalid-case'); assert.equal(result.status, 'failed'); assert.match(result.error, /Unknown worker case/);
});

test('full-app error guard rejects captured renderer failures', () => {
  const { assertNoRendererErrors } = require('./helpers/planet-notes-ui-verification');
  assert.doesNotThrow(() => assertNoRendererErrors([]));
  assert.throws(() => assertNoRendererErrors(['Uncaught fixture failure']), /Renderer errors.*\nUncaught fixture failure/);
});
test('End verification rejects unchanged focus and requires the last visible row', () => {
  const { assertEndDestination } = require('./helpers/planet-notes-ui-verification');
  assert.throws(() => assertEndDestination('g-first', ['g-first', 'n-last']), /expected n-last/);
  assert.throws(() => assertEndDestination(undefined, []), /Keyboard End destination/);
  assert.doesNotThrow(() => assertEndDestination('n-last', ['g-first', 'n-last']));
});
test('renderer input probe captures blocked delivery and handler duration before stopping', async () => {
  const { measureInputDuring } = require('./helpers/planet-notes-ui-verification');
  let clock = 0; let callback; let cancelled = false; let inputEvents = 0;
  const target = new EventTarget();
  target.addEventListener('input', () => { inputEvents++; clock += 7; });
  const result = measureInputDuring(target, () => { clock += 80; }, {
    now: () => clock, schedule: fn => { callback = fn; return 1; }, cancel: () => { cancelled = true; }
  });
  await Promise.resolve(); callback();
  const measured = (await result).inputDelay;
  assert.equal(inputEvents, 1); assert.equal(measured.sampleCount, 1);
  assert.equal(measured.maxMs, 80); assert.equal(measured.p95Ms, 80);
  assert.equal(measured.samples[0].handlerMs, 7); assert.equal(cancelled, true);
});
test('renderer input probe cancels pending delivery if the measured operation fails', async () => {
  const { measureInputDuring } = require('./helpers/planet-notes-ui-verification'); let cancelled = false;
  await assert.rejects(measureInputDuring(new EventTarget(), () => { throw new Error('fixture failed'); }, {
    schedule: () => 1, cancel: () => { cancelled = true; }
  }), /fixture failed/);
  assert.equal(cancelled, true);
});

test('history-populated scaling measures read amplification and saves without granting performance acceptance', async () => {
  const { runHistoryScaling } = require('./helpers/planet-notes-stress-scenarios');
  const result = await runHistoryScaling({ checkpoints: [0, 4], noteCount: 2 });
  assert.equal(result.status, 'passed'); assert.equal(result.performanceAccepted, false);
  assert.deepEqual(result.samples.map(s => s.priorSaves), [0, 4]);
  const report = createReleaseReport({ seed: 1, profile: 'smoke' }); report.results.push(result);
  assert.match(markdownReport(report), /4 prior saves:/);
  assert.match(markdownReport(report), /performance acceptance pending/);
  assert.equal(assessRelease(report).releaseReady, false);
  for (const sample of result.samples) {
    assert.ok(sample.scanReads > 0); assert.ok(sample.saveReads > 0);
    for (const field of ['scanMs', 'saveMs', 'scheduledTimerDelayMs']) assert.ok(Number.isFinite(sample[field]) && sample[field] >= 0);
  }
});
