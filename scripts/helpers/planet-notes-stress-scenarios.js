'use strict';
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const model = require('../../planet-notes'); const organization = require('../../planet-notes-organization');
const { createNotesSearch } = require('../../planet-notes-search');
const { createNotesStore } = require('../../planet-notes-store'); const { createNotesService } = require('../../planet-notes-service');
const { createStressFixture } = require('./planet-notes-stress-fixtures');
async function measure(fn) {
  const heapBefore = process.memoryUsage().heapUsed; const start = performance.now();
  const scheduled = new Promise(resolve => setTimeout(() => resolve(performance.now() - start), 0));
  const value = await fn(); const durationMs = performance.now() - start;
  return { value, durationMs, scheduledTimerDelayMs: await scheduled, heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore };
}
async function runDomainCase(definition, { seed, runs = 3 }) {
  const fixture = createStressFixture({ ...definition, seed }); const original = JSON.stringify(fixture.index); const samples = [];
  for (let iteration = 0; iteration < runs; iteration++) {
    const validation = await measure(() => model.validateIndex(fixture.index)); assert.equal(validation.value.status, 'ok');
    const tree = await measure(() => organization.visibleTree(fixture.index, new Set(fixture.index.groups.map(g => g.id)), 'en'));
    assert.equal(tree.value.length, fixture.noteCount + fixture.groupCount); assert.equal(new Set(tree.value.map(row => row.item.id)).size, tree.value.length);
    const built = await measure(() => {
      const index = createNotesSearch({ textOf: html => html.replace(/<[^>]*>/g, ' '), locale: 'en' });
      for (const note of fixture.index.notes) index.upsert({ document: { bookId: 'book-stress', kind: 'custom', noteId: note.id }, title: note.title, html: fixture.bodies[note.id].html, status: 'ok', groupPath: organization.pathTo(fixture.index, note.parentId).map(g => g.title).join(' / '), labels: note.labelIds.map(id => fixture.index.labels.find(l => l.id === id).name), labelIds: note.labelIds });
      return index;
    });
    const target = fixture.index.notes.at(-1); const marker = target && fixture.bodies[target.id].marker;
    const queried = await measure(() => built.value.query({ text: marker || '' }));
    assert.equal(queried.value.coverage.complete, true);
    assert.equal(queried.value.results.length, target ? 1 : 0);
    if (target) {
      assert.equal(queried.value.results[0].document.noteId, target.id);
      const live = [{ document: { bookId: 'book-stress', kind: 'custom', noteId: target.id }, html: '<p>immediate_unsaved_marker</p>' }];
      assert.equal(built.value.query({ text: 'immediate_unsaved_marker', live }).results.length, 1);
    }
    assert.equal(JSON.stringify(fixture.index), original);
    samples.push({ iteration, phase: iteration === 0 ? 'first' : 'repeat', validationMs: validation.durationMs, treeMs: tree.durationMs, searchBuildMs: built.durationMs, queryMs: queried.durationMs, scheduledTimerDelayMs: Math.max(validation.scheduledTimerDelayMs, tree.scheduledTimerDelayMs, built.scheduledTimerDelayMs, queried.scheduledTimerDelayMs), heapDeltaBytes: validation.heapDeltaBytes + tree.heapDeltaBytes + built.heapDeltaBytes + queried.heapDeltaBytes });
  }
  const ordered = samples.map(s => s.queryMs).sort((a,b) => a-b);
  return { id: definition.id, scope: 'Node worker; not UI/native evidence', status: 'passed', fixture: { notes: fixture.noteCount, groups: fixture.groupCount, depth: fixture.depth }, samples, queryP50Ms: ordered[Math.floor((ordered.length-1)*0.5)], queryP95Ms: ordered[Math.ceil((ordered.length-1)*0.95)], peakRssBytes: process.resourceUsage().maxRSS * 1024 };
}
function faultAdapter(initial = new Map()) {
  const files = new Map(initial); const unavailable = new Set(); const events = []; let writes = 0; let failAt = null;
  return { files, unavailable, events, arm: occurrence => { writes = 0; failAt = occurrence; events.length = 0; },
    adapter: {
      async read(path) { events.push({ operation: 'read', path }); return unavailable.has(path) ? { status: 'unavailable' } : files.has(path) ? { status: 'ok', text: files.get(path) } : { status: 'missing' }; },
      async writeDurable(path, text) { writes++; events.push({ operation: 'write', path, ordinal: writes }); if (writes === failAt) { failAt = null; throw Object.assign(new Error('Injected interrupted write'), { code: 'EIO' }); } files.set(path, text); },
      async list() { return [...files.keys()]; }, async remove(path) { events.push({ operation: 'remove', path }); files.delete(path); }
    }
  };
}
function openService(d) { const store = createNotesStore(d.adapter); return { store, service: createNotesService({ enabled: true, getBook: async () => ({ adapter: d.adapter, store }), now: () => '2026-11-12T10:00:00.000Z' }) }; }
async function seedStorage() {
  const d = faultAdapter(); const { service } = openService(d);
  const note = await service.create('book-stress', { operationId: 'o-seed-create', title: 'Retained character' });
  const body = await service.read('book-stress', note.noteId);
  await service.save('book-stress', note.noteId, { operationId: 'o-seed-save', html: '<p>Original author words</p>', expectedBodyToken: body.bodyToken, writingDay: '2026-11-11' });
  return { files: new Map(d.files), noteId: note.noteId, request: { operationId: 'o-stress-save', html: '<p>New author words</p>', expectedBodyToken: '<p>Original author words</p>', writingDay: '2026-11-12' } };
}
async function runStorageFaults() {
  const seed = await seedStorage(); const dry = faultAdapter(seed.files); dry.arm(null);
  await openService(dry).service.save('book-stress', seed.noteId, seed.request);
  const count = dry.events.filter(e => e.operation === 'write').length; assert.ok(count > 0);
  const checkpoints = [];
  for (let occurrence = 1; occurrence <= count; occurrence++) {
    const d = faultAdapter(seed.files); d.arm(occurrence);
    await assert.rejects(openService(d).service.save('book-stress', seed.noteId, seed.request), { code: 'EIO' });
    const restarted = openService(d);
    const observed = await restarted.service.read('book-stress', seed.noteId);
    assert.ok(['<p>Original author words</p>', seed.request.html].includes(observed.html));
    assert.equal((await restarted.service.save('book-stress', seed.noteId, seed.request)).status, 'saved');
    assert.equal((await restarted.store.read(seed.noteId)).html, seed.request.html);
    assert.equal(model.validateIndex((await restarted.store.load()).index).status, 'ok');
    const revisions = await restarted.store.listRevisions(seed.noteId); let preserved = false;
    for (const revision of revisions) if ((await restarted.store.readRevision(seed.noteId, revision.id)).html === '<p>Original author words</p>') preserved = true;
    assert.equal(preserved, true); checkpoints.push({ occurrence, status: 'passed' });
  }
  for (const path of ['index.json', seed.noteId + '.html']) {
    const d = faultAdapter(seed.files); d.unavailable.add(path);
    await assert.rejects(openService(d).service.save('book-stress', seed.noteId, seed.request), { code: 'ECLOUD' });
    assert.deepEqual(d.files, seed.files);
  }
  return { id: 'storage-faults', scope: 'Simulated I/O; not native durability', status: 'passed', checkpoints, unavailableInputs: 2 };
}
async function runSyncRaces(rounds = 12) {
  const seed = await seedStorage(); const d = faultAdapter(seed.files); const { service, store } = openService(d); let base = (await service.read('book-stress', seed.noteId)).bodyToken;
  for (let round = 0; round < rounds; round++) {
    const external = '<p>Observed external version ' + round + '</p>'; const local = '<p>Observed local version ' + round + '</p>';
    d.files.set(seed.noteId + '.html', external);
    const recovered = await service.refresh('book-stress', seed.noteId, { baseBodyToken: base, localHtml: local });
    assert.equal(recovered.status, 'ok'); assert.ok(recovered.conflictNoteId);
    assert.equal((await store.read(recovered.conflictNoteId)).html, external); assert.equal((await store.read(seed.noteId)).html, local);
    const count = (await store.load()).index.notes.length;
    const repeated = await service.refresh('book-stress', seed.noteId, { baseBodyToken: recovered.bodyToken, localHtml: local });
    assert.equal(repeated.status, 'ok'); assert.equal((await store.load()).index.notes.length, count);
    base = recovered.bodyToken;
  }
  return { id: 'sync-races', scope: 'Simulated external file edits; not cloud-provider certification', status: 'passed', rounds };
}
module.exports = { runDomainCase, faultAdapter, runStorageFaults, runSyncRaces };
