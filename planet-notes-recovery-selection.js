'use strict';
(function () {
const node = typeof module !== 'undefined' && module.exports;
const model = node ? require('./planet-notes') : globalThis.NeoPlanetNotes;
const copy = (value) => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (code, message) => Object.assign(new Error(message), { code });
const fields = { notes: ['title', 'parentId', 'labelIds'], groups: ['title', 'parentId', 'sortMode', 'childOrder'], labels: ['name'], root: ['sortMode', 'childOrder'] };
function recoveryChoices(record) {
  if (!record.variants || !['local', 'incoming'].every((side) => model.validateIndex(record.variants[side]).status === 'ok')) return [];
  const result = [];
  for (const collection of Object.keys(fields)) {
    const local = collection === 'root' ? [{ ...record.variants.local.root, id: null }] : record.variants.local[collection];
    const incoming = collection === 'root' ? [{ ...record.variants.incoming.root, id: null }] : record.variants.incoming[collection];
    const left = new Map(local.map((r) => [r.id, r])); const right = new Map(incoming.map((r) => [r.id, r]));
    for (const id of new Set([...left.keys(), ...right.keys()])) {
      const a = left.get(id); const b = right.get(id);
      const add = (field) => result.push({ collection, id, field, local: field === '*' ? a || null : a[field], incoming: field === '*' ? b || null : b[field], title: (a || b).title || (a || b).name || '' });
      if (!a || !b) add('*');
      else for (const field of fields[collection]) if (!same(a[field], b[field])) add(field);
    }
  }
  return result;
}
/** Apply only recorded choices, not arbitrary renderer values or full snapshots. */
function applyRecoveryChoices(current, record, selections) {
  if (model.validateIndex(current).status !== 'ok' || !Array.isArray(selections) || !selections.length) throw fail('EINVAL', 'Invalid recovery selection');
  const choices = recoveryChoices(record); const index = copy(current); const used = new Set();
  for (const selection of selections) {
    if (!selection || Object.keys(selection).some((k) => !['collection', 'id', 'field', 'side'].includes(k)) || !['local', 'incoming'].includes(selection.side)) throw fail('EINVAL', 'Invalid competing value');
    const identity = JSON.stringify([selection.collection, selection.id, selection.field]);
    const choice = choices.find((c) => c.collection === selection.collection && c.id === selection.id && c.field === selection.field);
    if (!choice || used.has(identity)) throw fail('EINVAL', 'Unknown or duplicate competing field');
    used.add(identity);
    const value = choice[selection.side];
    if (choice.field === '*') {
      // Note identity restoration/deletion uses the body-aware Trash/orphan paths.
      if (choice.collection === 'notes') throw fail('EINVAL', 'Recover note identities through Trash or Recovered Notes');
      const existing = index[choice.collection].find((r) => r.id === choice.id);
      if (value === null) {
        if (existing && choice.collection === 'groups') {
          const parent = existing.parentId === null ? index.root : index.groups.find((g) => g.id === existing.parentId);
          if (parent) { const at = parent.childOrder.indexOf(existing.id); if (at >= 0) parent.childOrder.splice(at, 1, ...existing.childOrder); }
          for (const item of [...index.groups, ...index.notes]) if (item.parentId === existing.id) item.parentId = existing.parentId;
          index.groups = index.groups.filter((g) => g.id !== existing.id);
        } else if (existing) {
          index.labels = index.labels.filter((l) => l.id !== existing.id);
          for (const note of index.notes) note.labelIds = note.labelIds.filter((id) => id !== existing.id);
        }
      } else if (existing) continue;
      else {
        if ([...index.groups, ...index.notes, ...index.labels].some((r) => r.id === choice.id)) throw fail('ECONFLICT', 'Recovery identity is occupied');
        index[choice.collection].push(copy(value));
      }
    } else {
      const target = choice.collection === 'root' ? index.root : index[choice.collection].find((r) => r.id === choice.id);
      if (!target) throw fail('ENOENT', 'Recovery target no longer exists');
      target[choice.field] = copy(value);
    }
  }
  // Relationships own membership. Keep chosen order for actual members and append
  // newer siblings; a recovered ordering may never remove or duplicate writing.
  for (const [parentId, parent] of [[null, index.root], ...index.groups.map((g) => [g.id, g])]) {
    const members = [...index.groups, ...index.notes].filter((r) => r.parentId === parentId).map((r) => r.id);
    parent.childOrder = [...new Set([...(parent.childOrder || []), ...members])].filter((id) => members.includes(id));
  }
  if (model.validateIndex(index).status !== 'ok') throw fail('EINVAL', 'Selected values create a cycle, missing destination, or invalid labels');
  return index;
}
const api = { recoveryChoices, applyRecoveryChoices };
if (node) module.exports = api;
else globalThis.NeoPlanetNotesRecoverySelection = api;
})();
