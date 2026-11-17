'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createNotesService } = require('../planet-notes-service');
const { createNotesStore } = require('../planet-notes-store');
function fixture() {
  const files = new Map(); const writes = []; let seq = 0;
  const adapter = { async read(p) { return files.has(p) ? { status: 'ok', text: files.get(p) } : { status: 'missing' }; }, async writeDurable(p, text) { writes.push(p); files.set(p, text); }, async list() { return [...files.keys()]; }, async remove(p) { files.delete(p); } };
  const ctx = { adapter, store: createNotesStore(adapter) };
  const options = { enabled: true, getBook: async () => ctx, makeId: (prefix) => prefix + '-id' + (++seq), now: () => '2026-11-10T12:00:00.000Z' };
  const service = createNotesService(options);
  const organize = (action, fields = {}, session = 'one') => service.organize('book-one', { operationId: 'o-action' + (++seq), action, ...fields }, session);
  const undo = (session = 'one') => service.undoOrganization('book-one', { operationId: 'o-undo' + (++seq) }, session);
  return { files, writes, adapter, ctx, options, service, organize, undo };
}

test('organization can initialize an empty collection without creating a note body', async () => {
  const d = fixture(); const result = await d.organize('createGroup', { title: 'Characters', parentId: null });
  assert.equal(result.status, 'saved'); assert.equal((await d.ctx.store.load()).index.groups[0].id, result.itemId);
  assert.equal([...d.files.keys()].filter((p) => !p.includes('/') && p.endsWith('.html')).length, 0);
  await d.undo(); assert.equal((await d.ctx.store.load()).index.groups.length, 0);
});

test('move then edit then undo preserves newer writing without rewriting HTML', async () => {
  const d = fixture(); const note = await d.service.create('book-one', { operationId: 'o-create', title: 'Mara' });
  const group = await d.organize('createGroup', { title: 'Characters', parentId: null });
  await d.organize('move', { itemId: note.noteId, parentId: group.itemId });
  const before = await d.service.read('book-one', note.noteId);
  await d.service.save('book-one', note.noteId, { operationId: 'o-writing', html: '<p>New writing after move</p>', expectedBodyToken: before.bodyToken, writingDay: '2026-11-10' });
  const bodyWrites = d.writes.filter((p) => p === note.noteId + '.html').length;
  await d.undo();
  assert.equal((await d.ctx.store.load()).index.notes[0].parentId, null);
  assert.equal((await d.ctx.store.read(note.noteId)).html, '<p>New writing after move</p>');
  assert.equal(d.writes.filter((p) => p === note.noteId + '.html').length, bodyWrites);
});

test('undo histories are isolated by window session and do not survive service restart', async () => {
  const d = fixture(); await d.organize('createLabel', { name: 'plot' });
  assert.equal((await d.service.organizationState('book-one', 'one')).canUndo, true);
  assert.equal((await d.service.organizationState('book-one', 'two')).canUndo, false);
  await assert.rejects(d.undo('two'), { code: 'EUNDO' });
  assert.equal((await createNotesService(d.options).organizationState('book-one', 'one')).canUndo, false);
  await d.undo(); assert.equal((await d.ctx.store.load()).index.labels.length, 0);
});

test('rename and merge labels preserve note bodies and undo restores exact-case assignments', async () => {
  const d = fixture(); const note = await d.service.create('book-one', { operationId: 'o-create', title: '' });
  const lower = await d.organize('createLabel', { name: 'plot' }); const upper = await d.organize('createLabel', { name: 'Plot' });
  await d.organize('assignLabel', { noteId: note.noteId, labelId: lower.itemId, assigned: true });
  await assert.rejects(d.organize('renameLabel', { labelId: lower.itemId, name: 'Plot' }), { code: 'EMERGE' });
  const body = (await d.ctx.store.read(note.noteId)).html;
  await d.organize('renameLabel', { labelId: lower.itemId, name: 'Plot', merge: true });
  assert.deepEqual((await d.ctx.store.load()).index.notes[0].labelIds, [upper.itemId]);
  await d.undo(); assert.deepEqual((await d.ctx.store.load()).index.notes[0].labelIds, [lower.itemId]);
  assert.equal((await d.ctx.store.read(note.noteId)).html, body);
});

test('lost organization acknowledgment retries one prepared action and one undo entry', async () => {
  const d = fixture(); const request = { operationId: 'o-fixed', action: 'createGroup', title: 'Characters', parentId: null };
  const first = await d.service.organize('book-one', request, 'one');
  const replay = await d.service.organize('book-one', request, 'one'); assert.equal(replay.itemId, first.itemId);
  assert.equal((await d.ctx.store.load()).index.groups.length, 1);
  await d.undo(); assert.equal((await d.service.organizationState('book-one', 'one')).canUndo, false);
  assert.equal((await d.ctx.store.load()).index.groups.length, 0);
  const restarted = createNotesService(d.options); assert.equal((await restarted.organize('book-one', request, 'new')).itemId, first.itemId);
  assert.equal((await d.ctx.store.load()).index.groups.length, 0);
});

test('a failed prepared organization action settles before a later body save', async () => {
  const d = fixture(); const note = await d.service.create('book-one', { operationId: 'o-create', title: 'Mara' });
  const original = d.adapter.writeDurable; let inject = true;
  d.adapter.writeDurable = async (path, text) => { if (inject && path === 'recovery/operations/o-interrupted.json') { inject = false; throw Object.assign(new Error('Interrupted'), { code: 'EIO' }); } return original(path, text); };
  const request = { operationId: 'o-interrupted', action: 'rename', itemId: note.noteId, title: 'New title' };
  await assert.rejects(d.service.organize('book-one', request), { code: 'EIO' });
  const restarted = createNotesService(d.options);
  const body = await restarted.read('book-one', note.noteId); assert.equal(body.title, 'New title');
  assert.equal((await restarted.save('book-one', note.noteId, { operationId: 'o-write', html: '<p>Keep writing</p>', expectedBodyToken: body.bodyToken, writingDay: '2026-11-10' })).status, 'saved');
});

test('trashing a note retains writing and organization undo restores it', async () => {
  const d = fixture(); const note = await d.service.create('book-one', { operationId: 'o-create', title: 'Mara' });
  const group = await d.organize('createGroup', { title: 'Characters', parentId: null });
  await d.organize('move', { itemId: note.noteId, parentId: group.itemId });
  await d.organize('trashNote', { noteId: note.noteId });
  assert.equal((await d.ctx.store.load()).index.notes.length, 0); assert.equal((await d.ctx.store.listTrash()).length, 1);
  await d.undo(); assert.equal((await d.ctx.store.load()).index.notes[0].parentId, group.itemId);
  assert.equal((await d.ctx.store.read(note.noteId)).html, '<p><br></p>');
});

test('disabled runtime organization never opens storage', async () => {
  let opened = false; const service = createNotesService({ enabled: false, getBook: () => { opened = true; } });
  await assert.rejects(service.organize('book-one', { operationId: 'o-one', action: 'createGroup', title: 'Characters', parentId: null }), { code: 'ENOTAVAILABLE' }); assert.equal(opened, false);
});

test('a concurrent move preserves both metadata branches without duplicating bodies', async () => {
  const d = fixture(); const note = await d.service.create('book-one', { operationId: 'o-create', title: 'Mara' });
  const a = await d.organize('createGroup', { title: 'Characters', parentId: null }); const b = await d.organize('createGroup', { title: 'Locations', parentId: null });
  const base = (await d.ctx.store.load()).index;
  await d.organize('move', { itemId: note.noteId, parentId: a.itemId });
  const domain = require('../planet-notes-organization');
  const incoming = domain.applyAction(base, { operationId: 'o-remote', action: 'move', itemId: note.noteId, parentId: b.itemId }).index;
  incoming.versionId = 'v-remote'; incoming.parentVersionIds = [base.versionId];
  d.files.set('index.json', JSON.stringify(incoming));
  const loaded = await d.service.load('book-one');
  assert.equal(loaded.index.notes[0].parentId, a.itemId);
  const conflicts = await d.ctx.store.listConflicts(); assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].variants.incoming.notes[0].parentId, b.itemId);
  assert.equal([...d.files.keys()].filter((p) => !p.includes('/') && p.endsWith('.html')).length, 1);
});

test('an incoming branch arriving after command preparation merges the intended move and remains retryable', async () => {
  const d = fixture(); const note = await d.service.create('book-one', { operationId: 'o-create', title: 'Mara' });
  const a = await d.organize('createGroup', { title: 'Characters', parentId: null }); const b = await d.organize('createGroup', { title: 'Locations', parentId: null });
  const base = (await d.ctx.store.load()).index;
  const domain = require('../planet-notes-organization');
  const incoming = domain.applyAction(base, { operationId: 'o-remote', action: 'move', itemId: note.noteId, parentId: b.itemId }).index;
  incoming.versionId = 'v-incoming'; incoming.parentVersionIds = [base.versionId];
  const original = d.adapter.writeDurable; let inject = true;
  d.adapter.writeDurable = async (path, text) => { await original(path, text); if (inject && path === 'recovery/organization-commands/o-race.json') { inject = false; d.files.set('index.json', JSON.stringify(incoming)); } };
  const request = { operationId: 'o-race', action: 'move', itemId: note.noteId, parentId: a.itemId };
  assert.equal((await d.service.organize('book-one', request)).status, 'saved');
  assert.equal((await d.ctx.store.load()).index.notes[0].parentId, a.itemId);
  assert.equal((await d.ctx.store.listConflicts())[0].variants.incoming.notes[0].parentId, b.itemId);
  assert.equal((await d.service.organize('book-one', request)).status, 'saved');
  const body = await d.service.read('book-one', note.noteId);
  assert.equal((await d.service.save('book-one', note.noteId, { operationId: 'o-after-race', html: '<p>Continue writing</p>', expectedBodyToken: body.bodyToken, writingDay: '2026-11-10' })).status, 'saved');
  const recovered = await d.ctx.store.recover(); assert.ok(recovered.every((r) => r.status === 'saved'));
});

test('merged metadata receipts require proven ancestry and cannot acknowledge creating writing', async () => {
  const d = fixture(); await d.organize('createGroup', { title: 'Characters', parentId: null });
  const base = (await d.ctx.store.load()).index;
  const unrelated = JSON.parse(JSON.stringify(base)); unrelated.versionId = 'v-unrelated'; unrelated.parentVersionIds = [base.versionId];
  assert.equal((await d.ctx.store.acknowledgeMergedMetadata({ operationId: 'o-no-proof', baseVersionId: base.versionId, nextIndex: unrelated, bodies: [] })).status, 'conflict');
  assert.equal(d.files.has('recovery/receipts/o-no-proof.json'), false);
  await d.service.create('book-one', { operationId: 'o-create', title: 'Mara' });
  const withWriting = (await d.ctx.store.load()).index;
  await assert.rejects(d.ctx.store.acknowledgeMergedMetadata({ operationId: 'o-no-body-proof', baseVersionId: base.versionId, nextIndex: withWriting, bodies: [] }), { code: 'EINVAL' });
  assert.equal(d.files.has('recovery/receipts/o-no-body-proof.json'), false);
});

for (const injectionPoint of ['organization', 'history']) {
  test('a rejected trash preserves competing words and cannot block later writing: ' + injectionPoint, async () => {
    const d = fixture(); const note = await d.service.create('book-one', { operationId: 'o-create', title: 'Mara' });
    const base = (await d.ctx.store.load()).index;
    const incoming = JSON.parse(JSON.stringify(base)); incoming.versionId = 'v-remote'; incoming.parentVersionIds = [base.versionId]; incoming.notes[0].title = 'Remote title';
    const original = d.adapter.writeDurable; let inject = true;
    const suffix = injectionPoint === 'organization' ? 'organization-commands' : 'history-operations';
    d.adapter.writeDurable = async (path, text) => { await original(path, text); if (inject && path === 'recovery/' + suffix + '/o-trash-race.json') { inject = false; d.files.set('index.json', JSON.stringify(incoming)); d.files.set(note.noteId + '.html', '<p>New incoming words</p>'); } };
    const result = await d.service.organize('book-one', { operationId: 'o-trash-race', action: 'trashNote', noteId: note.noteId });
    assert.equal(result.status, 'conflict'); assert.equal((await d.ctx.store.read(note.noteId)).html, '<p>New incoming words</p>');
    const read = await d.service.read('book-one', note.noteId);
    assert.equal((await d.service.save('book-one', note.noteId, { operationId: 'o-after-trash-race', html: '<p>Continue after conflict</p>', expectedBodyToken: read.bodyToken, writingDay: '2026-11-10' })).status, 'saved');
    const recovery = await d.ctx.store.recover(); assert.ok(recovery.every((r) => ['saved', 'conflict-preserved'].includes(r.status)));
    const refresh = await d.service.refresh('book-one', note.noteId, { baseBodyToken: '<p>Continue after conflict</p>', localHtml: '<p>Continue after conflict</p>' }); assert.equal(refresh.status, 'ok');
    assert.ok(d.files.has('recovery/abandoned-history/o-trash-race.json'));
  });
}

test('independently initialized metadata heads retain evidence without blocking later commands', async () => {
  const d = fixture();
  const incoming = { schemaVersion: 1, versionId: 'v-other-root', parentVersionIds: [], root: { sortMode: 'alphabetical', childOrder: [] }, groups: [], notes: [], labels: [{ id: 'l-remote', name: 'remote' }], tombstones: [] };
  const original = d.adapter.writeDurable; let inject = true;
  d.adapter.writeDurable = async (path, text) => { await original(path, text); if (inject && path === 'recovery/organization-commands/o-first.json') { inject = false; d.files.set('index.json', JSON.stringify(incoming)); } };
  assert.equal((await d.service.organize('book-one', { operationId: 'o-first', action: 'createGroup', title: 'Characters', parentId: null })).status, 'conflict');
  assert.equal((await d.service.create('book-one', { operationId: 'o-after-head-race', title: 'Writing stays available' })).status, 'saved');
  assert.ok(d.files.has('recovery/abandoned-metadata/o-first.json'));
  assert.ok((await d.ctx.store.recover()).every((r) => ['saved', 'conflict-preserved'].includes(r.status)));
});

test('an interrupted conflict-completion marker cannot strand subsequent writing', async () => {
  const d = fixture(); const note = await d.service.create('book-one', { operationId: 'o-create', title: 'Mara' });
  const base = (await d.ctx.store.load()).index; const incoming = JSON.parse(JSON.stringify(base)); incoming.versionId = 'v-incoming'; incoming.parentVersionIds = [base.versionId];
  const write = d.adapter.writeDurable; let inject = true; let failCompletion = true;
  d.adapter.writeDurable = async (path, text) => {
    if (failCompletion && path === 'recovery/organization-completions/o-interrupted-conflict.json') { failCompletion = false; throw Object.assign(new Error('Completion interrupted'), { code: 'EIO' }); }
    await write(path, text);
    if (inject && path === 'recovery/organization-commands/o-interrupted-conflict.json') { inject = false; d.files.set('index.json', JSON.stringify(incoming)); }
  };
  await assert.rejects(d.service.organize('book-one', { operationId: 'o-interrupted-conflict', action: 'trashNote', noteId: note.noteId }), { code: 'EIO' });
  const body = await d.service.read('book-one', note.noteId);
  assert.equal((await d.service.save('book-one', note.noteId, { operationId: 'o-continue', html: '<p>Not stranded</p>', expectedBodyToken: body.bodyToken, writingDay: '2026-11-10' })).status, 'saved');
});

for (const raceAt of ['resolution', 'intent']) {
  test('successive incoming branches cannot strand a prepared move: ' + raceAt, async () => {
    const d = fixture(); const note = await d.service.create('book-one', { operationId: 'o-create', title: 'Mara' });
    const a = await d.organize('createGroup', { title: 'Characters', parentId: null });
    const b = await d.organize('createGroup', { title: 'Locations', parentId: null });
    const base = (await d.ctx.store.load()).index;
    const domain = require('../planet-notes-organization');
    const remote = domain.applyAction(base, { operationId: 'o-remote', action: 'move', itemId: note.noteId, parentId: b.itemId }).index;
    remote.versionId = 'v-first-incoming'; remote.parentVersionIds = [base.versionId];
    const later = JSON.parse(JSON.stringify(remote)); later.versionId = 'v-later-incoming'; later.notes[0].title = 'Later title';
    const write = d.adapter.writeDurable; let injected = false; let firstAttempt;
    d.adapter.writeDurable = async (path, text) => {
      await write(path, text);
      if (path === 'recovery/organization-commands/o-repeated.json') d.files.set('index.json', JSON.stringify(remote));
      if (path === 'recovery/organization-resolutions/o-repeated.json') firstAttempt = text;
      if (!injected && ((raceAt === 'resolution' && path === 'recovery/organization-resolutions/o-repeated.json') || (raceAt === 'intent' && path.startsWith('recovery/reconcile-operations/')))) {
        injected = true; d.files.set('index.json', JSON.stringify(later));
      }
    };
    const request = { operationId: 'o-repeated', action: 'move', itemId: note.noteId, parentId: a.itemId };
    try { await d.service.organize('book-one', request); } catch (err) { assert.equal(err.code, 'EPENDING'); }
    d.adapter.writeDurable = write;
    const restarted = createNotesService(d.options);
    const read = await restarted.read('book-one', note.noteId);
    assert.equal(read.title, 'Later title');
    assert.equal((await d.ctx.store.load()).index.notes[0].parentId, a.itemId);
    assert.equal(d.files.get('recovery/organization-resolutions/o-repeated.json'), firstAttempt);
    assert.equal((await restarted.organize('book-one', request)).status, 'saved');
    assert.equal((await restarted.save('book-one', note.noteId, { operationId: 'o-write-after-repeated', html: '<p>Writing continues</p>', expectedBodyToken: read.bodyToken, writingDay: '2026-11-11' })).status, 'saved');
    assert.ok((await d.ctx.store.recover()).every((r) => ['saved', 'conflict-preserved'].includes(r.status)));
  });
}

for (const raceAt of ['organization', 'intent']) {
  test('a competing title arriving during undo is preserved and rejected: ' + raceAt, async () => {
    const d = fixture(); const note = await d.service.create('book-one', { operationId: 'o-create', title: 'Original' });
    await d.organize('rename', { itemId: note.noteId, title: 'Local' });
    const beforeUndo = (await d.ctx.store.load()).index;
    const remote = JSON.parse(JSON.stringify(beforeUndo)); remote.versionId = 'v-newer-title'; remote.parentVersionIds = [beforeUndo.versionId]; remote.notes[0].title = 'Newer remote';
    const write = d.adapter.writeDurable; let injected = false;
    const pathToRace = raceAt === 'organization' ? 'recovery/organization-commands/o-undo-race.json' : 'recovery/operations/o-undo-race.json';
    d.adapter.writeDurable = async (path, text) => { await write(path, text); if (!injected && path === pathToRace) { injected = true; d.files.set('index.json', JSON.stringify(remote)); } };
    const request = { operationId: 'o-undo-race' };
    assert.equal((await d.service.undoOrganization('book-one', request, 'one')).status, 'conflict');
    assert.equal((await d.ctx.store.load()).index.notes[0].title, 'Newer remote');
    assert.equal((await d.service.organizationState('book-one', 'one')).canUndo, true);
    d.adapter.writeDurable = write;
    const restarted = createNotesService(d.options);
    assert.equal((await restarted.undoOrganization('book-one', request, 'one')).status, 'conflict');
    const read = await restarted.read('book-one', note.noteId); assert.equal(read.title, 'Newer remote');
    assert.equal((await restarted.save('book-one', note.noteId, { operationId: 'o-writing-after-undo-race', html: '<p>Still editable</p>', expectedBodyToken: read.bodyToken, writingDay: '2026-11-11' })).status, 'saved');
    assert.ok((await d.ctx.store.recover()).every((r) => ['saved', 'conflict-preserved'].includes(r.status)));
  });
}

test('undo rebases safely over unrelated new notes and keeps their writing', async () => {
  const d = fixture(); const group = await d.organize('createGroup', { title: 'Characters', parentId: null });
  const source = (await d.ctx.store.load()).index;
  const incoming = JSON.parse(JSON.stringify(source)); incoming.versionId = 'v-extra-note'; incoming.parentVersionIds = [source.versionId];
  incoming.notes.push({ id: 'n-incoming', title: 'New writing', parentId: group.itemId, labelIds: [], createdAt: '2026-11-11T10:00:00.000Z' });
  incoming.groups[0].childOrder.push('n-incoming');
  const write = d.adapter.writeDurable; let injected = false;
  d.adapter.writeDurable = async (path, text) => { await write(path, text); if (!injected && path === 'recovery/organization-commands/o-undo-with-new-note.json') { injected = true; d.files.set('n-incoming.html', '<p>Keep the incoming words</p>'); d.files.set('index.json', JSON.stringify(incoming)); } };
  assert.equal((await d.service.undoOrganization('book-one', { operationId: 'o-undo-with-new-note' }, 'one')).status, 'saved');
  const current = (await d.ctx.store.load()).index;
  assert.equal(current.groups.length, 0); assert.equal(current.notes[0].parentId, null);
  assert.equal((await d.ctx.store.read('n-incoming')).html, '<p>Keep the incoming words</p>');
  assert.equal((await d.service.organizationState('book-one', 'one')).canUndo, false);
  assert.ok((await d.ctx.store.recover()).every((r) => ['saved', 'conflict-preserved'].includes(r.status)));
});

test('a later conflicting edit during a rebased undo is rejected on the next retry', async () => {
  const d = fixture(); const note = await d.service.create('book-one', { operationId: 'o-create', title: 'Original' });
  await d.organize('rename', { itemId: note.noteId, title: 'Local' });
  const base = (await d.ctx.store.load()).index;
  const first = JSON.parse(JSON.stringify(base)); first.versionId = 'v-unrelated'; first.parentVersionIds = [base.versionId]; first.labels.push({ id: 'l-unrelated', name: 'Research' });
  const next = JSON.parse(JSON.stringify(first)); next.versionId = 'v-touched'; next.parentVersionIds = [base.versionId]; next.notes[0].title = 'Newer remote';
  const write = d.adapter.writeDurable;
  d.adapter.writeDurable = async (path, text) => {
    await write(path, text);
    if (path === 'recovery/organization-commands/o-rebased-undo.json') d.files.set('index.json', JSON.stringify(first));
    if (path === 'recovery/organization-resolutions/o-rebased-undo.json') d.files.set('index.json', JSON.stringify(next));
  };
  await assert.rejects(d.service.undoOrganization('book-one', { operationId: 'o-rebased-undo' }, 'one'), { code: 'EPENDING' });
  d.adapter.writeDurable = write;
  assert.equal((await d.service.read('book-one', note.noteId)).title, 'Newer remote');
  assert.equal((await d.service.organizationState('book-one', 'one')).canUndo, true);
  assert.equal((await d.service.undoOrganization('book-one', { operationId: 'o-rebased-undo' }, 'one')).status, 'conflict');
  assert.ok((await d.ctx.store.recover()).every((r) => ['saved', 'conflict-preserved'].includes(r.status)));
});

test('a prepared undo attempt survives restart and preserves an exact observed token', async () => {
  const d = fixture(); const note = await d.service.create('book-one', { operationId: 'o-create', title: 'Original' });
  await d.organize('rename', { itemId: note.noteId, title: 'Local' });
  const base = (await d.ctx.store.load()).index;
  const remote = JSON.parse(JSON.stringify(base)); remote.versionId = 'v-other-metadata'; remote.parentVersionIds = [base.versionId]; remote.labels.push({ id: 'l-new', name: 'Research' });
  const write = d.adapter.writeDurable; let interrupted = false; let prepared;
  d.adapter.writeDurable = async (path, text) => {
    await write(path, text);
    if (path === 'recovery/organization-commands/o-undo-restart.json') d.files.set('index.json', JSON.stringify(remote, null, 2));
    if (!interrupted && path === 'recovery/organization-resolutions/o-undo-restart.json') {
      interrupted = true; prepared = text; throw Object.assign(new Error('Interrupted after preparation'), { code: 'EIO' });
    }
  };
  const request = { operationId: 'o-undo-restart' };
  await assert.rejects(d.service.undoOrganization('book-one', request, 'one'), { code: 'EIO' });
  d.adapter.writeDurable = write;
  const restarted = createNotesService(d.options);
  assert.equal((await restarted.undoOrganization('book-one', request, 'one')).status, 'saved');
  assert.equal(d.files.get('recovery/organization-resolutions/o-undo-restart.json'), prepared);
  assert.equal((await d.ctx.store.load()).index.notes[0].title, 'Original');
  assert.equal((await d.ctx.store.load()).index.labels[0].name, 'Research');
  assert.equal([...d.files.keys()].filter((p) => p.startsWith('recovery/organization-resolutions/o-undo-restart/')).length, 0);
});

test('legacy frozen resolutions remain evidence while a fresh attempt handles a later head', async () => {
  const d = fixture(); const note = await d.service.create('book-one', { operationId: 'o-create', title: 'Original' });
  const a = await d.organize('createGroup', { title: 'A', parentId: null }); const b = await d.organize('createGroup', { title: 'B', parentId: null });
  const base = (await d.ctx.store.load()).index;
  const domain = require('../planet-notes-organization'); const { createHash } = require('node:crypto');
  const first = domain.applyAction(base, { operationId: 'o-remote', action: 'move', itemId: note.noteId, parentId: b.itemId }).index;
  first.versionId = 'v-legacy-incoming'; first.parentVersionIds = [base.versionId];
  const later = JSON.parse(JSON.stringify(first)); later.versionId = 'v-new-incoming'; later.notes[0].title = 'Later title';
  const write = d.adapter.writeDurable; let legacy;
  d.adapter.writeDurable = async (path, text) => {
    await write(path, text);
    if (path === 'recovery/organization-commands/o-legacy-race.json') {
      const plan = JSON.parse(text).plan;
      const resolution = { operationId: 'o-legacy-merge', versionId: 'v-legacy-merge', createdAt: '2026-11-10T12:00:00.000Z', baseVersionId: base.versionId, localIndex: plan.after, incomingIndex: first, expectedIndexToken: JSON.stringify(first) };
      legacy = JSON.stringify({ resolution, digest: createHash('sha256').update(JSON.stringify(resolution)).digest('hex') });
      d.files.set('recovery/organization-resolutions/o-legacy-race.json', legacy); d.files.set('index.json', JSON.stringify(later));
    }
  };
  assert.equal((await d.service.organize('book-one', { operationId: 'o-legacy-race', action: 'move', itemId: note.noteId, parentId: a.itemId })).status, 'saved');
  assert.equal(d.files.get('recovery/organization-resolutions/o-legacy-race.json'), legacy);
  assert.equal((await d.ctx.store.load()).index.notes[0].parentId, a.itemId);
  assert.equal((await d.ctx.store.load()).index.notes[0].title, 'Later title');
  assert.ok(d.files.has('recovery/abandoned-reconciliations/o-legacy-merge.json'));
});

test('returning to an earlier incoming head creates a fresh attempt instead of reusing its retired one', async () => {
  const d = fixture(); const note = await d.service.create('book-one', { operationId: 'o-create', title: 'Original' });
  const base = (await d.ctx.store.load()).index;
  const first = JSON.parse(JSON.stringify(base)); first.versionId = 'v-first'; first.parentVersionIds = [base.versionId]; first.notes[0].title = 'First remote';
  const second = JSON.parse(JSON.stringify(first)); second.versionId = 'v-second'; second.notes[0].title = 'Second remote';
  const write = d.adapter.writeDurable; let returned = false;
  d.adapter.writeDurable = async (path, text) => {
    await write(path, text);
    if (path === 'recovery/organization-commands/o-returning-head.json') d.files.set('index.json', JSON.stringify(first));
    if (path === 'recovery/organization-resolutions/o-returning-head.json') d.files.set('index.json', JSON.stringify(second));
    if (!returned && path.startsWith('recovery/organization-resolutions/o-returning-head/')) { returned = true; d.files.set('index.json', JSON.stringify(first)); }
  };
  const request = { operationId: 'o-returning-head', action: 'rename', itemId: note.noteId, title: 'Local choice' };
  await assert.rejects(d.service.organize('book-one', request), { code: 'EPENDING' });
  await assert.rejects(d.service.read('book-one', note.noteId), { code: 'EPENDING' });
  d.adapter.writeDurable = write;
  assert.equal((await d.service.read('book-one', note.noteId)).title, 'Local choice');
  assert.equal((await d.service.organize('book-one', request)).status, 'saved');
  assert.equal([...d.files.keys()].filter((p) => p.startsWith('recovery/organization-resolutions/o-returning-head/')).length, 2);
  assert.ok((await d.ctx.store.recover()).every((r) => ['saved', 'conflict-preserved'].includes(r.status)));
});

test('undo revalidation refuses a validly encoded source journal with a different identity', async () => {
  const d = fixture(); const note = await d.service.create('book-one', { operationId: 'o-create', title: 'Original' });
  await d.service.organize('book-one', { operationId: 'o-source', action: 'rename', itemId: note.noteId, title: 'Local' }, 'one');
  const base = (await d.ctx.store.load()).index;
  const remote = JSON.parse(JSON.stringify(base)); remote.versionId = 'v-source-race'; remote.parentVersionIds = [base.versionId]; remote.notes[0].title = 'Remote';
  const write = d.adapter.writeDurable; const { createHash } = require('node:crypto'); let evidence;
  d.adapter.writeDurable = async (path, text) => {
    await write(path, text);
    if (path === 'recovery/organization-commands/o-check-source.json') {
      const source = JSON.parse(d.files.get('recovery/organization-commands/o-source.json')).plan;
      source.request.operationId = 'o-different-source';
      evidence = JSON.stringify({ plan: source, digest: createHash('sha256').update(JSON.stringify(source)).digest('hex') });
      d.files.set('recovery/organization-commands/o-source.json', evidence);
      d.files.set('index.json', JSON.stringify(remote));
    }
  };
  await assert.rejects(d.service.undoOrganization('book-one', { operationId: 'o-check-source' }, 'one'), { code: 'EINVAL' });
  assert.equal((await d.ctx.store.load()).index.notes[0].title, 'Remote');
  assert.equal(d.files.get('recovery/organization-commands/o-source.json'), evidence);
});
