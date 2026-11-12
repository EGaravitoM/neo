'use strict';

(function () {
const domain = globalThis.NeoPlanetNotesOrganization;
/** Notes-only navigation. All persistence uses domain bridge commands. */
function createNotesTree({ api, t, locale, currentBook, canManage, openNote, createNote, flushEditor, removeOpenNote, activeNote, titleChanged, contextMenu, onError }) {
  const root = document.createElement('section'); root.id = 'custom-notes-nav';
  const sessions = new Map(); let bookId = null; let index = null; let selected = null; let generation = 0;
  let busy = false; let pending = null; let canUndo = false; let dragId = null; let drop = null; let dropTarget = null; let mode = null; let renderedFormKey = null;
  const state = () => {
    if (!sessions.has(bookId)) sessions.set(bookId, { expanded: new Set(), selected: null });
    return sessions.get(bookId);
  };
  const manage = () => canManage() && !busy;
  const call = async (method, ...args) => {
    const result = await api[method](...args);
    if (result?.status === 'error') throw Object.assign(new Error(result.error.message), { code: result.error.code });
    return result;
  };
  const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node; };
  const button = (text, action, key) => {
    const b = el('button', text, 'btn-quiet'); b.type = 'button'; b.dataset.action = key;
    b.addEventListener('click', () => Promise.resolve().then(action).catch(error)); return b;
  };
  const error = (err) => {
    busy = false;
    if (onError) onError(err);
    const status = root.querySelector('.custom-notes-status');
    if (status) status.textContent = err.code === 'EMERGE' ? t('That exact label already exists. Choose Merge labels to combine them.') : err.code === 'EDUPLICATE' ? t('A label with this exact name already exists.') : err.code === 'ECONFLICT' ? t('Organization changed on another device. Your writing is safe; refresh before trying again.') : t('Custom Notes could not complete this action. Your writing is safe.');
    const retry = root.querySelector('[data-action="retry"]'); if (retry) retry.hidden = !pending;
  };
  const item = () => index && [...index.groups, ...index.notes].find((n) => n.id === selected);
  const group = (id) => index.groups.some((g) => g.id === id);
  const labelFor = (value) => value.title || t('Untitled');
  const location = (id) => id === null ? t('Custom Notes') : domain.pathTo(index, id).map(labelFor).join(' / ');
  const announce = (text) => { const status = root.querySelector('.custom-notes-status'); if (status) status.textContent = text; };
  const loadIndex = async (owner, turn) => {
    const [loaded, undo] = await Promise.all([call('notesLoad', owner), call('notesOrganizationState', owner)]);
    if (turn !== generation || owner !== bookId || owner !== currentBook()) return false;
    if (loaded.status === 'missing') index = null;
    else if (loaded.status === 'ok') index = loaded.index;
    else throw Object.assign(new Error('Collection unavailable'), { code: loaded.status === 'unavailable' ? 'ECLOUD' : 'EINVAL' });
    canUndo = !!undo.canUndo;
    if (index) for (const note of index.notes) titleChanged(note.id, note.title);
    return true;
  };
  const reveal = (id) => {
    const value = [...index.groups, ...index.notes].find((n) => n.id === id);
    if (value) for (const g of domain.pathTo(index, value.parentId)) state().expanded.add(g.id);
  };
  const run = async (request, undo = false) => {
    if (!canManage() || busy) return;
    if (pending && (pending.bookId !== bookId || JSON.stringify(pending.request) !== JSON.stringify(request))) throw Object.assign(new Error('Retry the pending operation first'), { code: 'EPENDING' });
    const owner = bookId; const turn = generation;
    busy = true; root.inert = true; root.setAttribute('aria-busy', 'true');
    try {
      await flushEditor();
      if (owner !== currentBook()) return;
      if (!pending) pending = { bookId: owner, request: { operationId: 'o-' + crypto.randomUUID(), ...request }, undo };
      const attempt = pending;
      const result = await call(attempt.undo ? 'notesUndoOrganization' : 'notesOrganize', owner, attempt.request);
      if (result.status !== 'saved') throw Object.assign(new Error('Organization conflict'), { code: 'ECONFLICT' });
      pending = null;
      if (request.action === 'trashNote') await removeOpenNote(request.noteId);
      if (request.action === 'rename') titleChanged(request.itemId, request.title);
      if (turn !== generation || owner !== currentBook()) return;
      if (await loadIndex(owner, turn)) {
        if (result.itemId && index && [...index.groups, ...index.notes].some((n) => n.id === result.itemId)) { selected = result.itemId; reveal(selected); }
        const writing = request.action === 'trashNote' && activeNote?.();
        if (writing && index?.notes.some((n) => n.id === writing)) { selected = writing; reveal(writing); }
        mode = null; render();
      }
    } catch (err) {
      // Validation/merge-choice failures have not prepared a command and should
      // permit correction rather than freezing a form behind an immutable ID.
      if (['EINVAL', 'EMERGE', 'EDUPLICATE', 'ENOENT', 'EUNDO', 'ECONFLICT'].includes(err.code)) pending = null;
      throw err;
    } finally { busy = false; root.inert = false; root.setAttribute('aria-busy', 'false'); }
  };
  const retry = async () => {
    if (!pending || pending.bookId !== bookId) return;
    const attempt = pending;
    return run(attempt.request, attempt.undo);
  };
  const focusRow = (id) => root.querySelector('[data-item-id="' + id + '"]')?.focus();
  const select = (id, focus = false) => { selected = id; state().selected = id; mode = null; render(); if (focus) focusRow(id); };
  const form = (title) => {
    const box = el('form'); box.className = 'custom-notes-form'; box.setAttribute('aria-label', title);
    box.append(el('h4', title)); root.append(box);
    box.addEventListener('submit', (e) => e.preventDefault());
    box.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); mode = null; render(); if (selected) focusRow(selected); } });
    return box;
  };
  const input = (box, text, value = '') => {
    const label = el('label', text); const field = el('input'); field.type = 'text'; field.value = value; label.append(field); box.append(label); return field;
  };
  const parentSelect = (box, value, movingId = null) => {
    const label = el('label', t('Destination')); const select = el('select'); select.dataset.field = 'destination';
    const destinations = index.groups.map((g) => ({ id: g.id, title: location(g.id) }));
    const counts = new Map(); const positions = new Map();
    for (const destination of destinations) counts.set(destination.title, (counts.get(destination.title) || 0) + 1);
    const options = [{ id: null, title: t('Custom Notes') }, ...destinations.map((destination) => {
      const n = (positions.get(destination.title) || 0) + 1; positions.set(destination.title, n);
      return { id: destination.id, title: counts.get(destination.title) > 1 ? t('{name} ({n})', { name: destination.title, n }) : destination.title };
    }).filter((g) => !movingId || domain.canMove(index, movingId, g.id))];
    for (const option of options) { const node = el('option', option.title); node.value = option.id || ''; node.selected = option.id === value; select.append(node); }
    label.append(select); box.append(label); return () => select.value || null;
  };
  const submit = (box, text, action) => {
    const b = el('button', text, 'btn-quiet'); b.type = 'submit'; box.append(b);
    box.addEventListener('submit', (e) => { e.preventDefault(); Promise.resolve().then(action).catch(error); });
    box.append(button(t('Cancel'), () => { mode = null; render(); }, 'cancel'));
  };
  const creation = (kind, focus = true) => {
    const isGroup = kind === 'group'; const box = form(isGroup ? t('New group') : t('New note'));
    const field = input(box, isGroup ? t('Group name') : t('Note title')); field.dataset.field = 'name'; field.required = isGroup;
    const value = item(); const parentId = value ? group(value.id) ? value.id : value.parentId : null;
    const parent = index ? parentSelect(box, parentId) : () => null;
    submit(box, t('Create'), async () => {
      if (isGroup) { await run({ action: 'createGroup', title: field.value, parentId: parent() }); if (selected) state().expanded.add(selected); render(); }
      else {
        if (!canManage() || busy || pending) return;
        busy = true; const owner = bookId; let result;
        try { result = await createNote(field.value); }
        finally { busy = false; }
        if (owner !== currentBook()) return;
        if (await loadIndex(owner, generation)) { selected = result.noteId; if (parent() !== null) await run({ action: 'move', itemId: selected, parentId: parent() }); else { mode = null; render(); } }
      }
    });
    if (focus) field.focus();
  };
  const labels = () => {
    const box = form(t('Labels'));
    const note = index?.notes.find((n) => n.id === selected);
    for (const label of index?.labels || []) {
      const row = el('div', undefined, 'custom-label-row');
      if (note) {
        const checkLabel = el('label'); const check = el('input'); check.type = 'checkbox'; check.checked = note.labelIds.includes(label.id);
        check.addEventListener('change', () => run({ action: 'assignLabel', noteId: note.id, labelId: label.id, assigned: check.checked }).then(() => { mode = 'labels'; render(); }).catch(error));
        checkLabel.append(check, document.createTextNode(label.name)); row.append(checkLabel);
      } else row.append(el('span', label.name));
      const rename = button(t('Rename'), () => { mode = { labelId: label.id }; render(); }, 'rename-label'); rename.dataset.labelId = label.id;
      row.append(rename, button(t('Delete label'), () => run({ action: 'deleteLabel', labelId: label.id }).then(() => { mode = 'labels'; render(); }), 'delete-label')); box.append(row);
    }
    const field = input(box, t('Label name')); field.dataset.field = 'label-name'; field.required = true;
    submit(box, t('Add label'), () => run({ action: 'createLabel', name: field.value }).then(() => { mode = 'labels'; render(); }));
  };
  const renameLabel = (id, focus = true) => {
    const label = index.labels.find((l) => l.id === id); if (!label) return;
    const box = form(t('Rename label')); const field = input(box, t('Label name'), label.name); field.required = true;
    const mergeLabel = el('label'); const merge = el('input'); merge.type = 'checkbox'; mergeLabel.append(merge, document.createTextNode(t('Merge labels if this exact name already exists'))); box.append(mergeLabel);
    submit(box, t('Save'), () => run({ action: 'renameLabel', labelId: id, name: field.value, merge: merge.checked })); if (focus) field.focus();
  };
  const reorder = (direction) => {
    const value = item(); const siblings = domain.sortedChildren(index, value.parentId, locale()); const at = siblings.findIndex((n) => n.id === value.id); const next = at + direction;
    if (next < 0 || next >= siblings.length) return;
    return run({ action: 'move', itemId: value.id, parentId: value.parentId, beforeId: direction < 0 ? siblings[next].id : siblings[next + 1]?.id || null }).then(() => focusRow(value.id));
  };
  const controls = () => {
    const value = item(); if (!value) return;
    const box = form(labelFor(value));
    const name = input(box, group(value.id) ? t('Group name') : t('Note title'), value.title); name.required = group(value.id);
    submit(box, t('Rename'), () => run({ action: 'rename', itemId: value.id, title: name.value }));
    const parent = parentSelect(box, value.parentId, value.id);
    box.append(button(t('Move'), () => run({ action: 'move', itemId: value.id, parentId: parent() }), 'move'));
    box.append(button(t('Move up'), () => reorder(-1), 'move-up'), button(t('Move down'), () => reorder(1), 'move-down'));
    const sort = (id) => {
      const parent = id === null ? index.root : index.groups.find((g) => g.id === id);
      box.append(button(parent.sortMode === 'manual' ? t('Sort alphabetically') : t('Use manual order'), () => run({ action: 'sort', parentId: id, sortMode: parent.sortMode === 'manual' ? 'alphabetical' : 'manual' }), 'sort'));
    };
    sort(group(value.id) ? value.id : value.parentId);
    if (group(value.id)) {
      box.append(el('p', t('Deleting a group moves its immediate children to its parent. Notes are kept.')));
      box.append(button(t('Delete group'), () => run({ action: 'deleteGroup', itemId: value.id }), 'delete-group'));
    } else box.append(button(t('Move note to trash'), () => run({ action: 'trashNote', noteId: value.id }), 'trash-note'));
  };
  const showContextMenu = async (event, value, row) => {
    if (!canManage() || busy || !contextMenu) return;
    event.preventDefault(); event.stopPropagation(); selected = value.id; state().selected = selected;
    const owner = bookId; const turn = generation;
    const isGroup = group(value.id);
    const choices = [
      { label: t('Rename'), value: 'rename' }, { label: t('Move'), value: 'move' },
      ...(!isGroup ? [{ label: t('Labels'), value: 'labels' }] : []),
      '-', { label: t('Move up'), value: 'up' }, { label: t('Move down'), value: 'down' },
      '-', { label: isGroup ? t('Delete group') : t('Move note to trash'), value: 'delete', danger: true }
    ];
    const choice = await contextMenu(event.clientX, event.clientY, choices, { title: labelFor(value), from: row });
    if (!choice || owner !== currentBook() || turn !== generation || !canManage()) return;
    if (!index || ![...index.groups, ...index.notes].some((item) => item.id === value.id)) return;
    selected = value.id; state().selected = selected;
    if (choice === 'up' || choice === 'down') return reorder(choice === 'up' ? -1 : 1);
    if (choice === 'delete') return run(isGroup ? { action: 'deleteGroup', itemId: value.id } : { action: 'trashNote', noteId: value.id });
    mode = choice === 'labels' ? 'labels' : 'item'; render();
    root.querySelector(choice === 'move' ? '.custom-notes-form select' : '.custom-notes-form input')?.focus();
  };
  const open = async (id) => { await openNote(id); select(id); };
  const keydown = (event, rows, at) => {
    const value = rows[at]; const expanded = state().expanded;
    let target;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && manage()) { event.preventDefault(); event.stopPropagation(); run({}, true).catch(error); return; }
    if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key) && manage()) { event.preventDefault(); event.stopPropagation(); selected = value.item.id; reorder(event.key === 'ArrowUp' ? -1 : 1)?.catch(error); return; }
    if (event.key === 'ArrowDown') target = rows[at + 1]?.item.id;
    else if (event.key === 'ArrowUp') target = rows[at - 1]?.item.id;
    else if (event.key === 'Home') target = rows[0]?.item.id;
    else if (event.key === 'End') target = rows.at(-1)?.item.id;
    else if (event.key === 'ArrowRight' && value.kind === 'group') {
      if (!expanded.has(value.item.id)) { expanded.add(value.item.id); target = value.item.id; } else target = rows[at + 1]?.item.parentId === value.item.id ? rows[at + 1].item.id : undefined;
    } else if (event.key === 'ArrowLeft') {
      if (value.kind === 'group' && expanded.has(value.item.id)) { expanded.delete(value.item.id); target = value.item.id; } else target = value.item.parentId;
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault(); event.stopPropagation();
      if (value.kind === 'note') open(value.item.id).catch(error);
      else { expanded.has(value.item.id) ? expanded.delete(value.item.id) : expanded.add(value.item.id); render(); focusRow(value.item.id); }
      return;
    } else if ((event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) && manage() && contextMenu) { showContextMenu(event, value.item, event.currentTarget).catch(error); return; }
    else if ((event.key === 'F2' || event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) && manage()) { event.preventDefault(); event.stopPropagation(); mode = 'item'; selected = value.item.id; render(); root.querySelector('.custom-notes-form input')?.focus(); return; }
    else return;
    event.preventDefault(); event.stopPropagation(); if (target) select(target, true);
  };
  const dragOver = (event, row) => {
    drop = null; dropTarget = null;
    root.querySelectorAll('[data-drop]').forEach((n) => delete n.dataset.drop);
    if (!manage() || !dragId || !index) return;
    const rect = row.getBoundingClientRect(); const fraction = (event.clientY - rect.top) / rect.height;
    const value = [...index.groups, ...index.notes].find((n) => n.id === row.dataset.itemId);
    if (value.id === dragId) return;
    let parentId; let beforeId; const into = group(value.id) && fraction > .25 && fraction < .75;
    if (into) parentId = value.id;
    else {
      parentId = value.parentId; const siblings = domain.sortedChildren(index, parentId, locale()); const at = siblings.findIndex((n) => n.id === value.id);
      beforeId = fraction < .5 ? value.id : siblings.slice(at + 1).find((n) => n.id !== dragId)?.id || null;
    }
    if (!domain.canMove(index, dragId, parentId)) return;
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
    root.querySelectorAll('[data-drop]').forEach((n) => delete n.dataset.drop);
    row.dataset.drop = into ? 'inside' : fraction < .5 ? 'before' : 'after';
    dropTarget = row;
    drop = { action: 'move', itemId: dragId, parentId, ...(into ? {} : { beforeId }) };
    announce(into ? t('Move into {destination}', { destination: location(parentId) }) : fraction < .5 ? t('Move before {title} in {destination}', { title: labelFor(value), destination: location(parentId) }) : t('Move after {title} in {destination}', { title: labelFor(value), destination: location(parentId) }));
  };
  const render = () => {
    const formKey = JSON.stringify([bookId, selected, mode]);
    const oldFields = [...root.querySelectorAll('.custom-notes-form input, .custom-notes-form select')];
    const draft = renderedFormKey === formKey ? oldFields.map((field) => ({ value: field.value, checked: field.checked })) : null;
    const activeField = oldFields.indexOf(document.activeElement);
    const focused = root.contains(document.activeElement) ? document.activeElement.closest('[data-item-id]')?.dataset.itemId : null;
    root.replaceChildren();
    const header = el('div', undefined, 'custom-notes-header ns-label'); header.append(el('h3', t('Custom Notes'))); root.append(header);
    const tools = el('div', undefined, 'custom-notes-tools'); tools.hidden = !canManage();
    tools.append(button(t('New note'), () => { mode = 'note'; render(); }, 'new-note'), button(t('New group'), () => { mode = 'group'; render(); }, 'new-group'), button(t('Labels'), () => { mode = 'labels'; render(); }, 'labels'));
    const undo = button(t('Undo organization'), () => run({}, true), 'undo'); undo.disabled = !canUndo; tools.append(undo);
    const retryButton = button(t('Retry'), retry, 'retry'); retryButton.hidden = !pending; tools.append(retryButton); header.append(tools);
    const status = el('p', '', 'custom-notes-status'); status.setAttribute('role', 'status'); root.append(status);
    if (index) {
      const selectedItem = item();
      const path = el('p', selectedItem ? location(group(selectedItem.id) ? selectedItem.id : selectedItem.parentId) : '', 'custom-notes-path');
      path.hidden = !selectedItem; root.append(path);
      const tree = el('div'); tree.className = 'custom-notes-tree'; tree.setAttribute('role', 'tree'); tree.setAttribute('aria-label', t('Custom Notes')); root.append(tree);
      const rows = domain.visibleTree(index, state().expanded, locale());
      if (!rows.some((row) => row.item.id === selected)) selected = rows[0]?.item.id || null;
      // Visual indentation must leave space for the title at any logical depth.
      // Parent relationships, full paths and aria-level retain the actual depth.
      const paneWidth = root.clientWidth || root.parentElement?.clientWidth || 248;
      const uiSize = parseFloat(getComputedStyle(root).fontSize) || 13;
      const maxIndent = Math.max(18, Math.min(paneWidth / 2, paneWidth - uiSize * 16));
      rows.forEach((value, at) => {
        const row = el('div', undefined, 'nav-item notes-item custom-note-row'); row.dataset.itemId = value.item.id; row.dataset.kind = value.kind; row.setAttribute('role', 'treeitem');
        row.setAttribute('aria-level', value.depth + 1); row.setAttribute('aria-selected', String(selected === value.item.id)); row.style.paddingInlineStart = Math.min(value.depth * 14 + 18, maxIndent) + 'px';
        row.classList.toggle('current', value.kind === 'note' && activeNote?.() === value.item.id); row.tabIndex = selected === value.item.id ? 0 : -1;
        row.setAttribute('aria-setsize', value.setSize); row.setAttribute('aria-posinset', value.posInSet);
        if (value.kind === 'group') row.setAttribute('aria-expanded', String(state().expanded.has(value.item.id)));
        const line = el('div', undefined, 'n-row'); row.append(line);
        line.append(el('span', value.kind === 'group' ? state().expanded.has(value.item.id) ? '▾' : '▸' : '', 'custom-note-disclosure'), el('span', labelFor(value.item), 'n-label custom-note-title'));
        if (value.kind === 'note') { const names = value.item.labelIds.map((id) => index.labels.find((l) => l.id === id)?.name).filter(Boolean); if (names.length) line.append(el('span', names.join(', '), 'n-words custom-note-labels')); }
        row.addEventListener('click', () => { if (value.kind === 'group') { const expanded = state().expanded; expanded.has(value.item.id) ? expanded.delete(value.item.id) : expanded.add(value.item.id); select(value.item.id); } else open(value.item.id).catch(error); });
        row.addEventListener('focus', () => { selected = value.item.id; state().selected = selected; });
        row.addEventListener('keydown', (e) => keydown(e, rows, at));
        if (canManage()) {
          row.draggable = true;
          const menu = button(t('Organize'), () => { selected = value.item.id; mode = 'item'; render(); root.querySelector('.custom-notes-form input')?.focus(); }, 'organize');
          menu.textContent = '⋯'; menu.title = t('Organize'); menu.setAttribute('aria-label', t('Organize'));
          menu.tabIndex = -1; menu.addEventListener('click', (e) => e.stopPropagation()); line.append(menu);
          row.addEventListener('contextmenu', (e) => showContextMenu(e, value.item, row).catch(error));
          row.addEventListener('dragstart', (e) => { dragId = value.item.id; selected = dragId; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('application/x-neo-note', dragId); });
          row.addEventListener('dragover', (e) => dragOver(e, row));
          row.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); const request = dropTarget === row ? drop : null; drop = null; dropTarget = null; dragId = null; if (request) run(request).catch(error); });
          row.addEventListener('dragend', () => { dragId = null; drop = null; root.querySelectorAll('[data-drop]').forEach((n) => delete n.dataset.drop); announce(''); });
        }
        tree.append(row);
      });
      const rootDrop = el('div', t('Top level'), 'custom-notes-root'); rootDrop.hidden = !canManage();
      rootDrop.addEventListener('dragover', (e) => { if (manage() && dragId) { e.preventDefault(); dropTarget = rootDrop; rootDrop.dataset.drop = 'inside'; drop = { action: 'move', itemId: dragId, parentId: null }; announce(t('Move into {destination}', { destination: t('Custom Notes') })); } });
      rootDrop.addEventListener('drop', (e) => { e.preventDefault(); if (dropTarget === rootDrop && drop) run(drop).catch(error); drop = null; dropTarget = null; dragId = null; }); root.append(rootDrop);
      if (canManage()) rootDrop.append(button(index.root.sortMode === 'manual' ? t('Sort alphabetically') : t('Use manual order'), () => run({ action: 'sort', parentId: null, sortMode: index.root.sortMode === 'manual' ? 'alphabetical' : 'manual' }), 'root-sort'));
    } else root.append(el('p', t('No custom notes yet.')));
    if (canManage()) {
      if (mode === 'group' || mode === 'note') creation(mode, !draft);
      else if (mode === 'labels') labels();
      else if (mode?.labelId) renameLabel(mode.labelId, !draft);
      else if (mode === 'item') controls();
    }
    if (draft) {
      const fields = [...root.querySelectorAll('.custom-notes-form input, .custom-notes-form select')];
      fields.forEach((field, i) => { if (draft[i]) { field.value = draft[i].value; if (field.type === 'checkbox') field.checked = draft[i].checked; } });
      if (activeField >= 0) fields[activeField]?.focus();
    }
    renderedFormKey = formKey;
    if (focused && !mode) focusRow(focused);
  };
  return {
    root,
    async mount(host, owner) {
      if (!owner || !api.notesCapabilities) return;
      const turn = ++generation; const capability = await call('notesCapabilities');
      if (turn !== generation || owner !== currentBook()) return;
      if (!capability.enabled) { root.remove(); return; }
      const changed = bookId !== owner;
      bookId = owner;
      if (changed) { index = null; selected = state().selected; mode = null; root.replaceChildren(el('p', t('Loading notes…'))); }
      host.append(root);
      if (await loadIndex(owner, turn)) render();
    },
    async refresh() {
      if (!bookId || bookId !== currentBook() || busy || mode || pending || dragId || !root.isConnected) return;
      const before = JSON.stringify(index); if (await loadIndex(bookId, generation) && JSON.stringify(index) !== before) render();
    },
    detach() { generation++; root.remove(); },
    reveal(id) { if (!index) return; selected = id; reveal(id); render(); },
    run
  };
}
globalThis.NeoPlanetNotesTree = { createNotesTree };
})();
