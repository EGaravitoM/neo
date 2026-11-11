'use strict';

(function () {
const model = typeof module !== 'undefined' && module.exports ? require('./planet-notes') : globalThis.NeoPlanetNotes;
const copy = (value) => JSON.parse(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const fail = (code, message) => Object.assign(new Error(message), { code });
const itemMap = (index) => new Map([...index.groups, ...index.notes].map((item) => [item.id, item]));
const container = (index, id) => {
  const parent = id === null ? index.root : index.groups.find((g) => g.id === id);
  if (!parent) throw fail('ENOENT', 'Destination group no longer exists');
  return parent;
};
const named = (name) => {
  if (typeof name !== 'string' || !name.trim()) throw fail('EINVAL', 'A name is required');
  return name.trim();
};
const fields = {
  createGroup: ['title', 'parentId'], rename: ['itemId', 'title'], move: ['itemId', 'parentId', 'beforeId'],
  deleteGroup: ['itemId'], trashNote: ['noteId'], sort: ['parentId', 'sortMode'], createLabel: ['name'],
  renameLabel: ['labelId', 'name', 'merge'], deleteLabel: ['labelId'], assignLabel: ['noteId', 'labelId', 'assigned']
};
/** Domain requests never contain paths, raw indexes or client-assigned versions. */
function validateAction(request) {
  if (!request || !Object.hasOwn(fields, request.action) || Object.keys(request).some((key) => !['operationId', 'action', ...fields[request.action]].includes(key)) || !model.safeId(request.operationId)) throw fail('EINVAL', 'Invalid organization request');
  const r = copy(request);
  for (const key of ['itemId', 'noteId', 'labelId']) if (fields[r.action].includes(key) && !model.safeId(r[key])) throw fail('EINVAL', 'Invalid item identity');
  if (fields[r.action].includes('parentId') && r.parentId !== null && !model.safeId(r.parentId)) throw fail('EINVAL', 'Invalid parent identity');
  if (r.beforeId !== undefined && r.beforeId !== null && !model.safeId(r.beforeId)) throw fail('EINVAL', 'Invalid sibling identity');
  if (['createGroup', 'rename'].includes(r.action)) {
    if (typeof r.title !== 'string') throw fail('EINVAL', 'Invalid title');
    r.title = r.action === 'createGroup' ? named(r.title) : r.title.trim();
  }
  if (['createLabel', 'renameLabel'].includes(r.action)) r.name = named(r.name);
  if (r.action === 'sort' && !['alphabetical', 'manual'].includes(r.sortMode)) throw fail('EINVAL', 'Invalid sort mode');
  if (r.merge !== undefined && typeof r.merge !== 'boolean') throw fail('EINVAL', 'Invalid merge choice');
  if (r.action === 'assignLabel' && typeof r.assigned !== 'boolean') throw fail('EINVAL', 'Invalid label assignment');
  return r;
}
function canMove(index, itemId, parentId) {
  const items = itemMap(index); const item = items.get(itemId);
  if (!item || (parentId !== null && !index.groups.some((g) => g.id === parentId))) return false;
  const seen = new Set(); let id = parentId;
  while (id !== null) {
    if (id === itemId || seen.has(id)) return false;
    seen.add(id); id = items.get(id)?.parentId;
    if (id === undefined) return false;
  }
  return true;
}
/** Stable ties use the parent's stored sequence, independently of display mode. */
function sortedChildren(index, parentId = null, locale) {
  const parent = container(index, parentId); const items = itemMap(index);
  const children = parent.childOrder.map((id) => items.get(id));
  if (parent.sortMode === 'manual') return children;
  const groups = new Set(index.groups.map((g) => g.id));
  const collator = new Intl.Collator(locale || undefined);
  return children.sort((a, b) => Number(groups.has(b.id)) - Number(groups.has(a.id)) || collator.compare(a.title, b.title));
}
/** Iterative flat tree: neither nesting nor collapsed navigation uses recursion. */
function visibleTree(index, expanded, locale) {
  const result = []; const groups = new Set(index.groups.map((g) => g.id));
  const pending = sortedChildren(index, null, locale).reverse().map((item) => ({ item, depth: 0 }));
  while (pending.length) {
    const row = pending.pop(); row.kind = groups.has(row.item.id) ? 'group' : 'note'; result.push(row);
    if (row.kind === 'group' && expanded.has(row.item.id)) {
      const children = sortedChildren(index, row.item.id, locale);
      for (let i = children.length - 1; i >= 0; i--) pending.push({ item: children[i], depth: row.depth + 1 });
    }
  }
  return result;
}
function pathTo(index, id) {
  const groups = new Map(index.groups.map((g) => [g.id, g])); const result = []; const seen = new Set();
  while (id !== null && groups.has(id) && !seen.has(id)) { seen.add(id); const group = groups.get(id); result.push(group); id = group.parentId; }
  return result.reverse();
}
function deleteGroup(index, id) {
  const group = index.groups.find((g) => g.id === id);
  if (!group) throw fail('ENOENT', 'Group no longer exists');
  const parent = container(index, group.parentId); const at = parent.childOrder.indexOf(id);
  parent.childOrder.splice(at, 1, ...group.childOrder);
  for (const item of [...index.groups, ...index.notes]) if (item.parentId === id) item.parentId = group.parentId;
  index.groups = index.groups.filter((g) => g.id !== id);
}
function deleteLabel(index, id) {
  index.labels = index.labels.filter((l) => l.id !== id);
  for (const note of index.notes) note.labelIds = note.labelIds.filter((labelId) => labelId !== id);
}
/** Pure metadata mutation plan. Server supplies any new identity and clock. */
function applyAction(source, request, { id, createdAt, locale } = {}) {
  if (model.validateIndex(source).status !== 'ok') throw fail('EINVAL', 'Invalid collection');
  const r = validateAction(request); const index = copy(source); const items = itemMap(index);
  const item = items.get(r.itemId);
  const label = index.labels.find((l) => l.id === r.labelId);
  let resultId = r.itemId || r.labelId || r.noteId;
  switch (r.action) {
    case 'createGroup': {
      if (!model.safeId(id) || !model.validDate(createdAt) || [...items.keys(), ...index.labels.map((l) => l.id)].includes(id)) throw fail('EINVAL', 'Invalid new group identity');
      container(index, r.parentId).childOrder.push(id);
      index.groups.push({ id, title: r.title, parentId: r.parentId, sortMode: 'alphabetical', childOrder: [], createdAt }); resultId = id; break;
    }
    case 'rename':
      if (!item) throw fail('ENOENT', 'Item no longer exists');
      if (index.groups.includes(item)) named(r.title);
      item.title = r.title; break;
    case 'move': {
      if (!canMove(index, r.itemId, r.parentId)) throw fail('EINVAL', 'Invalid move or hierarchy cycle');
      if (r.beforeId === r.itemId) throw fail('EINVAL', 'Cannot drop before itself');
      if (item.parentId === r.parentId && !Object.hasOwn(r, 'beforeId')) break;
      const target = container(index, r.parentId);
      if (r.beforeId != null && !target.childOrder.includes(r.beforeId)) throw fail('EINVAL', 'Sibling no longer exists');
      if (Object.hasOwn(r, 'beforeId') && target.sortMode === 'alphabetical') target.childOrder = sortedChildren(index, r.parentId, locale).map((child) => child.id);
      const previous = container(index, item.parentId);
      previous.childOrder = previous.childOrder.filter((child) => child !== item.id);
      item.parentId = r.parentId;
      // The explicit presence of beforeId means reorder, even at the end.
      if (Object.hasOwn(r, 'beforeId')) target.sortMode = 'manual';
      const at = r.beforeId == null ? target.childOrder.length : target.childOrder.indexOf(r.beforeId);
      target.childOrder.splice(at, 0, item.id); break;
    }
    case 'deleteGroup': deleteGroup(index, r.itemId); break;
    case 'trashNote': throw fail('EINVAL', 'Trashing needs the storage recovery operation');
    case 'sort': {
      const parent = container(index, r.parentId);
      if (r.sortMode === 'manual' && parent.sortMode !== 'manual') parent.childOrder = sortedChildren(index, r.parentId, locale).map((child) => child.id);
      parent.sortMode = r.sortMode; break;
    }
    case 'createLabel':
      if (index.labels.some((l) => l.name === r.name)) throw fail('EDUPLICATE', 'Label already exists');
      if (!model.safeId(id) || [...items.keys(), ...index.labels.map((l) => l.id)].includes(id)) throw fail('EINVAL', 'Invalid label identity');
      index.labels.push({ id, name: r.name }); resultId = id; break;
    case 'renameLabel': {
      if (!label) throw fail('ENOENT', 'Label no longer exists');
      const target = index.labels.find((l) => l.name === r.name && l.id !== label.id);
      if (target) {
        if (!r.merge) throw fail('EMERGE', 'Explicit label merge required');
        for (const note of index.notes) if (note.labelIds.includes(label.id) && !note.labelIds.includes(target.id)) note.labelIds.push(target.id);
        deleteLabel(index, label.id); resultId = target.id;
      } else label.name = r.name;
      break;
    }
    case 'deleteLabel': if (!label) throw fail('ENOENT', 'Label no longer exists'); deleteLabel(index, label.id); break;
    case 'assignLabel': {
      const note = index.notes.find((n) => n.id === r.noteId);
      if (!note || !label) throw fail('ENOENT', 'Note or label no longer exists');
      if (r.assigned && !note.labelIds.includes(label.id)) note.labelIds.push(label.id);
      if (!r.assigned) note.labelIds = note.labelIds.filter((l) => l !== label.id);
      break;
    }
  }
  if (model.validateIndex(index).status !== 'ok') throw fail('EINVAL', 'Organization would violate collection invariants');
  return { index, resultId, changed: !same(index, source) };
}
// One inverse-order policy for both root and group containers. New siblings
// survive; a competing reorder of known siblings requires explicit resolution.
function undoChildOrder(current, before, after, message) {
  const known = new Set(after);
  if (!same(current.filter((id) => known.has(id)), after)) throw fail('ECONFLICT', message);
  return [...before, ...current.filter((id) => !known.has(id) && !before.includes(id))];
}
/** Undo touches only fields changed by this action; never any HTML or revision.
 * Competing changes to touched fields reject instead of overwriting a device. */
function undoAction(current, before, after, request) {
  for (const value of [current, before, after]) if (model.validateIndex(value).status !== 'ok') throw fail('EINVAL', 'Invalid undo snapshot');
  const index = copy(current);
  if (request.action === 'createGroup') {
    const created = after.groups.find((g) => !before.groups.some((old) => old.id === g.id));
    const currentGroup = index.groups.find((g) => g.id === created.id);
    if (!currentGroup || ['title', 'parentId', 'sortMode', 'createdAt'].some((field) => !same(currentGroup[field], created[field]))) throw fail('ECONFLICT', 'Created group changed on another device');
    deleteGroup(index, created.id);
  } else if (request.action === 'createLabel') {
    const created = after.labels.find((l) => !before.labels.some((old) => old.id === l.id));
    const currentLabel = index.labels.find((l) => l.id === created.id);
    if (!currentLabel || currentLabel.name !== created.name) throw fail('ECONFLICT', 'Created label changed on another device');
    deleteLabel(index, created.id);
  } else {
    const sets = ['groups', 'notes', 'labels'];
    for (const collection of sets) {
      const left = new Map(before[collection].map((r) => [r.id, r])); const right = new Map(after[collection].map((r) => [r.id, r]));
      for (const id of new Set([...left.keys(), ...right.keys()])) {
        const b = left.get(id); const a = right.get(id); const c = index[collection].find((r) => r.id === id);
        if (same(b, a)) continue;
        if (!a) {
          if (c || [...index.groups, ...index.notes, ...index.labels].some((r) => r.id === id)) throw fail('ECONFLICT', 'Undo identity is occupied');
          index[collection].push(copy(b)); continue;
        }
        if (!c) throw fail('ECONFLICT', 'Undo target no longer exists');
        for (const field of new Set([...Object.keys(b), ...Object.keys(a)])) {
          if (same(b[field], a[field])) continue;
          if (field === 'childOrder') {
            c[field] = undoChildOrder(c[field], b[field], a[field], 'Sibling order changed since this action');
          } else if (field === 'labelIds') {
            const touched = new Set([...b[field], ...a[field]].filter((v) => b[field].includes(v) !== a[field].includes(v)));
            if ([...touched].some((v) => c[field].includes(v) !== a[field].includes(v))) throw fail('ECONFLICT', 'Label assignment changed since this action');
            c[field] = [...c[field].filter((v) => !touched.has(v)), ...b[field].filter((v) => touched.has(v))];
          } else {
            if (!same(c[field], a[field])) throw fail('ECONFLICT', 'Organization changed since this action');
            if (b[field] === undefined) delete c[field]; else c[field] = copy(b[field]);
          }
        }
      }
    }
    for (const field of ['sortMode', 'childOrder']) {
      if (same(before.root[field], after.root[field])) continue;
      if (field === 'childOrder') {
        index.root.childOrder = undoChildOrder(index.root.childOrder, before.root.childOrder, after.root.childOrder, 'Root order changed');
      } else {
        if (index.root[field] !== after.root[field]) throw fail('ECONFLICT', 'Root sorting changed');
        index.root[field] = before.root[field];
      }
    }
  }
  if (model.validateIndex(index).status !== 'ok') throw fail('ECONFLICT', 'Undo would create invalid hierarchy or labels');
  return index;
}
const api = { validateAction, applyAction, undoAction, canMove, sortedChildren, visibleTree, pathTo };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.NeoPlanetNotesOrganization = api;
})();
