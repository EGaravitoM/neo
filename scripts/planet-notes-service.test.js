'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createNotesStore } = require('../planet-notes-store');
const { createNotesService } = require('../planet-notes-service');
const at = '2026-11-10T10:00:00.000Z';
function fixture(enabled = true) {
  const books = new Map(); let opens = 0; let next = 0;
  const getBook = async (bookId) => {
    opens++;
    if (!books.has(bookId)) {
      const files = new Map();
      const adapter = {
        async read(path) { return files.has(path) ? { status: 'ok', text: files.get(path) } : { status: 'missing' }; },
        async writeDurable(path, text) { files.set(path, text); },
        async remove(path) { files.delete(path); },
        async list() { return [...files.keys()]; }
      };
      books.set(bookId, { files, adapter, store: createNotesStore(adapter) });
    }
    return books.get(bookId);
  };
  const options = { enabled, getBook, makeId: (prefix) => prefix + '-generated' + (++next), now: () => at };
  return { books, opens: () => opens, options, service: createNotesService(options) };
}
const create = (operationId = 'o-create') => ({ operationId, title: 'Mara' });

test('normal launches leave the feature disabled without opening any book storage', async () => {
  const d = fixture(false);
  assert.equal((await d.service.capabilities()).enabled, false);
  assert.equal((await d.service.load('book-one')).status, 'disabled');
  await assert.rejects(d.service.create('book-one', create()), { code: 'ENOTAVAILABLE' });
  assert.equal(d.opens(), 0);
});

test('a new custom note is created at root and can be read through the domain interface', async () => {
  const d = fixture();
  const created = await d.service.create('book-one', create());
  assert.equal(created.status, 'saved');
  const loaded = await d.service.load('book-one');
  const note = loaded.index.notes.find((n) => n.id === created.noteId);
  assert.equal(note.title, 'Mara'); assert.equal(note.parentId, null);
  assert.equal((await d.service.read('book-one', created.noteId)).status, 'ok');
});

test('concurrent reads use the same book context rather than constructing independent stores', async () => {
  const d = fixture();
  await Promise.all([d.service.load('book-one'), d.service.load('book-one')]);
  assert.equal(d.opens(), 1);
});

test('a creation retry after service restart returns the same note without duplication', async () => {
  const d = fixture();
  const first = await d.service.create('book-one', create());
  const restarted = createNotesService({ ...d.options, now: () => '2026-11-11T10:00:00.000Z' });
  const retried = await restarted.create('book-one', create());
  assert.equal(retried.noteId, first.noteId);
  assert.equal((await restarted.load('book-one')).index.notes.length, 1);
});

test('an operation ID cannot be retried with a different creation title', async () => {
  const d = fixture();
  await d.service.create('book-one', create());
  await assert.rejects(d.service.create('book-one', { ...create(), title: 'Different' }), { code: 'EINVAL' });
});

test('rename preserves body and note identity and permits a blank stored title', async () => {
  const d = fixture(); const created = await d.service.create('book-one', create());
  const before = await d.service.read('book-one', created.noteId);
  await d.service.rename('book-one', created.noteId, { operationId: 'o-rename', title: '' });
  const loaded = await d.service.load('book-one');
  assert.equal(loaded.index.notes[0].id, created.noteId); assert.equal(loaded.index.notes[0].title, '');
  assert.equal((await d.service.read('book-one', created.noteId)).html, before.html);
});

test('a save retry after a lost acknowledgment does not create another revision', async () => {
  const d = fixture(); const created = await d.service.create('book-one', create());
  const before = await d.service.read('book-one', created.noteId);
  const request = { operationId: 'o-save', html: '<p>Writing</p>', expectedBodyToken: before.bodyToken, writingDay: '2026-11-09' };
  await d.service.save('book-one', created.noteId, request);
  const restarted = createNotesService(d.options);
  await restarted.save('book-one', created.noteId, request);
  assert.equal((await restarted.read('book-one', created.noteId)).html, '<p>Writing</p>');
  const revisions = await d.books.get('book-one').store.listRevisions(created.noteId);
  assert.equal(revisions.length, 1); assert.equal(revisions[0].writingDay, '2026-11-09');
});

test('a changed disk body is reported as a conflict without overwriting external writing', async () => {
  const d = fixture(); const created = await d.service.create('book-one', create());
  const before = await d.service.read('book-one', created.noteId);
  d.books.get('book-one').files.set(created.noteId + '.html', '<p>External</p>');
  const result = await d.service.save('book-one', created.noteId, { operationId: 'o-save', html: '<p>Local</p>', expectedBodyToken: before.bodyToken, writingDay: '2026-11-10' });
  assert.equal(result.status, 'conflict');
  assert.equal((await d.service.read('book-one', created.noteId)).html, '<p>External</p>');
});

for (const bookId of ['../escape', '/absolute', 'book-one/elsewhere']) {
  test('unsafe book identity is rejected before opening storage: ' + bookId, async () => {
    const d = fixture();
    await assert.rejects(d.service.load(bookId), { code: 'EINVAL' });
    assert.equal(d.opens(), 0);
  });
}

test('unsafe note identity and unexpected raw index/path inputs are rejected', async () => {
  const d = fixture();
  await assert.rejects(d.service.read('book-one', '../outside'), { code: 'EINVAL' });
  await assert.rejects(d.service.create('book-one', { ...create(), path: '../../outside', nextIndex: {} }), { code: 'EINVAL' });
  assert.equal(d.opens(), 0);
});

test('a failure while preserving a prepared command does not create the note', async () => {
  const d = fixture();
  await d.service.load('book-one');
  const context = d.books.get('book-one');
  context.adapter.writeDurable = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  await assert.rejects(d.service.create('book-one', create()), { code: 'ENOSPC' });
  assert.equal((await context.store.load()).status, 'missing');
});

test('a copied book folder may have a safe human-readable name', async () => {
  const d = fixture();
  const created = await d.service.create('book-one copy', create());
  assert.equal((await d.service.read('book-one copy', created.noteId)).status, 'ok');
});

test('failed book-context loads can be retried instead of poisoning the cache', async () => {
  const d = fixture(); let first = true;
  const service = createNotesService({ ...d.options, getBook: async (bookId) => {
    if (first) { first = false; throw Object.assign(new Error('unavailable'), { code: 'ECLOUD' }); }
    return d.options.getBook(bookId);
  } });
  await assert.rejects(service.load('book-one'), { code: 'ECLOUD' });
  assert.equal((await service.load('book-one')).status, 'missing');
});

test('a no-op acknowledgment cannot be reused for a different command after restart', async () => {
  const d = fixture(); const created = await d.service.create('book-one', create());
  const before = await d.service.read('book-one', created.noteId);
  await d.service.save('book-one', created.noteId, { operationId: 'o-noop', html: before.html, expectedBodyToken: before.bodyToken, writingDay: '2026-11-10' });
  const restarted = createNotesService(d.options);
  await assert.rejects(restarted.save('book-one', created.noteId, { operationId: 'o-noop', html: '<p>Different</p>', expectedBodyToken: before.bodyToken, writingDay: '2026-11-10' }), { code: 'EINVAL' });
  assert.equal((await restarted.read('book-one', created.noteId)).html, before.html);
  assert.equal((await d.books.get('book-one').store.listRevisions(created.noteId)).length, 0);
});

test('a corrupted prepared command is retained rather than executed or silently regenerated', async () => {
  const d = fixture(); await d.service.load('book-one');
  const ctx = d.books.get('book-one'); const apply = ctx.store.apply;
  ctx.store.apply = async () => { throw Object.assign(new Error('interrupted'), { code: 'EIO' }); };
  await assert.rejects(d.service.create('book-one', create()), { code: 'EIO' });
  ctx.store.apply = apply;
  const path = 'recovery/editor-commands/o-create.json';
  const record = JSON.parse(ctx.files.get(path)); record.compiled.request.nextIndex.root.sortMode = 'manual';
  const corrupt = JSON.stringify(record); ctx.files.set(path, corrupt);
  await assert.rejects(d.service.create('book-one', create()), { code: 'EINVAL' });
  assert.equal(ctx.files.get(path), corrupt); assert.equal((await ctx.store.load()).status, 'missing');
});

test('a later rename settles a body save interrupted before its store intent, even after restart', async () => {
  const d = fixture(); const note = await d.service.create('book-one', create());
  const ctx = d.books.get('book-one'); const before = await d.service.read('book-one', note.noteId);
  const write = ctx.adapter.writeDurable; let inject = true;
  ctx.adapter.writeDurable = async (path, text) => {
    if (inject && path === 'recovery/history-operations/o-interrupted.json') { inject = false; throw Object.assign(new Error('EIO'), { code: 'EIO' }); }
    return write(path, text);
  };
  const request = { operationId: 'o-interrupted', html: '<p>Keep this writing</p>', expectedBodyToken: before.bodyToken, writingDay: '2026-11-10' };
  await assert.rejects(d.service.save('book-one', note.noteId, request), { code: 'EIO' });
  const restarted = createNotesService(d.options);
  assert.equal((await restarted.rename('book-one', note.noteId, { operationId: 'o-after', title: 'Renamed' })).status, 'saved');
  assert.equal((await restarted.save('book-one', note.noteId, request)).status, 'saved');
  assert.equal((await restarted.read('book-one', note.noteId)).html, request.html);
});

test('external adoption retains the prior observed body as a revision and repeated refresh is unchanged', async () => {
  const d = fixture(); const note = await d.service.create('book-one', create());
  const before = await d.service.read('book-one', note.noteId); const ctx = d.books.get('book-one');
  ctx.files.set(note.noteId + '.html', '<p>External writing</p>');
  const result = await d.service.refresh('book-one', note.noteId, { baseBodyToken: before.bodyToken, localHtml: before.html });
  assert.equal(result.changed, true); assert.equal(result.html, '<p>External writing</p>');
  const revisions = await ctx.store.listRevisions(note.noteId);
  assert.equal(revisions.length, 1); assert.equal((await ctx.store.readRevision(note.noteId, revisions[0].id)).html, before.html);
  const snapshot = [...ctx.files];
  const again = await d.service.refresh('book-one', note.noteId, { baseBodyToken: result.bodyToken, localHtml: result.html });
  assert.equal(again.changed, false); assert.deepEqual([...ctx.files], snapshot);
});

test('simultaneous body edits keep local writing and one visibly identified external conflict note', async () => {
  const d = fixture(); const note = await d.service.create('book-one', create()); const ctx = d.books.get('book-one');
  const before = await d.service.read('book-one', note.noteId);
  ctx.files.set(note.noteId + '.html', '<p>External</p>');
  const result = await d.service.refresh('book-one', note.noteId, { baseBodyToken: before.bodyToken, localHtml: '<p>Local</p>' });
  assert.equal(result.status, 'ok'); assert.ok(result.conflictNoteId);
  assert.equal((await ctx.store.read(note.noteId)).html, '<p>Local</p>');
  assert.equal((await ctx.store.read(result.conflictNoteId)).html, '<p>External</p>');
  assert.match((await ctx.store.load()).index.notes.find((n) => n.id === result.conflictNoteId).title, /conflict/);
  await d.service.refresh('book-one', note.noteId, { baseBodyToken: result.bodyToken, localHtml: result.html });
  assert.equal((await ctx.store.load()).index.notes.length, 2);
});

test('editable copies preserve the unsupported original and retry without duplication', async () => {
  const d = fixture(); const note = await d.service.create('book-one', create()); const ctx = d.books.get('book-one');
  const original = '<article><h1>Source</h1><p>Words</p></article>'; ctx.files.set(note.noteId + '.html', original);
  const request = { operationId: 'o-copy', html: '<p>Source</p><p>Words</p>', expectedBodyToken: original };
  const result = await d.service.copy('book-one', note.noteId, request);
  assert.equal(result.status, 'saved'); assert.notEqual(result.noteId, note.noteId);
  assert.equal((await ctx.store.read(note.noteId)).html, original);
  assert.equal((await ctx.store.read(result.noteId)).html, request.html);
  assert.equal((await createNotesService(d.options).copy('book-one', note.noteId, request)).noteId, result.noteId);
  assert.equal((await ctx.store.load()).index.notes.length, 2);
});

test('unavailable and missing external bodies are never adopted as empty', async () => {
  const d = fixture(); const note = await d.service.create('book-one', create()); const ctx = d.books.get('book-one');
  const before = await d.service.read('book-one', note.noteId); const read = ctx.adapter.read;
  ctx.adapter.read = async (path) => path === note.noteId + '.html' ? { status: 'unavailable' } : read(path);
  assert.equal((await d.service.refresh('book-one', note.noteId, { baseBodyToken: before.bodyToken, localHtml: before.html })).status, 'unavailable');
  ctx.adapter.read = read; ctx.files.delete(note.noteId + '.html');
  assert.equal((await d.service.refresh('book-one', note.noteId, { baseBodyToken: before.bodyToken, localHtml: before.html })).status, 'missing');
  assert.equal((await ctx.store.load()).index.notes.length, 1);
});

test('a refresh recovers an unindexed HTML file once and keeps missing indexed notes', async () => {
  const d = fixture(); const note = await d.service.create('book-one', create()); const ctx = d.books.get('book-one');
  const before = await d.service.read('book-one', note.noteId);
  ctx.files.set('outside.html', '<p>Found writing</p>');
  await d.service.refresh('book-one', note.noteId, { baseBodyToken: before.bodyToken, localHtml: before.html });
  const loaded = await ctx.store.load(); assert.equal(loaded.index.notes.length, 2);
  assert.equal(loaded.index.groups[0].systemRole, 'recovered');
  await d.service.refresh('book-one', note.noteId, { baseBodyToken: before.bodyToken, localHtml: before.html });
  assert.equal((await ctx.store.load()).index.notes.length, 2);
});

test('a metadata branch is merged against proven ancestry while keeping local conflicting titles', async () => {
  const d = fixture(); const note = await d.service.create('book-one', create()); const ctx = d.books.get('book-one');
  const base = (await ctx.store.load()).index;
  await d.service.rename('book-one', note.noteId, { operationId: 'o-local-title', title: 'Local title' });
  const incoming = JSON.parse(JSON.stringify(base)); incoming.versionId = 'v-incoming'; incoming.parentVersionIds = [base.versionId]; incoming.notes[0].title = 'Remote title';
  ctx.files.set('index.json', JSON.stringify(incoming));
  const before = await ctx.store.read(note.noteId);
  const result = await d.service.refresh('book-one', note.noteId, { baseBodyToken: before.bodyToken, localHtml: before.html });
  assert.equal(result.title, 'Local title');
  const conflicts = await ctx.store.listConflicts(); assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].variants.incoming.notes[0].title, 'Remote title');
});

test('deletion racing with unsaved editor text produces an active recovered note', async () => {
  const d = fixture(); const note = await d.service.create('book-one', create()); const ctx = d.books.get('book-one');
  const before = await d.service.read('book-one', note.noteId); const index = (await ctx.store.load()).index;
  await ctx.store.trashNote({ operationId: 'o-delete', baseVersionId: index.versionId, versionId: 'v-deleted', createdAt: at, noteId: note.noteId, expectedBodyToken: before.bodyToken, trashId: 't-deleted' });
  const result = await d.service.refresh('book-one', note.noteId, { baseBodyToken: before.bodyToken, localHtml: '<p>Still writing</p>' });
  assert.equal(result.status, 'recovered'); assert.notEqual(result.noteId, note.noteId);
  assert.equal((await ctx.store.read(result.noteId)).html, '<p>Still writing</p>');
  assert.equal((await ctx.store.readTrash('t-deleted')).html, before.html);
});

test('body observation cannot silently adopt metadata that arrives during a read', async () => {
  const d = fixture(); const note = await d.service.create('book-one', create());
  const ctx = d.books.get('book-one');
  const before = JSON.parse(ctx.files.get('index.json'));
  const external = structuredClone(before); external.versionId = 'v-unrelated-head'; external.parentVersionIds = [];
  external.notes[0].title = 'Competing organization';
  const read = ctx.adapter.read; let changed = false;
  ctx.adapter.read = async path => {
    const result = await read(path);
    if (!changed && path === note.noteId + '.html') { changed = true; ctx.files.set('index.json', JSON.stringify(external)); }
    return result;
  };
  assert.equal((await d.service.read('book-one', note.noteId)).status, 'ok');
  // A later read must reconcile the newly observed head, rather than having
  // silently remembered it after the body read without checking ancestry.
  await assert.rejects(d.service.load('book-one'), { code: 'ECONFLICT' });
});


test('refresh without orphan candidates reads the active body without traversing unrelated writing', async () => {
  const d = fixture(); const first = await d.service.create('book-one', create('o-first'));
  const second = await d.service.create('book-one', create('o-second'));
  const body = await d.service.read('book-one', first.noteId); const ctx = d.books.get('book-one');
  const originalRead = ctx.adapter.read; let unrelatedReads = 0;
  ctx.adapter.read = async path => { if (path === second.noteId + '.html') { unrelatedReads++; return { status: 'unavailable' }; } return originalRead(path); };
  const result = await d.service.refresh('book-one', first.noteId, { baseBodyToken: body.bodyToken, localHtml: body.html });
  assert.equal(result.status, 'ok'); assert.equal(unrelatedReads, 0);
  assert.equal((await ctx.store.load()).index.notes.length, 2);
});
