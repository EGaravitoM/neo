'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createNotesController } = require('../planet-notes-ui');
const doc = (bookId = 'book-one', noteId = 'n-first') => ({ bookId, kind: 'custom', noteId });
const key = (bookId, noteId) => bookId + '/' + noteId;
function deferred() {
  let fulfill; let fail;
  const promise = new Promise((resolve, reject) => { fulfill = resolve; fail = reject; });
  return { promise, resolve: fulfill, reject: fail };
}
function fixture(overrides = {}, inspect = (html) => ({ status: 'editable', html })) {
  const notes = new Map([
    ['book-one/n-first', '<p>First</p>'], ['book-one/n-second', '<p>Second</p>'], ['book-two/n-first', '<p>Other book</p>']
  ]);
  const saves = []; const timers = new Map(); let id = 0; let day = '2026-11-10';
  const view = {
    state: null, html: '',
    present(state) { this.state = state; this.html = state.html || ''; },
    capture() { return this.html; }
  };
  const api = {
    async notesCapabilities() { return { enabled: true }; },
    async notesLoad() { return { status: 'ok', index: { notes: [] } }; },
    async notesRead(bookId, noteId) {
      const html = notes.get(key(bookId, noteId));
      return html === undefined ? { status: 'missing' } : { status: 'ok', html, bodyToken: html, title: noteId };
    },
    async notesSave(bookId, noteId, request) {
      saves.push({ bookId, noteId, ...request }); notes.set(key(bookId, noteId), request.html);
      return { status: 'saved', bodyToken: request.html, versionId: 'v-saved' };
    },
    ...overrides
  };
  const controller = createNotesController({ api, view, inspect, writingDay: () => day, makeOperationId: () => 'o-edit' + (++id), setTimer: (fn) => { const token = ++id; timers.set(token, fn); return token; }, clearTimer: (token) => timers.delete(token) });
  return { api, view, controller, saves, notes, timers, setDay: (value) => { day = value; } };
}

test('opening a note presents an editable inspected document with explicit identity', async () => {
  const d = fixture(); await d.controller.open(doc());
  assert.deepEqual(d.view.state.document, doc());
  assert.equal(d.view.state.editable, true); assert.equal(d.view.html, '<p>First</p>');
});

test('file HTML is not mounted without a validator', async () => {
  const d = fixture({}, undefined);
  // Omit inspection entirely: Task 3.2 has not supplied the real validator yet.
  const controller = createNotesController({ api: d.api, view: d.view, writingDay: () => '2026-11-10', makeOperationId: () => 'o-first' });
  await controller.open(doc());
  assert.equal(d.view.state.editable, false);
  assert.equal(d.view.state.html, undefined);
});

test('a stale read cannot replace a more recently selected note', async () => {
  const slow = deferred(); const d = fixture({ notesRead: async (_bookId, noteId) => noteId === 'n-first' ? slow.promise : { status: 'ok', html: '<p>Second</p>', bodyToken: '<p>Second</p>' } });
  const opening = d.controller.open(doc());
  await d.controller.open(doc('book-one', 'n-second'));
  slow.resolve({ status: 'ok', html: '<p>Stale</p>', bodyToken: '<p>Stale</p>' });
  await opening;
  assert.equal(d.view.html, '<p>Second</p>');
});

test('outgoing content is captured before changing notes even if the input notification was missed', async () => {
  const d = fixture(); await d.controller.open(doc());
  d.view.html = '<p>Uncaptured edit</p>';
  await d.controller.open(doc('book-one', 'n-second')); await d.controller.flush();
  assert.equal(d.notes.get('book-one/n-first'), '<p>Uncaptured edit</p>');
  assert.equal(d.notes.get('book-one/n-second'), '<p>Second</p>');
});

test('pending content is keyed by both book and note when changing books', async () => {
  const d = fixture(); await d.controller.open(doc());
  d.view.html = '<p>Edited first book</p>'; d.controller.edit(d.view.html);
  await d.controller.open(doc('book-two')); await d.controller.flush();
  assert.equal(d.notes.get('book-one/n-first'), '<p>Edited first book</p>');
  assert.equal(d.view.html, '<p>Other book</p>');
});

test('a failed save leaves pending writing available when reopening the note', async () => {
  const d = fixture({ notesSave: async () => { throw Object.assign(new Error('failed'), { code: 'EIO' }); } });
  await d.controller.open(doc()); d.view.html = '<p>Pending</p>'; d.controller.edit(d.view.html);
  await assert.rejects(d.controller.flush(), { code: 'EIO' });
  await d.controller.open(doc('book-one', 'n-second')); await d.controller.open(doc());
  assert.equal(d.view.html, '<p>Pending</p>'); assert.equal(d.controller.hasPending(), true);
});

test('failed requests retry with the same operation identity and writing day', async () => {
  const attempts = []; let fail = true;
  const d = fixture({ notesSave: async (_bookId, _noteId, request) => {
    attempts.push(structuredClone(request));
    if (fail) { fail = false; throw Object.assign(new Error('lost acknowledgment'), { code: 'EIO' }); }
    return { status: 'saved', bodyToken: request.html };
  } });
  await d.controller.open(doc()); d.view.html = '<p>Pending</p>'; d.controller.edit(d.view.html);
  await assert.rejects(d.controller.flush(), { code: 'EIO' });
  d.setDay('2026-11-11'); await d.controller.flush();
  assert.equal(attempts[0].operationId, attempts[1].operationId);
  assert.equal(attempts[1].writingDay, '2026-11-10');
  assert.equal(d.controller.hasPending(), false);
});

test('edits made during an in-flight save are not cleared by its older acknowledgment', async () => {
  const sent = deferred(); const release = deferred(); const requests = [];
  const d = fixture({ notesSave: async (_bookId, _noteId, request) => {
    requests.push(structuredClone(request));
    if (requests.length === 1) { sent.resolve(); await release.promise; }
    return { status: 'saved', bodyToken: request.html };
  } });
  await d.controller.open(doc()); d.view.html = '<p>A</p>'; d.controller.edit(d.view.html);
  const flushing = d.controller.flush(); await sent.promise;
  d.view.html = '<p>B</p>'; d.controller.edit(d.view.html); release.resolve();
  await flushing; await d.controller.flush();
  assert.equal(requests.at(-1).html, '<p>B</p>');
  assert.equal(requests.at(-1).expectedBodyToken, '<p>A</p>');
  assert.equal(d.view.html, '<p>B</p>'); assert.equal(d.controller.hasPending(), false);
});

for (const status of ['missing', 'unavailable']) {
  test(status + ' notes are locked rather than displayed as editable empty content', async () => {
    const d = fixture({ notesRead: async () => ({ status }) }); await d.controller.open(doc());
    assert.equal(d.view.state.editable, false); assert.equal(d.view.state.status, status);
    assert.equal(d.view.state.html, undefined); assert.equal(d.saves.length, 0);
  });
}

test('a close request waits for composition to finish and saves the final text', async () => {
  const d = fixture(); await d.controller.open(doc()); d.controller.setComposing(true);
  d.view.html = '<p>Intermediate</p>'; d.controller.edit(d.view.html);
  let completed = false;
  const closing = d.controller.requestClose().then((result) => { completed = true; return result; });
  await Promise.resolve(); assert.equal(completed, false); assert.equal(d.saves.length, 0);
  d.view.html = '<p>Final</p>'; d.controller.edit(d.view.html); d.controller.setComposing(false);
  assert.equal((await closing).status, 'ready');
  assert.equal(d.notes.get('book-one/n-first'), '<p>Final</p>');
});

for (const code of ['EIO', 'EPENDING']) {
  test('close remains blocked when pending saves fail with ' + code, async () => {
    const d = fixture({ notesSave: async () => { throw Object.assign(new Error('blocked'), { code }); } });
    await d.controller.open(doc()); d.view.html = '<p>Unsaved</p>'; d.controller.edit(d.view.html);
    await assert.rejects(d.controller.requestClose(), { code });
    assert.equal(d.controller.hasPending(), true); assert.equal(d.view.html, '<p>Unsaved</p>');
  });
}

test('leaving custom notes invalidates delayed reads without writing to legacy auxiliary files', async () => {
  const slow = deferred(); let writes = 0;
  const d = fixture({ notesRead: async () => slow.promise, writeAux: async () => { writes++; } });
  const opening = d.controller.open(doc()); await d.controller.leave();
  slow.resolve({ status: 'ok', html: '<p>Late</p>', bodyToken: '<p>Late</p>' }); await opening;
  assert.notEqual(d.view.html, '<p>Late</p>'); assert.equal(writes, 0);
});

test('creating a note opens the returned identity without repurposing a chapter note', async () => {
  const d = fixture({ notesCreate: async (_bookId, request) => {
    assert.equal(request.title, 'New note');
    d.notes.set('book-one/n-created', '<p><br></p>');
    return { status: 'saved', noteId: 'n-created' };
  } });
  await d.controller.create('book-one', 'New note');
  assert.deepEqual(d.view.state.document, doc('book-one', 'n-created'));
});

test('renaming changes the displayed title without changing current writing', async () => {
  const d = fixture({ notesRename: async (_bookId, _noteId, request) => ({ status: 'saved', title: request.title }) });
  await d.controller.open(doc());
  await d.controller.rename('Updated title');
  assert.equal(d.view.state.title, 'Updated title'); assert.equal(d.view.html, '<p>First</p>');
});

test('a close request drains edits made while its first save is in flight', async () => {
  const sent = deferred(); const release = deferred(); const requests = [];
  const d = fixture({ notesSave: async (_bookId, _noteId, request) => {
    requests.push(structuredClone(request));
    if (requests.length === 1) { sent.resolve(); await release.promise; }
    return { status: 'saved', bodyToken: request.html };
  } });
  await d.controller.open(doc()); d.view.html = '<p>A</p>'; d.controller.edit(d.view.html);
  const closing = d.controller.requestClose(); await sent.promise;
  d.view.html = '<p>B</p>'; d.controller.edit(d.view.html); release.resolve();
  assert.equal((await closing).status, 'ready');
  assert.equal(requests.at(-1).html, '<p>B</p>'); assert.equal(d.controller.hasPending(), false);
});

test('a late save acknowledgment cannot replace the selected page in another book', async () => {
  const sent = deferred(); const release = deferred();
  const d = fixture({ notesSave: async (_bookId, _noteId, request) => { sent.resolve(); await release.promise; return { status: 'saved', bodyToken: request.html }; } });
  await d.controller.open(doc()); d.view.html = '<p>Pending</p>'; d.controller.edit(d.view.html);
  const flushing = d.controller.flush(); await sent.promise;
  await d.controller.open(doc('book-two')); release.resolve(); await flushing;
  assert.deepEqual(d.view.state.document, doc('book-two')); assert.equal(d.view.html, '<p>Other book</p>');
});

test('typed plain-data IPC failures retain their error code and pending writing', async () => {
  const d = fixture({ notesSave: async () => ({ status: 'error', error: { code: 'EPENDING', message: 'Earlier operation pending' } }) });
  await d.controller.open(doc()); d.view.html = '<p>Pending</p>'; d.controller.edit(d.view.html);
  await assert.rejects(d.controller.flush(), { code: 'EPENDING' });
  assert.equal(d.controller.hasPending(), true);
});

test('a successful creation is not duplicated if another pending save prevents opening it', async () => {
  let creates = 0; let fail = true;
  const d = fixture({ notesCreate: async () => { creates++; d.notes.set('book-one/n-created', '<p><br></p>'); return { status: 'saved', noteId: 'n-created' }; }, notesSave: async (_book, _note, request) => {
    if (fail) throw Object.assign(new Error('failed'), { code: 'EIO' });
    return { status: 'saved', bodyToken: request.html };
  } });
  await d.controller.open(doc()); d.view.html = '<p>Pending</p>'; d.controller.edit(d.view.html);
  await assert.rejects(d.controller.create('book-one', 'New'), { code: 'EIO' });
  fail = false; await d.controller.create('book-one', 'New');
  assert.equal(creates, 1); assert.equal(d.view.state.document.noteId, 'n-created');
});

test('a disposed controller cannot start a new storage command', async () => {
  let creates = 0;
  const d = fixture({ notesCreate: async () => { creates++; return { status: 'saved', noteId: 'n-new' }; } });
  d.controller.dispose();
  await assert.rejects(d.controller.create('book-one', 'Too late'), { code: 'ECLOSED' });
  assert.equal(creates, 0);
});

test('a refresh adopts supported external writing without an autosave', async () => {
  const d = fixture({ notesRefresh: async () => ({ status: 'ok', changed: true, title: 'Updated', html: '<p>External</p>', bodyToken: '<p>External</p>' }) });
  await d.controller.open(doc()); await d.controller.refresh();
  assert.equal(d.view.html, '<p>External</p>'); assert.equal(d.controller.hasPending(), false); assert.equal(d.saves.length, 0);
});

test('new writing during an external refresh remains pending over the observed external version', async () => {
  const slow = deferred(); const d = fixture({ notesRefresh: () => slow.promise });
  await d.controller.open(doc()); const refreshing = d.controller.refresh();
  d.view.html = '<p>New local writing</p>'; d.controller.edit(d.view.html);
  slow.resolve({ status: 'ok', changed: true, title: '', html: '<p>External</p>', bodyToken: '<p>External</p>' });
  await refreshing;
  assert.equal(d.view.html, '<p>New local writing</p>'); assert.equal(d.controller.hasPending(), true);
  await d.controller.flush(); assert.equal(d.saves[0].expectedBodyToken, '<p>External</p>');
});

test('refresh defers DOM replacement until composition ends', async () => {
  const slow = deferred(); const d = fixture({ notesRefresh: () => slow.promise });
  await d.controller.open(doc()); const refreshing = d.controller.refresh();
  d.controller.setComposing(true); d.view.html = '<p>Composing</p>'; d.controller.edit(d.view.html);
  slow.resolve({ status: 'ok', changed: true, title: '', html: '<p>External</p>', bodyToken: '<p>External</p>' });
  await Promise.resolve(); assert.equal(d.view.html, '<p>Composing</p>');
  d.controller.setComposing(false); await refreshing;
  assert.equal(d.view.html, '<p>Composing</p>');
});

test('unsupported preview passes text only and editable copy opens a separate note', async () => {
  let copied;
  const d = fixture({ notesCopy: async (_b, _n, request) => { copied = request; return { status: 'saved', noteId: 'n-second' }; } }, () => ({ status: 'unsupported', previewText: 'Safe words', copyHtml: '<p>Safe words</p>' }));
  await d.controller.open(doc()); assert.equal(d.view.state.html, undefined); assert.equal(d.view.state.previewText, 'Safe words');
  await d.controller.createEditableCopy(); assert.equal(copied.html, '<p>Safe words</p>'); assert.equal(d.view.state.document.noteId, 'n-second');
});

test('autosave after a competing deletion recovers before a pending job can block polling', async () => {
  let refreshes = 0;
  const d = fixture({
    notesSave: async (_bookId, noteId, request) => {
      if (noteId === 'n-first') throw Object.assign(new Error('Deleted'), { code: 'ENOENT' });
      return { status: 'saved', bodyToken: request.html };
    },
    notesRefresh: async (_bookId, _noteId, request) => {
      refreshes++; return { status: 'recovered', noteId: 'n-recovered', html: request.localHtml, bodyToken: request.localHtml };
    }
  });
  await d.controller.open(doc()); d.view.html = '<p>Writing after deletion</p>'; d.controller.edit(d.view.html);
  await d.controller.flush();
  assert.equal(refreshes, 1); assert.equal(d.controller.hasPending(), false);
  assert.equal(d.view.state.document.noteId, 'n-recovered'); assert.equal(d.view.html, '<p>Writing after deletion</p>');
  assert.equal((await d.controller.requestClose()).status, 'ready');
});

test('a queued rename follows recovered writing with a fresh command identity', async () => {
  const renames = [];
  const d = fixture({
    notesSave: async (_bookId, noteId, request) => {
      if (noteId === 'n-first') throw Object.assign(new Error('Deleted'), { code: 'ENOENT' });
      return { status: 'saved', bodyToken: request.html };
    },
    notesRefresh: async (_bookId, _noteId, request) => ({ status: 'recovered', noteId: 'n-recovered', html: request.localHtml, bodyToken: request.localHtml }),
    notesRename: async (_bookId, noteId, request) => { renames.push({ noteId, request }); assert.equal(noteId, 'n-recovered'); return { status: 'saved', title: request.title }; }
  });
  await d.controller.open(doc()); d.view.html = '<p>Recover this</p>'; d.controller.edit(d.view.html);
  await d.controller.rename('New title');
  assert.equal(renames.length, 1); assert.equal(d.view.state.title, 'New title');
  assert.equal(d.controller.hasPending(), false); assert.equal((await d.controller.requestClose()).status, 'ready');
});
