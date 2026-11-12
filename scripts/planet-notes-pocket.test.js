'use strict';
// Pocket acceptance contracts, including native fault injection and browser loading.
const { test } = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { createPocketNotesAdapter } = require('../planet-notes-pocket');
const { createPocketNotesBridge } = require('../planet-notes-pocket-bridge');
const { createNotesStore } = require('../planet-notes-store');
const { createNotesService } = require('../planet-notes-service');
const error = (code) => Object.assign(new Error(code), { code });
function fixture() {
  const files = new Map([['book-one/notes/n-one.html', '<p>Original</p>']]);
  const calls = []; const away = new Set(); let sequence = 0; let rejectRename = () => false; let afterWrite = () => {};
  const filesystem = {
    async stat({ path }) { calls.push(['stat', path]); if (files.has(path)) return { type: 'file', size: files.get(path).length }; if ([...files.keys()].some(p => p.startsWith(path + '/'))) return { type: 'directory' }; throw error('ENOENT'); },
    async readFile({ path }) { calls.push(['read', path]); if (!files.has(path)) throw error('ENOENT'); return { data: files.get(path) }; },
    async writeFile({ path, data }) { calls.push(['write', path]); files.set(path, data); afterWrite(path); },
    async rename({ from, to }) { calls.push(['rename', from, to]); if (rejectRename(to)) throw error('EIO'); if (!files.has(from)) throw error('ENOENT'); files.set(to, files.get(from)); files.delete(from); },
    async deleteFile({ path }) { calls.push(['delete', path]); files.delete(path); },
    async mkdir() {},
    async readdir({ path }) {
      calls.push(['list', path]); const children = new Map();
      for (const file of files.keys()) if (file.startsWith(path + '/')) { const rest = file.slice(path.length + 1); const name = rest.split('/')[0]; children.set(name, { name, type: rest.includes('/') ? 'directory' : 'file' }); }
      if (!children.size) throw error('ENOENT'); return { files: [...children.values()] };
    }
  };
  const options = { filesystem, location: (relative) => ({ path: relative, directory: 'DOCUMENTS' }), availability: async (relative) => away.has(relative) ? 'unavailable' : 'local', makeTemporaryId: () => 'tmp-' + (++sequence) };
  const adapter = createPocketNotesAdapter('book-one', options);
  return { adapter, options, filesystem, files, calls, away, failRename: (when = () => true) => { rejectRename = when; }, afterWrite: (fn) => { afterWrite = fn; } };
}
test('Pocket reads distinguish local, missing and cloud-only bodies', async () => {
  const d = fixture(); assert.deepEqual(await d.adapter.read('n-one.html'), { status: 'ok', text: '<p>Original</p>' });
  assert.deepEqual(await d.adapter.read('n-missing.html'), { status: 'missing' });
  d.away.add('book-one/notes/n-one.html'); assert.deepEqual(await d.adapter.read('n-one.html'), { status: 'unavailable' });
});
test('Pocket rejects traversal and unsafe book IDs before plugin access', async () => {
  const d = fixture();
  for (const rel of ['../book-two/notes.html', '/absolute', 'a//b', 'a/./b', 'a\\b', 'a\0b']) await assert.rejects(d.adapter.read(rel), { code: 'EINVAL' });
  assert.equal(d.calls.length, 0);
  for (const book of ['..', 'book-one/../book-two', '/book-one']) assert.throws(() => createPocketNotesAdapter(book, d.options), { code: 'EINVAL' });
});
test('Pocket write verifies a sibling and atomically replaces without in-place writes', async () => {
  const d = fixture(); await d.adapter.writeDurable('n-one.html', '<p>New writing</p>');
  assert.equal(d.files.get('book-one/notes/n-one.html'), '<p>New writing</p>');
  const rename = d.calls.find(c => c[0] === 'rename'); assert.ok(rename); assert.notEqual(rename[1], rename[2]);
  assert.equal(d.calls.some(c => c[0] === 'write' && c[1] === 'book-one/notes/n-one.html'), false);
  assert.ok(d.calls.some(c => c[0] === 'read' && c[1] === rename[1]));
});
test('failed Pocket replacement preserves original and never falls back to overwrite', async () => {
  const d = fixture(); d.failRename(); await assert.rejects(d.adapter.writeDurable('n-one.html', 'Replacement'), { code: 'EIO' });
  assert.equal(d.files.get('book-one/notes/n-one.html'), '<p>Original</p>');
  assert.equal(d.calls.some(c => c[0] === 'write' && c[1] === 'book-one/notes/n-one.html'), false);
});
test('Pocket refuses cloud-only destinations before and during replacement', async () => {
  const d = fixture(); d.away.add('book-one/notes/n-one.html');
  await assert.rejects(d.adapter.writeDurable('n-one.html', 'Replacement'), { code: 'ECLOUD' });
  assert.equal(d.calls.some(c => c[0] === 'write'), false);
  d.away.clear(); d.afterWrite(() => d.away.add('book-one/notes/n-one.html'));
  await assert.rejects(d.adapter.writeDurable('n-one.html', 'Replacement'), { code: 'ECLOUD' });
  assert.equal(d.files.get('book-one/notes/n-one.html'), '<p>Original</p>');
});
test('Pocket unchanged writes produce no plugin writes', async () => {
  const d = fixture(); await d.adapter.writeDurable('n-one.html', '<p>Original</p>');
  assert.equal(d.calls.some(c => c[0] === 'write' || c[0] === 'rename'), false);
});
test('Pocket recursive listing preserves book-local recovery and never lists another book', async () => {
  const d = fixture(); d.files.set('book-one/notes/trash/t-one/record.json', '{}'); d.files.set('book-two/notes/n-other.html', 'Other book');
  assert.deepEqual((await d.adapter.list()).sort(), ['n-one.html', 'trash/t-one/record.json']);
});
test('desktop-created writing is editable through Pocket and desktop can read its revision', async () => {
  const d = fixture(); const files = new Map(); let sequence = 0;
  const desktopAdapter = { read: async p => files.has(p) ? { status: 'ok', text: files.get(p) } : { status: 'missing' }, writeDurable: async (p, text) => { files.set(p, text); }, remove: async p => { files.delete(p); }, list: async () => [...files.keys()] };
  const desktopStore = createNotesStore(desktopAdapter);
  const desktop = createNotesService({ enabled: true, getBook: async () => ({ adapter: desktopAdapter, store: desktopStore }), makeId: prefix => prefix + '-desktop' + (++sequence) });
  const created = await desktop.create('book-one', { operationId: 'o-create', title: 'Character' });
  d.files.clear(); for (const [p, text] of files) d.files.set('book-one/notes/' + p, text);
  const browser = browserContext();
  const pocketStore = browser.NeoPlanetNotesStore.createNotesStore(d.adapter);
  const pocket = browser.NeoPlanetNotesService.createNotesService({ enabled: true, getBook: async () => ({ adapter: d.adapter, store: pocketStore }), makeId: prefix => prefix + '-pocket' + (++sequence) });
  const before = await pocket.read('book-one', created.noteId);
  assert.equal((await pocket.save('book-one', created.noteId, { operationId: 'o-phone', html: '<p>Written on phone</p>', expectedBodyToken: before.bodyToken, writingDay: '2026-11-12' })).status, 'saved');
  files.clear(); for (const [p, text] of d.files) files.set(p.slice('book-one/notes/'.length), text);
  assert.equal((await desktopStore.read(created.noteId)).html, '<p>Written on phone</p>');
  assert.equal((await desktopStore.listRevisions(created.noteId)).length, 1);
  // A real Web Crypto service reads Node-created journals and preserves both
  // observed bodies when the synced desktop body competes with mobile typing.
  const base = await pocket.read('book-one', created.noteId);
  d.files.set('book-one/notes/' + created.noteId + '.html', '<p>Desktop café</p>');
  const conflict = await pocket.refresh('book-one', created.noteId, { baseBodyToken: base.bodyToken, localHtml: '<p>Pocket 日本語</p>' });
  assert.equal(conflict.status, 'ok'); assert.ok(conflict.conflictNoteId);
  assert.equal((await pocketStore.read(created.noteId)).html, '<p>Pocket 日本語</p>');
  assert.equal((await pocketStore.read(conflict.conflictNoteId)).html, '<p>Desktop café</p>');
});
test('mobile bridge permits editing/inspection but denies organization and restoration', async () => {
  const calls = [];
  const service = new Proxy({}, { get: (_target, method) => async (...args) => { calls.push([method, ...args]); return method === 'capabilities' ? { enabled: true } : { status: 'ok' }; } });
  const bridge = createPocketNotesBridge({ enabled: true, service });
  const capabilities = await bridge.notesCapabilities();
  assert.equal(capabilities.enabled, true); assert.equal(capabilities.canManage, false); assert.equal(capabilities.canRestore, false);
  for (const [method, args] of [['notesLoad', ['book-one']], ['notesRead', ['book-one', 'n-one']], ['notesReadLegacy', ['book-one', { page: 'book' }]], ['notesSave', ['book-one', 'n-one', {}]], ['notesRefresh', ['book-one']], ['notesRecoveryList', ['book-one', { kind: 'trash' }]], ['notesRecoveryRead', ['book-one', { kind: 'conflict', id: 'c-one' }]]]) assert.equal((await bridge[method](...args)).status, 'ok');
  const permittedCalls = calls.length;
  for (const method of ['notesCreate', 'notesRename', 'notesCopy', 'notesOrganize', 'notesUndoOrganization', 'notesRecover']) {
    const result = await bridge[method]('book-one', {}); assert.equal(result.status, 'error'); assert.equal(result.error.code, 'ENOTSUPPORTED');
  }
  assert.equal(calls.length, permittedCalls);
});
test('disabled Pocket bridge never touches the service; enabled errors retain codes', async () => {
  let calls = 0; const service = { load: async () => { calls++; throw error('ECLOUD'); } };
  const disabled = createPocketNotesBridge({ enabled: false, service });
  assert.equal((await disabled.notesCapabilities()).enabled, false);
  assert.equal((await disabled.notesLoad('book-one')).error.code, 'ENOTAVAILABLE'); assert.equal(calls, 0);
  const enabled = createPocketNotesBridge({ enabled: true, service });
  assert.equal((await enabled.notesLoad('book-one')).error.code, 'ECLOUD');
});
function browserContext() {
  const context = vm.createContext({ crypto: webcrypto, TextEncoder, TextDecoder, console, setTimeout, clearTimeout });
  for (const file of ['i18n.js', 'planet-notes.js', 'planet-notes-reconcile.js', 'planet-notes-history.js', 'planet-notes-recovery.js', 'planet-notes-store.js', 'planet-notes-organization.js', 'planet-notes-recovery-selection.js', 'planet-notes-observer.js', 'planet-notes-organization-resolution.js', 'planet-notes-organization-service.js', 'planet-notes-library-recovery.js', 'planet-notes-service.js']) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context, { filename: file });
  return context;
}
test('shared service loads in a browser without Node or a compile step', () => {
  assert.equal(typeof browserContext().NeoPlanetNotesService?.createNotesService, 'function');
});

test('Pocket detects a short sibling write without replacing the original', async () => {
  const d = fixture(); d.afterWrite(path => { d.files.set(path, 'Short'); });
  await assert.rejects(d.adapter.writeDurable('n-one.html', 'Complete replacement'), { code: 'EIO' });
  assert.equal(d.files.get('book-one/notes/n-one.html'), '<p>Original</p>');
});
test('Pocket detects an observed destination race and preserves the competing text', async () => {
  const d = fixture(); d.afterWrite(() => { d.files.set('book-one/notes/n-one.html', 'Competing writing'); });
  await assert.rejects(d.adapter.writeDurable('n-one.html', 'Local writing'), { code: 'ECONFLICT' });
  assert.equal(d.files.get('book-one/notes/n-one.html'), 'Competing writing');
});
test('an interrupted Pocket body save replays its prepared command after restart', async () => {
  const d = fixture(); let sequence = 0;
  const context = { adapter: d.adapter, store: createNotesStore(d.adapter) };
  const options = { enabled: true, getBook: async () => context, makeId: prefix => prefix + '-restart' + (++sequence) };
  const service = createNotesService(options);
  const note = await service.create('book-one', { operationId: 'o-start', title: 'Character' });
  const before = await service.read('book-one', note.noteId);
  let interrupted = false;
  d.failRename(to => { if (!interrupted && to === 'book-one/notes/' + note.noteId + '.html') { interrupted = true; return true; } return false; });
  const request = { operationId: 'o-resume', html: '<p>Retained mobile words</p>', expectedBodyToken: before.bodyToken, writingDay: '2026-11-12' };
  await assert.rejects(service.save('book-one', note.noteId, request), { code: 'EIO' });
  const browser = browserContext(); const adapter = createPocketNotesAdapter('book-one', d.options);
  const restarted = browser.NeoPlanetNotesService.createNotesService({ ...options, getBook: async () => ({ adapter, store: browser.NeoPlanetNotesStore.createNotesStore(adapter) }) });
  assert.equal((await restarted.read('book-one', note.noteId)).html, request.html);
  assert.equal((await restarted.save('book-one', note.noteId, request)).status, 'saved');
  assert.equal((await context.store.listRevisions(note.noteId)).length, 1);
});
test('Pocket shared asset order includes every script before bridge initialization', () => {
  const page = fs.readFileSync(path.join(__dirname, '../pocket/www/index.html'), 'utf8');
  const pack = fs.readFileSync(path.join(__dirname, 'pocket-www.js'), 'utf8');
  for (const file of ['planet-notes.js', 'planet-notes-history.js', 'planet-notes-recovery.js', 'planet-notes-store.js', 'planet-notes-service.js', 'planet-notes-pocket.js', 'planet-notes-pocket-bridge.js', 'planet-notes-tree.js', 'planet-notes-ui.js', 'planet-notes-explorer.js']) {
    assert.ok(page.indexOf('src="' + file + '"') >= 0 && page.indexOf('src="' + file + '"') < page.indexOf('src="pocket-bridge.js"'));
    assert.ok(pack.includes("'" + file + "'"));
  }
});
