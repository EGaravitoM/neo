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
