'use strict';
(function () {
const node = typeof module !== 'undefined' && module.exports;

const { hash } = node ? require('./planet-notes-history') : globalThis.NeoPlanetNotesHistory;
const model = node ? require('./planet-notes') : globalThis.NeoPlanetNotes;
const json = JSON.stringify;
const fail = (code, message) => Object.assign(new Error(message), { code });
const required = (r) => {
  if (r.status !== 'ok') throw fail(r.status === 'unavailable' ? 'ECLOUD' : r.status === 'missing' ? 'ENOENT' : 'EINVAL', 'Notes observation: ' + r.status);
  return r;
};

/** Runs inside the service's book queue. Observations are immutable evidence,
 * not a second source of truth. Polls never rewrite unchanged canonical files. */
function createNotesObserver({ adapter, store, makeId, now }) {
  let localIndex = null; let localIndexToken = null;
  const artifact = async (path, text) => {
    const previous = await adapter.read(path);
    if (previous.status === 'missing') await adapter.writeDurable(path, text);
    else if (required(previous).text !== text) throw fail('ECONFLICT', 'Observation identity collision');
    if (required(await adapter.read(path)).text !== text) throw fail('EIO', 'Observation verification failed');
  };
  const observe = async (noteId, html) => artifact('recovery/observed-bodies/' + noteId + '/' + await hash(html) + '.html', html);
  const revision = async (noteId, html) => {
    await observe(noteId, html);
    const id = 'r-observed-' + await hash(html);
    const path = 'revisions/' + noteId + '/' + id;
    const old = await adapter.read(path + '.json');
    if (old.status === 'ok') {
      let record;
      try { record = JSON.parse(old.text); } catch { throw fail('EINVAL', 'Invalid observed revision'); }
      if (model.validateRevision(record).status !== 'ok' || record.noteId !== noteId || record.bodyHash !== await hash(html)) throw fail('EINVAL', 'Invalid observed revision');
      await artifact(path + '.html', html); return;
    }
    if (old.status !== 'missing') required(old);
    await artifact(path + '.html', html);
    await artifact(path + '.json', json({ schemaVersion: 1, id, noteId, operationId: 'o-observed-' + await hash(html), createdAt: now(), reason: 'external', writingDay: null, bodyHash: await hash(html) }));
  };
  const remember = async () => {
    const loaded = await store.loadReadOnly();
    if (loaded.status === 'ok') {
      await artifact('recovery/index-versions/' + loaded.index.versionId + '.json', json(loaded.index));
      localIndex = loaded.index; localIndexToken = loaded.indexToken;
    }
    return loaded;
  };
  const ancestors = async (index) => {
    const result = new Map(); const pending = [index];
    while (pending.length) {
      const current = pending.pop();
      if (result.has(current.versionId)) continue;
      result.set(current.versionId, current);
      for (const id of current.parentVersionIds) {
        const source = required(await adapter.read('recovery/index-versions/' + id + '.json'));
        let parent;
        try { parent = JSON.parse(source.text); } catch { throw fail('EINVAL', 'Invalid ancestry'); }
        if (model.validateIndex(parent).status !== 'ok' || parent.versionId !== id) throw fail('EINVAL', 'Invalid ancestry');
        pending.push(parent);
      }
    }
    return result;
  };
  const metadata = async () => {
    const incoming = await store.loadReadOnly();
    if (incoming.status !== 'ok') return incoming;
    if (!localIndex) return remember();
    if (incoming.indexToken === localIndexToken || json(incoming.index) === json(localIndex)) { localIndexToken = incoming.indexToken; return incoming; }
    if (incoming.index.versionId === localIndex.versionId) throw fail('EINVAL', 'Changed metadata reused a version identity');
    await artifact('recovery/index-versions/' + incoming.index.versionId + '.json', json(incoming.index));
    const left = await ancestors(localIndex); const right = await ancestors(incoming.index);
    if (right.has(localIndex.versionId)) return remember();
    const common = [...left.keys()].filter((id) => right.has(id));
    let base = null;
    for (const id of common) {
      if (common.some((other) => other !== id && left.get(other).parentVersionIds.includes(id))) continue;
      // Recovery validates that this is the newest proven common ancestor.
      base = id; break;
    }
    if (!base) throw fail('ECONFLICT', 'Metadata has no proven merge base');
    const result = await store.reconcileMetadata({ operationId: makeId('o'), versionId: makeId('v'), createdAt: now(), baseVersionId: base, localIndex, incomingIndex: incoming.index, expectedIndexToken: incoming.indexToken });
    if (result.status !== 'saved') throw fail('EPENDING', 'Metadata changed during reconciliation');
    return remember();
  };
  const discoverOrphans = async () => {
    let loaded = await metadata();
    // Missing/invalid metadata cannot prove which files were intentionally
    // trashed. Preserve that evidence rather than inventing a new index.
    if (loaded.status !== 'ok') return loaded;
    // Most polls have no new root HTML. Do not run a collection-wide recovery
    // transaction (and read every indexed body) just to refresh one open note.
    // If any candidate exists, the existing full recovery/validation still runs.
    const indexed = new Set(loaded.index.notes.map(note => note.id + '.html'));
    let names;
    try { names = await adapter.list('', false); }
    catch (err) {
      if (err.code !== 'ECLOUD') throw err;
      // An incomplete orphan inventory must not hide already indexed writing.
      return { ...loaded, orphanDiscovery: 'unavailable' };
    }
    const candidates = names.some(name => name !== '.html' && name.endsWith('.html') && !/[/\\\0]/.test(name) && !indexed.has(name));
    if (candidates) {
      const orphans = await store.recoverOrphans({ operationId: makeId('o'), versionId: makeId('v'), createdAt: now(), expectedIndexToken: loaded.indexToken });
      if (!['saved', 'unchanged'].includes(orphans.status)) return orphans;
      if (orphans.status === 'saved') { await remember(); loaded = required(await store.load()); }
    }
    return loaded;
  };
  const refresh = async (noteId, { baseBodyToken, localHtml }) => {
    const loaded = required(await discoverOrphans());
    const note = loaded.index.notes.find((n) => n.id === noteId);
    if (!note) {
      const deletion = [...loaded.index.tombstones].reverse().find((t) => t.id === noteId);
      if (deletion && localHtml !== baseBodyToken) {
        const disk = await store.read(noteId);
        if (disk.status === 'unavailable') return disk;
        // Preserve the editor's words independently of a competing on-disk edit.
        await observe(noteId, localHtml);
        const result = await store.recoverEditedDeletion({ operationId: makeId('o'), versionId: makeId('v'), createdAt: now(), baseVersionId: loaded.index.versionId, noteId, trashId: deletion.trashId, incomingHtml: localHtml, fromEditor: true, expectedBodyToken: disk.status === 'missing' ? null : disk.bodyToken });
        if (result.status !== 'saved') return result;
        await remember();
        return { status: 'recovered', noteId: result.recoveredNoteId, html: localHtml, bodyToken: localHtml };
      }
      return { status: 'missing' };
    }
    const disk = await store.read(noteId);
    if (disk.status !== 'ok') return disk;
    // Preserve both observed inputs before any canonical replacement or UI adopt.
    await observe(noteId, baseBodyToken); await observe(noteId, disk.html);
    if (disk.html === baseBodyToken) return { ...disk, title: note.title, changed: false };
    await revision(noteId, baseBodyToken);
    if (localHtml === baseBodyToken || localHtml === disk.html) return { ...disk, title: note.title, changed: true };
    await observe(noteId, localHtml);
    const result = await store.preserveBodyConflict({ operationId: makeId('o'), versionId: makeId('v'), createdAt: now(), baseVersionId: loaded.index.versionId, noteId, localHtml, incomingHtml: disk.html, expectedBodyToken: baseBodyToken });
    if (result.status !== 'saved') return result;
    await remember();
    return { status: 'ok', html: localHtml, bodyToken: localHtml, title: note.title, changed: true, conflictNoteId: result.conflictNoteId };
  };
  return { observe, remember, metadata, discoverOrphans, refresh };
}
const api = { createNotesObserver };
if (node) module.exports = api;
else globalThis.NeoPlanetNotesObserver = api;
})();
