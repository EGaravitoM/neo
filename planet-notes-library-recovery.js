'use strict';
(function () {
const node = typeof module !== 'undefined' && module.exports;
const { hash } = node ? require('./planet-notes-history') : globalThis.NeoPlanetNotesHistory;
const model = node ? require('./planet-notes') : globalThis.NeoPlanetNotes;
const selection = node ? require('./planet-notes-recovery-selection') : globalThis.NeoPlanetNotesRecoverySelection;
const organization = node ? require('./planet-notes-organization') : globalThis.NeoPlanetNotesOrganization;
const json = JSON.stringify;
const clone = (v) => JSON.parse(json(v));
const digest = (v) => hash(json(v));
const fail = (code, message) => Object.assign(new Error(message), { code });
const required = (r) => { if (r.status !== 'ok') throw fail(r.status === 'unavailable' ? 'ECLOUD' : r.status === 'missing' ? 'ENOENT' : 'EINVAL', 'Recovery source: ' + r.status); return r; };
const id = (v) => { if (!model.safeId(v)) throw fail('EINVAL', 'Invalid recovery identity'); };
const fields = (r, allowed) => { if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).some((k) => !allowed.includes(k))) throw fail('EINVAL', 'Invalid recovery request'); };
/** Main-only domain operations. Host owns the shared book queue. */
function createLibraryRecovery({ adapter, store, makeId, now, remember }) {
  const commandPath = (op) => 'recovery/view-commands/' + op + '.json';
  const completionPath = (op) => 'recovery/view-completions/' + op + '.json';
  const decode = async (text) => {
    let envelope;
    try { envelope = JSON.parse(text); } catch { throw fail('EINVAL', 'Invalid recovery journal'); }
    const p = envelope?.plan;
    if (!p || envelope.digest !== await digest(p) || p.schemaVersion !== 1 || !model.safeId(p.request?.operationId) || !['restoreTrash', 'restoreRevision', 'apply'].includes(p.compiled?.method)) throw fail('EINVAL', 'Invalid recovery command');
    if (p.compiled.request.operationId !== p.request.operationId) throw fail('EINVAL', 'Recovery identity mismatch');
    return p;
  };
  const artifact = async (path, text) => {
    const before = await adapter.read(path);
    if (before.status === 'missing') await adapter.writeDurable(path, text);
    else if (required(before).text !== text) throw fail('EINVAL', 'Recovery evidence identity collision');
    if (required(await adapter.read(path)).text !== text) throw fail('EIO', 'Recovery evidence verification failed');
  };
  const commandConflict = async (operationId) => {
    id(operationId);
    const source = await adapter.read('recovery/organization-commands/' + operationId + '.json');
    if (source.status !== 'ok') return source;
    let envelope;
    try { envelope = JSON.parse(source.text); } catch { return { status: 'invalid' }; }
    const p = envelope?.plan;
    if (!p || envelope.digest !== await digest(p) || p.request?.operationId !== operationId || !['organize', 'undo'].includes(p.kind) || model.validateIndex(p.after).status !== 'ok' || (p.before !== null && model.validateIndex(p.before).status !== 'ok')) return { status: 'invalid' };
    try { if (p.kind === 'organize') organization.validateAction(p.request); else if (Object.keys(p.request).some((key) => key !== 'operationId')) return { status: 'invalid' }; } catch { return { status: 'invalid' }; }
    const done = await adapter.read('recovery/organization-completions/' + operationId + '.json');
    if (done.status !== 'ok') return done;
    if (done.text !== json({ digest: await digest(p), status: 'conflict' })) return { status: 'missing' };
    const current = required(await store.load());
    let incoming = current.index;
    const marker = await adapter.read((p.compiled ? 'recovery/abandoned-history/' : 'recovery/abandoned-metadata/') + operationId + '.json');
    if (marker.status === 'unavailable') return marker;
    if (marker.status === 'ok') {
      let record; try { record = JSON.parse(marker.text); } catch { return { status: 'invalid' }; }
      if (model.validateIndex(record.index).status !== 'ok') return { status: 'invalid' };
      incoming = record.index;
    }
    return { status: 'ok', record: { id: operationId, kind: 'organization', createdAt: p.after.groups.find((g) => !p.before?.groups.some((old) => old.id === g.id))?.createdAt || null, variants: { local: p.after, incoming }, action: p.request.action } };
  };
  const read = async (request) => {
    fields(request, ['kind', 'id', 'noteId']); id(request.id);
    let result;
    if (request.kind === 'trash') result = await store.readTrash(request.id);
    else if (request.kind === 'revision') { id(request.noteId); result = await store.readRevision(request.noteId, request.id); }
    else if (request.kind === 'conflict') result = await store.readConflict(request.id);
    else if (request.kind === 'organization') result = await commandConflict(request.id);
    else throw fail('EINVAL', 'Unknown recovery source');
    const loaded = await store.load();
    return { ...result, versionId: loaded.status === 'ok' ? loaded.index.versionId : null, ...(result.record?.variants ? { choices: selection.recoveryChoices(result.record) } : {}) };
  };
  const list = async (request) => {
    fields(request, ['kind', 'noteId']);
    if (!['trash', 'revisions', 'conflicts'].includes(request.kind)) throw fail('EINVAL', 'Invalid recovery collection');
    if (request.kind === 'revisions') id(request.noteId);
    else if (request.noteId !== undefined) throw fail('EINVAL', 'Unexpected note identity');
    const entries = [];
    for (const path of (await adapter.list()).sort()) {
      let ref; let match;
      if (request.kind === 'trash' && (match = /^trash\/([^/]+)\/record\.json$/.exec(path))) {
        if (!model.safeId(match[1])) continue;
        const restored = await adapter.read('trash/' + match[1] + '/restored.json');
        if (restored.status === 'ok') {
          let marker; try { marker = JSON.parse(restored.text); } catch { entries.push({ ref: { kind: 'trash', id: match[1] }, status: 'invalid' }); continue; }
          if (marker.trashId === match[1] && model.safeId(marker.operationId) && model.safeId(marker.versionId)) continue;
        }
        ref = { kind: 'trash', id: match[1] };
        if (restored.status === 'unavailable') { entries.push({ ref, status: 'unavailable' }); continue; }
      } else if (request.kind === 'revisions' && (match = /^revisions\/([^/]+)\/([^/]+)\.json$/.exec(path)) && match[1] === request.noteId && model.safeId(match[2])) ref = { kind: 'revision', noteId: request.noteId, id: match[2] };
      else if (request.kind === 'conflicts' && (match = /^conflicts\/([^/]+)\.json$/.exec(path)) && model.safeId(match[1])) ref = { kind: 'conflict', id: match[1] };
      else if (request.kind === 'conflicts' && (match = /^recovery\/organization-commands\/([^/]+)\.json$/.exec(path)) && model.safeId(match[1])) ref = { kind: 'organization', id: match[1] };
      if (!ref) continue;
      let value;
      try { value = await read(ref); } catch (err) { value = { status: err.code === 'EINVAL' ? 'invalid' : 'unavailable' }; }
      if (ref.kind === 'organization' && value.status === 'missing') continue;
      entries.push({ ref, ...value });
    }
    return { status: 'ok', entries, complete: entries.every((e) => e.status === 'ok') };
  };
  const completion = async (plan) => {
    const source = await adapter.read(completionPath(plan.request.operationId));
    if (source.status === 'missing') return null;
    const text = required(source).text;
    let record;
    try { record = JSON.parse(text); } catch { throw fail('EINVAL', 'Invalid recovery completion'); }
    if (record.digest !== await digest(plan) || !['saved', 'conflict'].includes(record.result?.status)) throw fail('EINVAL', 'Recovery completion mismatch');
    return record.result;
  };
  const execute = async (plan) => {
    const done = await completion(plan); if (done) return done;
    let result = await store[plan.compiled.method](plan.compiled.request);
    if (result.status === 'conflict') {
      const preserved = plan.compiled.method === 'apply'
        ? await store.abandonMetadata(plan.compiled.request)
        : await store.abandonRecoveryHistory(plan.compiled.method === 'restoreTrash' ? 'restore-trash' : 'restore-revision', plan.compiled.request);
      result = preserved.status === 'saved' ? preserved : { status: 'conflict' };
    } else if (result.status === 'conflict-preserved') result = { status: 'conflict' };
    if (result.status !== 'saved' && result.status !== 'conflict') return result;
    result = { ...result, ...(result.status === 'saved' ? { noteId: plan.noteId } : {}) };
    await artifact(completionPath(plan.request.operationId), json({ digest: await digest(plan), result }));
    if (result.status === 'saved') await remember();
    return result;
  };
  const settle = async () => {
    for (const path of (await adapter.list()).filter((p) => /^recovery\/view-commands\/[^/]+\.json$/.test(p)).sort()) {
      const plan = await decode(required(await adapter.read(path)).text);
      if (commandPath(plan.request.operationId) !== path) throw fail('EINVAL', 'Mismatched recovery journal');
      if (!await completion(plan)) {
        const result = await execute(plan);
        if (!['saved', 'conflict'].includes(result.status)) throw fail('EPENDING', 'An earlier recovery command is pending');
      }
    }
  };
  const perform = async (request) => {
    fields(request, ['operationId', 'kind', 'id', 'noteId', 'mode', 'expectedVersionId', 'selections']); id(request.operationId); id(request.id);
    if (!['trash', 'revision', 'conflict', 'organization'].includes(request.kind)) throw fail('EINVAL', 'Unknown recovery command');
    if (request.expectedVersionId !== undefined) id(request.expectedVersionId);
    if (request.kind === 'revision') { id(request.noteId); if (!['replace', 'new'].includes(request.mode) || request.selections !== undefined) throw fail('EINVAL', 'Invalid revision restoration'); }
    else if (request.noteId !== undefined || request.mode !== undefined) throw fail('EINVAL', 'Unexpected body restoration fields');
    if (request.kind === 'trash' && request.selections !== undefined) throw fail('EINVAL', 'Unexpected metadata selection');
    const old = await adapter.read(commandPath(request.operationId)); let plan;
    if (old.status === 'ok') {
      plan = await decode(old.text);
      if (json(plan.request) !== json(request)) throw fail('EINVAL', 'Recovery operation identity reused');
    } else {
      if (old.status !== 'missing') required(old);
      const current = required(await store.load());
      if (request.expectedVersionId !== undefined && request.expectedVersionId !== current.index.versionId) return { status: 'conflict' };
      const source = required(await read({ kind: request.kind, id: request.id, ...(request.noteId ? { noteId: request.noteId } : {}) }));
      const versionId = makeId('v'); const common = { operationId: request.operationId, baseVersionId: current.index.versionId, versionId, createdAt: now() };
      let compiled; let noteId = null;
      if (request.kind === 'trash') {
        noteId = source.record.note.id;
        compiled = { method: 'restoreTrash', request: { ...common, trashId: request.id } };
      } else if (request.kind === 'revision') {
        const body = required(await store.read(request.noteId));
        noteId = request.mode === 'new' ? makeId('n') : request.noteId;
        compiled = { method: 'restoreRevision', request: { ...common, noteId: request.noteId, revisionId: request.id, mode: request.mode, expectedBodyToken: body.bodyToken, ...(request.mode === 'new' ? { newNoteId: noteId } : {}) } };
      } else {
        if (!request.expectedVersionId) throw fail('EINVAL', 'Recovery requires the displayed metadata version');
        const nextIndex = selection.applyRecoveryChoices(current.index, source.record, request.selections);
        nextIndex.versionId = versionId; nextIndex.parentVersionIds = [current.index.versionId];
        compiled = { method: 'apply', request: { operationId: request.operationId, baseVersionId: current.index.versionId, nextIndex, bodies: [] } };
      }
      plan = { schemaVersion: 1, request: clone(request), noteId, compiled, source };
      await artifact(commandPath(request.operationId), json({ plan, digest: await digest(plan) }));
    }
    return execute(plan);
  };
  return { list, read, perform, settle };
}
const api = { createLibraryRecovery };
if (node) module.exports = api;
else globalThis.NeoPlanetNotesLibraryRecovery = api;
})();
