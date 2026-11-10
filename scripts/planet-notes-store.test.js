'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createNotesStore } = require('../planet-notes-store');

// Filesystem fault simulator: only completed durable writes survive a restart.
// No store internals are mocked. Exceptions model loss before/after any mutation.
function disk(seed = {}, failAt = Infinity, after = false) {
  const files = new Map(Object.entries(seed));
  let mutations = 0;
  const mutate = (fn) => {
    mutations++;
    if (mutations === failAt && !after) throw new Error('simulated power loss');
    fn();
    if (mutations === failAt && after) throw new Error('simulated power loss');
  };
  return {
    files,
    count: () => mutations,
    adapter: {
      async read(path) { return files.has(path) ? { status: 'ok', text: files.get(path) } : { status: 'missing' }; },
      async writeDurable(path, text) { mutate(() => files.set(path, text)); },
      async remove(path) { mutate(() => files.delete(path)); },
      async list() { return [...files.keys()]; }
    }
  };
}

function creation() {
  return {
    operationId: 'o-create', baseVersionId: null,
    nextIndex: {
      schemaVersion: 1, versionId: 'v-created', parentVersionIds: [],
      root: { sortMode: 'alphabetical', childOrder: ['n-mara'] }, groups: [], labels: [], tombstones: [],
      notes: [{ id: 'n-mara', title: 'Mara', parentId: null, labelIds: [], createdAt: '2026-11-10T10:00:00.000Z' }]
    },
    bodies: [{ noteId: 'n-mara', html: '<p>Mara kept the letter.</p>', expectedBodyToken: null }]
  };
}

test('a missing collection remains missing without creating files', async () => {
  const d = disk();
  assert.equal((await createNotesStore(d.adapter).load()).status, 'missing');
  assert.equal(d.files.size, 0);
});

test('unavailable index is not treated as an empty collection', async () => {
  const d = disk();
  d.adapter.read = async () => ({ status: 'unavailable' });
  assert.equal((await createNotesStore(d.adapter).load()).status, 'unavailable');
  assert.equal(d.count(), 0);
});

test('invalid JSON remains intact and is reported', async () => {
  const d = disk({ 'index.json': '{broken' });
  assert.equal((await createNotesStore(d.adapter).load()).status, 'invalid');
  assert.equal(d.files.get('index.json'), '{broken');
});

test('creation is readable after a new store is opened', async () => {
  const d = disk();
  const store = createNotesStore(d.adapter);
  assert.equal((await store.apply(creation())).status, 'saved');
  const reopened = createNotesStore(d.adapter);
  assert.equal((await reopened.load()).index.notes[0].title, 'Mara');
  assert.equal((await reopened.read('n-mara')).html, '<p>Mara kept the letter.</p>');
});

test('retrying an acknowledged operation does not rewrite unchanged files', async () => {
  const d = disk();
  const store = createNotesStore(d.adapter);
  await store.apply(creation());
  const count = d.count();
  await store.apply(creation());
  assert.equal(d.count(), count);
});

test('unsafe note IDs cannot reach storage', async () => {
  const d = disk();
  await assert.rejects(createNotesStore(d.adapter).read('../escape'), { code: 'EINVAL' });
  assert.equal(d.count(), 0);
});

test('an invalid proposed index cannot mutate storage', async () => {
  const d = disk();
  const request = creation();
  request.nextIndex.root.childOrder = ['n-unknown'];
  await assert.rejects(createNotesStore(d.adapter).apply(request), { code: 'EINVAL' });
  assert.equal(d.count(), 0);
});

test('a stale base preserves the existing index instead of overwriting it', async () => {
  const d = disk();
  const store = createNotesStore(d.adapter);
  await store.apply(creation());
  const before = d.files.get('index.json');
  const stale = { ...creation(), operationId: 'o-stale' };
  stale.nextIndex.versionId = 'v-stale';
  stale.nextIndex.notes[0].title = 'Wrong title';
  assert.equal((await store.apply(stale)).status, 'conflict');
  assert.equal(d.files.get('index.json'), before);
});

test('creation survives interruption before or after every durable mutation', async () => {
  const baseline = disk();
  await createNotesStore(baseline.adapter).apply(creation());
  const steps = baseline.count();
  assert.ok(steps > 0);
  for (let cut = 1; cut <= steps; cut++) {
    for (const after of [false, true]) {
      const failed = disk({}, cut, after);
      await assert.rejects(createNotesStore(failed.adapter).apply(creation()), /simulated power loss/);
      const restarted = disk(Object.fromEntries(failed.files));
      const store = createNotesStore(restarted.adapter);
      await store.recover();
      await store.apply(creation());
      await store.recover();
      assert.equal((await store.read('n-mara')).html, '<p>Mara kept the letter.</p>');
      assert.equal((await store.load()).index.notes.length, 1);
    }
  }
});

test('published metadata never references a body not durably written', async () => {
  const d = disk();
  const write = d.adapter.writeDurable;
  d.adapter.writeDurable = async (path, text) => {
    if (path === 'index.json') {
      const value = JSON.parse(text);
      for (const note of value.notes) assert.ok(d.files.has(note.id + '.html'), 'body must precede publication');
    }
    await write(path, text);
  };
  await createNotesStore(d.adapter).apply(creation());
});

test('a body update preserves its input and survives each interrupted mutation', async () => {
  const original = disk();
  await createNotesStore(original.adapter).apply(creation());
  const seed = Object.fromEntries(original.files);
  const request = creation();
  request.operationId = 'o-update';
  request.baseVersionId = 'v-created';
  request.nextIndex.versionId = 'v-updated';
  request.nextIndex.parentVersionIds = ['v-created'];
  request.bodies[0].expectedBodyToken = '<p>Mara kept the letter.</p>';
  request.bodies[0].html = '<p>Mara opened the letter.</p>';
  const baseline = disk(seed);
  await createNotesStore(baseline.adapter).apply(request);
  for (let cut = 1; cut <= baseline.count(); cut++) {
    for (const after of [false, true]) {
      const failed = disk(seed, cut, after);
      await assert.rejects(createNotesStore(failed.adapter).apply(request), /simulated power loss/);
      const restarted = disk(Object.fromEntries(failed.files));
      const store = createNotesStore(restarted.adapter);
      await store.recover();
      await store.apply(request);
      assert.equal((await store.read('n-mara')).html, '<p>Mara opened the letter.</p>');
      assert.equal(restarted.files.get('recovery/inputs/o-update/n-mara.html'), '<p>Mara kept the letter.</p>');
      assert.ok(restarted.files.has('recovery/index-versions/v-created.json'));
    }
  }
});

test('recovery refuses to overwrite a newly observed external body', async () => {
  const baseline = disk();
  await createNotesStore(baseline.adapter).apply(creation());
  const seed = Object.fromEntries(baseline.files);
  const request = creation();
  request.operationId = 'o-update';
  request.baseVersionId = 'v-created';
  request.nextIndex.versionId = 'v-updated';
  request.nextIndex.parentVersionIds = ['v-created'];
  request.bodies[0].expectedBodyToken = '<p>Mara kept the letter.</p>';
  request.bodies[0].html = '<p>Local edit</p>';
  // Simulate a crash after the intent persisted and another editor then saved.
  seed['recovery/operations/o-update.json'] = JSON.stringify(request);
  seed['n-mara.html'] = '<p>External edit</p>';
  const d = disk(seed);
  const store = createNotesStore(d.adapter);
  const results = await store.recover();
  assert.equal(results.find((r) => r.path.endsWith('o-update.json')).status, 'conflict');
  assert.equal((await store.read('n-mara')).html, '<p>External edit</p>');
  assert.equal(d.files.get('recovery/operations/o-update.json'), JSON.stringify(request));
});

test('reused operation IDs cannot substitute another payload', async () => {
  const d = disk();
  const store = createNotesStore(d.adapter);
  await store.apply(creation());
  const altered = creation();
  altered.bodies[0].html = '<p>Substituted</p>';
  await assert.rejects(store.apply(altered), { code: 'EINVAL' });
  assert.equal((await store.read('n-mara')).html, '<p>Mara kept the letter.</p>');
});

for (const target of ['body', 'index']) {
  test('refuses an external ' + target + ' change observed after the intent is durable', async () => {
    const d = disk();
    const request = creation();
    const incomingIndex = structuredClone(request.nextIndex);
    incomingIndex.versionId = 'v-external';
    incomingIndex.notes[0].title = 'External title';
    const path = target === 'body' ? 'n-mara.html' : 'index.json';
    const external = target === 'body' ? '<p>New external writing</p>' : JSON.stringify(incomingIndex);
    const read = d.adapter.read;
    let injected = false;
    d.adapter.read = async (name) => {
      if (!injected && name === path && d.files.has('recovery/operations/o-create.json')) {
        d.files.set(path, external);
        injected = true;
      }
      return read(name);
    };
    assert.equal((await createNotesStore(d.adapter).apply(request)).status, 'conflict');
    assert.equal(d.files.get(path), external);
    assert.ok(d.files.has('recovery/operations/o-create.json'), 'local request remains recoverable');
    assert.equal(d.files.has('recovery/receipts/o-create.json'), false);
  });
}

for (const unavailable of [false, true]) {
  test('preflights ' + (unavailable ? 'unavailable' : 'missing') + ' untouched bodies without mutating any files', async () => {
    const seedRequest = creation();
    seedRequest.nextIndex.root.childOrder.push('n-other');
    seedRequest.nextIndex.notes.push({ ...seedRequest.nextIndex.notes[0], id: 'n-other' });
    const d = disk({ 'index.json': JSON.stringify(seedRequest.nextIndex), 'n-mara.html': '<p>Original</p>' });
    if (unavailable) {
      const read = d.adapter.read;
      d.adapter.read = async (name) => name === 'n-other.html' ? { status: 'unavailable' } : read(name);
    }
    const request = structuredClone(seedRequest);
    request.operationId = 'o-update';
    request.baseVersionId = 'v-created';
    request.nextIndex.versionId = 'v-updated';
    request.nextIndex.parentVersionIds = ['v-created'];
    request.bodies[0].html = '<p>Changed</p>';
    request.bodies[0].expectedBodyToken = '<p>Original</p>';
    await assert.rejects(createNotesStore(d.adapter).apply(request), { code: unavailable ? 'ECLOUD' : 'ENOENT' });
    assert.equal(d.count(), 0);
    assert.equal(d.files.get('n-mara.html'), '<p>Original</p>');
  });
}
