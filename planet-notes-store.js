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
    if (results.some((result) => result.status !== 'saved')) {
      const failure = error(results.some((result) => result.status === 'unavailable') ? 'ECLOUD' : 'EPENDING', 'A published notes operation must finish before another write');
      failure.pending = results.filter((result) => result.status !== 'saved');
      throw failure;
    }
  };
  return {
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
