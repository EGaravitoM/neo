'use strict';

// Isolate declarations when loaded alongside other classic browser scripts.
(function () {

// Internal persistence protocol, deliberately not exposed as a raw IPC writer.
// Adapter: read(path), writeDurable(path,text), remove(path), list().
// Paths are relative to one notes directory. Missing and unavailable differ.
const model = typeof module !== 'undefined' && module.exports ? require('./planet-notes') : globalThis.NeoPlanetNotes;
const queues = new WeakMap();
const error = (code, message) => Object.assign(new Error(message), { code });
function createNotesStore(adapter) {
  const serial = (fn) => {
    const task = (queues.get(adapter) || Promise.resolve()).catch(() => {}).then(fn);
    queues.set(adapter, task);
    return task;
  };
  const snapshotCommand = (command, request) => {
    let snapshot;
    try { snapshot = JSON.parse(JSON.stringify(request)); } catch { return Promise.reject(error('EINVAL', 'Invalid request')); }
    return serial(() => command(snapshot));
  };
  const idCheck = (id) => { if (!model.safeId(id)) throw error('EINVAL', 'Invalid ID'); };
  // Exact source token, not a short collision-prone hash. Kept internal/in memory.
  const token = (text) => text;
  const load = async () => {
    const r = await adapter.read('index.json');
    if (r.status !== 'ok') return r;
    let index;
    try { index = JSON.parse(r.text); } catch { return { status: 'invalid', issues: ['Invalid JSON'] }; }
    const result = model.validateIndex(index);
    return result.status === 'ok' ? { ...result, indexToken: r.text } : result;
  };
  const read = async (id) => {
    idCheck(id);
    const r = await adapter.read(id + '.html');
    return r.status === 'ok' ? { status: 'ok', html: r.text, bodyToken: token(r.text) } : r;
  };
  const ensure = async (path, text, immutable = false) => {
    const current = await adapter.read(path);
    if (current.status === 'unavailable') throw error('ECLOUD', 'File unavailable: ' + path);
    if (immutable && current.status === 'ok' && current.text !== text) throw error('ECONFLICT', 'Recovery identity collision: ' + path);
    if (current.status !== 'ok' || current.text !== text) await adapter.writeDurable(path, text);
  };
  // A re-read is a newly observed version, not permission to overwrite it.
  // This narrows races but does not claim atomic compare-and-swap across devices.
  const replaceCanonical = async (path, text, expected) => {
    const current = await adapter.read(path);
    if (current.status === 'unavailable') throw error('ECLOUD', 'File unavailable: ' + path);
    const observed = current.status === 'ok' ? current.text : null;
    if (observed !== expected) return false;
    if (observed !== text) await adapter.writeDurable(path, text);
    return true;
  };
  const validateRequest = (r) => {
    if (!r || !model.safeId(r.operationId) || (r.baseVersionId !== null && !model.safeId(r.baseVersionId)) || model.validateIndex(r.nextIndex).status !== 'ok' || !Array.isArray(r.bodies)) throw error('EINVAL', 'Invalid persistence request');
    if (r.nextIndex.versionId === r.baseVersionId || (r.baseVersionId !== null && !r.nextIndex.parentVersionIds.includes(r.baseVersionId))) throw error('EINVAL', 'Invalid version transition');
    const seen = new Set();
    for (const b of r.bodies) {
      if (!b || !model.safeId(b.noteId) || seen.has(b.noteId) || typeof b.html !== 'string' || (b.expectedBodyToken !== null && typeof b.expectedBodyToken !== 'string') || !r.nextIndex.notes.some((n) => n.id === b.noteId)) throw error('EINVAL', 'Invalid body request');
      seen.add(b.noteId);
    }
  };
  const execute = async (request, recovering = false) => {
    validateRequest(request);
    const intentPath = 'recovery/operations/' + request.operationId + '.json';
    const receiptPath = 'recovery/receipts/' + request.operationId + '.json';
    const encoded = JSON.stringify(request);
    const abandoned = await adapter.read('recovery/abandoned-metadata/' + request.operationId + '.json');
    if (abandoned.status === 'unavailable') throw error('ECLOUD', 'Organization conflict evidence unavailable');
    if (abandoned.status === 'ok') {
      let record;
      try { record = JSON.parse(abandoned.text); } catch { throw error('EINVAL', 'Invalid organization conflict evidence'); }
      if (JSON.stringify(record.request) !== encoded || model.validateIndex(record.index).status !== 'ok') throw error('EINVAL', 'Organization conflict identity reused');
      return { status: 'conflict-preserved' };
    }
    const receipt = await adapter.read(receiptPath);
    if (receipt.status === 'unavailable') throw error('ECLOUD', 'Receipt unavailable');
    if (receipt.status === 'ok') {
      if (receipt.text !== encoded) throw error('EINVAL', 'Operation ID reused with different content');
      return { status: 'saved', versionId: request.nextIndex.versionId };
    }
    const intent = await adapter.read(intentPath);
    if (intent.status === 'unavailable') throw error('ECLOUD', 'Operation unavailable');
    if (intent.status === 'ok' && intent.text !== encoded) throw error('EINVAL', 'Operation ID reused');
    const current = await load();
    if (!['ok', 'missing'].includes(current.status)) throw error(current.status === 'unavailable' ? 'ECLOUD' : 'EINVAL', 'Index cannot be written: ' + current.status);
    const version = current.status === 'ok' ? current.index.versionId : null;
    const alreadyPublished = version === request.nextIndex.versionId;
    if (alreadyPublished && JSON.stringify(current.index) !== JSON.stringify(request.nextIndex)) return { status: 'conflict' };
    if (!alreadyPublished && version !== request.baseVersionId) return { status: 'conflict' };
    // Removal/trashed content is a later task: refuse, do not silently drop it.
    if (current.status === 'ok' && current.index.notes.some((n) => !request.nextIndex.notes.some((next) => next.id === n.id))) throw error('EINVAL', 'Use the future trash operation to remove notes');
    const observedBodies = new Map();
    for (const b of request.bodies) {
      const disk = await read(b.noteId);
      if (disk.status === 'unavailable') throw error('ECLOUD', 'Body unavailable');
      const observed = disk.status === 'ok' ? disk.bodyToken : null;
      observedBodies.set(b.noteId, observed);
      if (observed !== b.expectedBodyToken && !((recovering || intent.status === 'ok') && observed === b.html)) return { status: 'conflict' };
    }
    // Resolve every untouched reference before making ANY durable mutations.
    // Requested bodies may be absent: this operation will create them.
    for (const note of request.nextIndex.notes) {
      if (observedBodies.has(note.id)) continue;
      const body = await read(note.id);
      if (body.status !== 'ok') throw error(body.status === 'unavailable' ? 'ECLOUD' : 'ENOENT', 'Referenced body unavailable');
    }
    if (current.status === 'ok' && !alreadyPublished) await ensure('recovery/index-versions/' + version + '.json', JSON.stringify(current.index), true);
    for (const b of request.bodies) if (b.expectedBodyToken !== null) await ensure('recovery/inputs/' + request.operationId + '/' + b.noteId + '.html', b.expectedBodyToken, true);
    await ensure(intentPath, encoded, true);
    for (const b of request.bodies) {
      if (!await replaceCanonical(b.noteId + '.html', b.html, observedBodies.get(b.noteId))) return { status: 'conflict' };
    }
    // New entries must never publish references to absent/unavailable bodies.
    for (const note of request.nextIndex.notes) {
      const body = await read(note.id);
      if (body.status !== 'ok') throw error(body.status === 'unavailable' ? 'ECLOUD' : 'ENOENT', 'Referenced body unavailable');
    }
    if (!await replaceCanonical('index.json', JSON.stringify(request.nextIndex), current.status === 'ok' ? current.indexToken : null)) return { status: 'conflict' };
    const verified = await load();
    if (verified.status !== 'ok' || JSON.stringify(verified.index) !== JSON.stringify(request.nextIndex)) throw error('EIO', 'Index verification failed');
    for (const b of request.bodies) {
      const body = await read(b.noteId);
      if (body.status !== 'ok' || body.html !== b.html) throw error('EIO', 'Body verification failed');
    }
    // Receipts are retained; no cleanup/retention policy is implemented yet.
    await ensure(receiptPath, encoded, true);
    return { status: 'saved', versionId: request.nextIndex.versionId };
  };
  const recoverBase = async (publishedVersion = null) => {
    const results = await history.recover(publishedVersion);
    for (const path of (await adapter.list()).filter((p) => /^recovery\/operations\/[a-z][a-z0-9]*-[A-Za-z0-9-]+\.json$/.test(p)).sort()) {
      const record = await adapter.read(path);
      if (record.status !== 'ok') { results.push({ path, status: record.status }); continue; }
      let request;
      try { request = JSON.parse(record.text); } catch {
        if (publishedVersion === null) results.push({ path, status: 'invalid' });
        continue;
      }
      if (publishedVersion !== null && request?.nextIndex?.versionId !== publishedVersion) continue;
      try { validateRequest(request); } catch { results.push({ path, status: 'invalid' }); continue; }
      if (path !== 'recovery/operations/' + request.operationId + '.json') { results.push({ path, status: 'invalid' }); continue; }
      results.push({ path, ...await execute(request, true) });
    }
    return results;
  };
  // Lazy loading keeps Task 2.1 browser users working without history loaded.
  let historyModule;
  const history = {};
  const getHistory = () => {
    if (!historyModule) {
      const api = typeof module !== 'undefined' && module.exports ? require('./planet-notes-history') : globalThis.NeoPlanetNotesHistory;
      if (!api) throw error('EINVAL', 'History module is not loaded');
      historyModule = api.createNotesHistory({ adapter, load, read, ensure, replaceCanonical, beforeWrite: settlePublished });
    }
    return historyModule;
  };
  history.recover = async (publishedVersion = null) => {
    // No history module is needed when no history operations have been persisted.
    if (!(await adapter.list()).some((p) => p.startsWith('recovery/history-operations/'))) return [];
    return getHistory().recover(publishedVersion);
  };
  const command = (name, r) => {
    let copy;
    try { copy = JSON.parse(JSON.stringify(r)); } catch { return Promise.reject(error('EINVAL', 'Invalid history request')); }
    return serial(() => getHistory()[name](copy));
  };
  let recoveryModule;
  const getRecovery = () => {
    if (!recoveryModule) {
      const api = typeof module !== 'undefined' && module.exports ? require('./planet-notes-recovery') : globalThis.NeoPlanetNotesRecovery;
      if (!api) throw error('EINVAL', 'Recovery module is not loaded');
      recoveryModule = api.createNotesRecovery({ adapter, load, read, ensure, replaceCanonical, getHistory, beforeWrite: settlePublished, recoverPending: async () => [...await recoverBase(), ...await getRecovery().recover()] });
    }
    return recoveryModule;
  };
  const recoveryCommand = (name, r) => {
    let request;
    try { request = JSON.parse(JSON.stringify(r)); } catch { return Promise.reject(error('EINVAL', 'Invalid reconciliation request')); }
    return serial(() => getRecovery()[name](request));
  };
  const recover = async () => {
    const results = await recoverBase();
    if ((await adapter.list()).some((p) => p.startsWith('recovery/reconcile-operations/'))) results.push(...await getRecovery().recover());
    return results;
  };
  // A published operation may have failed only its final receipt. Finish it
  // while its exact version is still current, before any later write advances it.
  // Module recovery is unqueued/internal, so this never re-enters the public queue.
  const settlePublished = async () => {
    const current = await load();
    if (current.status === 'missing') return;
    if (current.status !== 'ok') throw error(current.status === 'unavailable' ? 'ECLOUD' : 'EINVAL', 'Cannot settle the current notes version');
    const results = await recoverBase(current.index.versionId);
    if ((await adapter.list()).some((path) => path.startsWith('recovery/reconcile-operations/'))) results.push(...await getRecovery().recover(current.index.versionId));
    if (results.some((result) => !['saved', 'conflict-preserved'].includes(result.status))) {
      const failure = error(results.some((result) => result.status === 'unavailable') ? 'ECLOUD' : 'EPENDING', 'A published notes operation must finish before another write');
      failure.pending = results.filter((result) => result.status !== 'saved');
      throw failure;
    }
  };
  const abandonMetadata = async (request) => {
    validateRequest(request);
    if (request.bodies.length) throw error('EINVAL', 'Body writes cannot be retired as metadata');
    const receipt = await adapter.read('recovery/receipts/' + request.operationId + '.json');
    if (receipt.status === 'unavailable') throw error('ECLOUD', 'Metadata receipt unavailable');
    if (receipt.status === 'ok') {
      if (receipt.text !== JSON.stringify(request)) throw error('EINVAL', 'Metadata operation identity reused');
      return { status: 'saved', versionId: request.nextIndex.versionId };
    }
    if (request.baseVersionId === null) {
      if (request.nextIndex.notes.length) throw error('EINVAL', 'Initial writing cannot be retired as metadata');
    } else {
      const base = await loadArchivedIndex(request.baseVersionId);
      if (base.notes.length !== request.nextIndex.notes.length || base.notes.some((n) => !request.nextIndex.notes.some((next) => next.id === n.id))) throw error('EINVAL', 'Retired metadata cannot create or delete writing');
    }
    const current = await load();
    if (current.status !== 'ok') throw error(current.status === 'unavailable' ? 'ECLOUD' : current.status === 'missing' ? 'ENOENT' : 'EINVAL', 'Current metadata unavailable');
    if (current.index.versionId === request.nextIndex.versionId) throw error('EPENDING', 'Published metadata cannot be retired');
    const path = 'recovery/abandoned-metadata/' + request.operationId + '.json';
    const previous = await adapter.read(path);
    if (previous.status === 'missing') await ensure(path, JSON.stringify({ request, index: current.index }), true);
    else {
      if (previous.status !== 'ok') throw error('ECLOUD', 'Metadata conflict evidence unavailable');
      let record;
      try { record = JSON.parse(previous.text); } catch { throw error('EINVAL', 'Invalid metadata conflict evidence'); }
      if (JSON.stringify(record.request) !== JSON.stringify(request) || model.validateIndex(record.index).status !== 'ok') throw error('EINVAL', 'Metadata conflict identity reused');
    }
    return { status: 'conflict-preserved' };
  };
  const loadArchivedIndex = async (id) => {
    const source = await adapter.read('recovery/index-versions/' + id + '.json');
    if (source.status !== 'ok') throw error(source.status === 'unavailable' ? 'ECLOUD' : 'ENOENT', 'Metadata base unavailable');
    let index;
    try { index = JSON.parse(source.text); } catch { throw error('EINVAL', 'Invalid metadata base'); }
    if (model.validateIndex(index).status !== 'ok' || index.versionId !== id) throw error('EINVAL', 'Invalid metadata base');
    return index;
  };
  // A metadata-only command can be represented by a later reconciled index
  // without ever publishing its intermediate index. Prove ancestry and preserve
  // its exact snapshot before issuing its original idempotence receipt.
  const acknowledgeMergedMetadata = async (request) => {
    validateRequest(request);
    if (request.bodies.length || request.baseVersionId === null) return { status: 'conflict' };
    const current = await load();
    if (current.status !== 'ok') return current;
    const pending = [current.index]; const visited = new Set(); let represented = false;
    while (pending.length) {
      const index = pending.pop();
      if (visited.has(index.versionId)) continue;
      visited.add(index.versionId);
      if (index.versionId === request.nextIndex.versionId) {
        if (JSON.stringify(index) !== JSON.stringify(request.nextIndex)) throw error('EINVAL', 'Merged command identity collision');
        represented = true; break;
      }
      for (const id of index.parentVersionIds) {
        const source = await adapter.read('recovery/index-versions/' + id + '.json');
        if (source.status !== 'ok') continue;
        let archived;
        try { archived = JSON.parse(source.text); } catch { throw error('EINVAL', 'Invalid merge ancestry'); }
        if (model.validateIndex(archived).status !== 'ok' || archived.versionId !== id) throw error('EINVAL', 'Invalid merge ancestry');
        pending.push(archived);
      }
    }
    if (!represented) return { status: 'conflict' };
    const base = await adapter.read('recovery/index-versions/' + request.baseVersionId + '.json');
    if (base.status !== 'ok') return { status: 'conflict' };
    let original;
    try { original = JSON.parse(base.text); } catch { throw error('EINVAL', 'Invalid metadata base'); }
    if (model.validateIndex(original).status !== 'ok' || original.notes.length !== request.nextIndex.notes.length || original.notes.some((n) => !request.nextIndex.notes.some((next) => next.id === n.id))) throw error('EINVAL', 'Merged acknowledgment cannot create or delete writing');
    await ensure('recovery/index-versions/' + request.nextIndex.versionId + '.json', JSON.stringify(request.nextIndex), true);
    await ensure('recovery/receipts/' + request.operationId + '.json', JSON.stringify(request), true);
    return { status: 'saved', versionId: request.nextIndex.versionId };
  };
  return {
    abandonInitialMetadata: (r) => snapshotCommand((copy) => { if (copy.baseVersionId !== null) throw error('EINVAL', 'Expected initial metadata'); return abandonMetadata(copy); }, r),
    abandonMetadata: (r) => snapshotCommand(abandonMetadata, r),
    abandonMetadataResolution: (r) => snapshotCommand((copy) => getRecovery().abandonMetadata(copy), r),
    abandonOrganizationHistory: (kind, r) => snapshotCommand((copy) => getHistory().abandonOrganization(kind, copy), r),
    acknowledgeMergedMetadata: (r) => snapshotCommand(acknowledgeMergedMetadata, r),
    preserveBodyConflict: (r) => recoveryCommand('preserveBodyConflict', r),
    reconcileMetadata: (r) => recoveryCommand('reconcileMetadata', r),
    recoverEditedDeletion: (r) => recoveryCommand('recoverEditedDeletion', r),
    recoverOrphans: (r) => recoveryCommand('recoverOrphans', r),
    listConflicts: () => serial(() => getRecovery().listConflicts()),
    readConflict: (id) => serial(() => getRecovery().readConflict(id)),
    saveNote: (r) => command('saveNote', r),
    listRevisions: (noteId) => serial(() => getHistory().listRevisions(noteId)),
    readRevision: (noteId, revisionId) => serial(() => getHistory().readRevision(noteId, revisionId)),
    trashNote: (r) => command('trashNote', r),
    listTrash: () => serial(() => getHistory().listTrash()),
    readTrash: (trashId) => serial(() => getHistory().readTrash(trashId)),
    restoreTrash: (r) => command('restoreTrash', r),
    restoreRevision: (r) => command('restoreRevision', r),
    load: () => serial(load), read: (id) => serial(() => read(id)), apply: (r) => {
    // Snapshot caller-owned input before the asynchronous queue runs.
    let copy;
    try { copy = JSON.parse(JSON.stringify(r)); } catch { return Promise.reject(error('EINVAL', 'Invalid request')); }
    return serial(async () => {
      validateRequest(copy);
      await settlePublished();
      return execute(copy);
    });
  }, recover: () => serial(recover) };
}
const api = { createNotesStore };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.NeoPlanetNotesStore = api;

})();
