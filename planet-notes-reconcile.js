'use strict';

(function () {
const model = typeof module !== 'undefined' && module.exports ? require('./planet-notes') : globalThis.NeoPlanetNotes;
const copy = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
// Record fields have bounded depth; the group hierarchy itself uses ID references.
const canonical = (value) => value === undefined ? 'undefined' : JSON.stringify(value, (_key, item) => item && !Array.isArray(item) && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const equal = (a, b) => canonical(a) === canonical(b);
/** Pure three-way reconciliation. Inputs and evidence are never mutated. */
function mergeNotesIndex(request) {
  if (!request || !model.safeId(request.versionId) || !['base', 'local', 'incoming'].every((key) => model.validateIndex(request[key]).status === 'ok') || [request.local.versionId, request.incoming.versionId, request.base.versionId].includes(request.versionId)) return { status: 'invalid', issues: ['Invalid merge input'] };
  const { base, local, incoming } = request;
  if (local.versionId === incoming.versionId && !equal(local, incoming)) return { status: 'invalid', issues: ['Conflicting snapshots share a version ID'] };
  const changes = [];
  const choose = (b, l, r, collection, id, field) => {
    if (equal(l, r)) return copy(l);
    if (equal(l, b)) return copy(r);
    if (equal(r, b)) return copy(l);
    changes.push({ collection, id, field, base: copy(b) ?? null, local: copy(l) ?? null, incoming: copy(r) ?? null });
    return copy(l);
  };
  const mergeRecords = (collection, key = 'id') => {
    const maps = [base, local, incoming].map((branch) => new Map(branch[collection].map((record) => [record[key], record])));
    const merged = [];
    for (const id of new Set([...maps[1].keys(), ...maps[2].keys(), ...maps[0].keys()])) {
      const [b, l, r] = maps.map((map) => map.get(id));
      if (!l || !r || !b) {
        const value = choose(b, l, r, collection, id, '*');
        if (value) merged.push(value);
      } else {
        const value = {};
        for (const field of new Set([...Object.keys(l), ...Object.keys(r), ...Object.keys(b)])) {
          const selected = choose(b[field], l[field], r[field], collection, id, field);
          if (selected !== undefined) value[field] = selected;
        }
        merged.push(value);
      }
    }
    return merged;
  };
  const index = {
    ...copy(local), versionId: request.versionId,
    parentVersionIds: [...new Set([local.versionId, incoming.versionId])],
    root: Object.fromEntries([...new Set([...Object.keys(base.root), ...Object.keys(local.root), ...Object.keys(incoming.root)])].map((key) => [key, choose(base.root[key], local.root[key], incoming.root[key], 'root', null, key)])),
    groups: mergeRecords('groups'), notes: mergeRecords('notes'), labels: mergeRecords('labels')
  };
  // A deletion event is immutable evidence: never remove it via a stale branch.
  const tombstones = new Map();
  for (const branch of [base, incoming, local]) { for (const record of branch.tombstones) {
    const old = tombstones.get(record.operationId);
    if (old && !equal(old, record)) changes.push({ collection: 'tombstones', id: record.operationId, field: '*', base: null, local: copy(record), incoming: copy(old) });
    tombstones.set(record.operationId, copy(record));
  } }
  index.tombstones = [...tombstones.values()];
  // Membership is authoritative; each actual child appears once in its parent.
  for (const [parentId, parent] of [[null, index.root], ...index.groups.map((g) => [g.id, g])]) {
    const members = [...index.groups, ...index.notes].filter((item) => item.parentId === parentId).map((item) => item.id);
    const valid = new Set(members);
    const lists = [parent.childOrder, ...[local, incoming, base].map((branch) => (parentId === null ? branch.root : branch.groups.find((g) => g.id === parentId))?.childOrder || []), members];
    parent.childOrder = [...new Set(lists.flat().filter((id) => valid.has(id)))];
  }
  const variants = { base: copy(base), local: copy(local), incoming: copy(incoming) };
  const conflicts = changes.length ? [{ kind: 'metadata', variants, changes }] : [];
  if (model.validateIndex(index).status !== 'ok') {
    // Preserve a valid local view and every incoming value in durable evidence.
    const fallback = { ...copy(local), versionId: request.versionId, parentVersionIds: index.parentVersionIds, tombstones: index.tombstones };
    const kind = new Set(index.labels.map((l) => l.name)).size !== index.labels.length ? 'metadata' : 'hierarchy';
    conflicts.push({ kind, variants, changes: [{ collection: 'index', field: '*', reason: 'Combined branch invariants conflict' }] });
    return { status: 'ok', index: fallback, conflicts };
  }
  return { status: 'ok', index, conflicts };
}
function validateConflict(record) {
  const object = record && typeof record === 'object' && !Array.isArray(record);
  if (object && Number.isInteger(record.schemaVersion) && record.schemaVersion > 1) return { status: 'unsupported-version', version: record.schemaVersion };
  let valid = object && record.schemaVersion === 1 && model.safeId(record.id) && model.safeId(record.operationId) && model.validDate(record.createdAt);
  if (valid && ['metadata', 'hierarchy'].includes(record.kind)) valid = record.variants && ['base', 'local', 'incoming'].every((key) => model.validateIndex(record.variants[key]).status === 'ok');
  else if (valid && record.kind === 'body') valid = model.safeId(record.sourceNoteId) && model.safeId(record.recoveredNoteId) && ['baseHtml', 'localHtml', 'incomingHtml'].every((key) => typeof record[key] === 'string');
  else if (valid && record.kind === 'edit-delete') valid = model.safeId(record.sourceNoteId) && model.safeId(record.recoveredNoteId) && model.safeId(record.trashId) && typeof record.deletedHtml === 'string' && typeof record.incomingHtml === 'string';
  else valid = false;
  return valid ? { status: 'ok', record } : { status: 'invalid', issues: ['Invalid conflict evidence'] };
}
const api = { mergeNotesIndex, validateConflict };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.NeoPlanetNotesReconcile = api;
})();
