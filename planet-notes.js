'use strict';

// Isolate declarations when loaded alongside other classic browser scripts.
(function () {

/**
 * @typedef {{id:string,title:string,parentId:string|null,labelIds:string[],createdAt:string}} PlanetNote
 * @typedef {{id:string,title:string,parentId:string|null,sortMode:'alphabetical'|'manual',childOrder:string[],createdAt:string}} PlanetGroup
 * @typedef {{schemaVersion:1,versionId:string,parentVersionIds:string[],root:{sortMode:string,childOrder:string[]},groups:PlanetGroup[],notes:PlanetNote[],labels:{id:string,name:string}[],tombstones:Object[]}} PlanetIndex
 * @typedef {{status:'ok',index:PlanetIndex}|{status:'invalid',issues:string[]}|{status:'unsupported-version',version:number}} IndexValidation
 */
// Shared, non-mutating schema validation; no filesystem or DOM dependencies.
const safeId = (s) => typeof s === 'string' && /^[a-z][a-z0-9]*-[A-Za-z0-9-]{1,120}$/.test(s);
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** @param {unknown} value @returns {IndexValidation} */
function validateIndex(value) {
  const issues = [];
  const bad = (message) => { issues.push(message); };
  if (!object(value)) return { status: 'invalid', issues: ['Expected an index object'] };
  if (Number.isInteger(value.schemaVersion) && value.schemaVersion > 1) return { status: 'unsupported-version', version: value.schemaVersion };
  if (value.schemaVersion !== 1) bad('Unsupported schema');
  if (!safeId(value.versionId)) bad('Invalid version ID');
  if (!Array.isArray(value.parentVersionIds) || value.parentVersionIds.some((id) => !safeId(id) || id === value.versionId) || new Set(value.parentVersionIds).size !== value.parentVersionIds.length) bad('Invalid version ancestry');
  if (!['groups', 'notes', 'labels', 'tombstones'].every((key) => Array.isArray(value[key])) || !object(value.root)) return { status: 'invalid', issues: [...issues, 'Missing collections or root'] };
  const ids = new Set();
  const groups = new Map();
  const children = new Map([[null, []]]);
  const register = (item) => {
    if (!object(item)) { bad('Invalid record'); return false; }
    if (!safeId(item.id) || ids.has(item.id)) bad('Invalid or duplicate ID');
    ids.add(item.id);
    return true;
  };
  const dated = (item) => typeof item.createdAt === 'string' && /^\d{4}-\d\d-\d\dT/.test(item.createdAt) && Number.isFinite(Date.parse(item.createdAt));
  for (const g of value.groups) if (register(g)) { groups.set(g.id, g); children.set(g.id, []); }
  const roles = new Set();
  for (const group of groups.values()) {
    if (group.systemRole !== undefined) {
      if (group.systemRole !== 'recovered' || roles.has(group.systemRole)) bad('Invalid or duplicate system group role');
      roles.add(group.systemRole);
    }
  }
  const labels = new Set();
  const names = new Set();
  for (const l of value.labels) { if (register(l)) {
    labels.add(l.id);
    if (typeof l.name !== 'string' || !l.name.trim() || l.name !== l.name.trim() || names.has(l.name)) bad('Invalid or duplicate label name');
    names.add(l.name);
  } }
  const noteRecords = new Set(value.notes);
  for (const item of [...value.groups, ...value.notes]) {
    if (!object(item)) { bad('Invalid item'); continue; }
    if (noteRecords.has(item)) {
      register(item);
      if (!Array.isArray(item.labelIds) || item.labelIds.some((id) => !labels.has(id)) || new Set(item.labelIds).size !== item.labelIds.length) bad('Invalid label assignments');
    }
    if (typeof item.title !== 'string' || (groups.has(item.id) && !item.title.trim())) bad('Invalid title');
    if (!dated(item)) bad('Invalid creation date');
    if (item.parentId !== null && !groups.has(item.parentId)) bad('Missing parent');
    else children.get(item.parentId).push(item.id);
  }
  for (const [parent, container] of [[null, value.root], ...groups]) {
    if (!['alphabetical', 'manual'].includes(container.sortMode)) bad('Invalid sorting mode');
    const order = container.childOrder;
    const expected = children.get(parent);
    const expectedIds = new Set(expected);
    if (!Array.isArray(order) || new Set(order).size !== order.length || order.length !== expected.length || order.some((id) => !expectedIds.has(id))) bad('Invalid child order');
  }
  // Each node is visited at most twice; nesting does not consume call stack.
  const settled = new Set();
  for (const id of groups.keys()) {
    const path = new Set();
    let next = id;
    while (next !== null && groups.has(next) && !settled.has(next)) {
      if (path.has(next)) { bad('Group cycle'); break; }
      path.add(next);
      next = groups.get(next).parentId;
    }
    for (const seen of path) settled.add(seen);
  }
  const deletions = new Set();
  for (const entry of value.tombstones) {
    if (validateTombstone(entry).status !== 'ok' || deletions.has(entry.operationId)) bad('Invalid or duplicate tombstone');
    else deletions.add(entry.operationId);
  }
  return issues.length ? { status: 'invalid', issues } : { status: 'ok', index: value };
}
/** @typedef {{schemaVersion:1,id:string,noteId:string,operationId:string,createdAt:string,reason:'daily'|'external'|'restore',writingDay:string|null,bodyHash:string}} PlanetRevision */
/** @typedef {{schemaVersion:1,id:string,operationId:string,deletedAt:string,note:PlanetNote,originalPosition:number,labels:{id:string,name:string}[],bodyHash:string}} PlanetTrash */
/** @typedef {{kind:'note',id:string,operationId:string,trashId:string,deletedAt:string}} PlanetTombstone */
const validDate = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const validDay = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const unique = (values) => Array.isArray(values) && new Set(values).size === values.length;
const validNote = (note) => object(note) && safeId(note.id) && typeof note.title === 'string' && (note.parentId === null || safeId(note.parentId)) && unique(note.labelIds) && note.labelIds.every(safeId) && validDate(note.createdAt);
function recordResult(record, valid) {
  if (object(record) && Number.isInteger(record.schemaVersion) && record.schemaVersion > 1) return { status: 'unsupported-version', version: record.schemaVersion };
  return valid ? { status: 'ok', record } : { status: 'invalid', issues: ['Invalid recovery record'] };
}
function validateRevision(record) {
  const valid = object(record) && record.schemaVersion === 1 && safeId(record.id) && safeId(record.noteId) && safeId(record.operationId) && validDate(record.createdAt) && typeof record.bodyHash === 'string' && /^[a-f0-9]{64}$/.test(record.bodyHash) && ['daily', 'external', 'restore'].includes(record.reason) && (record.reason === 'daily' ? validDay(record.writingDay) : record.writingDay === null);
  return recordResult(record, valid);
}
function validateTrash(record) {
  const valid = object(record) && record.schemaVersion === 1 && safeId(record.id) && safeId(record.operationId) && validDate(record.deletedAt) && validNote(record.note) && Number.isSafeInteger(record.originalPosition) && record.originalPosition >= 0 && typeof record.bodyHash === 'string' && /^[a-f0-9]{64}$/.test(record.bodyHash) && Array.isArray(record.labels) && record.labels.every((label) => object(label) && safeId(label.id) && typeof label.name === 'string' && !!label.name.trim() && label.name === label.name.trim()) && unique(record.labels.map((l) => l.id)) && unique(record.labels.map((l) => l.name)) && record.note.labelIds.length === record.labels.length && record.note.labelIds.every((id) => record.labels.some((l) => l.id === id));
  return recordResult(record, valid);
}
function validateTombstone(record) {
  return recordResult(record, object(record) && record.kind === 'note' && safeId(record.id) && safeId(record.operationId) && safeId(record.trashId) && validDate(record.deletedAt));
}
const api = { validateIndex, safeId, validateRevision, validateTrash, validateTombstone, validDate, validDay };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.NeoPlanetNotes = api;

})();
