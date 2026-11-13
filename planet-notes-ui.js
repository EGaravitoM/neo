'use strict';

(function () {
const fail = (code, message) => Object.assign(new Error(message), { code });
/** Browser controller. No filesystem access; file HTML needs an inspector. */
function createNotesController({ api, view, inspect, writingDay, makeOperationId, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const call = async (name, ...args) => {
    let result;
    try { result = await api[name](...args); } catch (err) {
      if (!err.code) err.code = 'EIO';
      throw err;
    }
    if (result && result.status === 'error' && result.error) throw fail(result.error.code || 'EIO', result.error.message || 'Notes request failed');
    return result;
  };
  const entries = new Map(); const actions = new Map(); const creations = new Map();
  let preview = null; let refreshing = null;
  let active = null; let editable = false; let generation = 0; let composing = false;
  let timer = null; let flushing = null; let disposed = false; const compositionWaiters = [];
  const live = () => { if (disposed) throw fail('ECLOSED', 'Notes controller is disposed'); };
  const key = (doc) => JSON.stringify([doc.bookId, doc.noteId]);
  const validateDocument = (doc) => {
    if (!doc || doc.kind !== 'custom' || typeof doc.bookId !== 'string' || typeof doc.noteId !== 'string') throw fail('EINVAL', 'Invalid notes document');
    return { bookId: doc.bookId, kind: 'custom', noteId: doc.noteId };
  };
  const relocate = (entry, noteId) => {
    const previous = key(entry.document);
    entry.document = { ...entry.document, noteId };
    entries.delete(previous); entries.set(key(entry.document), entry);
    // A recovered note is a different command target. Preserve the writer's
    // queued title intent, but never reuse an immutable old-target identity.
    for (const [id, action] of [...actions]) {
      if (action.kind !== 'rename' || key(action.document) !== previous) continue;
      actions.delete(id);
      const operationId = makeOperationId();
      actions.set(operationId, { ...action, document: { ...entry.document }, request: { ...action.request, operationId } });
    }
  };
  const isComposing = () => composing;
  const waitComposition = () => composing ? new Promise((resolve) => compositionWaiters.push(resolve)) : Promise.resolve();
  const report = (err) => { if (api.logError) Promise.resolve(api.logError('custom notes save: ' + err.message)).catch(() => {}); };
  const schedule = () => {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => { timer = null; flush().catch(report); }, 800);
  };
  const edit = (html) => {
    if (typeof html !== 'string') throw fail('EINVAL', 'Expected note HTML');
    if (!active || !editable || disposed) return false;
    if (html !== active.html) {
      active.html = html; active.editDay = writingDay();
      active.dirty = !!active.job || html !== active.savedHtml;
      schedule();
    }
    return true;
  };
  const capture = () => { if (active && editable && !composing) edit(view.capture()); };
  const show = (entry) => view.present({ document: entry.document, title: entry.title, status: 'ok', editable: true, html: entry.html });
  const open = async (document) => {
    live();
    const doc = validateDocument(document); const turn = ++generation;
    if (composing) await waitComposition();
    if (turn !== generation || disposed) return;
    capture(); active = null; preview = null; editable = false;
    view.present({ document: doc, status: 'loading', editable: false });
    const capabilities = api.notesCapabilities ? await call('notesCapabilities') : { enabled: false };
    if (turn !== generation || disposed) return;
    if (!capabilities.enabled) { view.present({ document: doc, status: 'disabled', editable: false }); return; }
    let entry = entries.get(key(doc));
    if (!entry || (!entry.dirty && !entry.job)) {
      let result;
      try { result = await call('notesRead', doc.bookId, doc.noteId); } catch (err) {
        if (turn === generation && !disposed) view.present({ document: doc, status: 'error', editable: false });
        throw err;
      }
      if (turn !== generation || disposed) return;
      if (result.status !== 'ok') { view.present({ document: doc, status: result.status, editable: false }); return; }
      entry = { document: doc, title: result.title || '', html: result.html, savedHtml: result.html, bodyToken: result.bodyToken, dirty: false, job: null, editDay: null };
      entries.set(key(doc), entry);
    }
    const checked = inspect ? await inspect(entry.html) : { status: 'unvalidated' };
    if (turn !== generation || disposed) return;
    if (!checked || checked.status !== 'editable' || typeof checked.html !== 'string') {
      preview = { entry, checked };
      view.present({ document: doc, title: entry.title, status: checked?.status || 'unvalidated', editable: false, previewText: checked?.previewText, canCopy: typeof checked?.copyHtml === 'string' }); return;
    }
    // Inspection can normalize supported markup without making opening a save.
    if (!entry.dirty && !entry.job) entry.savedHtml = checked.html;
    entry.html = checked.html; active = entry; editable = true; show(entry);
  };
  const leave = async () => {
    generation++;
    if (composing) await waitComposition();
    capture(); active = null; preview = null; editable = false;
  };
  const hasPending = () => actions.size > 0 || [...entries.values()].some((entry) => entry.dirty || entry.job);
  const flushActions = async () => {
    for (const [id, action] of actions) {
      const result = action.kind === 'create'
        ? await call('notesCreate', action.bookId, action.request)
        : await call('notesRename', action.document.bookId, action.document.noteId, action.request);
      if (result.status !== 'saved') throw fail('ECONFLICT', 'Note metadata could not be saved');
      capture();
      action.result = result; actions.delete(id);
      if (action.kind === 'rename') {
        const entry = entries.get(key(action.document));
        if (entry) {
          entry.title = typeof result.title === 'string' ? result.title : action.request.title;
          if (active === entry && ![...actions.values()].some((a) => a.kind === 'rename' && key(a.document) === key(entry.document))) show(entry);
        }
      }
    }
  };
  const drain = async () => {
    if (timer !== null) { clearTimer(timer); timer = null; }
    do {
      if (refreshing) await refreshing;
      await waitComposition(); capture();
      for (const entry of entries.values()) {
        while (entry.dirty || entry.job) {
          await waitComposition(); capture();
          if (!entry.job) entry.job = { operationId: makeOperationId(), html: entry.html, expectedBodyToken: entry.bodyToken, writingDay: entry.editDay || writingDay() };
          const sent = entry.job;
          let result;
          try { result = await call('notesSave', entry.document.bookId, entry.document.noteId, { ...sent }); }
          catch (err) { if (err.code !== 'ENOENT' || !api.notesRefresh) throw err; result = { status: 'missing' }; }
          if (['conflict', 'missing'].includes(result.status) && api.notesRefresh) {
            const recovered = await call('notesRefresh', entry.document.bookId, entry.document.noteId, { baseBodyToken: sent.expectedBodyToken, localHtml: sent.html });
            if (recovered.status === 'recovered') {
              relocate(entry, recovered.noteId);
              if (active === entry) { await waitComposition(); capture(); show(entry); }
              result = { status: 'saved', bodyToken: recovered.bodyToken };
            } else if (recovered.status === 'ok' && recovered.bodyToken === sent.html) result = { status: 'saved', bodyToken: sent.html, conflictNoteId: recovered.conflictNoteId };
          }
          if (result.conflictNoteId && view.notice) view.notice('conflict');
          if (result.status !== 'saved') throw fail('ECONFLICT', 'Note body changed elsewhere');
          entry.bodyToken = typeof result.bodyToken === 'string' ? result.bodyToken : sent.html;
          entry.savedHtml = sent.html; entry.job = null; entry.dirty = entry.html !== sent.html;
          // Never repaint an acknowledged older body over newer typing.
        }
      }
      await flushActions(); capture();
    } while (hasPending() || isComposing());
  };
  const flush = () => {
    if (disposed) return Promise.reject(fail('ECLOSED', 'Notes controller is disposed'));
    if (!flushing) {
      const pending = drain(); flushing = pending;
      pending.finally(() => { if (flushing === pending) flushing = null; }).catch(() => {});
    }
    return flushing;
  };
  const requestClose = async () => {
    do { await flush(); capture(); } while (hasPending() || isComposing());
    return { status: 'ready' };
  };
  const create = async (bookId, title = '') => {
    live(); capture();
    let action = creations.get(bookId);
    if (action && action.request.title !== title) throw fail('EPENDING', 'Retry the pending creation first');
    if (!action) {
      const operationId = makeOperationId();
      action = { kind: 'create', bookId, request: { operationId, title } }; actions.set(operationId, action); creations.set(bookId, action);
    }
    await flush();
    if (!action.result) throw fail('EPENDING', 'Creation is pending');
    await open({ bookId, kind: 'custom', noteId: action.result.noteId });
    creations.delete(bookId);
    return action.result;
  };
  const rename = async (title) => {
    live();
    if (!active) throw fail('EINVAL', 'No editable custom note is open');
    capture(); const operationId = makeOperationId();
    actions.set(operationId, { kind: 'rename', document: { ...active.document }, request: { operationId, title } });
    await flush();
  };
  return {
    open, leave, edit, flush, requestClose, create, rename, hasPending,
    liveDocuments(bookId) {
      capture();
      return [...entries.values()].filter((entry) => entry.document.bookId === bookId && (entry === active || entry.dirty || entry.job)).map((entry) => ({ document: { ...entry.document }, title: entry.title, html: entry.html }));
    },
    updateTitle(bookId, noteId, title) {
      const entry = entries.get(key({ bookId, noteId }));
      if (entry) { entry.title = title; if (active === entry && !composing) { capture(); show(entry); } }
    },
    async createEditableCopy() {
      live();
      if (!preview || typeof preview.checked?.copyHtml !== 'string') throw fail('EINVAL', 'No unsupported note is open');
      const source = preview;
      if (!source.request) source.request = { operationId: makeOperationId(), html: source.checked.copyHtml, expectedBodyToken: source.entry.bodyToken };
      const result = await call('notesCopy', source.entry.document.bookId, source.entry.document.noteId, source.request);
      if (result.status !== 'saved') throw fail('ECONFLICT', 'Copy source changed; reopen the original');
      await open({ ...source.entry.document, noteId: result.noteId });
      return result;
    },
    refresh() {
      live();
      if (refreshing) return refreshing;
      if (!api.notesRefresh || composing || flushing || !(active || preview?.entry) || (active || preview?.entry).job) return Promise.resolve();
      const entry = active || preview.entry; const turn = generation;
      const current = () => active === entry || preview?.entry === entry;
      capture(); const displayedHtml = entry.html;
      // DOM normalization is not author writing. Compare clean refreshes against
      // the exact observed bytes, while tracking subsequent typing separately.
      const localHtml = entry.dirty ? displayedHtml : entry.bodyToken;
      const pending = (async () => {
        const result = await call('notesRefresh', entry.document.bookId, entry.document.noteId, { baseBodyToken: entry.bodyToken, localHtml });
        if (turn !== generation || !current() || disposed) return;
        await waitComposition();
        if (turn !== generation || !current() || disposed) return;
        capture();
        if (result.status !== 'ok') {
          if (result.status === 'recovered') {
            const recoveredDoc = { ...entry.document, noteId: result.noteId };
            const recovered = { ...entry, document: recoveredDoc, savedHtml: result.html, bodyToken: result.bodyToken, dirty: entry.html !== result.html, job: null };
            relocate(entry, result.noteId); entries.set(key(recoveredDoc), recovered);
            active = null; preview = null;
            await open(recoveredDoc);
          } else if (!entry.dirty) {
            editable = false;
            view.present({ document: entry.document, title: entry.title, status: result.status, editable: false });
          }
          return;
        }
        if (!result.changed && editable) { entry.title = result.title || ''; return; }
        const checked = inspect ? await inspect(result.html) : { status: 'unvalidated' };
        if (turn !== generation || !current() || disposed) return;
        await waitComposition();
        if (turn !== generation || !current() || disposed) return;
        capture();
        const newer = entry.html !== displayedHtml;
        if (checked.status !== 'editable') {
          if (entry.dirty || newer) return; // retain writing; next flush preserves the competing source
          editable = false; active = null; preview = { entry: { ...entry, html: result.html, bodyToken: result.bodyToken }, checked };
          view.present({ document: entry.document, title: result.title, status: checked.status, editable: false, previewText: checked.previewText, canCopy: typeof checked.copyHtml === 'string' });
          return;
        }
        entry.bodyToken = result.bodyToken; entry.savedHtml = checked.html; entry.title = result.title || '';
        if (!newer) entry.html = checked.html;
        entry.dirty = entry.html !== entry.savedHtml;
        active = entry; preview = null; editable = true;
        if (!newer) show(entry);
        if (result.conflictNoteId && view.notice) view.notice('conflict');
      })();
      refreshing = pending;
      pending.finally(() => { if (refreshing === pending) refreshing = null; }).catch(() => {});
      return pending;
    },
    setComposing(value) {
      composing = !!value;
      if (!composing) { capture(); for (const resolve of compositionWaiters.splice(0)) resolve(); }
    },
    dispose() {
      if (hasPending() || composing) throw fail('EPENDING', 'Cannot dispose pending writing');
      if (timer !== null) clearTimer(timer);
      generation++; disposed = true; active = null; editable = false;
    }
  };
}
const api = { createNotesController };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.NeoPlanetNotesUI = api;
})();
