'use strict';
const at = '2026-11-12T10:00:00.000Z';
/** Synthetic flat-on-disk hierarchy. Counts are fixture sizes, never app limits. */
function createStressFixture({ noteCount = 20, groupCount = 4, depth = 2, seed = 7301 } = {}) {
  for (const value of [noteCount, groupCount, depth, seed]) if (!Number.isSafeInteger(value) || value < 0) throw new Error('Fixture values must be nonnegative integers');
  if (depth > groupCount) throw new Error('Depth exceeds group count');
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state; };
  const index = { schemaVersion: 1, versionId: 'v-stress1', parentVersionIds: [], root: { sortMode: 'alphabetical', childOrder: [] }, groups: [], notes: [], labels: [{ id: 'l-lower', name: 'plot' }, { id: 'l-upper', name: 'Plot' }, { id: 'l-reference', name: 'reference' }], tombstones: [] };
  const parents = new Map([[null, index.root]]); const bodies = {};
  for (let i = 0; i < groupCount; i++) {
    const id = 'g-stress' + (i + 1); const parentId = i > 0 && i < depth ? 'g-stress' + i : null;
    const group = { id, title: 'Group ' + (i + 1), parentId, sortMode: i % 2 ? 'manual' : 'alphabetical', childOrder: [], createdAt: at };
    index.groups.push(group); parents.set(id, group); parents.get(parentId).childOrder.push(id);
  }
  for (let i = 0; i < noteCount; i++) {
    const id = 'n-stress' + (i + 1); const parentId = groupCount ? depth === groupCount ? 'g-stress' + depth : 'g-stress' + (random() % groupCount + 1) : null;
    const title = i % 23 === 0 ? '' : i % 17 === 0 ? 'Shared title' : 'Note ' + String(i + 1).padStart(6, '0') + ' ' + random().toString(36);
    const labelIds = [i % 2 ? 'l-upper' : 'l-lower']; if (i % 3 === 0) labelIds.push('l-reference');
    index.notes.push({ id, title, parentId, labelIds, createdAt: at }); parents.get(parentId).childOrder.push(id);
    const marker = 'token_' + String(i + 1).padStart(8, '0') + '_end';
    bodies[id] = { marker, html: '<p>Preserve these author words ' + marker + ' <em>café 日本語</em>.</p>' };
  }
  return { seed, noteCount, groupCount, depth, index, bodies };
}
const profiles = {
  smoke: [{ id: 'smoke', noteCount: 20, groupCount: 4, depth: 2 }],
  full: [
    ...[100, 1000, 10000].map(noteCount => ({ id: 'wide-' + noteCount, noteCount, groupCount: Math.ceil(Math.sqrt(noteCount)), depth: 1 })),
    ...[100, 1000, 5000].map(depth => ({ id: 'deep-' + depth, noteCount: 1, groupCount: depth, depth })),
    { id: 'mixed-3000', noteCount: 3000, groupCount: 200, depth: 40 }
  ]
};
module.exports = { createStressFixture, profiles };
