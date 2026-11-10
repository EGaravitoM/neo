'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createNotesStore } = require('../planet-notes-store');
const { validateIndex } = require('../planet-notes');
const { mergeNotesIndex, validateConflict } = require('../planet-notes-reconcile');
const at = '2026-11-10T10:00:00.000Z';
const copy = (value) => structuredClone(value);
function index() {
  return {
    schemaVersion: 1, versionId: 'v-base', parentVersionIds: [],
    root: { sortMode: 'manual', childOrder: ['g-cast', 'g-places'] },
    groups: [
      { id: 'g-cast', title: 'Cast', parentId: null, sortMode: 'manual', childOrder: ['n-mara'], createdAt: at },
      { id: 'g-places', title: 'Places', parentId: null, sortMode: 'alphabetical', childOrder: [], createdAt: at }
    ],
    notes: [{ id: 'n-mara', title: 'Mara', parentId: 'g-cast', labelIds: [], createdAt: at }],
    labels: [{ id: 'l-plot', name: 'Plot' }], tombstones: []
  };
}
function branches() {
  const base = index();
  const local = { ...copy(base), versionId: 'v-local', parentVersionIds: ['v-base'] };
  const incoming = { ...copy(base), versionId: 'v-incoming', parentVersionIds: ['v-base'] };
  return { base, local, incoming, versionId: 'v-merged' };
}
function fixture(seed, failAt = Infinity, after = false) {
  const files = new Map(Object.entries(seed || { 'index.json': JSON.stringify(index()), 'n-mara.html': '<p>Base writing</p>', 'recovery/index-versions/v-base.json': JSON.stringify(index()) }));
  let mutations = 0;
  const mutate = (fn) => {
    mutations++;
    if (mutations === failAt && !after) throw new Error('power loss');
    fn();
    if (mutations === failAt && after) throw new Error('power loss');
  };
  const adapter = {
    async read(path) { return files.has(path) ? { status: 'ok', text: files.get(path) } : { status: 'missing' }; },
    async list() { return [...files.keys()]; },
    async writeDurable(path, text) { mutate(() => files.set(path, text)); },
    async remove(path) { mutate(() => files.delete(path)); }
  };
  return { files, adapter, store: createNotesStore(adapter), count: () => mutations };
}
const bodyConflict = () => ({ operationId: 'o-body', noteId: 'n-mara', expectedBodyToken: '<p>Base writing</p>', localHtml: '<p>Local writing</p>', incomingHtml: '<p>External writing</p>', baseVersionId: 'v-base', versionId: 'v-body', createdAt: at });
const discovery = (d) => ({ operationId: 'o-orphans', versionId: 'v-orphans', createdAt: at, expectedIndexToken: d.files.get('index.json') });

// Pure merge interface: compare explicit branch variants, not wall-clock order.
test('independent metadata changes merge without mutating their inputs', () => {
  const request = branches();
  request.local.notes[0].title = 'Local title';
  request.incoming.notes[0].labelIds = ['l-plot'];
  const before = JSON.stringify(request);
  const result = mergeNotesIndex(request);
  assert.equal(result.status, 'ok');
  assert.equal(result.index.notes[0].title, 'Local title');
  assert.deepEqual(result.index.notes[0].labelIds, ['l-plot']);
  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(new Set(result.index.parentVersionIds), new Set(['v-local', 'v-incoming']));
  assert.equal(JSON.stringify(request), before);
});

test('competing field values retain local choice and all index variants', () => {
  const request = branches();
  request.local.notes[0].title = 'Local'; request.incoming.notes[0].title = 'Incoming';
  const result = mergeNotesIndex(request);
  assert.equal(result.index.notes[0].title, 'Local');
  assert.equal(result.conflicts.length, 1);
  assert.deepEqual(result.conflicts[0].variants, { base: request.base, local: request.local, incoming: request.incoming });
});

test('independent additions on both devices survive with valid ordering', () => {
  const request = branches();
  for (const [branch, id] of [[request.local, 'n-local'], [request.incoming, 'n-incoming']]) {
    branch.notes.push({ ...copy(branch.notes[0]), id, parentId: null }); branch.root.childOrder.push(id);
  }
  const result = mergeNotesIndex(request);
  assert.equal(validateIndex(result.index).status, 'ok');
  assert.deepEqual(new Set(result.index.notes.map((n) => n.id)), new Set(['n-mara', 'n-local', 'n-incoming']));
});

test('concurrent moves that combine into a cycle retain a valid local hierarchy', () => {
  const request = branches();
  request.local.groups[0].parentId = 'g-places';
  request.local.root.childOrder = ['g-places']; request.local.groups[1].childOrder.push('g-cast');
  request.incoming.groups[1].parentId = 'g-cast';
  request.incoming.root.childOrder = ['g-cast']; request.incoming.groups[0].childOrder.push('g-places');
  const result = mergeNotesIndex(request);
  assert.equal(validateIndex(result.index).status, 'ok');
  assert.equal(result.index.groups.find((g) => g.id === 'g-cast').parentId, 'g-places');
  assert.ok(result.conflicts.some((c) => c.kind === 'hierarchy'));
});

test('malformed branch data is not repaired into a publishable empty collection', () => {
  const request = branches(); request.incoming.notes[0].parentId = 'g-missing';
  assert.equal(mergeNotesIndex(request).status, 'invalid');
});

test('same-case label name collisions never produce an invalid index', () => {
  const request = branches();
  request.local.labels.push({ id: 'l-local', name: 'Research' });
  request.incoming.labels.push({ id: 'l-incoming', name: 'Research' });
  const result = mergeNotesIndex(request);
  assert.equal(validateIndex(result.index).status, 'ok');
  assert.ok(result.conflicts.length > 0, 'retain variants rather than silently merge label identities');
});

// Storage interface: actual writing and recovery records must remain retrievable.
test('body conflict preserves local original and the incoming version as an active note', async () => {
  const d = fixture(); d.files.set('n-mara.html', '<p>External writing</p>');
  const result = await d.store.preserveBodyConflict(bodyConflict());
  assert.equal(result.status, 'saved');
  assert.notEqual(result.conflictNoteId, 'n-mara');
  assert.equal((await d.store.read('n-mara')).html, '<p>Local writing</p>');
  assert.equal((await d.store.read(result.conflictNoteId)).html, '<p>External writing</p>');
  const loaded = (await d.store.load()).index;
  assert.equal(loaded.notes.find((n) => n.id === result.conflictNoteId).parentId, 'g-cast');
  const conflict = (await d.store.listConflicts()).find((c) => c.kind === 'body');
  assert.equal((await d.store.readConflict(conflict.id)).status, 'ok');
});

test('repeated observation of the same incoming body does not create another conflict note', async () => {
  const d = fixture(); d.files.set('n-mara.html', '<p>External writing</p>');
  const first = await d.store.preserveBodyConflict(bodyConflict());
  const current = (await d.store.load()).index.versionId;
  const second = await d.store.preserveBodyConflict({ ...bodyConflict(), operationId: 'o-repeat', baseVersionId: current, versionId: 'v-repeat' });
  assert.equal(second.conflictNoteId, first.conflictNoteId);
  assert.equal((await d.store.load()).index.notes.length, 2);
});

test('a new external version arriving during conflict preservation is not overwritten', async () => {
  const d = fixture(); d.files.set('n-mara.html', '<p>External writing</p>');
  const read = d.adapter.read; let reads = 0;
  d.adapter.read = async (path) => {
    if (path === 'n-mara.html' && ++reads === 2) d.files.set(path, '<p>Newer external writing</p>');
    return read(path);
  };
  assert.equal((await d.store.preserveBodyConflict(bodyConflict())).status, 'conflict');
  assert.equal(d.files.get('n-mara.html'), '<p>Newer external writing</p>');
});

test('metadata reconciliation persists variants without duplicating note bodies', async () => {
  const d = fixture(); const request = branches();
  request.local.notes[0].title = 'Local'; request.incoming.notes[0].title = 'Incoming';
  d.files.set('index.json', JSON.stringify(request.incoming));
  const result = await d.store.reconcileMetadata({ operationId: 'o-metadata', baseVersionId: 'v-base', localIndex: request.local, incomingIndex: request.incoming, expectedIndexToken: d.files.get('index.json'), versionId: 'v-merged', createdAt: at });
  assert.equal(result.status, 'saved');
  assert.equal((await d.store.load()).index.notes[0].title, 'Local');
  assert.equal((await d.store.load()).index.notes.length, 1);
  const conflict = (await d.store.listConflicts()).find((c) => c.kind === 'metadata');
  assert.deepEqual((await d.store.readConflict(conflict.id)).record.variants, { base: request.base, local: request.local, incoming: request.incoming });
});

test('missing merge base refuses reconciliation before any writes', async () => {
  const d = fixture(); const request = branches();
  d.files.delete('recovery/index-versions/v-base.json');
  await assert.rejects(d.store.reconcileMetadata({ operationId: 'o-metadata', baseVersionId: 'v-base', localIndex: request.local, incomingIndex: request.incoming, expectedIndexToken: d.files.get('index.json'), versionId: 'v-merged', createdAt: at }), { code: 'ENOENT' });
  assert.equal(d.count(), 0);
});

test('unindexed root HTML is recovered once using its filename as the initial title', async () => {
  const d = fixture(); d.files.set('Lighthouse.html', '<p>Cliff notes</p>');
  const first = await d.store.recoverOrphans(discovery(d));
  const loaded = (await d.store.load()).index;
  const note = loaded.notes.find((n) => n.title === 'Lighthouse');
  assert.ok(first.recoveredNoteIds.includes(note.id));
  assert.equal((await d.store.read(note.id)).html, '<p>Cliff notes</p>');
  assert.equal(loaded.groups.find((g) => g.id === note.parentId).title, 'Recovered Notes');
  await d.store.recoverOrphans({ ...discovery(d), operationId: 'o-rescan', versionId: 'v-rescan' });
  assert.equal((await d.store.load()).index.notes.length, 2);
});

test('indexed missing and unavailable notes remain indexed and are reported', async () => {
  for (const status of ['missing', 'unavailable']) {
    const d = fixture(); const read = d.adapter.read;
    d.adapter.read = async (path) => path === 'n-mara.html' ? { status } : read(path);
    const result = await d.store.recoverOrphans(discovery(d));
    assert.ok(result.unavailableNoteIds.includes('n-mara'));
    assert.equal((await d.store.load()).index.notes[0].id, 'n-mara');
    assert.equal(d.count(), 0);
  }
});

test('trash/history artifacts and temporary files are not orphan notes', async () => {
  const d = fixture();
  for (const path of ['n-copy.html.tmp', 'n-copy.html.bak', 'trash/t-copy/note.html', 'revisions/n-copy/r-first.html']) d.files.set(path, '<p>Recovery material</p>');
  assert.deepEqual((await d.store.recoverOrphans(discovery(d))).recoveredNoteIds, []);
  assert.equal(d.count(), 0);
});

test('an unresolved pending operation defers orphan classification', async () => {
  const d = fixture();
  d.files.set('recovery/operations/o-incomplete.json', '{broken');
  d.files.set('n-unpublished.html', '<p>Pending content</p>');
  assert.equal((await d.store.recoverOrphans(discovery(d))).status, 'deferred');
  assert.equal(d.count(), 0);
});

test('an edited deletion retains its trash copy and exposes the edit as an active recovered note', async () => {
  const d = fixture();
  await d.store.trashNote({ operationId: 'o-trash', trashId: 't-mara', noteId: 'n-mara', expectedBodyToken: '<p>Base writing</p>', baseVersionId: 'v-base', versionId: 'v-trash', createdAt: at });
  d.files.set('n-mara.html', '<p>Edited on another device</p>');
  const result = await d.store.recoverEditedDeletion({ operationId: 'o-edited-deletion', noteId: 'n-mara', trashId: 't-mara', incomingHtml: '<p>Edited on another device</p>', baseVersionId: 'v-trash', versionId: 'v-edited', createdAt: at });
  assert.equal((await d.store.readTrash('t-mara')).html, '<p>Base writing</p>');
  assert.equal((await d.store.read(result.recoveredNoteId)).html, '<p>Edited on another device</p>');
  assert.ok((await d.store.load()).index.notes.some((n) => n.id === result.recoveredNoteId));
});

for (const kind of ['body', 'orphan']) {
  test(kind + ' preservation recovers after every interrupted mutation', async () => {
    const seed = fixture();
    seed.files.set(kind === 'body' ? 'n-mara.html' : 'Lighthouse.html', kind === 'body' ? '<p>External writing</p>' : '<p>Cliff notes</p>');
    const initial = Object.fromEntries(seed.files);
    const request = kind === 'body' ? bodyConflict() : discovery(seed);
    const run = (store) => kind === 'body' ? store.preserveBodyConflict(request) : store.recoverOrphans(request);
    const baseline = fixture(initial); await run(baseline.store);
    assert.ok(baseline.count() > 0);
    for (let cut = 1; cut <= baseline.count(); cut++) {
      for (const after of [false, true]) {
        const failed = fixture(initial, cut, after);
        await assert.rejects(run(failed.store), /power loss/);
        const restarted = fixture(Object.fromEntries(failed.files));
        await restarted.store.recover(); await run(restarted.store);
        const notes = (await restarted.store.load()).index.notes;
        assert.equal(notes.length, 2);
        const bodies = await Promise.all(notes.map((n) => restarted.store.read(n.id)));
        assert.ok(bodies.some((r) => r.html === (kind === 'body' ? '<p>External writing</p>' : '<p>Cliff notes</p>')));
        if (kind === 'body') assert.ok(bodies.some((r) => r.html === '<p>Local writing</p>'));
      }
    }
  });
}

test('conflict validation rejects malformed records without mutating input', () => {
  for (const value of [null, {}, { schemaVersion: 1, id: '../unsafe' }]) {
    const before = JSON.stringify(value);
    assert.equal(validateConflict(value).status, 'invalid'); assert.equal(JSON.stringify(value), before);
  }
});

test('case-distinct labels remain distinct after merging independent additions', () => {
  const request = branches();
  request.local.labels.push({ id: 'l-lower', name: 'plot' });
  request.incoming.labels.push({ id: 'l-other', name: 'Research' });
  const result = mergeNotesIndex(request);
  assert.equal(validateIndex(result.index).status, 'ok');
  assert.deepEqual(new Set(result.index.labels.map((l) => l.name)), new Set(['Plot', 'plot', 'Research']));
});

test('incoming deletion of an unchanged note retains its tombstone', () => {
  const request = branches();
  request.incoming.notes = [];
  request.incoming.groups[0].childOrder = [];
  request.incoming.tombstones.push({ kind: 'note', id: 'n-mara', operationId: 'o-trash', trashId: 't-mara', deletedAt: at });
  const result = mergeNotesIndex(request);
  assert.equal(validateIndex(result.index).status, 'ok');
  assert.equal(result.index.notes.length, 0);
  assert.equal(result.index.tombstones[0].trashId, 't-mara');
});

test('unavailable incoming body blocks preservation without writes', async () => {
  const d = fixture(); const read = d.adapter.read;
  d.adapter.read = async (path) => path === 'n-mara.html' ? { status: 'unavailable' } : read(path);
  await assert.rejects(d.store.preserveBodyConflict(bodyConflict()), { code: 'ECLOUD' });
  assert.equal(d.count(), 0);
});

test('orphan discovery does not resurrect an unchanged deleted body', async () => {
  const d = fixture();
  await d.store.trashNote({ operationId: 'o-trash', trashId: 't-mara', noteId: 'n-mara', expectedBodyToken: '<p>Base writing</p>', baseVersionId: 'v-base', versionId: 'v-trash', createdAt: at });
  d.files.set('n-mara.html', '<p>Base writing</p>');
  assert.deepEqual((await d.store.recoverOrphans(discovery(d))).recoveredNoteIds, []);
  assert.equal((await d.store.load()).index.notes.length, 0);
  assert.equal((await d.store.readTrash('t-mara')).html, '<p>Base writing</p>');
});

test('a valid metadata conflict retains the complete branch snapshots', () => {
  const request = branches();
  const record = {
    schemaVersion: 1, id: 'c-metadata', kind: 'metadata', operationId: 'o-metadata', createdAt: at,
    variants: { base: request.base, local: request.local, incoming: request.incoming }
  };
  assert.equal(validateConflict(record).status, 'ok');
});

test('independent root ordering and sorting changes merge field by field', () => {
  const request = branches();
  request.local.root.sortMode = 'alphabetical';
  request.incoming.root.childOrder.reverse();
  const result = mergeNotesIndex(request);
  assert.equal(result.index.root.sortMode, 'alphabetical');
  assert.deepEqual(result.index.root.childOrder, ['g-places', 'g-cast']);
  assert.equal(result.conflicts.length, 0);
});

test('a changed orphan source preserves the earlier recovered note and recovers the new version', async () => {
  const d = fixture(); d.files.set('Lighthouse.html', '<p>First</p>');
  const first = await d.store.recoverOrphans(discovery(d));
  d.files.set('Lighthouse.html', '<p>Second</p>');
  const second = await d.store.recoverOrphans({ ...discovery(d), operationId: 'o-second', versionId: 'v-second' });
  assert.notEqual(first.recoveredNoteIds[0], second.recoveredNoteIds[0]);
  assert.equal((await d.store.read(first.recoveredNoteIds[0])).html, '<p>First</p>');
  assert.equal((await d.store.read(second.recoveredNoteIds[0])).html, '<p>Second</p>');
  assert.equal(d.files.get('Lighthouse.html'), '<p>Second</p>');
});

test('a user-created Recovered Notes group is not mistaken for the system group', async () => {
  const current = index(); current.groups[0].title = 'Recovered Notes';
  const d = fixture({ 'index.json': JSON.stringify(current), 'n-mara.html': '<p>Base writing</p>', 'Lighthouse.html': '<p>New</p>' });
  const result = await d.store.recoverOrphans(discovery(d));
  const loaded = (await d.store.load()).index;
  const note = loaded.notes.find((n) => n.id === result.recoveredNoteIds[0]);
  assert.notEqual(note.parentId, 'g-cast');
  assert.equal(loaded.groups.find((g) => g.id === note.parentId).systemRole, 'recovered');
});

test('metadata reconciliation requires proven ancestry, not just an existing named base', async () => {
  const request = branches(); request.local.parentVersionIds = [];
  const d = fixture(); d.files.set('index.json', JSON.stringify(request.incoming));
  await assert.rejects(d.store.reconcileMetadata({ operationId: 'o-unrelated', baseVersionId: 'v-base', localIndex: request.local, incomingIndex: request.incoming, expectedIndexToken: d.files.get('index.json'), versionId: 'v-merged', createdAt: at }), { code: 'EINVAL' });
  assert.equal(d.count(), 0);
});

test('metadata reconciliation refuses a newer index observed during publication', async () => {
  const request = branches(); request.local.notes[0].title = 'Local'; request.incoming.notes[0].title = 'Incoming';
  const d = fixture(); d.files.set('index.json', JSON.stringify(request.incoming));
  const args = { operationId: 'o-metadata', baseVersionId: 'v-base', localIndex: request.local, incomingIndex: request.incoming, expectedIndexToken: d.files.get('index.json'), versionId: 'v-merged', createdAt: at };
  const newer = { ...copy(request.incoming), versionId: 'v-newer', parentVersionIds: ['v-incoming'] };
  newer.notes[0].title = 'Newer';
  const read = d.adapter.read; let injected = false;
  d.adapter.read = async (name) => {
    if (!injected && name === 'index.json' && d.files.has('recovery/reconcile-operations/o-metadata.json')) {
      d.files.set(name, JSON.stringify(newer)); injected = true;
    }
    return read(name);
  };
  assert.equal((await d.store.reconcileMetadata(args)).status, 'conflict');
  assert.equal(JSON.parse(d.files.get('index.json')).notes[0].title, 'Newer');
  const evidence = (await d.store.listConflicts())[0];
  assert.equal(evidence.variants.local.notes[0].title, 'Local');
});

test('malformed reconciliation evidence is reported without crashing recovery or deleting it', async () => {
  const d = fixture();
  const text = JSON.stringify({ digest: 'a'.repeat(64) });
  d.files.set('recovery/reconcile-operations/o-broken.json', text);
  const result = await d.store.recover();
  assert.equal(result.find((r) => r.path.endsWith('o-broken.json')).status, 'invalid');
  assert.equal(d.files.get('recovery/reconcile-operations/o-broken.json'), text);
  assert.equal(d.count(), 0);
});

for (const kind of ['metadata', 'edit-delete']) {
  test(kind + ' reconciliation recovers after every interrupted mutation', async () => {
    const seed = fixture();
    let request;
    let run;
    if (kind === 'metadata') {
      const branchesRequest = branches();
      branchesRequest.local.notes[0].title = 'Local'; branchesRequest.incoming.notes[0].title = 'Incoming';
      seed.files.set('index.json', JSON.stringify(branchesRequest.incoming));
      request = { operationId: 'o-metadata', baseVersionId: 'v-base', localIndex: branchesRequest.local, incomingIndex: branchesRequest.incoming, expectedIndexToken: seed.files.get('index.json'), versionId: 'v-merged', createdAt: at };
      run = (store) => store.reconcileMetadata(request);
    } else {
      await seed.store.trashNote({ operationId: 'o-trash', trashId: 't-mara', noteId: 'n-mara', expectedBodyToken: '<p>Base writing</p>', baseVersionId: 'v-base', versionId: 'v-trash', createdAt: at });
      seed.files.set('n-mara.html', '<p>Edited after deletion</p>');
      request = { operationId: 'o-edit-delete', noteId: 'n-mara', trashId: 't-mara', incomingHtml: '<p>Edited after deletion</p>', baseVersionId: 'v-trash', versionId: 'v-recovered', createdAt: at };
      run = (store) => store.recoverEditedDeletion(request);
    }
    const initial = Object.fromEntries(seed.files);
    const baseline = fixture(initial); await run(baseline.store);
    assert.ok(baseline.count() > 0);
    for (let cut = 1; cut <= baseline.count(); cut++) {
      for (const after of [false, true]) {
        const failed = fixture(initial, cut, after);
        await assert.rejects(run(failed.store), /power loss/);
        const restarted = fixture(Object.fromEntries(failed.files));
        await restarted.store.recover();
        const result = await run(restarted.store);
        assert.equal(result.status, 'saved');
        assert.equal(validateIndex((await restarted.store.load()).index).status, 'ok');
        if (kind === 'metadata') assert.equal((await restarted.store.load()).index.notes[0].title, 'Local');
        else {
          assert.equal((await restarted.store.read(result.recoveredNoteId)).html, '<p>Edited after deletion</p>');
          assert.equal((await restarted.store.readTrash('t-mara')).html, '<p>Base writing</p>');
        }
      }
    }
  });
}

test('an unsaved in-memory edit survives a deletion that already removed its file', async () => {
  const d = fixture();
  await d.store.trashNote({ operationId: 'o-trash', trashId: 't-mara', noteId: 'n-mara', expectedBodyToken: '<p>Base writing</p>', baseVersionId: 'v-base', versionId: 'v-trash', createdAt: at });
  assert.equal((await d.store.read('n-mara')).status, 'missing');
  const result = await d.store.recoverEditedDeletion({ operationId: 'o-memory', noteId: 'n-mara', trashId: 't-mara', expectedBodyToken: null, incomingHtml: '<p>Not saved yet</p>', baseVersionId: 'v-trash', versionId: 'v-memory', createdAt: at });
  assert.equal(result.status, 'saved');
  assert.equal((await d.store.read(result.recoveredNoteId)).html, '<p>Not saved yet</p>');
  assert.equal((await d.store.readTrash('t-mara')).html, '<p>Base writing</p>');
  assert.equal((await d.store.read('n-mara')).status, 'missing');
});

test('all shared modules load together and preserve conflicts in a browser environment', async () => {
  const vm = require('node:vm'); const fs = require('node:fs'); const path = require('node:path');
  const { webcrypto } = require('node:crypto');
  const context = vm.createContext({ crypto: webcrypto, TextEncoder });
  for (const file of ['i18n.js', 'planet-notes.js', 'planet-notes-history.js', 'planet-notes-reconcile.js', 'planet-notes-recovery.js', 'planet-notes-store.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, { filename: file });
  const d = fixture(); d.files.set('n-mara.html', '<p>External writing</p>');
  const store = context.NeoPlanetNotesStore.createNotesStore(d.adapter);
  const result = await store.preserveBodyConflict(bodyConflict());
  assert.equal((await store.read(result.conflictNoteId)).html, '<p>External writing</p>');
  assert.equal((await store.read('n-mara')).html, '<p>Local writing</p>');
});

test('metadata edit-versus-delete keeps trash and recovers the edited title and writing', async () => {
  const d = fixture();
  const local = { ...copy(index()), versionId: 'v-local', parentVersionIds: ['v-base'] };
  local.notes[0].title = 'Edited title';
  await d.store.trashNote({ operationId: 'o-trash', trashId: 't-mara', noteId: 'n-mara', expectedBodyToken: '<p>Base writing</p>', baseVersionId: 'v-base', versionId: 'v-trash', createdAt: at });
  const incoming = (await d.store.load()).index;
  d.files.set('n-mara.html', '<p>Edited writing</p>');
  await d.store.reconcileMetadata({ operationId: 'o-merge-deletion', baseVersionId: 'v-base', localIndex: local, incomingIndex: incoming, expectedIndexToken: d.files.get('index.json'), versionId: 'v-merged', createdAt: at });
  const result = (await d.store.load()).index;
  assert.equal(result.notes.some((n) => n.id === 'n-mara'), false);
  const recovered = result.notes.find((n) => n.title === 'Edited title');
  assert.equal((await d.store.read(recovered.id)).html, '<p>Edited writing</p>');
  assert.equal((await d.store.readTrash('t-mara')).html, '<p>Base writing</p>');
});

test('an older common ancestor cannot override a later shared restore boundary', async () => {
  const d = fixture();
  await d.store.trashNote({ operationId: 'o-trash', trashId: 't-mara', noteId: 'n-mara', expectedBodyToken: '<p>Base writing</p>', baseVersionId: 'v-base', versionId: 'v-trash', createdAt: at });
  const incoming = (await d.store.load()).index;
  await d.store.restoreTrash({ operationId: 'o-restore', trashId: 't-mara', baseVersionId: 'v-trash', versionId: 'v-restored', createdAt: at });
  const local = (await d.store.load()).index;
  d.files.set('index.json', JSON.stringify(incoming));
  const count = d.count();
  await assert.rejects(d.store.reconcileMetadata({ operationId: 'o-old-base', baseVersionId: 'v-base', localIndex: local, incomingIndex: incoming, expectedIndexToken: d.files.get('index.json'), versionId: 'v-merged', createdAt: at }), { code: 'EINVAL' });
  assert.equal(d.count(), count);
  await d.store.reconcileMetadata({ operationId: 'o-correct-base', baseVersionId: 'v-trash', localIndex: local, incomingIndex: incoming, expectedIndexToken: d.files.get('index.json'), versionId: 'v-merged', createdAt: at });
  assert.equal((await d.store.load()).index.notes[0].id, 'n-mara');
  assert.equal((await d.store.read('n-mara')).html, '<p>Base writing</p>');
});

test('a hierarchy fallback does not resurrect an unrelated unchanged deletion', async () => {
  const d = fixture();
  const local = { ...copy(index()), versionId: 'v-local', parentVersionIds: ['v-base'] };
  local.groups[0].parentId = 'g-places'; local.root.childOrder = ['g-places']; local.groups[1].childOrder = ['g-cast'];
  await d.store.trashNote({ operationId: 'o-trash', trashId: 't-mara', noteId: 'n-mara', expectedBodyToken: '<p>Base writing</p>', baseVersionId: 'v-base', versionId: 'v-trash', createdAt: at });
  const incoming = (await d.store.load()).index;
  incoming.versionId = 'v-incoming'; incoming.parentVersionIds = ['v-base'];
  incoming.groups[1].parentId = 'g-cast'; incoming.root.childOrder = ['g-cast']; incoming.groups[0].childOrder = ['g-places'];
  d.files.set('index.json', JSON.stringify(incoming));
  d.files.set('n-mara.html', '<p>Base writing</p>');
  await d.store.reconcileMetadata({ operationId: 'o-hierarchy-deletion', baseVersionId: 'v-base', localIndex: local, incomingIndex: incoming, expectedIndexToken: d.files.get('index.json'), versionId: 'v-merged', createdAt: at });
  const result = (await d.store.load()).index;
  assert.equal(validateIndex(result).status, 'ok');
  assert.equal(result.notes.length, 0);
  assert.equal(result.tombstones[0].trashId, 't-mara');
  assert.ok((await d.store.listConflicts()).some((record) => record.kind === 'hierarchy'));
});

test('a history save settles a published reconciliation operation before advancing it', async () => {
  const d = fixture(); d.files.set('n-mara.html', '<p>External writing</p>');
  const write = d.adapter.writeDurable; let once = true;
  d.adapter.writeDurable = async (name, text) => {
    if (once && name === 'recovery/reconcile-receipts/o-body.json') { once = false; throw Object.assign(new Error('receipt failed'), { code: 'EIO' }); }
    return write(name, text);
  };
  await assert.rejects(d.store.preserveBodyConflict(bodyConflict()), { code: 'EIO' });
  await d.store.saveNote({ operationId: 'o-later', noteId: 'n-mara', expectedBodyToken: '<p>Local writing</p>', html: '<p>Later local writing</p>', baseVersionId: 'v-body', versionId: 'v-later', reason: 'daily', writingDay: '2026-11-10', createdAt: at });
  assert.ok(d.files.has('recovery/reconcile-receipts/o-body.json'));
  assert.ok((await d.store.recover()).every((result) => result.status === 'saved'));
  assert.equal((await d.store.read('n-mara')).html, '<p>Later local writing</p>');
  const conflict = (await d.store.listConflicts()).find((record) => record.kind === 'body');
  assert.equal((await d.store.read(conflict.recoveredNoteId)).html, '<p>External writing</p>');
});
