'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict');
const { applyRecoveryChoices } = require('../planet-notes-recovery-selection');
const { applyAction } = require('../planet-notes-organization');
const copy = (v) => JSON.parse(JSON.stringify(v));
function fixture() {
  let index = { schemaVersion: 1, versionId: 'v-start', parentVersionIds: [], root: { sortMode: 'alphabetical', childOrder: [] }, groups: [], notes: [], labels: [], tombstones: [] };
  for (const id of ['g-a', 'g-b']) index = applyAction(index, { operationId: 'o-test', action: 'createGroup', parentId: null, title: id }, { id, createdAt: '2026-11-11T10:00:00.000Z' }).index;
  index.notes.push({ id: 'n-one', title: 'Writing', parentId: null, labelIds: [], createdAt: '2026-11-11T10:00:00.000Z' }); index.root.childOrder.push('n-one');
  return index;
}
const choose = (collection, id, field, side = 'incoming') => ({ collection, id, field, side });
test('recovered parent fields validate against current hierarchy and missing destinations', () => {
  const base = fixture();
  const incoming = applyAction(base, { operationId: 'o-test', action: 'move', itemId: 'g-a', parentId: 'g-b' }).index;
  const current = applyAction(base, { operationId: 'o-test', action: 'move', itemId: 'g-b', parentId: 'g-a' }).index;
  const record = { variants: { local: base, incoming } };
  assert.throws(() => applyRecoveryChoices(current, record, [choose('groups', 'g-a', 'parentId')]), { code: 'EINVAL' });
  const removed = applyAction(base, { operationId: 'o-test', action: 'deleteGroup', itemId: 'g-b' }).index;
  assert.throws(() => applyRecoveryChoices(removed, record, [choose('groups', 'g-a', 'parentId')]), { code: 'EINVAL' });
  assert.deepEqual(base.notes, current.notes);
});
test('field recovery preserves newer unrelated metadata and rejects invented or duplicate values', () => {
  const base = fixture(); const incoming = copy(base); incoming.notes[0].title = 'Other title';
  const current = copy(base); current.groups[0].title = 'Newer group';
  const record = { variants: { local: base, incoming } }; const selected = choose('notes', 'n-one', 'title');
  const next = applyRecoveryChoices(current, record, [selected]);
  assert.equal(next.notes[0].title, 'Other title'); assert.equal(next.groups[0].title, 'Newer group'); assert.equal(current.notes[0].title, 'Writing');
  for (const choices of [[selected, selected], [{ ...selected, value: 'Injected' }], [choose('notes', 'n-one', 'parentId')], []]) assert.throws(() => applyRecoveryChoices(current, record, choices), { code: 'EINVAL' });
});
test('combined existence and move selections are validated as a whole', () => {
  const base = fixture(); const incoming = applyAction(base, { operationId: 'o-test', action: 'createGroup', title: 'New', parentId: null }, { id: 'g-new', createdAt: '2026-11-11T10:00:00.000Z' }).index;
  const moved = applyAction(incoming, { operationId: 'o-test', action: 'move', itemId: 'n-one', parentId: 'g-new' }).index;
  const next = applyRecoveryChoices(base, { variants: { local: base, incoming: moved } }, [choose('notes', 'n-one', 'parentId'), choose('groups', 'g-new', '*')]);
  assert.equal(next.notes[0].parentId, 'g-new'); assert.deepEqual(next.groups.find(g => g.id === 'g-new').childOrder, ['n-one']);
});
test('note existence cannot bypass body-aware recovery', () => {
  const base = fixture(); const empty = copy(base); empty.notes = []; empty.root.childOrder = empty.root.childOrder.filter(id => id !== 'n-one');
  assert.throws(() => applyRecoveryChoices(empty, { variants: { local: empty, incoming: base } }, [choose('notes', 'n-one', '*')]), { code: 'EINVAL' });
});
