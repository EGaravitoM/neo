'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createNotesStore } = require('../planet-notes-store');
const { validateRevision, validateTrash, validateTombstone } = require('../planet-notes');

const at = '2026-11-10T10:00:00.000Z';
function fixture(seed, failAt = Infinity, after = false) {
  const initial = {
    schemaVersion: 1, versionId: 'v-start', parentVersionIds: [],
    root: { sortMode: 'manual', childOrder: ['g-cast'] },
    groups: [{ id: 'g-cast', title: 'Cast', parentId: null, sortMode: 'manual', childOrder: ['n-mara'], createdAt: at }],
    notes: [{ id: 'n-mara', title: 'Mara', parentId: 'g-cast', labelIds: ['l-plot'], createdAt: at }],
    labels: [{ id: 'l-plot', name: 'Plot' }], tombstones: []
  };
  const files = new Map(Object.entries(seed || { 'index.json': JSON.stringify(initial), 'n-mara.html': '<p>Original writing</p>' }));
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
const change = (overrides = {}) => ({
  operationId: 'o-save', noteId: 'n-mara', expectedBodyToken: '<p>Original writing</p>',
  baseVersionId: 'v-start', versionId: 'v-save', html: '<p>New writing</p>',
  reason: 'daily', writingDay: '2026-11-10', createdAt: at, ...overrides
});
const deletion = () => ({ operationId: 'o-trash', trashId: 't-mara', noteId: 'n-mara', expectedBodyToken: '<p>Original writing</p>', baseVersionId: 'v-start', versionId: 'v-trash', createdAt: at });
const restore = () => ({ operationId: 'o-restore', trashId: 't-mara', baseVersionId: 'v-trash', versionId: 'v-restore', createdAt: at });

// Return shapes and domain IDs are the public seam, not internal call counts.
test('first change of a writing day preserves the previous saved body only once', async () => {
  const d = fixture();
  await d.store.saveNote(change());
  await d.store.saveNote(change({ operationId: 'o-second', baseVersionId: 'v-save', versionId: 'v-second', expectedBodyToken: '<p>New writing</p>', html: '<p>Later writing</p>' }));
  const revisions = await d.store.listRevisions('n-mara');
  assert.equal(revisions.length, 1);
  assert.equal((await d.store.readRevision('n-mara', revisions[0].id)).html, '<p>Original writing</p>');
  assert.equal(revisions[0].writingDay, '2026-11-10');
});

test('the next supplied writing day preserves its own starting body', async () => {
  const d = fixture();
  await d.store.saveNote(change());
  await d.store.saveNote(change({ operationId: 'o-next', baseVersionId: 'v-save', versionId: 'v-next', expectedBodyToken: '<p>New writing</p>', html: '<p>Tomorrow</p>', writingDay: '2026-11-11' }));
  assert.equal((await d.store.listRevisions('n-mara')).length, 2);
});

test('a no-op save creates neither revision nor writes', async () => {
  const d = fixture();
  await d.store.saveNote(change({ html: '<p>Original writing</p>' }));
  assert.equal(d.count(), 0);
  assert.deepEqual(await d.store.listRevisions('n-mara'), []);
});

test('an acknowledged save retry creates no duplicate revision', async () => {
  const d = fixture();
  await d.store.saveNote(change());
  const count = d.count();
  await d.store.saveNote(change());
  assert.equal(d.count(), count);
  assert.equal((await d.store.listRevisions('n-mara')).length, 1);
});

test('adopting an external replacement preserves the previous body even after a daily revision', async () => {
  const d = fixture();
  await d.store.saveNote(change());
  await d.store.saveNote(change({ operationId: 'o-external', baseVersionId: 'v-save', versionId: 'v-external', expectedBodyToken: '<p>New writing</p>', html: '<p>External writing</p>', reason: 'external' }));
  const revisions = await d.store.listRevisions('n-mara');
  const external = revisions.find((r) => r.reason === 'external');
  assert.equal((await d.store.readRevision('n-mara', external.id)).html, '<p>New writing</p>');
});

test('trash preserves title, labels, original placement and writing', async () => {
  const d = fixture();
  await d.store.trashNote(deletion());
  const trash = await d.store.readTrash('t-mara');
  assert.equal(trash.html, '<p>Original writing</p>');
  assert.equal(trash.record.note.title, 'Mara');
  assert.equal(trash.record.note.parentId, 'g-cast');
  assert.deepEqual(trash.record.labels, [{ id: 'l-plot', name: 'Plot' }]);
  assert.equal(trash.record.originalPosition, 0);
  assert.equal((await d.store.load()).index.notes.length, 0);
  assert.equal((await d.store.load()).index.tombstones[0].trashId, 't-mara');
  assert.equal((await d.store.read('n-mara')).status, 'missing');
});

test('trash inspection does not mutate files', async () => {
  const d = fixture();
  await d.store.trashNote(deletion());
  const count = d.count();
  assert.equal((await d.store.listTrash()).length, 1);
  await d.store.readTrash('t-mara');
  assert.equal(d.count(), count);
});

test('restore retains recovery source and original parent and labels', async () => {
  const d = fixture();
  await d.store.trashNote(deletion());
  await d.store.restoreTrash(restore());
  const note = (await d.store.load()).index.notes[0];
  assert.equal(note.parentId, 'g-cast');
  assert.deepEqual(note.labelIds, ['l-plot']);
  assert.equal((await d.store.read('n-mara')).html, '<p>Original writing</p>');
  assert.equal((await d.store.readTrash('t-mara')).html, '<p>Original writing</p>');
});

test('restore falls back to root when the original group no longer exists', async () => {
  const d = fixture();
  await d.store.trashNote(deletion());
  const index = (await d.store.load()).index;
  index.groups = [];
  index.root.childOrder = [];
  index.versionId = 'v-no-group';
  index.parentVersionIds = ['v-trash'];
  d.files.set('index.json', JSON.stringify(index));
  await d.store.restoreTrash({ ...restore(), baseVersionId: 'v-no-group' });
  assert.equal((await d.store.load()).index.notes[0].parentId, null);
});

for (const mode of ['replace', 'new']) {
  test('revision restore ' + mode + ' preserves current writing and source revision', async () => {
    const d = fixture();
    await d.store.saveNote(change());
    const revision = (await d.store.listRevisions('n-mara'))[0];
    const result = await d.store.restoreRevision({ operationId: 'o-restore-revision', noteId: 'n-mara', revisionId: revision.id, mode, newNoteId: mode === 'new' ? 'n-copy' : null, baseVersionId: 'v-save', versionId: 'v-restored', expectedBodyToken: '<p>New writing</p>', createdAt: at });
    assert.equal(result.status, 'saved');
    assert.equal((await d.store.readRevision('n-mara', revision.id)).html, '<p>Original writing</p>');
    const index = (await d.store.load()).index;
    assert.equal(index.notes.find((n) => n.id === 'n-mara').title, 'Mara');
    if (mode === 'new') {
      assert.equal((await d.store.read('n-mara')).html, '<p>New writing</p>');
      assert.equal((await d.store.read('n-copy')).html, '<p>Original writing</p>');
    } else {
      const previous = (await d.store.listRevisions('n-mara')).find((r) => r.reason === 'restore');
      assert.equal((await d.store.readRevision('n-mara', previous.id)).html, '<p>New writing</p>');
    }
  });
}

for (const operation of ['trash', 'restore']) {
  test(operation + ' is replayable after interruption at each mutation boundary', async () => {
    const source = fixture();
    if (operation === 'restore') await source.store.trashNote(deletion());
    const seed = Object.fromEntries(source.files);
    const baseline = fixture(seed);
    const run = (store) => operation === 'trash' ? store.trashNote(deletion()) : store.restoreTrash(restore());
    await run(baseline.store);
    assert.ok(baseline.count() > 0);
    for (let cut = 1; cut <= baseline.count(); cut++) { for (const after of [false, true]) {
      const failed = fixture(seed, cut, after);
      await assert.rejects(run(failed.store), /power loss/);
      const restarted = fixture(Object.fromEntries(failed.files));
      await restarted.store.recover();
      await run(restarted.store);
      await restarted.store.recover();
      assert.equal((await restarted.store.readTrash('t-mara')).html, '<p>Original writing</p>');
      assert.equal((await restarted.store.load()).index.notes.length, operation === 'trash' ? 0 : 1);
      if (operation === 'restore') assert.equal((await restarted.store.read('n-mara')).html, '<p>Original writing</p>');
    } }
  });
}

for (const status of ['missing', 'unavailable']) {
  test(status + ' active content cannot be trashed or rewritten', async () => {
    const d = fixture();
    const read = d.adapter.read;
    d.adapter.read = async (name) => name === 'n-mara.html' ? { status } : read(name);
    await assert.rejects(d.store.trashNote(deletion()), { code: status === 'missing' ? 'ENOENT' : 'ECLOUD' });
    assert.equal(d.count(), 0);
  });
}

test('trash cleanup refuses writing that changed after deletion began', async () => {
  const d = fixture();
  const read = d.adapter.read;
  let injected = false;
  d.adapter.read = async (name) => {
    const index = JSON.parse(d.files.get('index.json'));
    if (!injected && name === 'n-mara.html' && index.notes.length === 0) {
      injected = true;
      d.files.set(name, '<p>Concurrent writing</p>');
    }
    return read(name);
  };
  assert.equal((await d.store.trashNote(deletion())).status, 'conflict');
  assert.equal(d.files.get('n-mara.html'), '<p>Concurrent writing</p>');
  assert.equal((await d.store.readTrash('t-mara')).html, '<p>Original writing</p>');
});

for (const [name, validate] of [['revision', validateRevision], ['trash', validateTrash], ['tombstone', validateTombstone]]) {
  test(name + ' metadata rejects malformed records without mutation', () => {
    for (const record of [null, {}, { schemaVersion: 1, id: '../escape' }]) {
      const before = JSON.stringify(record);
      assert.equal(validate(record).status, 'invalid');
      assert.equal(JSON.stringify(record), before);
    }
  });
}

test('trash content is durable before the active entry is removed', async () => {
  const d = fixture();
  const write = d.adapter.writeDurable;
  d.adapter.writeDurable = async (name, text) => {
    if (name === 'index.json' && JSON.parse(text).notes.length === 0) {
      assert.equal(d.files.get('trash/t-mara/note.html'), '<p>Original writing</p>');
      const record = JSON.parse(d.files.get('trash/t-mara/record.json'));
      assert.equal(record.note.id, 'n-mara');
    }
    await write(name, text);
  };
  await d.store.trashNote(deletion());
});

test('restore refuses an occupied note identity instead of replacing writing', async () => {
  const d = fixture();
  await d.store.trashNote(deletion());
  d.files.set('n-mara.html', '<p>Unindexed external writing</p>');
  assert.equal((await d.store.restoreTrash(restore())).status, 'conflict');
  assert.equal(d.files.get('n-mara.html'), '<p>Unindexed external writing</p>');
});

const bodyHash = 'a'.repeat(64);
const note = { id: 'n-mara', title: 'Mara', parentId: 'g-cast', labelIds: ['l-plot'], createdAt: at };
for (const [name, validate, record] of [
  ['revision', validateRevision, { schemaVersion: 1, id: 'r-first', noteId: 'n-mara', operationId: 'o-save', createdAt: at, reason: 'daily', writingDay: '2026-11-10', bodyHash }],
  ['trash', validateTrash, { schemaVersion: 1, id: 't-mara', operationId: 'o-trash', deletedAt: at, note, originalPosition: 0, labels: [{ id: 'l-plot', name: 'Plot' }], bodyHash }],
  ['tombstone', validateTombstone, { kind: 'note', id: 'n-mara', operationId: 'o-trash', trashId: 't-mara', deletedAt: at }]
]) {
  test(name + ' accepts its valid metadata without mutating it', () => {
    const before = JSON.stringify(record);
    assert.equal(validate(record).status, 'ok');
    assert.equal(JSON.stringify(record), before);
  });
}

test('a failed revision commit leaves current writing and index unchanged', async () => {
  const d = fixture();
  const before = d.files.get('index.json');
  const write = d.adapter.writeDurable;
  d.adapter.writeDurable = async (name, text) => {
    if (name.startsWith('revisions/') && name.endsWith('.json')) throw Object.assign(new Error('revision failed'), { code: 'EIO' });
    return write(name, text);
  };
  await assert.rejects(d.store.saveNote(change()), { code: 'EIO' });
  assert.equal(d.files.get('n-mara.html'), '<p>Original writing</p>');
  assert.equal(d.files.get('index.json'), before);
});

test('a late external body change is not overwritten by a history save', async () => {
  const d = fixture();
  const read = d.adapter.read;
  let injected = false;
  d.adapter.read = async (name) => {
    if (!injected && name === 'n-mara.html' && d.files.has('recovery/history-operations/o-save.json')) {
      injected = true; d.files.set(name, '<p>External writing</p>');
    }
    return read(name);
  };
  assert.equal((await d.store.saveNote(change())).status, 'conflict');
  assert.equal(d.files.get('n-mara.html'), '<p>External writing</p>');
  assert.ok(d.files.has('recovery/history-operations/o-save.json'));
});

test('corrupt historical writing is reported and cannot replace current writing', async () => {
  const d = fixture();
  await d.store.saveNote(change());
  const revision = (await d.store.listRevisions('n-mara'))[0];
  d.files.set('revisions/n-mara/' + revision.id + '.html', '<p>Corrupt</p>');
  assert.equal((await d.store.readRevision('n-mara', revision.id)).status, 'invalid');
  const count = d.count();
  await assert.rejects(d.store.restoreRevision({ operationId: 'o-corrupt', noteId: 'n-mara', revisionId: revision.id, mode: 'replace', newNoteId: null, expectedBodyToken: '<p>New writing</p>', baseVersionId: 'v-save', versionId: 'v-corrupt', createdAt: at }), { code: 'EINVAL' });
  assert.equal(d.count(), count);
  assert.equal(d.files.get('n-mara.html'), '<p>New writing</p>');
});

test('restored notes disappear from trash listings but their source stays readable', async () => {
  const d = fixture();
  await d.store.trashNote(deletion());
  await d.store.restoreTrash(restore());
  assert.deepEqual(await d.store.listTrash(), []);
  assert.equal((await d.store.readTrash('t-mara')).status, 'ok');
  assert.equal((await d.store.load()).index.tombstones.length, 1);
});

test('storage uses the supplied writing day rather than the timestamp date', async () => {
  const d = fixture();
  await d.store.saveNote(change({ writingDay: '2026-11-09' }));
  assert.equal((await d.store.listRevisions('n-mara'))[0].writingDay, '2026-11-09');
});

test('history operation IDs cannot be reused with a different command', async () => {
  const d = fixture();
  await d.store.saveNote(change());
  await assert.rejects(d.store.trashNote({ ...deletion(), operationId: 'o-save' }), { code: 'EINVAL' });
});

for (const action of ['save', 'restore-revision']) {
  test(action + ' recovers after interruption at each mutation boundary', async () => {
    const initial = fixture();
    let request = change();
    let run = (store) => store.saveNote(request);
    if (action === 'restore-revision') {
      await initial.store.saveNote(change());
      const revision = (await initial.store.listRevisions('n-mara'))[0];
      request = { operationId: 'o-revision-restore', noteId: 'n-mara', revisionId: revision.id, mode: 'replace', newNoteId: null, baseVersionId: 'v-save', versionId: 'v-restored', expectedBodyToken: '<p>New writing</p>', createdAt: at };
      run = (store) => store.restoreRevision(request);
    }
    const seed = Object.fromEntries(initial.files);
    const baseline = fixture(seed);
    await run(baseline.store);
    for (let cut = 1; cut <= baseline.count(); cut++) {
      for (const after of [false, true]) {
        const failed = fixture(seed, cut, after);
        await assert.rejects(run(failed.store), /power loss/);
        const restarted = fixture(Object.fromEntries(failed.files));
        await restarted.store.recover();
        await run(restarted.store);
        const revisions = await restarted.store.listRevisions('n-mara');
        assert.equal(revisions.length, action === 'save' ? 1 : 2);
        assert.equal((await restarted.store.read('n-mara')).html, action === 'save' ? '<p>New writing</p>' : '<p>Original writing</p>');
      }
    }
  });
}

test('browser history preserves the same SHA-256 source hash as Node', async () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  const { webcrypto, createHash } = require('node:crypto');
  const context = vm.createContext({ crypto: webcrypto, TextEncoder });
  for (const file of ['planet-notes.js', 'planet-notes-history.js', 'planet-notes-store.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  const d = fixture();
  const store = context.NeoPlanetNotesStore.createNotesStore(d.adapter);
  await store.saveNote(change());
  const record = (await store.listRevisions('n-mara'))[0];
  assert.equal(record.bodyHash, createHash('sha256').update('<p>Original writing</p>', 'utf8').digest('hex'));
  assert.equal((await store.readRevision('n-mara', record.id)).html, '<p>Original writing</p>');
});

test('restoration recovers missing label definitions without changing case', async () => {
  const d = fixture();
  await d.store.trashNote(deletion());
  const index = (await d.store.load()).index;
  index.labels = [{ id: 'l-lower', name: 'plot' }];
  index.versionId = 'v-labels'; index.parentVersionIds = ['v-trash'];
  d.files.set('index.json', JSON.stringify(index));
  await d.store.restoreTrash({ ...restore(), baseVersionId: 'v-labels' });
  const restored = (await d.store.load()).index;
  assert.deepEqual(restored.notes[0].labelIds, ['l-plot']);
  assert.deepEqual(restored.labels.map((l) => l.name).sort(), ['Plot', 'plot']);
});

test('restoration refuses a reused label ID rather than dropping its snapshot', async () => {
  const d = fixture();
  await d.store.trashNote(deletion());
  const index = (await d.store.load()).index;
  index.labels[0].name = 'Different';
  index.versionId = 'v-labels'; index.parentVersionIds = ['v-trash'];
  d.files.set('index.json', JSON.stringify(index));
  const count = d.count();
  assert.equal((await d.store.restoreTrash({ ...restore(), baseVersionId: 'v-labels' })).status, 'conflict');
  assert.equal(d.count(), count);
});

test('unavailable revision bodies block restoration before any writes', async () => {
  const d = fixture();
  await d.store.saveNote(change());
  const revision = (await d.store.listRevisions('n-mara'))[0];
  const read = d.adapter.read;
  d.adapter.read = async (name) => name === 'revisions/n-mara/' + revision.id + '.html' ? { status: 'unavailable' } : read(name);
  const count = d.count();
  await assert.rejects(d.store.restoreRevision({ operationId: 'o-unavailable', noteId: 'n-mara', revisionId: revision.id, mode: 'replace', expectedBodyToken: '<p>New writing</p>', baseVersionId: 'v-save', versionId: 'v-unavailable', createdAt: at }), { code: 'ECLOUD' });
  assert.equal(d.count(), count);
});

test('replay rejects a save intent that also changes unrelated metadata', async () => {
  const d = fixture();
  const write = d.adapter.writeDurable;
  d.adapter.writeDurable = async (name, text) => {
    await write(name, text);
    if (name === 'recovery/history-operations/o-save.json') throw new Error('power loss');
  };
  await assert.rejects(d.store.saveNote(change()), /power loss/);
  const record = JSON.parse(d.files.get('recovery/history-operations/o-save.json'));
  record.nextIndex.notes[0].title = 'Unrequested title';
  d.files.set('recovery/history-operations/o-save.json', JSON.stringify(record));
  d.adapter.writeDurable = write;
  const count = d.count();
  const recovered = await d.store.recover();
  assert.equal(recovered.find((r) => r.path.includes('history-operations')).status, 'invalid');
  assert.equal(d.count(), count);
  assert.equal((await d.store.load()).index.notes[0].title, 'Mara');
});

for (const reopen of [false, true]) {
  test('a later save settles a published receipt failure' + (reopen ? ' after reopening' : ''), async () => {
    const d = fixture();
    const write = d.adapter.writeDurable;
    let failReceipt = true;
    d.adapter.writeDurable = async (name, text) => {
      if (failReceipt && name === 'recovery/history-receipts/o-save.json') {
        failReceipt = false;
        throw Object.assign(new Error('receipt failed'), { code: 'EIO' });
      }
      return write(name, text);
    };
    await assert.rejects(d.store.saveNote(change()), { code: 'EIO' });
    assert.equal((await d.store.load()).index.versionId, 'v-save');
    const store = reopen ? createNotesStore(d.adapter) : d.store;
    await store.saveNote(change({ operationId: 'o-later', baseVersionId: 'v-save', versionId: 'v-later', expectedBodyToken: '<p>New writing</p>', html: '<p>Later writing</p>' }));
    assert.ok(d.files.has('recovery/history-receipts/o-save.json'));
    assert.ok((await store.recover()).every((result) => result.status === 'saved'));
    assert.equal((await store.read('n-mara')).html, '<p>Later writing</p>');
    d.files.set('Lighthouse.html', '<p>Research</p>');
    const scan = await store.recoverOrphans({ operationId: 'o-scan', versionId: 'v-scan', expectedIndexToken: d.files.get('index.json'), createdAt: at });
    assert.equal(scan.status, 'saved');
    assert.equal(scan.recoveredNoteIds.length, 1);
    assert.equal((await store.read('n-mara')).html, '<p>Later writing</p>');
  });
}

test('a persistent receipt failure refuses a later save before its body changes', async () => {
  const d = fixture(); const write = d.adapter.writeDurable;
  d.adapter.writeDurable = async (name, text) => {
    if (name === 'recovery/history-receipts/o-save.json') throw Object.assign(new Error('receipt failed'), { code: 'EIO' });
    return write(name, text);
  };
  await assert.rejects(d.store.saveNote(change()), { code: 'EIO' });
  await assert.rejects(d.store.saveNote(change({ operationId: 'o-later', baseVersionId: 'v-save', versionId: 'v-later', expectedBodyToken: '<p>New writing</p>', html: '<p>Later writing</p>' })), { code: 'EIO' });
  assert.equal((await d.store.load()).index.versionId, 'v-save');
  assert.equal((await d.store.read('n-mara')).html, '<p>New writing</p>');
});

test('core writes also settle earlier published history operations', async () => {
  const d = fixture(); const write = d.adapter.writeDurable;
  let once = true;
  d.adapter.writeDurable = async (name, text) => {
    if (once && name === 'recovery/history-receipts/o-save.json') { once = false; throw Object.assign(new Error('receipt failed'), { code: 'EIO' }); }
    return write(name, text);
  };
  await assert.rejects(d.store.saveNote(change()), { code: 'EIO' });
  const nextIndex = structuredClone((await d.store.load()).index);
  nextIndex.versionId = 'v-core'; nextIndex.parentVersionIds = ['v-save']; nextIndex.notes[0].title = 'Renamed';
  await d.store.apply({ operationId: 'o-core', baseVersionId: 'v-save', nextIndex, bodies: [] });
  assert.ok(d.files.has('recovery/history-receipts/o-save.json'));
  assert.ok((await d.store.recover()).every((result) => result.status === 'saved'));
});

test('a genuinely changed published body blocks a later write without overwriting it', async () => {
  const d = fixture(); const write = d.adapter.writeDurable; let once = true;
  d.adapter.writeDurable = async (name, text) => {
    if (once && name === 'recovery/history-receipts/o-save.json') { once = false; throw Object.assign(new Error('receipt failed'), { code: 'EIO' }); }
    return write(name, text);
  };
  await assert.rejects(d.store.saveNote(change()), { code: 'EIO' });
  d.files.set('n-mara.html', '<p>New external writing</p>');
  await assert.rejects(d.store.saveNote(change({ operationId: 'o-later', baseVersionId: 'v-save', versionId: 'v-later', expectedBodyToken: '<p>New external writing</p>', html: '<p>Later writing</p>' })), { code: 'EPENDING' });
  assert.equal(d.files.get('n-mara.html'), '<p>New external writing</p>');
  assert.equal((await d.store.load()).index.versionId, 'v-save');
  assert.ok(d.files.has('recovery/history-operations/o-save.json'));
});
