'use strict';
(function () {
const node = typeof module !== 'undefined' && module.exports;

const { hash } = node ? require('./planet-notes-history') : globalThis.NeoPlanetNotesHistory;
const domain = node ? require('./planet-notes-organization') : globalThis.NeoPlanetNotesOrganization;
const model = node ? require('./planet-notes') : globalThis.NeoPlanetNotes;
const { createOrganizationResolution } = node ? require('./planet-notes-organization-resolution') : globalThis.NeoPlanetNotesOrganizationResolution;
const json = JSON.stringify;
const clone = (v) => JSON.parse(json(v));
const digest = (v) => hash(json(v));
const fail = (code, message) => Object.assign(new Error(message), { code });
const required = (r) => {
  if (r.status !== 'ok') throw fail(r.status === 'unavailable' ? 'ECLOUD' : r.status === 'missing' ? 'ENOENT' : 'EINVAL', 'Organization data: ' + r.status);
  return r;
};

/** Main-only durable organization commands. Host owns the shared book queue;
 * undo stacks are per renderer session, while all recovery evidence is durable. */
function createOrganizationService({ adapter, store, makeId, now, remember, locale }) {
  const sessions = new Map();
  const history = (session) => {
    if (!sessions.has(session)) sessions.set(session, { stack: [], seen: new Set() });
    return sessions.get(session);
  };
  const paths = (id) => ({ plan: 'recovery/organization-commands/' + id + '.json', done: 'recovery/organization-completions/' + id + '.json' });
  const decode = async (text) => {
    let envelope;
    try { envelope = JSON.parse(text); } catch { throw fail('EINVAL', 'Invalid organization journal'); }
    const p = envelope?.plan;
    if (!p || envelope.digest !== await digest(p) || p.schemaVersion !== 1 || !model.safeId(p.request?.operationId) || model.validateIndex(p.after).status !== 'ok' || (p.before !== null && model.validateIndex(p.before).status !== 'ok') || !['organize', 'undo'].includes(p.kind)) throw fail('EINVAL', 'Corrupt organization plan');
    if (p.kind === 'organize') domain.validateAction(p.request);
    if (p.compiled && (!['trashNote', 'restoreTrash'].includes(p.compiled.method) || p.compiled.request.operationId !== p.request.operationId || p.compiled.request.versionId !== p.after.versionId || p.compiled.request.baseVersionId !== p.before?.versionId)) throw fail('EINVAL', 'Invalid compiled history command');
    if (p.changed && (!p.before && p.after.parentVersionIds.length || p.before && !p.after.parentVersionIds.includes(p.before.versionId))) throw fail('EINVAL', 'Invalid organization ancestry');
    return p;
  };
  const resolution = createOrganizationResolution({ adapter, store, makeId, now, readPlan: async (id) => {
    if (!model.safeId(id)) throw fail('EINVAL', 'Invalid undo source identity');
    const source = await decode(required(await adapter.read(paths(id).plan)).text);
    if (source.request.operationId !== id || source.kind !== 'organize' || !source.changed) throw fail('EINVAL', 'Mismatched undo source journal');
    return source;
  } });
  const completion = async (plan) => {
    const result = await adapter.read(paths(plan.request.operationId).done);
    if (result.status === 'missing') return false;
    const text = required(result).text;
    if (text === json({ digest: await digest(plan) })) return 'saved';
    if (text === json({ digest: await digest(plan), status: 'conflict' })) return 'conflict';
    throw fail('EINVAL', 'Invalid organization completion');
  };
  const execute = async (plan) => {
    if (await completion(plan) === 'conflict') return { status: 'conflict' };
    let result = { status: 'saved', versionId: plan.after.versionId };
    if (plan.changed) { result = plan.compiled
      ? await store[plan.compiled.method](plan.compiled.request)
      : await store.apply({ operationId: plan.request.operationId, baseVersionId: plan.before?.versionId || null, nextIndex: plan.after, bodies: [] });
    }
    if (result.status === 'conflict-preserved') {
      await adapter.writeDurable(paths(plan.request.operationId).done, json({ digest: await digest(plan), status: 'conflict' }));
      return { status: 'conflict' };
    }
    if (result.status === 'conflict' && !plan.compiled && plan.before) {
      result = await resolution.resolve(plan);
      if (result.status === 'conflict-preserved') {
        await adapter.writeDurable(paths(plan.request.operationId).done, json({ digest: await digest(plan), status: 'conflict' }));
        return { status: 'conflict' };
      }
    }
    if (result.status === 'conflict' && !plan.before && !plan.compiled) {
      await store.abandonInitialMetadata({ operationId: plan.request.operationId, baseVersionId: null, nextIndex: plan.after, bodies: [] });
      await adapter.writeDurable(paths(plan.request.operationId).done, json({ digest: await digest(plan), status: 'conflict' }));
      return { status: 'conflict' };
    }
    if (result.status === 'conflict' && plan.compiled) {
      const retired = await store.abandonOrganizationHistory(plan.compiled.method === 'trashNote' ? 'trash' : 'restore-trash', plan.compiled.request);
      if (retired.status === 'conflict-preserved') {
        await adapter.writeDurable(paths(plan.request.operationId).done, json({ digest: await digest(plan), status: 'conflict' }));
        return { status: 'conflict' };
      }
      result = retired;
    }
    if (result.status !== 'saved') return result;
    if (!await completion(plan)) await adapter.writeDurable(paths(plan.request.operationId).done, json({ digest: await digest(plan) }));
    await remember();
    return { ...result, itemId: plan.resultId, changed: plan.changed };
  };
  const settle = async () => {
    for (const path of (await adapter.list('recovery/organization-commands')).filter((p) => /^recovery\/organization-commands\/[^/]+\.json$/.test(p)).sort()) {
      const plan = await decode(required(await adapter.read(path)).text);
      if (paths(plan.request.operationId).plan !== path) throw fail('EINVAL', 'Mismatched organization journal');
      if (await completion(plan)) continue;
      const result = await execute(plan);
      if (result.status !== 'saved' && !await completion(plan)) throw fail('EPENDING', 'Earlier organization command needs recovery');
    }
  };
  const perform = async (kind, request, session) => {
    const normalized = kind === 'organize' ? domain.validateAction(request) : request;
    if (kind === 'undo' && (!request || !model.safeId(request.operationId) || Object.keys(request).some((key) => key !== 'operationId'))) throw fail('EINVAL', 'Invalid organization undo');
    const path = paths(normalized.operationId).plan; const previous = await adapter.read(path);
    let plan;
    if (previous.status === 'ok') {
      plan = await decode(previous.text);
      if (plan.kind !== kind || json(plan.request) !== json(normalized)) throw fail('EINVAL', 'Organization identity reused');
    } else {
      if (previous.status !== 'missing') required(previous);
      const loaded = await store.load();
      if (loaded.status !== 'ok' && !(loaded.status === 'missing' && kind === 'organize' && ['createGroup', 'createLabel'].includes(normalized.action))) required(loaded);
      const before = loaded.status === 'ok' ? loaded.index : null;
      const versionId = makeId('v');
      const source = before || { schemaVersion: 1, versionId, parentVersionIds: [], root: { sortMode: 'alphabetical', childOrder: [] }, groups: [], notes: [], labels: [], tombstones: [] };
      let after; let resultId = null; let changed = true; let undoneOperationId = null; let compiled = null;
      if (kind === 'organize' && normalized.action === 'trashNote') {
        const note = source.notes.find((n) => n.id === normalized.noteId);
        if (!note) throw fail('ENOENT', 'Note no longer exists');
        const body = required(await store.read(note.id));
        const trashId = makeId('t'); const createdAt = now();
        after = clone(source); after.notes = after.notes.filter((n) => n.id !== note.id);
        const parent = note.parentId === null ? after.root : after.groups.find((g) => g.id === note.parentId);
        parent.childOrder = parent.childOrder.filter((id) => id !== note.id);
        after.tombstones.push({ kind: 'note', id: note.id, operationId: normalized.operationId, trashId, deletedAt: createdAt });
        resultId = note.id;
        compiled = { method: 'trashNote', request: { operationId: normalized.operationId, baseVersionId: source.versionId, versionId, noteId: note.id, expectedBodyToken: body.bodyToken, trashId, createdAt } };
      } else if (kind === 'organize') {
        const result = domain.applyAction(source, normalized, { id: ['createGroup', 'createLabel'].includes(normalized.action) ? makeId(normalized.action === 'createGroup' ? 'g' : 'l') : undefined, createdAt: now(), locale: locale() });
        ({ index: after, resultId, changed } = result);
      } else {
        const last = history(session).stack.at(-1);
        if (!last) throw fail('EUNDO', 'No organization action to undo in this session');
        if (last.request.action === 'trashNote') {
          after = clone(source);
          const trash = required(await store.readTrash(last.compiled.request.trashId));
          const note = clone(trash.record.note);
          if (!after.groups.some((g) => g.id === note.parentId)) note.parentId = null;
          note.labelIds = [];
          for (const label of trash.record.labels) {
            const existing = after.labels.find((l) => l.name === label.name);
            if (existing) note.labelIds.push(existing.id);
            else { after.labels.push(clone(label)); note.labelIds.push(label.id); }
          }
          after.notes.push(note);
          const parent = note.parentId === null ? after.root : after.groups.find((g) => g.id === note.parentId);
          parent.childOrder.splice(parent.sortMode === 'manual' ? Math.min(trash.record.originalPosition, parent.childOrder.length) : parent.childOrder.length, 0, note.id);
          // History restoration owns label/group fallback and body preservation.
          compiled = { method: 'restoreTrash', request: { operationId: normalized.operationId, baseVersionId: source.versionId, versionId, trashId: last.compiled.request.trashId, createdAt: now() } };
        } else after = domain.undoAction(source, last.before || { ...clone(last.after), groups: [], notes: [], labels: [], root: { sortMode: 'alphabetical', childOrder: [] } }, last.after, last.request);
        undoneOperationId = last.request.operationId;
      }
      if (changed) { after.versionId = versionId; after.parentVersionIds = before ? [before.versionId] : []; }
      if (model.validateIndex(after).status !== 'ok') throw fail('EINVAL', 'Invalid organization result');
      plan = { schemaVersion: 1, kind, request: normalized, before, after, resultId, changed, undoneOperationId, compiled };
      const envelope = json({ plan, digest: await digest(plan) });
      await adapter.writeDurable(path, envelope);
      if (required(await adapter.read(path)).text !== envelope) throw fail('EIO', 'Organization journal verification failed');
    }
    const result = await execute(plan);
    if (result.status === 'saved') {
      const state = history(session);
      if (!state.seen.has(normalized.operationId)) {
        if (kind === 'organize' && plan.changed) state.stack.push(plan);
        if (kind === 'undo' && state.stack.at(-1)?.request.operationId === plan.undoneOperationId) state.stack.pop();
        state.seen.add(normalized.operationId);
      }
      return { ...result, canUndo: state.stack.length > 0 };
    }
    return result;
  };
  return { settle, organize: (request, session) => perform('organize', request, session), undo: (request, session) => perform('undo', request, session), canUndo: (session) => history(session).stack.length > 0 };
}
const api = { createOrganizationService };
if (node) module.exports = api;
else globalThis.NeoPlanetNotesOrganizationService = api;
})();
