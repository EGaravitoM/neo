'use strict';

(function () {
const node = typeof module !== 'undefined' && module.exports;
const { t } = node ? require('./i18n') : globalThis.NeoI18n;
const model = node ? require('./planet-notes') : globalThis.NeoPlanetNotes;
const merge = node ? require('./planet-notes-reconcile') : globalThis.NeoPlanetNotesReconcile;
const digest = node ? require('./planet-notes-history').hash : globalThis.NeoPlanetNotesHistory.hash;
const copy = (value) => JSON.parse(JSON.stringify(value));
const json = (value) => JSON.stringify(value);
const fail = (code, message) => Object.assign(new Error(message), { code });
const idCheck = (id) => { if (!model.safeId(id)) throw fail('EINVAL', 'Invalid recovery ID'); };
const directHtml = (name) => typeof name === 'string' && name.endsWith('.html') && !/[/\\\0]/.test(name) && name !== '.html';
const hex = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const required = (value) => {
  if (value.status !== 'ok') throw fail(value.status === 'missing' ? 'ENOENT' : value.status === 'unavailable' ? 'ECLOUD' : 'EINVAL', 'Required recovery source: ' + value.status);
  return value;
};

// These methods run INSIDE the host store queue. None calls a queued public method.
function createNotesRecovery({ adapter, load, read, ensure, replaceCanonical, getHistory, recoverPending, beforeWrite = async () => {} }) {
  const parse = async (path, validate) => {
    const source = await adapter.read(path);
    if (source.status !== 'ok') return source;
    let record;
    try { record = JSON.parse(source.text); } catch { return { status: 'invalid' }; }
    return validate(record);
  };
  const readConflict = async (id) => {
    idCheck(id);
    const result = await parse('conflicts/' + id + '.json', merge.validateConflict);
    return result.status === 'ok' && result.record.id !== id ? { status: 'invalid' } : result;
  };
  const listConflicts = async () => {
    const records = [];
    for (const path of await adapter.list('conflicts')) {
      const match = /^conflicts\/([^/]+)\.json$/.exec(path);
      if (match) records.push(required(await readConflict(match[1])).record);
    }
    return records.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  };
  const validateMapping = (record) => {
    if (record && Number.isInteger(record.schemaVersion) && record.schemaVersion > 1) return { status: 'unsupported-version', version: record.schemaVersion };
    const valid = record && record.schemaVersion === 1 && model.safeId(record.id) && model.safeId(record.noteId) && model.safeId(record.groupId) && directHtml(record.sourceName) && hex(record.sourceHash) && model.validDate(record.createdAt);
    return valid ? { status: 'ok', record } : { status: 'invalid' };
  };
  const readMapping = async (id) => {
    idCheck(id);
    const result = await parse('recovery/orphans/' + id + '.json', validateMapping);
    if (result.status !== 'ok') return result;
    if (result.record.id !== id) return { status: 'invalid' };
    const source = await adapter.read('recovery/orphans/' + id + '.html');
    if (source.status !== 'ok') return source;
    if (await digest(source.text) !== result.record.sourceHash) return { status: 'invalid' };
    return { ...result, html: source.text };
  };
  const indexVersion = async (id) => {
    idCheck(id);
    const result = await parse('recovery/index-versions/' + id + '.json', (index) => {
      const validated = model.validateIndex(index);
      return validated.status === 'ok' && index.versionId === id ? { status: 'ok', record: index } : { status: 'invalid' };
    });
    return required(result).record;
  };
  const ancestry = async (branch, baseId, known) => {
    const pending = [branch]; const visited = new Set();
    while (pending.length) {
      const item = pending.pop();
      if (visited.has(item.versionId)) continue;
      visited.add(item.versionId);
      if (item.versionId === baseId) continue;
      for (const parentId of item.parentVersionIds) {
        if (!known.has(parentId)) known.set(parentId, await indexVersion(parentId));
        pending.push(known.get(parentId));
      }
    }
    return visited;
  };
  const parent = (index, parentId) => parentId === null ? index.root : index.groups.find((g) => g.id === parentId);
  const recoveredGroup = async (index, at) => {
    const found = index.groups.find((g) => g.systemRole === 'recovered');
    if (found) return found.id;
    const id = 'g-' + (await digest('planet-notes:recovered-group')).slice(0, 40);
    if ([...index.groups, ...index.notes, ...index.labels].some((item) => item.id === id)) throw fail('ECONFLICT', 'Recovered group identity is occupied');
    index.groups.push({ id, title: t('Recovered Notes'), parentId: null, sortMode: 'alphabetical', childOrder: [], createdAt: at, systemRole: 'recovered' });
    index.root.childOrder.push(id);
    return id;
  };
  const remapLabels = (index, note, snapshots) => {
    const ids = [];
    for (const labelId of note.labelIds) {
      const snapshot = snapshots.find((l) => l.id === labelId);
      if (!snapshot) throw fail('EINVAL', 'Missing label snapshot');
      const exact = index.labels.find((l) => l.name === snapshot.name);
      if (exact) ids.push(exact.id);
      else {
        if ([...index.notes, ...index.groups, ...index.labels].some((item) => item.id === snapshot.id)) throw fail('ECONFLICT', 'Label identity is occupied');
        index.labels.push(copy(snapshot)); ids.push(snapshot.id);
      }
    }
    note.labelIds = ids;
  };
  const addNote = (index, note) => {
    if ([...index.notes, ...index.groups, ...index.labels].some((item) => item.id === note.id)) throw fail('ECONFLICT', 'Recovery note identity is occupied');
    index.notes.push(note);
    parent(index, note.parentId).childOrder.push(note.id);
  };
  const checkRequest = (kind, r) => {
    if (!r || !['body', 'metadata', 'edit-delete', 'orphans'].includes(kind)) throw fail('EINVAL', 'Invalid reconciliation request');
    idCheck(r.operationId); idCheck(r.versionId);
    if (!model.validDate(r.createdAt)) throw fail('EINVAL', 'Invalid reconciliation date');
    if (kind === 'orphans') {
      if (typeof r.expectedIndexToken !== 'string') throw fail('EINVAL', 'Expected index token');
    } else {
      idCheck(r.baseVersionId);
      if (r.versionId === r.baseVersionId) throw fail('EINVAL', 'Reconciliation needs a new version');
      if (kind === 'metadata') {
        if (model.validateIndex(r.localIndex).status !== 'ok' || model.validateIndex(r.incomingIndex).status !== 'ok' || typeof r.expectedIndexToken !== 'string') throw fail('EINVAL', 'Invalid branch snapshots');
      } else {
        idCheck(r.noteId);
        if (typeof r.incomingHtml !== 'string') throw fail('EINVAL', 'Missing incoming writing');
        if (kind === 'body' && (typeof r.localHtml !== 'string' || typeof r.expectedBodyToken !== 'string')) throw fail('EINVAL', 'Missing local writing');
        if (kind === 'edit-delete') {
          idCheck(r.trashId);
          if (r.fromEditor !== undefined && typeof r.fromEditor !== 'boolean') throw fail('EINVAL', 'Invalid editor recovery source');
          if (r.expectedBodyToken !== undefined && r.expectedBodyToken !== null && typeof r.expectedBodyToken !== 'string') throw fail('EINVAL', 'Invalid deletion observation');
        }
      }
    }
  };
  const makePlan = (kind, r, current) => ({
    schemaVersion: 1, kind, request: r, previousIndex: current.index, previousToken: current.indexToken,
    nextIndex: { ...copy(current.index), versionId: r.versionId, parentVersionIds: [current.index.versionId] },
    bodies: [], conflicts: [], mappings: [], sources: [], snapshots: [current.index],
    result: { status: 'saved', versionId: r.versionId }
  });
  const addNewBody = async (plan, noteId, html, known = false) => {
    const body = await read(noteId);
    if (body.status === 'unavailable') throw fail('ECLOUD', 'Recovery destination unavailable');
    if (body.status !== 'missing' && (!known || body.html !== html)) throw fail('ECONFLICT', 'Recovery destination is occupied');
    plan.bodies.push({ noteId, expected: body.status === 'ok' ? body.html : null, html });
  };
  const addEditedDeletion = async (plan, trash, incomingHtml, sourceName, metadata = null) => {
    const sourceId = trash.record.note.id;
    const key = (await digest('edit-delete\0' + sourceId + '\0' + trash.record.id + '\0' + incomingHtml)).slice(0, 40);
    const id = 'c-' + key; const recoveredNoteId = 'n-' + key;
    const prior = await readConflict(id);
    if (prior.status === 'unavailable') throw fail('ECLOUD', 'Conflict evidence unavailable');
    if (prior.status !== 'missing' && prior.status !== 'ok') throw fail('EINVAL', 'Invalid conflict evidence');
    if (prior.status === 'ok' && (prior.record.kind !== 'edit-delete' || prior.record.sourceNoteId !== sourceId || prior.record.trashId !== trash.record.id || prior.record.incomingHtml !== incomingHtml || prior.record.recoveredNoteId !== recoveredNoteId)) throw fail('ECONFLICT', 'Conflict identity collision');
    if (!plan.nextIndex.notes.some((n) => n.id === recoveredNoteId)) {
      if (plan.nextIndex.tombstones.some((t) => t.id === recoveredNoteId)) return { recoveredNoteId, existing: true };
      const note = { ...copy(metadata ? metadata.note : trash.record.note), id: recoveredNoteId, parentId: await recoveredGroup(plan.nextIndex, plan.request.createdAt), createdAt: plan.request.createdAt };
      remapLabels(plan.nextIndex, note, metadata ? metadata.labels : trash.record.labels);
      addNote(plan.nextIndex, note);
      await addNewBody(plan, recoveredNoteId, incomingHtml, prior.status === 'ok');
    } else if (required(await read(recoveredNoteId)).html !== incomingHtml) {
      // The recovered copy has since been edited; the original incoming version
      // remains in its immutable conflict record, so never reset that copy.
      if (prior.status !== 'ok') throw fail('ECONFLICT', 'Recovery identity collision');
    }
    plan.conflicts.push(prior.status === 'ok' ? prior.record : { schemaVersion: 1, id, kind: 'edit-delete', operationId: plan.request.operationId, createdAt: plan.request.createdAt, sourceNoteId: sourceId, recoveredNoteId, trashId: trash.record.id, deletedHtml: trash.html, incomingHtml });
    if (sourceName !== null) plan.sources.push({ name: sourceName, text: incomingHtml });
    return { recoveredNoteId, existing: prior.status === 'ok' };
  };
  const build = async (kind, r) => {
    // Read the base first so missing ancestry is never replaced by guessed data.
    let base;
    if (kind === 'metadata') base = await indexVersion(r.baseVersionId);
    const current = required(await load());
    const plan = makePlan(kind, r, current);
    if (kind !== 'orphans' && kind !== 'metadata' && current.index.versionId !== r.baseVersionId) return { status: 'conflict' };
    if (kind === 'body') {
      const source = current.index.notes.find((n) => n.id === r.noteId);
      if (!source) throw fail('ENOENT', 'Conflict source is not active');
      const disk = required(await read(r.noteId));
      const key = (await digest('body\0' + r.noteId + '\0' + r.incomingHtml)).slice(0, 40);
      const conflictId = 'c-' + key; const conflictNoteId = 'n-' + key;
      const old = await readConflict(conflictId);
      if (old.status === 'unavailable') throw fail('ECLOUD', 'Conflict evidence unavailable');
      if (old.status !== 'ok' && old.status !== 'missing') throw fail('EINVAL', 'Invalid conflict evidence');
      if (old.status === 'ok' && (old.record.kind !== 'body' || old.record.sourceNoteId !== r.noteId || old.record.recoveredNoteId !== conflictNoteId || old.record.incomingHtml !== r.incomingHtml)) throw fail('ECONFLICT', 'Conflict identity collision');
      if (old.status === 'ok' && disk.html === r.localHtml && (current.index.notes.some((n) => n.id === conflictNoteId) || current.index.tombstones.some((t) => t.id === conflictNoteId))) return { status: 'saved', versionId: current.index.versionId, conflictNoteId };
      if (disk.html !== r.incomingHtml) return { status: 'conflict' };
      if (r.incomingHtml === r.localHtml) return { status: 'saved', versionId: current.index.versionId, conflictNoteId: null };
      if (!plan.nextIndex.notes.some((n) => n.id === conflictNoteId) && !plan.nextIndex.tombstones.some((t) => t.id === conflictNoteId)) {
        addNote(plan.nextIndex, { ...copy(source), title: t('{title} (conflict)', { title: source.title }), id: conflictNoteId, createdAt: r.createdAt });
        await addNewBody(plan, conflictNoteId, r.incomingHtml, old.status === 'ok');
      } else if (old.status !== 'ok') throw fail('ECONFLICT', 'Conflict note identity is occupied');
      plan.conflicts.push(old.status === 'ok' ? old.record : { schemaVersion: 1, id: conflictId, kind: 'body', operationId: r.operationId, createdAt: r.createdAt, sourceNoteId: r.noteId, recoveredNoteId: conflictNoteId, baseHtml: r.expectedBodyToken, localHtml: r.localHtml, incomingHtml: r.incomingHtml });
      // The incoming copy is written and verifiable BEFORE the original changes.
      plan.bodies.push({ noteId: r.noteId, expected: r.incomingHtml, html: r.localHtml });
      plan.result.conflictNoteId = conflictNoteId;
    } else if (kind === 'metadata') {
      if (current.indexToken !== r.expectedIndexToken || json(current.index) !== json(r.incomingIndex)) return { status: 'conflict' };
      const known = new Map([base, r.localIndex, r.incomingIndex].map((snapshot) => [snapshot.versionId, snapshot]));
      const localAncestors = await ancestry(r.localIndex, r.baseVersionId, known);
      const incomingAncestors = await ancestry(r.incomingIndex, r.baseVersionId, known);
      if (!localAncestors.has(r.baseVersionId) || !incomingAncestors.has(r.baseVersionId)) throw fail('EINVAL', 'Unproven merge base');
      for (const candidate of localAncestors) {
        if (candidate !== r.baseVersionId && incomingAncestors.has(candidate) && (await ancestry(known.get(candidate), r.baseVersionId, known)).has(r.baseVersionId)) throw fail('EINVAL', 'A newer common merge base must be used');
      }
      const merged = merge.mergeNotesIndex({ base, local: r.localIndex, incoming: r.incomingIndex, versionId: r.versionId });
      if (merged.status !== 'ok') throw fail('EINVAL', 'Invalid merge');
      plan.nextIndex = merged.index;
      plan.snapshots = [base, r.localIndex, r.incomingIndex];
      for (const [position, record] of merged.conflicts.entries()) {
        const id = 'c-' + (await digest(json({ base, local: r.localIndex, incoming: r.incomingIndex, position }))).slice(0, 40);
        const existing = await readConflict(id);
        if (existing.status === 'unavailable') throw fail('ECLOUD', 'Metadata conflict unavailable');
        if (existing.status === 'ok') {
          if (existing.record.kind !== record.kind || json(existing.record.variants) !== json(record.variants)) throw fail('ECONFLICT', 'Metadata conflict identity collision');
          plan.conflicts.push(existing.record);
        } else if (existing.status === 'missing') plan.conflicts.push({ schemaVersion: 1, id, operationId: r.operationId, createdAt: r.createdAt, ...record });
        else throw fail('EINVAL', 'Invalid metadata conflict');
      }
      // Before a metadata deletion is adopted, prove the writing is recoverable.
      for (const note of base.notes) {
        const localNote = r.localIndex.notes.find((n) => n.id === note.id);
        const incomingNote = r.incomingIndex.notes.find((n) => n.id === note.id);
        if (localNote && incomingNote) continue;
        const deletion = [...plan.nextIndex.tombstones].reverse().find((t) => t.id === note.id);
        if (!deletion) throw fail('EINVAL', 'Deletion without recovery evidence');
        const trash = required(await getHistory().readTrash(deletion.trashId));
        if (trash.record.note.id !== note.id) throw fail('EINVAL', 'Mismatched trash identity');
        const body = await read(note.id);
        if (body.status === 'unavailable') throw fail('ECLOUD', 'Deleted body is unavailable');
        const metadataEdited = (localNote && json(localNote) !== json(note)) || (incomingNote && json(incomingNote) !== json(note));
        // A conservative hierarchy fallback must not resurrect an unrelated,
        // unchanged deletion. Edited content gets a separate recovered identity.
        plan.nextIndex.notes = plan.nextIndex.notes.filter((n) => n.id !== note.id);
        for (const item of [plan.nextIndex.root, ...plan.nextIndex.groups]) item.childOrder = item.childOrder.filter((child) => child !== note.id);
        if ((body.status === 'ok' && body.html !== trash.html) || metadataEdited) {
          const editedBranch = localNote && json(localNote) !== json(note) ? r.localIndex : r.incomingIndex;
          const editedNote = editedBranch.notes.find((n) => n.id === note.id);
          await addEditedDeletion(plan, trash, body.status === 'ok' ? body.html : trash.html, body.status === 'ok' ? note.id + '.html' : null, editedNote ? { note: editedNote, labels: editedBranch.labels } : null);
        }
      }
    } else if (kind === 'edit-delete') {
      const deletion = current.index.tombstones.find((t) => t.id === r.noteId && t.trashId === r.trashId);
      if (!deletion) throw fail('EINVAL', 'Missing deletion event');
      const trash = required(await getHistory().readTrash(r.trashId));
      if (trash.record.note.id !== r.noteId) throw fail('EINVAL', 'Mismatched deletion evidence');
      if (current.index.notes.some((n) => n.id === r.noteId)) return { status: 'conflict' };
      const disk = await read(r.noteId);
      const inMemoryEdit = r.fromEditor === true || (disk.status === 'missing' && r.expectedBodyToken === null);
      if (!inMemoryEdit) {
        required(disk);
        if (disk.html !== r.incomingHtml || r.expectedBodyToken === null || (typeof r.expectedBodyToken === 'string' && disk.html !== r.expectedBodyToken)) return { status: 'conflict' };
      }
      if (r.incomingHtml === trash.html) return { status: 'unchanged', versionId: current.index.versionId };
      const added = await addEditedDeletion(plan, trash, r.incomingHtml, inMemoryEdit ? null : r.noteId + '.html');
      if (added.existing && !plan.bodies.length) return { status: 'saved', versionId: current.index.versionId, recoveredNoteId: added.recoveredNoteId };
      plan.result.recoveredNoteId = added.recoveredNoteId;
    } else {
      if (current.indexToken !== r.expectedIndexToken || current.index.versionId === r.versionId) return { status: 'conflict' };
      const unavailableNoteIds = [];
      for (const note of current.index.notes) if ((await read(note.id)).status !== 'ok') unavailableNoteIds.push(note.id);
      const recoveredNoteIds = []; const unavailableSources = [];
      const indexed = new Set(current.index.notes.map((n) => n.id + '.html'));
      for (const name of (await adapter.list()).filter(directHtml).sort()) {
        if (indexed.has(name)) continue;
        const source = await adapter.read(name);
        if (source.status !== 'ok') { unavailableSources.push(name); continue; }
        const deletedId = name.slice(0, -5);
        const deletions = current.index.tombstones.filter((t) => t.id === deletedId);
        if (deletions.length) {
          const copies = [];
          for (const deletion of deletions) {
            const trash = required(await getHistory().readTrash(deletion.trashId));
            if (trash.record.note.id !== deletedId) throw fail('EINVAL', 'Mismatched tombstone');
            copies.push(trash);
          }
          if (copies.some((trash) => trash.html === source.text)) continue;
          const added = await addEditedDeletion(plan, copies[copies.length - 1], source.text, name);
          if (!added.existing || plan.bodies.some((b) => b.noteId === added.recoveredNoteId)) recoveredNoteIds.push(added.recoveredNoteId);
          continue;
        }
        const key = (await digest(name + '\0' + source.text)).slice(0, 40);
        const mapId = 'm-' + key; const noteId = 'n-' + key;
        const mapping = await readMapping(mapId);
        if (mapping.status === 'unavailable') throw fail('ECLOUD', 'Orphan mapping unavailable');
        if (!['ok', 'missing'].includes(mapping.status)) throw fail('EINVAL', 'Invalid orphan mapping');
        if (mapping.status === 'ok') {
          if (mapping.record.sourceName !== name || mapping.html !== source.text || mapping.record.noteId !== noteId) throw fail('ECONFLICT', 'Orphan identity collision');
          if (current.index.notes.some((n) => n.id === noteId) || current.index.tombstones.some((t) => t.id === noteId)) continue;
        }
        const groupId = await recoveredGroup(plan.nextIndex, r.createdAt);
        addNote(plan.nextIndex, { id: noteId, title: name.slice(0, -5), parentId: groupId, labelIds: [], createdAt: r.createdAt });
        await addNewBody(plan, noteId, source.text, mapping.status === 'ok');
        plan.mappings.push({ record: mapping.status === 'ok' ? mapping.record : { schemaVersion: 1, id: mapId, noteId, groupId, sourceName: name, sourceHash: await digest(source.text), createdAt: r.createdAt }, html: source.text });
        plan.sources.push({ name, text: source.text });
        recoveredNoteIds.push(noteId);
      }
      plan.result = { status: 'saved', versionId: r.versionId, recoveredNoteIds, unavailableNoteIds, unavailableSources };
      if (!recoveredNoteIds.length) return { ...plan.result, status: 'unchanged', versionId: current.index.versionId };
    }
    if (model.validateIndex(plan.nextIndex).status !== 'ok') throw fail('EINVAL', 'Invalid reconciliation result');
    return plan;
  };
  const locations = (id) => ({ intent: 'recovery/reconcile-operations/' + id + '.json', receipt: 'recovery/reconcile-receipts/' + id + '.json' });
  const validatePlan = async (plan) => {
    try {
      if (!plan || plan.schemaVersion !== 1) return false;
      checkRequest(plan.kind, plan.request);
      if (model.validateIndex(plan.previousIndex).status !== 'ok' || model.validateIndex(plan.nextIndex).status !== 'ok' || typeof plan.previousToken !== 'string' || json(JSON.parse(plan.previousToken)) !== json(plan.previousIndex) || plan.nextIndex.versionId !== plan.request.versionId) return false;
      if (!['bodies', 'conflicts', 'mappings', 'sources', 'snapshots'].every((key) => Array.isArray(plan[key])) || !plan.result || plan.result.status !== 'saved' || plan.result.versionId !== plan.request.versionId) return false;
      const seen = new Set();
      for (const b of plan.bodies) {
        if (!b || !model.safeId(b.noteId) || seen.has(b.noteId) || typeof b.html !== 'string' || (b.expected !== null && typeof b.expected !== 'string') || !plan.nextIndex.notes.some((n) => n.id === b.noteId)) return false;
        seen.add(b.noteId);
      }
      for (const record of plan.conflicts) if (merge.validateConflict(record).status !== 'ok') return false;
      for (const mapping of plan.mappings) if (!mapping || validateMapping(mapping.record).status !== 'ok' || typeof mapping.html !== 'string' || await digest(mapping.html) !== mapping.record.sourceHash || !plan.nextIndex.notes.some((n) => n.id === mapping.record.noteId)) return false;
      for (const source of plan.sources) if (!source || !directHtml(source.name) || typeof source.text !== 'string') return false;
      const versions = new Map();
      for (const snapshot of plan.snapshots) {
        if (model.validateIndex(snapshot).status !== 'ok') return false;
        if (versions.has(snapshot.versionId) && versions.get(snapshot.versionId) !== json(snapshot)) return false;
        versions.set(snapshot.versionId, json(snapshot));
      }
      if (!versions.has(plan.previousIndex.versionId) || versions.get(plan.previousIndex.versionId) !== json(plan.previousIndex)) return false;
      if (plan.kind === 'body') {
        if (plan.conflicts.length !== 1 || plan.conflicts[0].kind !== 'body' || plan.conflicts[0].sourceNoteId !== plan.request.noteId || plan.conflicts[0].incomingHtml !== plan.request.incomingHtml) return false;
        const original = plan.bodies.find((b) => b.noteId === plan.request.noteId);
        if (!original || original.expected !== plan.request.incomingHtml || original.html !== plan.request.localHtml) return false;
      }
      if (plan.kind === 'metadata') {
        const base = plan.snapshots.find((snapshot) => snapshot.versionId === plan.request.baseVersionId);
        if (!base || json(plan.previousIndex) !== json(plan.request.incomingIndex)) return false;
        if (!versions.has(plan.request.localIndex.versionId)) return false;
      }
      return true;
    } catch { return false; }
  };
  const preflight = async (plan, replaying) => {
    const observations = new Map();
    for (const source of plan.sources) {
      const file = required(await adapter.read(source.name));
      if (file.text !== source.text) return null;
    }
    for (const b of plan.bodies) {
      const body = await read(b.noteId);
      if (body.status === 'unavailable') throw fail('ECLOUD', 'Target unavailable');
      const observed = body.status === 'ok' ? body.html : null;
      if (observed !== b.expected && !(replaying && observed === b.html)) return null;
      observations.set(b.noteId, observed);
    }
    for (const note of plan.nextIndex.notes) {
      if (observations.has(note.id)) continue;
      const body = await read(note.id);
      // Existing unavailable entries remain indexed; never pretend they are empty.
      if (body.status !== 'ok' && !plan.previousIndex.notes.some((n) => n.id === note.id)) required(body);
    }
    // Detect archive collisions BEFORE writes; snapshot identities are immutable.
    for (const snapshot of plan.snapshots) {
      const old = await adapter.read('recovery/index-versions/' + snapshot.versionId + '.json');
      if (old.status === 'unavailable') throw fail('ECLOUD', 'Ancestry archive unavailable');
      if (old.status === 'ok' && old.text !== json(snapshot)) throw fail('ECONFLICT', 'Ancestry identity collision');
    }
    return observations;
  };
  const verifiedArtifact = async (path, text) => {
    await ensure(path, text, true);
    if (required(await adapter.read(path)).text !== text) throw fail('EIO', 'Recovery artifact verification failed');
  };
  const commit = async (plan, replaying) => {
    if (!await validatePlan(plan)) throw fail('EINVAL', 'Invalid reconciliation plan');
    const current = required(await load());
    const published = current.index.versionId === plan.nextIndex.versionId;
    if (published ? json(current.index) !== json(plan.nextIndex) : current.indexToken !== plan.previousToken) return { status: 'conflict' };
    const observed = await preflight(plan, replaying || published);
    if (!observed) return { status: 'conflict' };
    for (const snapshot of plan.snapshots) await verifiedArtifact('recovery/index-versions/' + snapshot.versionId + '.json', json(snapshot));
    for (const b of plan.bodies) if (b.expected !== null) await verifiedArtifact('recovery/reconcile-inputs/' + plan.request.operationId + '/' + b.noteId + '.html', b.expected);
    for (const source of plan.sources) await verifiedArtifact('recovery/reconcile-inputs/' + plan.request.operationId + '/s-' + await digest(source.name) + '.html', source.text);
    const envelope = { plan, digest: await digest(json(plan)) };
    await verifiedArtifact(locations(plan.request.operationId).intent, json(envelope));
    for (const record of plan.conflicts) await verifiedArtifact('conflicts/' + record.id + '.json', json(record));
    for (const mapping of plan.mappings) {
      await verifiedArtifact('recovery/orphans/' + mapping.record.id + '.html', mapping.html);
      await verifiedArtifact('recovery/orphans/' + mapping.record.id + '.json', json(mapping.record));
    }
    // Check observed sources again after preservation; never overwrite a newer one.
    for (const source of plan.sources) if (required(await adapter.read(source.name)).text !== source.text) return { status: 'conflict' };
    for (const b of plan.bodies) {
      if (!await replaceCanonical(b.noteId + '.html', b.html, observed.get(b.noteId))) return { status: 'conflict' };
      if (required(await read(b.noteId)).html !== b.html) throw fail('EIO', 'Recovered body verification failed');
    }
    for (const note of plan.nextIndex.notes) {
      const body = await read(note.id);
      if (body.status !== 'ok' && !plan.previousIndex.notes.some((n) => n.id === note.id)) required(body);
    }
    if (!await replaceCanonical('index.json', json(plan.nextIndex), current.indexToken)) return { status: 'conflict' };
    if (json(required(await load()).index) !== json(plan.nextIndex)) throw fail('EIO', 'Merged index verification failed');
    for (const b of plan.bodies) if (required(await read(b.noteId)).html !== b.html) throw fail('EIO', 'Reconciled body changed during verification');
    await verifiedArtifact(locations(plan.request.operationId).receipt, json({ kind: plan.kind, request: plan.request, result: plan.result }));
    return plan.result;
  };
  const decodeIntent = async (text) => {
    try {
      const envelope = JSON.parse(text);
      if (!envelope || !envelope.plan || !hex(envelope.digest) || envelope.digest !== await digest(json(envelope.plan)) || !await validatePlan(envelope.plan)) return null;
      return envelope.plan;
    } catch { return null; }
  };
  const perform = async (kind, request, recovering = false) => {
    const r = copy(request); checkRequest(kind, r);
    if (!recovering) {
      await beforeWrite();
      return perform(kind, r, true);
    }
    const path = locations(r.operationId);
    const receipt = await adapter.read(path.receipt);
    if (receipt.status === 'unavailable') throw fail('ECLOUD', 'Reconciliation receipt unavailable');
    if (receipt.status === 'ok') {
      let saved;
      try { saved = JSON.parse(receipt.text); } catch { throw fail('EINVAL', 'Invalid reconciliation receipt'); }
      if (saved.kind !== kind || json(saved.request) !== json(r) || !saved.result || saved.result.status !== 'saved' || saved.result.versionId !== r.versionId) throw fail('EINVAL', 'Operation ID reused or receipt invalid');
      return saved.result;
    }
    const abandoned = await adapter.read('recovery/abandoned-reconciliations/' + r.operationId + '.json');
    if (abandoned.status === 'unavailable') throw fail('ECLOUD', 'Reconciliation conflict evidence unavailable');
    if (abandoned.status === 'ok') {
      let record;
      try { record = JSON.parse(abandoned.text); } catch { throw fail('EINVAL', 'Invalid reconciliation conflict evidence'); }
      if (kind !== 'metadata' || record.kind !== kind || json(record.request) !== json(r) || model.validateIndex(record.index).status !== 'ok') throw fail('EINVAL', 'Reconciliation conflict identity reused');
      return { status: 'conflict-preserved' };
    }
    const pending = await adapter.read(path.intent);
    if (pending.status === 'unavailable') throw fail('ECLOUD', 'Reconciliation intent unavailable');
    if (pending.status === 'ok') {
      const plan = await decodeIntent(pending.text);
      if (!plan || plan.kind !== kind || json(plan.request) !== json(r)) throw fail('EINVAL', 'Invalid pending reconciliation or reused operation ID');
      return commit(plan, true);
    }
    if (kind === 'orphans') {
      let recovered;
      try { recovered = await recoverPending(); } catch (err) {
        if (!['ECLOUD', 'EINVAL', 'ENOENT', 'ECONFLICT'].includes(err.code)) throw err;
        return { status: 'deferred', recoveredNoteIds: [], unavailableNoteIds: [] };
      }
      if (recovered.some((entry) => !['saved', 'unchanged', 'conflict-preserved'].includes(entry.status))) return { status: 'deferred', recoveredNoteIds: [], unavailableNoteIds: [] };
    }
    const plan = await build(kind, r);
    return plan.status ? plan : commit(plan, false);
  };
  const recover = async (publishedVersion = null) => {
    const results = [];
    for (const path of (await adapter.list('recovery/reconcile-operations')).filter((p) => /^recovery\/reconcile-operations\/[^/]+\.json$/.test(p)).sort()) {
      const source = await adapter.read(path);
      if (source.status !== 'ok') { results.push({ path, status: source.status }); continue; }
      if (publishedVersion !== null) {
        let envelope;
        try { envelope = JSON.parse(source.text); } catch { continue; }
        if (envelope?.plan?.request?.versionId !== publishedVersion) continue;
      }
      const plan = await decodeIntent(source.text);
      if (!plan || locations(plan.request.operationId).intent !== path) { results.push({ path, status: 'invalid' }); continue; }
      results.push({ path, ...await perform(plan.kind, plan.request, true) });
    }
    return results;
  };
  const abandonMetadata = async (request) => {
    const r = copy(request); checkRequest('metadata', r);
    const current = required(await load());
    if (current.index.versionId === r.versionId) throw fail('EPENDING', 'Published reconciliation must finish');
    const receipt = await adapter.read(locations(r.operationId).receipt);
    if (receipt.status === 'unavailable') throw fail('ECLOUD', 'Reconciliation receipt unavailable');
    if (receipt.status === 'ok') return perform('metadata', r, true);
    const path = 'recovery/abandoned-reconciliations/' + r.operationId + '.json';
    const previous = await adapter.read(path);
    if (previous.status === 'missing') await verifiedArtifact(path, json({ kind: 'metadata', request: r, index: current.index }));
    else required(previous);
    return perform('metadata', r, true);
  };
  return {
    abandonMetadata,
    preserveBodyConflict: (r) => perform('body', r), reconcileMetadata: (r) => perform('metadata', r),
    recoverEditedDeletion: (r) => perform('edit-delete', r), recoverOrphans: (r) => perform('orphans', r),
    readConflict, listConflicts, recover
  };
}
const api = { createNotesRecovery };
if (node) module.exports = api;
else globalThis.NeoPlanetNotesRecovery = api;
})();
