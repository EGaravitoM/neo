'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createDesktopNotesAdapter } = require('../planet-notes-desktop');
async function fixture(t, options = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'neo-planet-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'notes');
  return { dir, root, adapter: createDesktopNotesAdapter(root, { availability: async () => 'local', ...options }) };
}
test('native adapter writes, reopens, lists and removes nested content', async (t) => {
  const { adapter } = await fixture(t);
  assert.equal((await adapter.read('n-mara.html')).status, 'missing');
  await adapter.writeDurable('recovery/example.json', 'hello');
  assert.deepEqual(await adapter.list(), ['recovery/example.json']);
  assert.equal((await adapter.read('recovery/example.json')).text, 'hello');
  await adapter.remove('recovery/example.json');
  await adapter.remove('recovery/example.json');
});
test('path traversal and ancestor symlinks are rejected', async (t) => {
  const { adapter, dir, root } = await fixture(t);
  await assert.rejects(adapter.writeDurable('../escaped', 'bad'), { code: 'EINVAL' });
  await fs.mkdir(root);
  await fs.symlink(dir, path.join(root, 'linked'));
  await assert.rejects(adapter.read('linked/secret'), { code: 'EINVAL' });
  await assert.rejects(adapter.list(), { code: 'EINVAL' });
});
test('unavailable targets are not overwritten', async (t) => {
  const { adapter, root } = await fixture(t, { availability: async () => 'unavailable' });
  assert.equal((await adapter.read('n-mara.html')).status, 'unavailable');
  await assert.rejects(adapter.writeDurable('n-mara.html', 'bad'), { code: 'ECLOUD' });
  await assert.rejects(fs.stat(root), { code: 'ENOENT' });
});
for (const failure of ['rename', 'sync', 'zero-write']) {
  test(failure + ' failure preserves the original destination', async (t) => {
    const { root, adapter } = await fixture(t);
    await adapter.writeDurable('n-mara.html', 'original');
    const io = Object.create(fs);
    if (failure === 'rename') io.rename = async () => { throw Object.assign(new Error('rename failed'), { code: 'EIO' }); };
    else { io.open = async (...args) => {
      const handle = await fs.open(...args);
      if (args[1] !== 'wx') return handle;
      return {
        write: (...writeArgs) => failure === 'zero-write' ? Promise.resolve({ bytesWritten: 0 }) : handle.write(...writeArgs),
        sync: () => Promise.reject(Object.assign(new Error('sync failed'), { code: 'EIO' })),
        close: () => handle.close()
      };
    }; }
    const broken = createDesktopNotesAdapter(root, { availability: async () => 'local', io });
    await assert.rejects(broken.writeDurable('n-mara.html', 'new'), { code: 'EIO' });
    assert.equal((await adapter.read('n-mara.html')).text, 'original');
    assert.deepEqual(await adapter.list(), ['n-mara.html']);
  });
}
test('partial native writes are completed', async (t) => {
  const { root } = await fixture(t);
  const io = Object.create(fs);
  io.open = async (...args) => {
    const h = await fs.open(...args);
    if (args[1] !== 'wx') return h;
    return { write: (buffer, offset, length, position) => h.write(buffer, offset, Math.min(2, length), position), sync: () => h.sync(), close: () => h.close() };
  };
  const adapter = createDesktopNotesAdapter(root, { availability: async () => 'local', io });
  await adapter.writeDurable('n-mara.html', 'écrit 🌍');
  assert.equal((await adapter.read('n-mara.html')).text, 'écrit 🌍');
});

test('the persistence protocol creates and reopens a real book-local collection', async (t) => {
  const { createNotesStore } = require('../planet-notes-store');
  const { adapter } = await fixture(t);
  const request = {
    operationId: 'o-native', baseVersionId: null,
    nextIndex: {
      schemaVersion: 1, versionId: 'v-native', parentVersionIds: [],
      root: { sortMode: 'alphabetical', childOrder: ['n-native'] }, groups: [], labels: [], tombstones: [],
      notes: [{ id: 'n-native', title: 'Native note', parentId: null, labelIds: [], createdAt: '2026-11-10T10:00:00.000Z' }]
    },
    bodies: [{ noteId: 'n-native', html: '<p>Words on disk.</p>', expectedBodyToken: null }]
  };
  await createNotesStore(adapter).apply(request);
  const reopened = createNotesStore(adapter);
  await reopened.recover();
  assert.equal((await reopened.load()).index.notes[0].title, 'Native note');
  assert.equal((await reopened.read('n-native')).html, '<p>Words on disk.</p>');
});

test('native history saves, trashes and restores a note across reopened stores', async (t) => {
  const { createNotesStore } = require('../planet-notes-store');
  const { adapter } = await fixture(t);
  const at = '2026-11-10T10:00:00.000Z';
  const store = createNotesStore(adapter);
  await store.apply({
    operationId: 'o-create', baseVersionId: null,
    nextIndex: { schemaVersion: 1, versionId: 'v-create', parentVersionIds: [], root: { sortMode: 'alphabetical', childOrder: ['n-mara'] }, groups: [], labels: [], tombstones: [], notes: [{ id: 'n-mara', title: 'Mara', parentId: null, labelIds: [], createdAt: at }] },
    bodies: [{ noteId: 'n-mara', html: '<p>Original</p>', expectedBodyToken: null }]
  });
  await store.saveNote({ operationId: 'o-save', noteId: 'n-mara', expectedBodyToken: '<p>Original</p>', html: '<p>Updated</p>', reason: 'daily', writingDay: '2026-11-10', createdAt: at, baseVersionId: 'v-create', versionId: 'v-save' });
  await createNotesStore(adapter).trashNote({ operationId: 'o-trash', trashId: 't-mara', noteId: 'n-mara', expectedBodyToken: '<p>Updated</p>', baseVersionId: 'v-save', versionId: 'v-trash', createdAt: at });
  const reopened = createNotesStore(adapter);
  await reopened.recover();
  await reopened.restoreTrash({ operationId: 'o-restore', trashId: 't-mara', baseVersionId: 'v-trash', versionId: 'v-restore', createdAt: at });
  assert.equal((await reopened.read('n-mara')).html, '<p>Updated</p>');
  const revision = (await reopened.listRevisions('n-mara'))[0];
  assert.equal((await reopened.readRevision('n-mara', revision.id)).html, '<p>Original</p>');
  assert.equal((await reopened.readTrash('t-mara')).html, '<p>Updated</p>');
});

test('native conflict preservation and orphan recovery persist across reopening', async (t) => {
  const { createNotesStore } = require('../planet-notes-store');
  const { adapter } = await fixture(t);
  const at = '2026-11-10T10:00:00.000Z';
  const store = createNotesStore(adapter);
  await store.apply({ operationId: 'o-create', baseVersionId: null,
    nextIndex: { schemaVersion: 1, versionId: 'v-create', parentVersionIds: [], root: { sortMode: 'manual', childOrder: ['n-mara'] }, groups: [], labels: [], tombstones: [], notes: [{ id: 'n-mara', title: 'Mara', parentId: null, labelIds: [], createdAt: at }] },
    bodies: [{ noteId: 'n-mara', html: '<p>Base</p>', expectedBodyToken: null }]
  });
  await adapter.writeDurable('n-mara.html', '<p>External</p>');
  const result = await store.preserveBodyConflict({ operationId: 'o-conflict', noteId: 'n-mara', expectedBodyToken: '<p>Base</p>', localHtml: '<p>Local</p>', incomingHtml: '<p>External</p>', baseVersionId: 'v-create', versionId: 'v-conflict', createdAt: at });
  await adapter.writeDurable('Lighthouse.html', '<p>Research</p>');
  const discovery = await store.recoverOrphans({ operationId: 'o-orphans', expectedIndexToken: (await store.load()).indexToken, versionId: 'v-orphans', createdAt: at });
  const reopened = createNotesStore(adapter);
  await reopened.recover();
  assert.equal((await reopened.read('n-mara')).html, '<p>Local</p>');
  assert.equal((await reopened.read(result.conflictNoteId)).html, '<p>External</p>');
  assert.equal((await reopened.read(discovery.recoveredNoteIds[0])).html, '<p>Research</p>');
  assert.equal((await reopened.listConflicts()).length, 1);
});
test('scoped listing keeps root-relative names and avoids unrelated recovery subtrees', async (t) => {
  const { adapter, root } = await fixture(t);
  await adapter.writeDurable('recovery/editor-commands/o-one.json', '{}');
  await adapter.writeDurable('recovery/observed-bodies/n-one/body.html', 'writing');
  const scoped = createDesktopNotesAdapter(root, { availability: async (file) => file.includes('observed-bodies') ? 'unavailable' : 'local' });
  assert.deepEqual(await scoped.list('recovery/editor-commands'), ['recovery/editor-commands/o-one.json']);
  await assert.rejects(scoped.list(), { code: 'ECLOUD' });
  await assert.rejects(scoped.list('../elsewhere'), { code: 'EINVAL' });
});
test('scoped listing rejects unavailable ancestors and placeholder intents', async (t) => {
  const { adapter, root } = await fixture(t);
  await adapter.writeDurable('recovery/editor-commands/.o-one.json.icloud', '');
  await assert.rejects(adapter.list('recovery/editor-commands'), { code: 'ECLOUD' });
  const blocked = createDesktopNotesAdapter(root, { availability: async (file) => file === path.join(root, 'recovery') ? 'unavailable' : 'local' });
  await assert.rejects(blocked.list('recovery/missing'), { code: 'ECLOUD' });
});
