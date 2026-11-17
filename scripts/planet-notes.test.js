'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { validateIndex } = require('../planet-notes');

function index() {
  return {
    schemaVersion: 1, versionId: 'v-first', parentVersionIds: [],
    root: { sortMode: 'alphabetical', childOrder: ['g-cast'] },
    groups: [{ id: 'g-cast', title: 'Cast', parentId: null, sortMode: 'manual', childOrder: ['n-mara'], createdAt: '2026-11-10T10:00:00.000Z' }],
    notes: [{ id: 'n-mara', title: 'Mara', parentId: 'g-cast', labelIds: ['l-plot'], createdAt: '2026-11-10T10:00:00.000Z' }],
    labels: [{ id: 'l-plot', name: 'Plot' }], tombstones: []
  };
}

test('a valid collection is accepted without changing its input', () => {
  const value = index();
  const before = JSON.stringify(value);
  assert.equal(validateIndex(value).status, 'ok');
  assert.equal(JSON.stringify(value), before);
});

test('future schemas are distinguished from corrupt data', () => {
  assert.equal(validateIndex({ ...index(), schemaVersion: 2 }).status, 'unsupported-version');
});

test('blank note titles and distinct case-sensitive labels are valid', () => {
  const value = index();
  value.notes[0].title = '';
  value.labels.push({ id: 'l-lower', name: 'plot' });
  assert.equal(validateIndex(value).status, 'ok');
});

const invalid = {
  'missing parent': (v) => { v.notes[0].parentId = 'g-missing'; },
  'self-parenting': (v) => { v.groups[0].parentId = 'g-cast'; },
  'duplicate IDs': (v) => { v.notes.push({ ...v.notes[0] }); },
  'unsafe path ID': (v) => { v.notes[0].id = '../escape'; },
  'blank group title': (v) => { v.groups[0].title = ' '; },
  'blank label': (v) => { v.labels[0].name = ''; },
  'untrimmed label': (v) => { v.labels[0].name = ' Plot '; },
  'duplicate exact-case labels': (v) => { v.labels.push({ id: 'l-other', name: 'Plot' }); },
  'unknown label assignment': (v) => { v.notes[0].labelIds = ['l-missing']; },
  'unknown sort mode': (v) => { v.root.sortMode = 'random'; },
  'duplicate child ordering': (v) => { v.groups[0].childOrder.push('n-mara'); },
  'missing child ordering': (v) => { v.groups[0].childOrder = []; },
  'wrong parent ordering': (v) => { v.root.childOrder.push('n-mara'); },
  'invalid timestamp': (v) => { v.notes[0].createdAt = 'yesterday'; },
  'invalid tombstone record': (v) => { v.tombstones = [{}]; }
};
for (const [name, mutate] of Object.entries(invalid)) {
  test('invalid index: ' + name, () => {
    const value = index();
    mutate(value);
    const before = JSON.stringify(value);
    assert.equal(validateIndex(value).status, 'invalid');
    assert.equal(JSON.stringify(value), before, 'validation must not silently repair evidence');
  });
}

test('a multi-group cycle is rejected', () => {
  const value = index();
  value.groups.push({ ...value.groups[0], id: 'g-second', parentId: 'g-cast', childOrder: ['g-cast'] });
  value.groups[0].parentId = 'g-second';
  value.groups[0].childOrder.push('g-second');
  value.root.childOrder = [];
  assert.equal(validateIndex(value).status, 'invalid');
});

for (const value of [null, [], 'not JSON', {}, { schemaVersion: 1 }]) {
  test('malformed index is reported, not defaulted: ' + JSON.stringify(value), () => {
    assert.equal(validateIndex(value).status, 'invalid');
  });
}

module.exports = { index };

test('model and store load together as classic browser scripts', async () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  const context = vm.createContext({});
  for (const file of ['planet-notes.js', 'planet-notes-store.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, { filename: file });
  }
  assert.equal(context.NeoPlanetNotes.validateIndex(index()).status, 'ok');
  const store = context.NeoPlanetNotesStore.createNotesStore({ read: async () => ({ status: 'missing' }) });
  assert.equal((await store.load()).status, 'missing');
});
