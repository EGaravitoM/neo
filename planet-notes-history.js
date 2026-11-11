'use strict';

(function () {
const model = typeof module !== 'undefined' && module.exports ? require('./planet-notes') : globalThis.NeoPlanetNotes;
const fail = (code, message) => Object.assign(new Error(message), { code });
const clone = (value) => JSON.parse(JSON.stringify(value));
const json = (value) => JSON.stringify(value);
async function hash(text) {
  if (typeof module !== 'undefined' && module.exports) return require('node:crypto').createHash('sha256').update(text, 'utf8').digest('hex');
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

// Runs inside the store's existing serialization queue; never calls queued methods.
function createNotesHistory({ adapter, load, read, ensure, replaceCanonical, beforeWrite = async () => {} }) {
  const id = (value) => { if (!model.safeId(value)) throw fail('EINVAL', 'Invalid recovery ID'); };
  const required = (result) => {
    if (result.status !== 'ok') throw fail(result.status === 'unavailable' ? 'ECLOUD' : result.status === 'missing' ? 'ENOENT' : 'EINVAL', 'Required notes input: ' + result.status);
    return result;
  };
  const readRecord = async (path, validator) => {
    const r = await adapter.read(path);
    if (r.status !== 'ok') return r;
    let record;
    try { record = JSON.parse(r.text); } catch { return { status: 'invalid', issues: ['Invalid JSON'] }; }
    return validator(record);
  };
  const readRevision = async (noteId, revisionId) => {
    id(noteId); id(revisionId);
    const base = 'revisions/' + noteId + '/' + revisionId;
    const metadata = await readRecord(base + '.json', model.validateRevision);
    if (metadata.status !== 'ok') return metadata;
    if (metadata.record.id !== revisionId || metadata.record.noteId !== noteId) return { status: 'invalid' };
    const body = await adapter.read(base + '.html');
    if (body.status !== 'ok') return body;
    if (await hash(body.text) !== metadata.record.bodyHash) return { status: 'invalid' };
    return { ...metadata, html: body.text };
  };
  const readTrash = async (trashId) => {
    id(trashId);
    const base = 'trash/' + trashId;
    const metadata = await readRecord(base + '/record.json', model.validateTrash);
    if (metadata.status !== 'ok') return metadata;
    if (metadata.record.id !== trashId) return { status: 'invalid' };
    const body = await adapter.read(base + '/note.html');
    if (body.status !== 'ok') return body;
    if (await hash(body.text) !== metadata.record.bodyHash) return { status: 'invalid' };
    return { ...metadata, html: body.text };
  };
  const listRevisions = async (noteId) => {
    id(noteId);
    const records = [];
    for (const path of await adapter.list()) {
      const match = /^revisions\/([^/]+)\/([^/]+)\.json$/.exec(path);
      if (!match || match[1] !== noteId) continue;
      records.push(required(await readRevision(noteId, match[2])).record);
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  };
  const listTrash = async () => {
    const records = [];
    for (const path of await adapter.list()) {
      const match = /^trash\/([^/]+)\/record\.json$/.exec(path);
      if (!match) continue;
      const entry = required(await readTrash(match[1]));
      const restored = await adapter.read('trash/' + match[1] + '/restored.json');
      if (restored.status === 'unavailable') throw fail('ECLOUD', 'Trash completion unavailable');
      if (restored.status === 'ok') {
        let completion;
        try { completion = JSON.parse(restored.text); } catch { throw fail('EINVAL', 'Invalid trash completion'); }
        if (!completion || completion.trashId !== match[1] || !model.safeId(completion.operationId) || !model.safeId(completion.versionId)) throw fail('EINVAL', 'Invalid trash completion');
      } else records.push(entry.record);
    }
    return records.sort((a, b) => a.deletedAt.localeCompare(b.deletedAt) || a.id.localeCompare(b.id));
  };
  const validateRequest = (kind, r) => {
    if (!r || !['save', 'trash', 'restore-trash', 'restore-revision'].includes(kind)) throw fail('EINVAL', 'Invalid history request');
    for (const key of ['operationId', 'baseVersionId', 'versionId']) id(r[key]);
    if (r.versionId === r.baseVersionId || !model.validDate(r.createdAt)) throw fail('EINVAL', 'Invalid history version/date');
    if (kind === 'restore-trash') id(r.trashId);
    else {
      id(r.noteId);
      if (typeof r.expectedBodyToken !== 'string') throw fail('EINVAL', 'Expected known body content');
    }
    if (kind === 'save' && (typeof r.html !== 'string' || !['daily', 'external'].includes(r.reason) || !model.validDay(r.writingDay))) throw fail('EINVAL', 'Invalid save');
    if (kind === 'trash') id(r.trashId);
    if (kind === 'restore-revision') {
      id(r.revisionId);
      if (!['replace', 'new'].includes(r.mode)) throw fail('EINVAL', 'Invalid restore mode');
      if (r.mode === 'new') { id(r.newNoteId); if (r.newNoteId === r.noteId) throw fail('EINVAL', 'Copy needs a fresh ID'); }
    }
  };
  const paths = (op) => ({ intent: 'recovery/history-operations/' + op + '.json', receipt: 'recovery/history-receipts/' + op + '.json' });
  const revision = async (r, html, reason) => ({
    record: { schemaVersion: 1, id: 'r-' + (await hash(r.operationId)).slice(0, 40), noteId: r.noteId, operationId: r.operationId, createdAt: r.createdAt, reason, writingDay: reason === 'daily' ? r.writingDay : null, bodyHash: await hash(html) }, html
  });
  const container = (index, parentId) => parentId === null ? index.root : index.groups.find((g) => g.id === parentId);
  const placeRestoredNote = (index, record) => {
    if ([...index.notes, ...index.groups, ...index.labels].some((item) => item.id === record.note.id)) return false;
    const note = clone(record.note);
    if (!index.groups.some((g) => g.id === note.parentId)) note.parentId = null;
    note.labelIds = [];
    for (const label of record.labels) {
      const exact = index.labels.find((l) => l.name === label.name);
      if (exact) note.labelIds.push(exact.id);
      else {
        if ([...index.labels, ...index.groups, ...index.notes].some((item) => item.id === label.id)) return false;
        index.labels.push(clone(label)); note.labelIds.push(label.id);
      }
    }
    index.notes.push(note);
    const parent = container(index, note.parentId);
    parent.childOrder.splice(parent.sortMode === 'manual' ? Math.min(record.originalPosition, parent.childOrder.length) : parent.childOrder.length, 0, note.id);
    return true;
  };
  const preflight = async (plan, published) => {
    for (const note of plan.nextIndex.notes) {
      const body = await read(note.id);
      if (plan.body && note.id === plan.body.noteId) {
        if (body.status === 'unavailable') throw fail('ECLOUD', 'Body unavailable');
        const text = body.status === 'ok' ? body.html : null;
        if (text !== plan.body.expected && text !== plan.body.html) return false;
      } else required(body);
    }
    if (plan.cleanup && !published) {
      const source = required(await read(plan.cleanup.noteId));
      if (source.html !== plan.cleanup.html) return false;
    }
    return true;
  };
  const prepare = async (kind, r) => {
    const current = required(await load());
    if (current.index.versionId !== r.baseVersionId) return { status: 'conflict' };
    const next = clone(current.index);
    next.versionId = r.versionId;
    next.parentVersionIds = [r.baseVersionId];
    const plan = { kind, request: r, previousIndex: current.index, previousToken: current.indexToken, nextIndex: next, body: null, revision: null, trash: null, cleanup: null, restoredTrashId: null, restoreSource: null };
    let note = next.notes.find((n) => n.id === r.noteId);
    if (kind === 'restore-trash') {
      const source = required(await readTrash(r.trashId));
      const restored = await adapter.read('trash/' + r.trashId + '/restored.json');
      if (restored.status === 'unavailable') throw fail('ECLOUD', 'Trash completion unavailable');
      if (restored.status === 'ok') return { status: 'conflict' };
      if (!next.tombstones.some((t) => t.trashId === r.trashId && t.id === source.record.note.id)) throw fail('EINVAL', 'Trash has no matching deletion');
      if (next.notes.some((n) => n.id === source.record.note.id) || next.groups.some((g) => g.id === source.record.note.id)) return { status: 'conflict' };
      const target = await read(source.record.note.id);
      if (target.status === 'unavailable') throw fail('ECLOUD', 'Restore destination unavailable');
      if (target.status !== 'missing') return { status: 'conflict' };
      if (!placeRestoredNote(next, source.record)) return { status: 'conflict' };
      note = next.notes.find((n) => n.id === source.record.note.id);
      plan.restoreSource = { record: source.record, html: source.html };
      plan.body = { noteId: note.id, expected: null, html: source.html };
      plan.restoredTrashId = r.trashId;
    } else {
      if (!note) throw fail('ENOENT', 'Note is not active');
      const source = required(await read(r.noteId));
      if (source.html !== r.expectedBodyToken) return { status: 'conflict' };
      if (kind === 'save') {
        if (source.html === r.html) return { status: 'saved', versionId: current.index.versionId };
        const revisions = await listRevisions(r.noteId);
        if (r.reason === 'external' || !revisions.some((item) => item.reason === 'daily' && item.writingDay === r.writingDay)) plan.revision = await revision(r, source.html, r.reason);
        plan.body = { noteId: r.noteId, expected: source.html, html: r.html };
      } else if (kind === 'trash') {
        const existing = await readTrash(r.trashId);
        if (existing.status === 'unavailable') throw fail('ECLOUD', 'Trash destination unavailable');
        if (existing.status !== 'missing') return { status: 'conflict' };
        const parent = container(next, note.parentId);
        plan.trash = { record: { schemaVersion: 1, id: r.trashId, operationId: r.operationId, deletedAt: r.createdAt, note: clone(note), originalPosition: parent.childOrder.indexOf(note.id), labels: next.labels.filter((l) => note.labelIds.includes(l.id)), bodyHash: await hash(source.html) }, html: source.html };
        parent.childOrder = parent.childOrder.filter((child) => child !== note.id);
        next.notes = next.notes.filter((n) => n.id !== note.id);
        next.tombstones.push({ kind: 'note', id: note.id, operationId: r.operationId, trashId: r.trashId, deletedAt: r.createdAt });
        plan.cleanup = { noteId: note.id, html: source.html };
      } else {
        const previous = required(await readRevision(r.noteId, r.revisionId));
        plan.restoreSource = { record: previous.record, html: previous.html };
        if (r.mode === 'new') {
          const target = await read(r.newNoteId);
          if (target.status === 'unavailable') throw fail('ECLOUD', 'Copy destination unavailable');
          if (target.status !== 'missing' || [...next.notes, ...next.groups, ...next.labels].some((item) => item.id === r.newNoteId)) return { status: 'conflict' };
          const copy = { ...clone(note), id: r.newNoteId, createdAt: r.createdAt };
          next.notes.push(copy); container(next, copy.parentId).childOrder.push(copy.id);
          plan.body = { noteId: copy.id, expected: null, html: previous.html };
        } else {
          plan.revision = await revision(r, source.html, 'restore');
          plan.body = { noteId: r.noteId, expected: source.html, html: previous.html };
        }
      }
    }
    if (model.validateIndex(next).status !== 'ok') throw fail('EINVAL', 'Invalid history result');
    if (!await preflight(plan, false)) return { status: 'conflict' };
    return plan;
  };
  const validatePlan = async (plan) => {
    try {
      if (!plan || typeof plan !== 'object') return false;
      validateRequest(plan.kind, plan.request);
      if (model.validateIndex(plan.previousIndex).status !== 'ok' || model.validateIndex(plan.nextIndex).status !== 'ok' || typeof plan.previousToken !== 'string' || json(JSON.parse(plan.previousToken)) !== json(plan.previousIndex)) return false;
      if (plan.previousIndex.versionId !== plan.request.baseVersionId || plan.nextIndex.versionId !== plan.request.versionId || json(plan.nextIndex.parentVersionIds) !== json([plan.request.baseVersionId])) return false;
      if (plan.body && (!model.safeId(plan.body.noteId) || typeof plan.body.html !== 'string' || (plan.body.expected !== null && typeof plan.body.expected !== 'string') || !plan.nextIndex.notes.some((n) => n.id === plan.body.noteId))) return false;
      if (plan.revision && (model.validateRevision(plan.revision.record).status !== 'ok' || typeof plan.revision.html !== 'string' || await hash(plan.revision.html) !== plan.revision.record.bodyHash || plan.revision.record.operationId !== plan.request.operationId || plan.revision.record.noteId !== plan.request.noteId)) return false;
      if (plan.trash && (model.validateTrash(plan.trash.record).status !== 'ok' || typeof plan.trash.html !== 'string' || await hash(plan.trash.html) !== plan.trash.record.bodyHash || plan.trash.record.id !== plan.request.trashId || plan.trash.record.operationId !== plan.request.operationId)) return false;
      if (plan.kind === 'trash') {
        if (!plan.trash || !plan.cleanup || plan.body || plan.revision || plan.restoredTrashId !== null || plan.cleanup.noteId !== plan.request.noteId || plan.cleanup.html !== plan.trash.html || plan.trash.record.note.id !== plan.request.noteId || plan.trash.html !== plan.request.expectedBodyToken || plan.nextIndex.notes.some((n) => n.id === plan.request.noteId) || !plan.nextIndex.tombstones.some((t) => t.operationId === plan.request.operationId && t.trashId === plan.request.trashId && t.id === plan.request.noteId)) return false;
      } else if (!plan.body || plan.cleanup || plan.trash) return false;
      if (plan.kind === 'restore-trash' && (plan.restoredTrashId !== plan.request.trashId || plan.revision || plan.body.expected !== null)) return false;
      if (plan.kind !== 'restore-trash' && plan.restoredTrashId !== null) return false;
      if (plan.kind === 'save' && (plan.body.noteId !== plan.request.noteId || plan.body.html !== plan.request.html || plan.body.expected !== plan.request.expectedBodyToken)) return false;
      if (plan.kind === 'restore-revision' && (plan.body.noteId !== (plan.request.mode === 'new' ? plan.request.newNoteId : plan.request.noteId) || (plan.request.mode === 'replace' && !plan.revision))) return false;
      if (plan.kind === 'restore-trash' || plan.kind === 'restore-revision') {
        const source = plan.restoreSource;
        const checked = source && (plan.kind === 'restore-trash' ? model.validateTrash(source.record) : model.validateRevision(source.record));
        if (!checked || checked.status !== 'ok' || typeof source.html !== 'string' || await hash(source.html) !== source.record.bodyHash || source.html !== plan.body.html) return false;
        if (plan.kind === 'restore-trash' ? source.record.id !== plan.request.trashId : source.record.id !== plan.request.revisionId || source.record.noteId !== plan.request.noteId) return false;
      } else if (plan.restoreSource !== null) return false;
      // Valid JSON is not sufficient: replay may only perform the requested delta.
      const expected = clone(plan.previousIndex);
      expected.versionId = plan.request.versionId;
      expected.parentVersionIds = [plan.request.baseVersionId];
      if (plan.kind === 'trash') {
        const note = expected.notes.find((n) => n.id === plan.request.noteId);
        if (!note || json(note) !== json(plan.trash.record.note)) return false;
        const parent = container(expected, note.parentId);
        if (parent.childOrder.indexOf(note.id) !== plan.trash.record.originalPosition || json(expected.labels.filter((l) => note.labelIds.includes(l.id))) !== json(plan.trash.record.labels)) return false;
        parent.childOrder = parent.childOrder.filter((child) => child !== note.id);
        expected.notes = expected.notes.filter((n) => n.id !== note.id);
        expected.tombstones.push({ kind: 'note', id: note.id, operationId: plan.request.operationId, trashId: plan.request.trashId, deletedAt: plan.request.createdAt });
      } else if (plan.kind === 'restore-trash') {
        if (!placeRestoredNote(expected, plan.restoreSource.record)) return false;
      } else if (plan.kind === 'restore-revision' && plan.request.mode === 'new') {
        const source = expected.notes.find((n) => n.id === plan.request.noteId);
        if (!source) return false;
        const copy = { ...clone(source), id: plan.request.newNoteId, createdAt: plan.request.createdAt };
        expected.notes.push(copy);
        container(expected, copy.parentId).childOrder.push(copy.id);
      }
      if (json(expected) !== json(plan.nextIndex)) return false;
      return true;
    } catch { return false; }
  };
  const run = async (plan) => {
    if (!await validatePlan(plan)) throw fail('EINVAL', 'Invalid history intent');
    const r = plan.request;
    const location = paths(r.operationId);
    const current = required(await load());
    const published = current.index.versionId === r.versionId;
    if (json(current.index) !== json(published ? plan.nextIndex : plan.previousIndex)) return { status: 'conflict' };
    if (plan.restoreSource) {
      const source = required(plan.kind === 'restore-trash' ? await readTrash(r.trashId) : await readRevision(r.noteId, r.revisionId));
      if (json(source.record) !== json(plan.restoreSource.record) || source.html !== plan.restoreSource.html) return { status: 'conflict' };
    }
    if (!await preflight(plan, published)) return { status: 'conflict' };
    const bodyState = plan.body ? await read(plan.body.noteId) : null;
    if (bodyState && bodyState.status === 'unavailable') throw fail('ECLOUD', 'Body unavailable');
    const observed = bodyState && bodyState.status === 'ok' ? bodyState.html : null;
    if (plan.body && observed !== plan.body.expected && observed !== plan.body.html) return { status: 'conflict' };
    await ensure('recovery/index-versions/' + r.baseVersionId + '.json', json(plan.previousIndex), true);
    const original = plan.cleanup || (plan.body && plan.body.expected !== null ? { noteId: plan.body.noteId, html: plan.body.expected } : null);
    if (original) await ensure('recovery/inputs/' + r.operationId + '/' + original.noteId + '.html', original.html, true);
    await ensure(location.intent, json(plan), true);
    if (plan.revision) {
      const base = 'revisions/' + plan.revision.record.noteId + '/' + plan.revision.record.id;
      await ensure(base + '.html', plan.revision.html, true);
      await ensure(base + '.json', json(plan.revision.record), true);
      required(await readRevision(plan.revision.record.noteId, plan.revision.record.id));
    }
    if (plan.trash) {
      const base = 'trash/' + plan.trash.record.id;
      await ensure(base + '/note.html', plan.trash.html, true);
      await ensure(base + '/record.json', json(plan.trash.record), true);
      required(await readTrash(plan.trash.record.id));
    }
    if (plan.body && !await replaceCanonical(plan.body.noteId + '.html', plan.body.html, observed)) return { status: 'conflict' };
    // Recheck required bodies after preservation and before publication.
    for (const note of plan.nextIndex.notes) required(await read(note.id));
    if (!await replaceCanonical('index.json', json(plan.nextIndex), current.indexToken)) return { status: 'conflict' };
    const verified = required(await load());
    if (json(verified.index) !== json(plan.nextIndex)) throw fail('EIO', 'History index verification failed');
    if (plan.body && required(await read(plan.body.noteId)).html !== plan.body.html) throw fail('EIO', 'History body verification failed');
    if (plan.cleanup) {
      // Preserve a late external version in place; Task 2.3 will reconcile it.
      required(await readTrash(plan.trash.record.id));
      const body = await read(plan.cleanup.noteId);
      if (body.status === 'unavailable') throw fail('ECLOUD', 'Cleanup target unavailable');
      if (body.status === 'ok') {
        if (body.html !== plan.cleanup.html) return { status: 'conflict' };
        await adapter.remove(plan.cleanup.noteId + '.html');
      }
    }
    if (plan.restoredTrashId) {
      await ensure('trash/' + plan.restoredTrashId + '/restored.json', json({ trashId: plan.restoredTrashId, operationId: r.operationId, versionId: r.versionId }), true);
    }
    await ensure(location.receipt, json({ kind: plan.kind, request: r }), true);
    return { status: 'saved', versionId: r.versionId };
  };
  const perform = async (kind, request, recovering = false) => {
    const r = clone(request);
    validateRequest(kind, r);
    if (!recovering) {
      await beforeWrite();
      return perform(kind, r, true);
    }
    const location = paths(r.operationId);
    const abandoned = await adapter.read('recovery/abandoned-history/' + r.operationId + '.json');
    if (abandoned.status === 'unavailable') throw fail('ECLOUD', 'History conflict evidence unavailable');
    if (abandoned.status === 'ok') {
      let record;
      try { record = JSON.parse(abandoned.text); } catch { throw fail('EINVAL', 'Invalid history conflict evidence'); }
      if (record.kind !== kind || json(record.request) !== json(r) || model.validateIndex(record.index).status !== 'ok') throw fail('EINVAL', 'History conflict identity reused');
      return { status: 'conflict-preserved', versionId: record.index.versionId };
    }
    const encoded = json({ kind, request: r });
    const receipt = await adapter.read(location.receipt);
    if (receipt.status === 'unavailable') throw fail('ECLOUD', 'History receipt unavailable');
    if (receipt.status === 'ok') {
      if (receipt.text !== encoded) throw fail('EINVAL', 'History operation ID reused');
      return { status: 'saved', versionId: r.versionId };
    }
    const pending = await adapter.read(location.intent);
    if (pending.status === 'unavailable') throw fail('ECLOUD', 'History operation unavailable');
    if (pending.status === 'ok') {
      let plan;
      try { plan = JSON.parse(pending.text); } catch { throw fail('EINVAL', 'Invalid pending history'); }
      if (!await validatePlan(plan) || json({ kind: plan.kind, request: plan.request }) !== encoded) throw fail('EINVAL', 'History operation ID reused or invalid');
      return run(plan);
    }
    const plan = await prepare(kind, r);
    return plan.status ? plan : run(plan);
  };
  const recover = async (publishedVersion = null) => {
    const results = [];
    for (const path of (await adapter.list()).filter((p) => /^recovery\/history-operations\/[^/]+\.json$/.test(p)).sort()) {
      const source = await adapter.read(path);
      if (source.status !== 'ok') { results.push({ path, status: source.status }); continue; }
      let plan;
      try { plan = JSON.parse(source.text); } catch {
        if (publishedVersion === null) results.push({ path, status: 'invalid' });
        continue;
      }
      if (publishedVersion !== null && plan?.request?.versionId !== publishedVersion) continue;
      if (!await validatePlan(plan) || paths(plan.request.operationId).intent !== path) { results.push({ path, status: 'invalid' }); continue; }
      results.push({ path, ...await perform(plan.kind, plan.request, true) });
    }
    return results;
  };
  // A rejected trash/restore is not a completed operation. Preserve its inputs
  // and the competing index, then retire it without changing any canonical file.
  const abandon = async (kind, request) => {
    validateRequest(kind, request);
    if (!['trash', 'restore-trash', 'restore-revision'].includes(kind)) throw fail('EINVAL', 'Only rejected trash or restoration history can be retired');
    const current = required(await load());
    if (current.index.versionId === request.versionId) throw fail('EPENDING', 'Published history must finish, not be retired');
    const receipt = await adapter.read(paths(request.operationId).receipt);
    if (receipt.status === 'unavailable') throw fail('ECLOUD', 'History receipt unavailable');
    if (receipt.status === 'ok') return perform(kind, request, true);
    if (typeof request.expectedBodyToken === 'string') await ensure('recovery/abandoned-inputs/' + request.operationId + '/' + request.noteId + '.html', request.expectedBodyToken, true);
    if (kind === 'restore-revision') {
      const body = await read(request.mode === 'new' ? request.newNoteId : request.noteId);
      if (body.status === 'unavailable') throw fail('ECLOUD', 'Recovery target unavailable');
      if (body.status === 'ok') await ensure('recovery/abandoned-observations/' + request.operationId + '/' + await hash(body.html) + '.html', body.html, true);
    }
    const marker = { kind, request: clone(request), index: current.index };
    const path = 'recovery/abandoned-history/' + request.operationId + '.json';
    const previous = await adapter.read(path);
    if (previous.status === 'missing') await ensure(path, json(marker), true);
    else required(previous);
    return perform(kind, request, true);
  };
  return {
    abandonOrganization: (kind, r) => abandon(kind, clone(r)),
    saveNote: (r) => perform('save', r), trashNote: (r) => perform('trash', r),
    restoreTrash: (r) => perform('restore-trash', r), restoreRevision: (r) => perform('restore-revision', r),
    listRevisions, readRevision, listTrash, readTrash, recover
  };
}
const api = { createNotesHistory, hash };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.NeoPlanetNotesHistory = api;
})();
