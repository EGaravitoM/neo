'use strict';
(function () {
const search = globalThis.NeoPlanetNotesSearch;
const organization = globalThis.NeoPlanetNotesOrganization;
const selection = globalThis.NeoPlanetNotesRecoverySelection;
/** Notes-pane search/recovery. DOM previews and file commands belong to the host. */
function createNotesExplorer({ api, t, locale, currentBook, catalogLegacy, liveDocuments, currentDocument, editorRoot, openDocument, preview, closePreview, flush, dataChanged, onMode, onError }) {
  const root = document.createElement('section'); root.id = 'notes-explorer';
  let owner = null; let generation = 0; let navigation = 0; let mode = null; let index = null;
  let queryText = ''; let scope = 'all'; let selectedLabels = new Set(); let trashText = '';
  let list = null; let selectedWords = []; let hydrationTimer = null;
  const resultRows = new WeakMap();
  const cancelHydrationRender = () => { if (hydrationTimer !== null) clearTimeout(hydrationTimer); hydrationTimer = null; };
  let canRestore = true; let model = null; let metadataUnavailable = false; let busy = false; let loadTask = null; const pending = new Map();
  const textOf = (html) => {
    const holder = document.createElement('template'); holder.innerHTML = html;
    holder.content.querySelectorAll('script,style,template,noscript').forEach((n) => n.remove());
    holder.content.querySelectorAll('p,div,li,br,h1,h2,h3,h4,h5,h6,blockquote,pre,tr').forEach((n) => n.after(document.createTextNode('\n')));
    return holder.content.textContent || '';
  };
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; };
  const button = (title, callback, action) => {
    const el = node('button', title, 'btn-quiet'); el.type = 'button'; el.dataset.explorerAction = action;
    el.addEventListener('click', () => Promise.resolve().then(callback).catch(error)); return el;
  };
  const call = async (method, ...args) => {
    const result = await api[method](...args);
    if (result?.status === 'error') throw Object.assign(new Error(result.error.message), { code: result.error.code });
    return result;
  };
  const sameOwner = (book, turn) => owner === book && currentBook() === book && generation === turn;
  const status = (text) => { const el = root.querySelector('.notes-explorer-status'); if (el) el.textContent = text; };
  const error = (err) => {
    if (onError) onError(err);
    status(err.code === 'ECONFLICT' ? t('This recovery view changed. Refresh it before applying changes.') : t('NEO could not finish this notes request. Your material is preserved.'));
    const retry = root.querySelector('[data-explorer-action="retry"]'); if (retry) retry.hidden = !pending.has(owner);
  };
  const clearHighlights = () => { if (globalThis.CSS?.highlights) CSS.highlights.delete('neo-notes-search'); };
  const highlight = () => {
    clearHighlights(); const body = editorRoot();
    if (mode !== 'search' || !body || !selectedWords.length || !globalThis.CSS?.highlights || !globalThis.Highlight) return;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT); const nodes = []; let el; let text = '';
    while ((el = walker.nextNode())) { nodes.push({ el, start: text.length, end: text.length + el.length }); text += el.data; }
    const point = (offset, end) => {
      const item = nodes.find((n) => end ? offset > n.start && offset <= n.end : offset >= n.start && offset < n.end);
      return item ? [item.el, offset - item.start] : null;
    };
    const ranges = [];
    for (const word of selectedWords) {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      for (const match of text.matchAll(new RegExp(escaped, 'giu'))) {
        const start = point(match.index, false); const end = point(match.index + match[0].length, true);
        if (start && end) { const range = document.createRange(); range.setStart(...start); range.setEnd(...end); ranges.push(range); }
      }
    }
    const marks = new Highlight(); for (const range of ranges) marks.add(range);
    CSS.highlights.set('neo-notes-search', marks);
  };
  const reportCoverage = (coverage) => {
    status(coverage.complete ? t('{n} notes found', { n: coverage.results ?? 0 }) : t('Search coverage is incomplete: {loading} loading, {unavailable} unavailable.', { loading: coverage.pending, unavailable: coverage.unavailable }));
  };
  const renderResults = () => {
    if (mode !== 'search' || !model) return;
    const results = root.querySelector('.notes-search-results'); if (!results) return;
    const focused = results.contains(document.activeElement) ? document.activeElement.closest('[data-result-key]')?.dataset.resultKey : null;
    const value = model.query({ text: queryText, scope, labelIds: [...selectedLabels], live: liveDocuments(owner) });
    reportCoverage({ ...value.coverage, unavailable: value.coverage.unavailable + Number(metadataUnavailable), complete: value.coverage.complete && !metadataUnavailable, results: value.results.length });
    // The initial empty All view fills with available results. Coverage still
    // counts every pending body; explicit queries/filters retain known-title
    // matches, and unavailable notes remain visible rather than becoming blanks.
    const displayed = queryText.trim() || scope !== 'all' || selectedLabels.size ? value.results : value.results.filter(result => result.status !== 'loading');
    // Batch initial population and large reductions in one attached-DOM update.
    // Retained rows keep their handlers/state; focus is restored below if moved.
    const batch = !results.childElementCount || results.childElementCount > displayed.length * 2 ? document.createDocumentFragment() : null;
    const existing = new Map([...results.children].map(row => [row.dataset.resultKey, row]));
    let cursor = results.firstElementChild;
    for (const result of displayed) {
      const key = search.key(result.document); let row = existing.get(key); let entry;
      if (row) entry = resultRows.get(row);
      else {
        entry = { result };
        row = button('', async () => {
          const book = owner; const turn = generation;
          selectedWords = search.words(queryText);
          await openDocument(entry.result.document, entry.result);
          if (sameOwner(book, turn)) highlight();
        }, 'open-result');
        row.className = 'nav-item notes-item notes-search-result'; row.dataset.resultKey = key;
        const line = node('div', undefined, 'n-row'); entry.title = node('span', '', 'n-label'); line.append(entry.title); row.append(line);
        entry.location = node('div', '', 'notes-result-location'); entry.excerpt = node('div', '', 'nav-note nav-note-ro'); row.append(entry.location, entry.excerpt);
        resultRows.set(row, entry);
      }
      entry.result = result;
      for (const [element, text] of [[entry.title, result.title || t('Untitled')], [entry.location, result.location || result.groupPath || t('Top level')], [entry.excerpt, result.status === 'ok' ? result.excerpt : t('This note is not available on this device yet.')]]) if (element.textContent !== text) element.textContent = text;
      if (batch) batch.append(row);
      else { if (row !== cursor) results.insertBefore(row, cursor); cursor = row.nextElementSibling; }
      existing.delete(key);
    }
    if (batch) results.replaceChildren(batch);
    else for (const row of existing.values()) row.remove();
    if (focused && document.activeElement?.dataset.resultKey !== focused) [...results.children].find(row => row.dataset.resultKey === focused)?.focus();
  };
  const scheduleHydrationRender = (book, turn) => {
    if (hydrationTimer !== null) return;
    hydrationTimer = setTimeout(() => { hydrationTimer = null; if (sameOwner(book, turn)) renderResults(); }, 16);
  };

  const searchForm = (focus = true) => {
    const form = node('form', undefined, 'notes-explorer-form'); form.setAttribute('aria-label', t('Search notes'));
    const label = node('label', t('Search notes')); const input = node('input'); input.type = 'search'; input.value = queryText; input.dataset.notesSearch = 'query'; label.append(input); form.append(label);
    const scopeLabel = node('label', t('Search in')); const select = node('select'); select.dataset.notesSearch = 'scope';
    for (const [value, title] of [['all', t('All')], ['title', t('Title')], ['content', t('Content')], ['group', t('Group')], ['label', t('Label')]]) {
      const option = node('option', title); option.value = value; option.selected = value === scope; select.append(option);
    }
    scopeLabel.append(select); form.append(scopeLabel);
    input.addEventListener('input', () => { queryText = input.value; renderResults(); selectedWords = search.words(queryText); highlight(); });
    select.addEventListener('change', () => { scope = select.value; renderResults(); });
    form.addEventListener('submit', (e) => { e.preventDefault(); renderResults(); });
    if (index?.labels.length) {
      const labels = node('fieldset'); labels.append(node('legend', t('Labels')));
      for (const value of index.labels) {
        const label = node('label'); const check = node('input'); check.type = 'checkbox'; check.checked = selectedLabels.has(value.id); check.dataset.labelId = value.id;
        check.addEventListener('change', () => { check.checked ? selectedLabels.add(value.id) : selectedLabels.delete(value.id); renderResults(); });
        label.append(check, document.createTextNode(value.name)); labels.append(label);
      }
      form.append(labels);
    }
    root.querySelector('.notes-search-body').append(form, node('div', undefined, 'notes-search-results')); renderResults(); if (focus) input.focus();
  };
  const startSearch = async (background = false) => {
    const book = owner; const turn = generation;
    cancelHydrationRender();
    model = search.createNotesSearch({ textOf, locale: locale() });
    let loaded;
    try { loaded = await call('notesLoad', book); }
    catch (err) { if (onError) onError(err); loaded = { status: 'unavailable' }; }
    if (!sameOwner(book, turn) || mode !== 'search') return;
    metadataUnavailable = !['ok', 'missing'].includes(loaded.status);
    if (!metadataUnavailable) {
      index = loaded.status === 'ok' ? loaded.index : null;
      const availableLabels = new Set((index?.labels || []).map((label) => label.id));
      selectedLabels = new Set([...selectedLabels].filter((id) => availableLabels.has(id)));
    }
    root.querySelector('.notes-search-body').replaceChildren(); searchForm(!background);
    const tasks = [];
    for (const legacy of catalogLegacy(book)) tasks.push({ ...legacy, document: { bookId: book, ...legacy.document } });
    for (const note of index?.notes || []) {
      const groups = organization.pathTo(index, note.parentId);
      tasks.push({ document: { bookId: book, kind: 'custom', noteId: note.id }, title: note.title || t('Untitled'), groupPath: groups.map((g) => g.title).join(' / '), location: groups.map((g) => g.title).join(' / ') || t('Custom Notes'), labelIds: note.labelIds, labels: note.labelIds.map((id) => index.labels.find((l) => l.id === id)?.name).filter(Boolean) });
    }
    for (const task of tasks) model.upsert({ ...task, status: 'loading' }); renderResults();
    // Small batches permit editor writes to enter the book queue between reads.
    for (let offset = 0; offset < tasks.length; offset += 4) {
      if (!sameOwner(book, turn) || mode !== 'search') return;
      await Promise.all(tasks.slice(offset, offset + 4).map(async (task) => {
        let result;
        try { result = task.document.kind === 'custom' ? await call('notesRead', book, task.document.noteId) : await call('notesReadLegacy', book, { page: task.document.kind === 'book' ? 'book' : task.document.chapterId }); }
        catch (err) { result = { status: err.code === 'ECLOUD' ? 'unavailable' : 'invalid' }; }
        if (!sameOwner(book, turn) || mode !== 'search') return;
        if (task.document.kind === 'chapter' && result.status === 'missing') model.upsert({ ...task, status: 'absent', html: '' });
        else model.upsert({ ...task, ...result, ...(task.document.kind === 'book' && result.status === 'missing' ? { status: 'ok', html: '' } : {}) });
        scheduleHydrationRender(book, turn);
      }));
    }
    if (sameOwner(book, turn) && mode === 'search') { cancelHydrationRender(); renderResults(); }
  };
  const fieldName = (field) => ({ title: t('Title'), name: t('Label name'), parentId: t('Group'), labelIds: t('Labels'), sortMode: t('Ordering'), childOrder: t('Sequence'), '*': t('Item') })[field];
  const describe = (choice, side, record) => {
    const value = choice[side]; const variant = record.variants[side];
    if (value === null) return choice.field === 'parentId' ? t('Top level') : t('Absent');
    if (choice.field === '*') return value.title || value.name || t('Untitled');
    if (choice.field === 'parentId') return organization.pathTo(variant, value).map((g) => g.title).join(' / ') || t('Unavailable group');
    if (Array.isArray(value)) return value.map((id) => [...variant.groups, ...variant.notes, ...variant.labels].find((v) => v.id === id)).map((v) => v?.title || v?.name || t('Untitled')).join(', ') || t('None');
    if (choice.field === 'sortMode') return value === 'manual' ? t('Manual') : t('Alphabetical');
    return String(value);
  };
  const command = async (request) => {
    if (!canRestore) throw Object.assign(new Error('Restoration requires desktop NEO'), { code: 'ENOTSUPPORTED' });
    if (busy) return;
    const book = owner; const turn = generation; const epoch = navigation;
    const previous = pending.get(book);
    if (previous && JSON.stringify(previous.request) !== JSON.stringify(request)) throw Object.assign(new Error('Retry the previous recovery first'), { code: 'EPENDING' });
    busy = true; root.setAttribute('aria-busy', 'true');
    try {
      await flush();
      const attempt = previous || { request: { operationId: 'o-' + crypto.randomUUID(), ...request } }; pending.set(book, attempt);
      const result = await call('notesRecover', book, attempt.request);
      if (result.status !== 'saved') { pending.delete(book); throw Object.assign(new Error('Recovery changed'), { code: 'ECONFLICT' }); }
      pending.delete(book);
      if (!sameOwner(book, turn) || epoch !== navigation) return;
      await dataChanged(book);
      if (result.noteId) { await closePreview(false); await openDocument({ bookId: book, kind: 'custom', noteId: result.noteId }); }
      if (sameOwner(book, turn)) await loadRecovery();
    } catch (err) {
      if (['EINVAL', 'ENOENT', 'ECONFLICT'].includes(err.code)) pending.delete(book);
      throw err;
    } finally { busy = false; root.setAttribute('aria-busy', 'false'); }
  };
  const showEntry = async (entry) => {
    const book = owner; const turn = generation; const epoch = ++navigation;
    const result = await call('notesRecoveryRead', book, entry.ref);
    if (!sameOwner(book, turn) || epoch !== navigation) return;
    if (result.status !== 'ok') { status(t('This recovery item is not available on this device yet.')); return; }
    const actions = root.querySelector('.notes-recovery-actions'); actions.replaceChildren();
    const title = result.record?.note?.title || (mode === 'history' ? currentDocument()?.title : '') || t('Untitled');
    if (typeof result.html === 'string') {
      await preview({ title, html: result.html, ref: entry.ref });
      if (!sameOwner(book, turn) || epoch !== navigation) return;
      if (canRestore && entry.ref.kind === 'trash') actions.append(button(t('Restore'), () => command({ ...entry.ref, expectedVersionId: result.versionId }), 'restore'));
      else if (canRestore) actions.append(button(t('Restore'), () => command({ ...entry.ref, mode: 'replace', expectedVersionId: result.versionId }), 'restore'), button(t('Restore as new note'), () => command({ ...entry.ref, mode: 'new', expectedVersionId: result.versionId }), 'restore-new'));
    } else if (result.record.variants) {
      await preview({ title: t('Organization conflict'), text: canRestore ? t('Choose recorded values to apply to the current notebook. Notes and recovery evidence are preserved.') : t('These competing organization values are preserved. Resolve them in desktop NEO.'), ref: entry.ref });
      if (!sameOwner(book, turn) || epoch !== navigation) return;
      const form = node('form', undefined, 'notes-explorer-form'); form.setAttribute('aria-label', t('Recover organization'));
      const selections = [];
      for (const choice of selection.recoveryChoices(result.record)) {
        const label = node('label', (choice.title || t('Top level')) + ' · ' + fieldName(choice.field));
        if (!canRestore) {
          for (const side of ['local', 'incoming']) label.append(node('small', t('{side}: {value}', { side: side === 'local' ? t('This device') : t('Other version'), value: describe(choice, side, result.record) })));
          form.append(label); continue;
        }
        const select = node('select');
        select.append(node('option', t('Keep current value'))); select.firstChild.value = '';
        for (const side of ['local', 'incoming']) { const option = node('option', t('{side}: {value}', { side: side === 'local' ? t('This device') : t('Other version'), value: describe(choice, side, result.record) })); option.value = side; select.append(option); }
        if (choice.collection === 'notes' && choice.field === '*') { select.disabled = true; label.append(node('small', t('Restore note identities through Trash or Recovered Notes.'))); }
        label.append(select); form.append(label); selections.push({ choice, select });
      }
      const apply = button(t('Apply selected values'), () => {
        const values = selections.filter((r) => r.select.value).map(({ choice, select }) => ({ collection: choice.collection, id: choice.id, field: choice.field, side: select.value }));
        return command({ ...entry.ref, expectedVersionId: result.versionId, selections: values });
      }, 'apply-values');
      const updateApply = () => { apply.disabled = !selections.some(({ select }) => !select.disabled && select.value); };
      for (const { select } of selections) select.addEventListener('change', updateApply);
      updateApply(); if (canRestore) form.append(apply);
      form.addEventListener('submit', (e) => e.preventDefault()); actions.append(form);
    } else {
      const record = result.record;
      await preview({ title: t('Competing note versions'), html: record.incomingHtml || '', ref: entry.ref });
      if (record.localHtml !== undefined) actions.append(button(t('Preview local version'), () => preview({ title: t('Local version'), html: record.localHtml, ref: entry.ref }), 'preview-local'));
      actions.append(button(t('Preview other version'), () => preview({ title: t('Other version'), html: record.incomingHtml, ref: entry.ref }), 'preview-other'));
      if (record.recoveredNoteId) actions.append(button(t('Open recovered note'), () => openDocument({ bookId: book, kind: 'custom', noteId: record.recoveredNoteId }), 'open-recovered'));
    }
  };
  const renderRecoveryList = () => {
    const rows = root.querySelector('.notes-recovery-list'); if (!rows || !list) return; rows.replaceChildren();
    const needles = search.words(trashText).map((word) => word.toLocaleLowerCase(locale()));
    for (const entry of list.entries) {
      const record = entry.record;
      if (mode === 'trash' && entry.status === 'ok' && needles.length && !needles.every((needle) => ((record.note.title || '') + ' ' + textOf(entry.html) + ' ' + record.labels.map((l) => l.name).join(' ')).toLocaleLowerCase(locale()).includes(needle))) continue;
      const title = mode === 'trash' ? record?.note?.title || t('Untitled') : mode === 'history' ? record?.createdAt ? new Date(record.createdAt).toLocaleString(locale()) : t('Unavailable revision') : record?.kind === 'body' || record?.kind === 'edit-delete' ? t('Competing note versions') : t('Organization conflict');
      const row = button(title, () => showEntry(entry), 'preview'); row.className = 'notes-recovery-row'; row.disabled = entry.status !== 'ok';
      if (entry.status !== 'ok') row.textContent = t('Recovery item unavailable'); rows.append(row);
    }
    status(list.complete ? list.entries.length ? '' : t('No recovery items here.') : t('Some recovery files are unavailable. Available items remain accessible.'));
  };
  const loadRecovery = async () => {
    if (!['trash', 'history', 'conflicts'].includes(mode)) return;
    const book = owner; const turn = generation; const document = currentDocument();
    if (mode === 'history' && document?.kind !== 'custom') { status(t('Open a custom note to view its history.')); return; }
    list = await call('notesRecoveryList', book, { kind: mode === 'history' ? 'revisions' : mode, ...(mode === 'history' ? { noteId: document.noteId } : {}) });
    if (!sameOwner(book, turn)) return;
    renderRecoveryList();
  };
  const render = () => {
    root.replaceChildren();
    const tools = node('div', undefined, 'notes-explorer-tools');
    tools.append(button(t('Search notes'), () => setMode('search'), 'search'), button(t('Trash'), () => setMode('trash'), 'trash'), button(t('History'), () => setMode('history'), 'history'), button(t('Conflicts'), () => setMode('conflicts'), 'conflicts'));
    root.append(tools);
    const feedback = node('p', '', 'notes-explorer-status'); feedback.setAttribute('role', 'status'); root.append(feedback);
    const area = node('div', undefined, 'notes-explorer-content'); root.append(area);
    if (!mode) return;
    const heading = node('div', undefined, 'notes-explorer-heading'); heading.append(node('span', mode === 'search' ? t('Search notes') : mode === 'trash' ? t('Trash') : mode === 'history' ? t('Revision history') : t('Conflicts')));
    heading.append(button(t('Close'), () => setMode(null), 'close'), button(t('Refresh'), () => setMode(mode), 'refresh'));
    const retry = button(t('Retry'), () => command(pending.get(owner).request), 'retry'); retry.hidden = !pending.has(owner); heading.append(retry); area.append(heading);
    if (mode === 'search') area.append(node('div', undefined, 'notes-search-body'));
    else {
      if (mode === 'trash') {
        const label = node('label', t('Search trash'), 'notes-explorer-form'); const input = node('input'); input.type = 'search'; input.value = trashText; input.addEventListener('input', () => { trashText = input.value; renderRecoveryList(); }); label.append(input); area.append(label);
      }
      area.append(node('div', undefined, 'notes-recovery-list'), node('div', undefined, 'notes-recovery-actions'));
    }
  };
  const setMode = (value) => {
    generation++; navigation++; cancelHydrationRender(); clearHighlights(); mode = value;
    const book = owner; const turn = generation;
    onMode(!!mode); render();
    // settled() must include asynchronous preview closure, not the previous
    // search's completed promise. Abandoned transitions cannot restart loading.
    loadTask = (async () => {
      if (!value || value === 'search') await closePreview(true);
      if (!sameOwner(book, turn) || mode !== value) return;
      if (value === 'search') await startSearch();
      else if (value) await loadRecovery();
    })();
    return loadTask;
  };
  return {
    root,
    async mount(host, book) {
      const capability = await call('notesCapabilities');
      if (!capability.enabled || currentBook() !== book) return;
      canRestore = capability.canRestore !== false;
      if (owner !== book) { owner = book; generation++; navigation++; mode = null; selectedLabels = new Set(); queryText = ''; trashText = ''; index = null; model = null; render(); }
      host.prepend(root); onMode(!!mode);
    },
    edited() { if (mode === 'search') { renderResults(); highlight(); } },
    navigated() { navigation++; clearHighlights(); },
    async refresh() { if (!busy && mode === 'search' && !root.contains(document.activeElement)) { generation++; loadTask = startSearch(true); await loadTask; } },
    detach() { cancelHydrationRender(); owner = null; generation++; navigation++; mode = null; clearHighlights(); root.remove(); onMode(false); },
    isOpen: () => !!mode,
    settled: () => loadTask || Promise.resolve()
  };
}
globalThis.NeoPlanetNotesExplorer = { createNotesExplorer };
})();
