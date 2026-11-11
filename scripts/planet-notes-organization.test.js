'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const domain = require('../planet-notes-organization');
const { validateIndex } = require('../planet-notes');
const at = '2026-11-10T10:00:00.000Z';
const empty = () => ({ schemaVersion: 1, versionId: 'v-start', parentVersionIds: [], root: { sortMode: 'alphabetical', childOrder: [] }, groups: [], notes: [], labels: [], tombstones: [] });
const act = (index, action, fields, id) => domain.applyAction(index, { operationId: 'o-test', action, ...fields }, { id, createdAt: at, locale: 'en' }).index;
function fixture() {
  let index = act(empty(), 'createGroup', { title: 'Characters', parentId: null }, 'g-characters');
  index = act(index, 'createGroup', { title: 'Antagonists', parentId: 'g-characters' }, 'g-nested');
  for (const [id, title] of [['n-first', 'Zelda'], ['n-second', 'Amy'], ['n-third', 'Amy']]) { index.notes.push({ id, title, parentId: null, labelIds: [], createdAt: at }); index.root.childOrder.push(id); }
  return index;
}

test('alphabetical view is groups first, locale aware, and stable for duplicate titles', () => {
  const index = fixture(); assert.deepEqual(domain.sortedChildren(index, null, 'en').map((n) => n.id), ['g-characters', 'n-second', 'n-third', 'n-first']);
  assert.deepEqual(index.root.childOrder, ['g-characters', 'n-first', 'n-second', 'n-third']);
});

test('manual mode retains explicit order after rename and appends new children', () => {
  let index = fixture(); index = act(index, 'move', { itemId: 'n-first', parentId: null, beforeId: 'n-second' });
  assert.equal(index.root.sortMode, 'manual');
  assert.deepEqual(index.root.childOrder, ['g-characters', 'n-first', 'n-second', 'n-third']);
  index = act(index, 'rename', { itemId: 'n-first', title: 'Aaron' });
  index = act(index, 'createGroup', { title: 'Locations', parentId: null }, 'g-locations');
  assert.deepEqual(domain.sortedChildren(index).map((n) => n.id), ['g-characters', 'n-first', 'n-second', 'n-third', 'g-locations']);
});

test('reordering an alphabetical parent freezes the displayed sequence first', () => {
  const index = act(fixture(), 'move', { itemId: 'n-first', parentId: null, beforeId: 'n-third' });
  assert.deepEqual(index.root.childOrder, ['g-characters', 'n-second', 'n-first', 'n-third']);
});

test('moves reject self-parenting, descendants and missing destinations', () => {
  const index = fixture();
  for (const parentId of ['g-characters', 'g-nested', 'g-missing']) assert.throws(() => act(index, 'move', { itemId: 'g-characters', parentId }), { code: 'EINVAL' });
  assert.equal(domain.canMove(index, 'n-first', 'g-nested'), true);
  assert.equal(validateIndex(index).status, 'ok');
});

test('deleting a group lifts immediate children and retains nested subtrees', () => {
  let index = act(fixture(), 'move', { itemId: 'n-first', parentId: 'g-nested' });
  index = act(index, 'move', { itemId: 'n-second', parentId: 'g-characters' });
  index = act(index, 'deleteGroup', { itemId: 'g-characters' });
  assert.equal(index.groups.find((g) => g.id === 'g-nested').parentId, null);
  assert.equal(index.notes.find((n) => n.id === 'n-first').parentId, 'g-nested');
  assert.equal(index.notes.find((n) => n.id === 'n-second').parentId, null);
  assert.equal(index.notes.length, 3); assert.equal(validateIndex(index).status, 'ok');
});

test('label spelling is trimmed, case-sensitive and independent of groups', () => {
  let index = act(fixture(), 'createLabel', { name: ' plot ' }, 'l-lower');
  index = act(index, 'createLabel', { name: 'Plot' }, 'l-upper');
  index = act(index, 'assignLabel', { noteId: 'n-first', labelId: 'l-lower', assigned: true });
  index = act(index, 'move', { itemId: 'n-second', parentId: 'g-nested' });
  index = act(index, 'assignLabel', { noteId: 'n-second', labelId: 'l-lower', assigned: true });
  assert.deepEqual(index.labels.map((l) => l.name), ['plot', 'Plot']);
  assert.throws(() => act(index, 'createLabel', { name: 'plot' }, 'l-duplicate'), { code: 'EDUPLICATE' });
  assert.throws(() => act(index, 'renameLabel', { labelId: 'l-upper', name: 'plot' }), { code: 'EMERGE' });
  const merged = act(index, 'renameLabel', { labelId: 'l-upper', name: 'plot', merge: true });
  assert.deepEqual(merged.labels.map((l) => l.id), ['l-lower']);
  assert.deepEqual(merged.notes.find((n) => n.id === 'n-second').labelIds, ['l-lower']);
});

test('label merge and deletion undo restore assignments without touching unrelated labels', () => {
  let before = act(fixture(), 'createLabel', { name: 'plot' }, 'l-one');
  before = act(before, 'createLabel', { name: 'Plot' }, 'l-two');
  before = act(before, 'assignLabel', { noteId: 'n-first', labelId: 'l-one', assigned: true });
  before = act(before, 'assignLabel', { noteId: 'n-second', labelId: 'l-two', assigned: true });
  for (const request of [{ action: 'renameLabel', labelId: 'l-one', name: 'Plot', merge: true }, { action: 'deleteLabel', labelId: 'l-one' }]) {
    const after = domain.applyAction(before, { operationId: 'o-test', ...request }).index;
    const current = act(after, 'createLabel', { name: 'New label' }, 'l-new');
    const undone = domain.undoAction(current, before, after, request);
    assert.deepEqual(undone.notes, before.notes); assert.ok(undone.labels.some((l) => l.id === 'l-new'));
  }
});

test('undo moves fields against the latest index and preserves new siblings', () => {
  const before = fixture(); const request = { operationId: 'o-test', action: 'move', itemId: 'n-first', parentId: 'g-nested' };
  const after = domain.applyAction(before, request).index;
  const current = act(after, 'createGroup', { title: 'New group', parentId: null }, 'g-new');
  current.versionId = 'v-newer';
  const undone = domain.undoAction(current, before, after, request);
  assert.equal(undone.notes.find((n) => n.id === 'n-first').parentId, null); assert.ok(undone.groups.some((g) => g.id === 'g-new'));
});

test('undo rejects concurrent moves or missing destinations instead of guessing', () => {
  const before = fixture(); const request = { operationId: 'o-test', action: 'move', itemId: 'n-first', parentId: 'g-nested' };
  const after = domain.applyAction(before, request).index;
  const current = act(after, 'move', { itemId: 'n-first', parentId: 'g-characters' });
  assert.throws(() => domain.undoAction(current, before, after, request), { code: 'ECONFLICT' });
});

test('undo group creation preserves children written or created afterward', () => {
  const before = fixture(); const request = { operationId: 'o-test', action: 'createGroup', title: 'New', parentId: null };
  const after = domain.applyAction(before, request, { id: 'g-new', createdAt: at }).index;
  const current = act(after, 'move', { itemId: 'n-first', parentId: 'g-new' });
  const undone = domain.undoAction(current, before, after, request);
  assert.equal(undone.notes.find((n) => n.id === 'n-first').parentId, null); assert.equal(undone.notes.length, 3);
});

test('blank note names and duplicate group names work but blank containers and labels do not', () => {
  let index = act(fixture(), 'rename', { itemId: 'n-first', title: '   ' }); assert.equal(index.notes[0].title, '');
  index = act(index, 'createGroup', { title: 'Characters', parentId: null }, 'g-duplicate'); assert.equal(index.groups.length, 3);
  assert.throws(() => act(index, 'createGroup', { title: ' ', parentId: null }, 'g-blank'), { code: 'EINVAL' });
  assert.throws(() => act(index, 'rename', { itemId: 'g-characters', title: '' }), { code: 'EINVAL' });
  assert.throws(() => act(index, 'createLabel', { name: '' }, 'l-blank'), { code: 'EINVAL' });
});

test('tree traversal and ancestor paths are iterative and reflect expansion', () => {
  const index = fixture(); assert.equal(domain.visibleTree(index, new Set()).length, 4);
  const rows = domain.visibleTree(index, new Set(['g-characters']));
  assert.equal(rows[1].item.id, 'g-nested'); assert.equal(rows[1].depth, 1);
  assert.deepEqual(domain.pathTo(index, 'g-nested').map((g) => g.id), ['g-characters', 'g-nested']);
});

test('domain validation refuses raw filesystem fields and malformed organization actions', () => {
  for (const request of [null, { operationId: 'o-test', action: 'move', itemId: 'n-first', parentId: null, path: '../x' }, { operationId: 'o-test', action: 'sort', parentId: null, sortMode: 'random' }, { operationId: 'o-test', action: 'assignLabel', noteId: 'n-first', labelId: 'l-one', assigned: 'yes' }]) assert.throws(() => domain.validateAction(request), { code: 'EINVAL' });
});
