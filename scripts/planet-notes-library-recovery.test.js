'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict');
const { createNotesService } = require('../planet-notes-service'); const { createNotesStore } = require('../planet-notes-store');
function fixture() {
  const files = new Map(); let sequence = 0;
  const adapter = { async read(path) { return files.has(path) ? { status: 'ok', text: files.get(path) } : { status: 'missing' }; }, async writeDurable(path, text) { files.set(path, text); }, async remove(path) { files.delete(path); }, async list() { return [...files.keys()]; } };
  const context = { adapter, store: createNotesStore(adapter) };
  const options = { enabled: true, getBook: async () => context, makeId: (prefix) => prefix + '-id' + (++sequence), now: () => '2026-11-11T10:00:00.000Z' };
  const service = createNotesService(options);
  return { files, adapter, context, service, options };
}
async function written(d) {
  const note = await d.service.create('book-one', { operationId: 'o-create', title: 'Mara' });
  const body = await d.service.read('book-one', note.noteId);
  await d.service.save('book-one', note.noteId, { operationId: 'o-write', html: '<p>New writing</p>', expectedBodyToken: body.bodyToken, writingDay: '2026-11-11' });
  return note;
}
test('revision previews are read-only and replacement preserves current body and organization', async () => {
  const d = fixture(); const note = await written(d);
  const group = await d.service.organize('book-one', { operationId: 'o-group', action: 'createGroup', title: 'Characters', parentId: null });
  await d.service.organize('book-one', { operationId: 'o-move', action: 'move', itemId: note.noteId, parentId: group.itemId });
  const list = await d.service.recoveryList('book-one', { kind: 'revisions', noteId: note.noteId }); assert.equal(list.entries.length, 1);
  const before = d.files.get(note.noteId + '.html');
  const preview = await d.service.recoveryRead('book-one', list.entries[0].ref); assert.equal(preview.html, '<p><br></p>'); assert.equal(d.files.get(note.noteId + '.html'), before);
  assert.equal((await d.service.recover('book-one', { operationId: 'o-restore', kind: 'revision', noteId: note.noteId, id: list.entries[0].ref.id, mode: 'replace' })).status, 'saved');
  const current = (await d.context.store.load()).index.notes[0]; assert.equal(current.parentId, group.itemId); assert.equal(current.title, 'Mara');
  const revisions = await d.context.store.listRevisions(note.noteId); assert.equal(revisions.length, 2);
  assert.equal((await d.context.store.readRevision(note.noteId, revisions[1].id)).html, before);
});
test('restore-as-new has stable identity after restart and leaves the source body unchanged', async () => {
  const d = fixture(); const note = await written(d); const list = await d.service.recoveryList('book-one', { kind: 'revisions', noteId: note.noteId });
  const request = { operationId: 'o-copy-revision', kind: 'revision', noteId: note.noteId, id: list.entries[0].ref.id, mode: 'new' };
  const result = await d.service.recover('book-one', request); assert.notEqual(result.noteId, note.noteId);
  const restarted = createNotesService(d.options); assert.equal((await restarted.recover('book-one', request)).noteId, result.noteId);
  assert.equal((await d.context.store.load()).index.notes.length, 2); assert.equal(d.files.get(note.noteId + '.html'), '<p>New writing</p>');
});
test('trash preview and restoration preserve labels and original group fallback', async () => {
  const d = fixture(); const note = await written(d);
  await d.service.organize('book-one', { operationId: 'o-trash', action: 'trashNote', noteId: note.noteId });
  const list = await d.service.recoveryList('book-one', { kind: 'trash' }); assert.equal(list.entries.length, 1);
  assert.equal((await d.service.recoveryRead('book-one', list.entries[0].ref)).html, '<p>New writing</p>');
  await d.service.recover('book-one', { operationId: 'o-restore-trash', ...list.entries[0].ref });
  assert.equal((await d.service.recoveryList('book-one', { kind: 'trash' })).entries.length, 0);
  assert.equal(d.files.get(note.noteId + '.html'), '<p>New writing</p>');
});
test('unavailable recovery files keep partial lists visible', async () => {
  const d = fixture(); const note = await written(d); const list = await d.service.recoveryList('book-one', { kind: 'revisions', noteId: note.noteId });
  const read = d.adapter.read;
  d.adapter.read = async (path) => path === 'revisions/' + note.noteId + '/' + list.entries[0].ref.id + '.html' ? { status: 'unavailable' } : read(path);
  const partial = await d.service.recoveryList('book-one', { kind: 'revisions', noteId: note.noteId });
  assert.equal(partial.complete, false); assert.equal(partial.entries[0].status, 'unavailable');
});

test('selected competing moves apply only recorded values without changing writing', async () => {
  const d = fixture(); const note = await written(d);
  const a = await d.service.organize('book-one', { operationId: 'o-a', action: 'createGroup', title: 'People', parentId: null });
  const b = await d.service.organize('book-one', { operationId: 'o-b', action: 'createGroup', title: 'Places', parentId: null });
  const base = (await d.context.store.load()).index;
  await d.service.organize('book-one', { operationId: 'o-move', action: 'move', itemId: note.noteId, parentId: a.itemId });
  const { applyAction } = require('../planet-notes-organization');
  const incoming = applyAction(base, { operationId: 'o-remote', action: 'move', itemId: note.noteId, parentId: b.itemId }).index;
  incoming.versionId = 'v-incoming'; incoming.parentVersionIds = [base.versionId]; d.files.set('index.json', JSON.stringify(incoming));
  await d.service.load('book-one');
  const conflicts = await d.service.recoveryList('book-one', { kind: 'conflicts' }); const conflict = conflicts.entries.find((e) => e.record?.kind === 'metadata'); assert.ok(conflict);
  const preview = await d.service.recoveryRead('book-one', conflict.ref);
  assert.equal((await d.service.recover('book-one', { operationId: 'o-apply-choice', ...conflict.ref, expectedVersionId: preview.versionId, selections: [{ collection: 'notes', id: note.noteId, field: 'parentId', side: 'incoming' }] })).status, 'saved');
  assert.equal((await d.context.store.load()).index.notes[0].parentId, b.itemId); assert.equal(d.files.get(note.noteId + '.html'), '<p>New writing</p>');
  assert.equal((await d.context.store.readConflict(conflict.ref.id)).status, 'ok');
});

test('a recovery interrupted before its history intent settles before later writing', async () => {
  const d = fixture(); const note = await written(d); const list = await d.service.recoveryList('book-one', { kind: 'revisions', noteId: note.noteId });
  const write = d.adapter.writeDurable; let inject = true;
  d.adapter.writeDurable = async (path, text) => { if (inject && path === 'recovery/history-operations/o-interrupted-restore.json') { inject = false; throw Object.assign(new Error('Interrupted'), { code: 'EIO' }); } return write(path, text); };
  const request = { operationId: 'o-interrupted-restore', kind: 'revision', noteId: note.noteId, id: list.entries[0].ref.id, mode: 'replace' };
  await assert.rejects(d.service.recover('book-one', request), { code: 'EIO' });
  const restarted = createNotesService(d.options); const read = await restarted.read('book-one', note.noteId); assert.equal(read.html, '<p><br></p>');
  assert.equal((await restarted.recover('book-one', request)).status, 'saved');
  assert.equal((await restarted.save('book-one', note.noteId, { operationId: 'o-after-restore', html: '<p>Continue</p>', expectedBodyToken: read.bodyToken, writingDay: '2026-11-11' })).status, 'saved');
});

test('cloud-only recovery completion preserves ECLOUD and the same operation can retry', async () => {
  const d = fixture(); const note = await written(d);
  const list = await d.service.recoveryList('book-one', { kind: 'revisions', noteId: note.noteId });
  const request = { operationId: 'o-cloud-completion', ...list.entries[0].ref, mode: 'new' };
  const result = await d.service.recover('book-one', request);
  const before = new Map(d.files); const read = d.adapter.read;
  d.adapter.read = async (path) => path === 'recovery/view-completions/o-cloud-completion.json' ? { status: 'unavailable' } : read(path);
  await assert.rejects(d.service.recover('book-one', request), { code: 'ECLOUD' });
  assert.deepEqual(d.files, before);
  d.adapter.read = read;
  assert.equal((await d.service.recover('book-one', request)).noteId, result.noteId);
  assert.equal((await d.context.store.load()).index.notes.length, 2);
});
