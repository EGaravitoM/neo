'use strict';
// Book transfer preservation and failure contracts, included in npm test.
const { test } = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const vm = require('node:vm');
const { fork } = require('node:child_process'); const JSZip = require('jszip');
const { loadMain } = require('./helpers/planet-notes-transfer-fixtures');
const { bookCopyPolicy } = require('../planet-notes-transfer');
const { createNotesService } = require('../planet-notes-service'); const { createNotesStore } = require('../planet-notes-store');
const { createDesktopNotesAdapter } = require('../planet-notes-desktop');
const main = loadMain();
const root = path.resolve(__dirname, '..');
function library(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'neo-notes-transfer-'))); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  main.pointAt(dir); main.call('library:read'); const book = main.call('book:create', { title: 'Source' });
  return { dir, book, bookDir: path.join(dir, book.id) };
}
function write(directory, relative, text) { const file = path.join(directory, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
function contents(directory) {
  const result = new Map();
  const walk = (dir, rel = '') => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const sub = rel ? rel + '/' + entry.name : entry.name; if (entry.isDirectory()) walk(path.join(dir, entry.name), sub); else if (entry.isFile()) result.set(sub, fs.readFileSync(path.join(dir, entry.name))); } };
  walk(directory); return result;
}
async function material(bookId, directory, pending = false) {
  const files = new Map(); let sequence = 0; let fail = pending;
  const adapter = { read: async p => files.has(p) ? { status: 'ok', text: files.get(p) } : { status: 'missing' }, writeDurable: async (p, text) => { if (fail && p === 'recovery/history-operations/o-pending.json') { fail = false; throw Object.assign(new Error('Interrupted'), { code: 'EIO' }); } files.set(p, text); }, remove: async p => { files.delete(p); }, list: async () => [...files.keys()] };
  const store = createNotesStore(adapter); const service = createNotesService({ enabled: true, getBook: async () => ({ adapter, store }), makeId: prefix => prefix + '-fixture' + (++sequence) });
  const note = await service.create(bookId, { operationId: 'o-create', title: 'Character' });
  let body = await service.read(bookId, note.noteId);
  await service.save(bookId, note.noteId, { operationId: 'o-write', html: '<p>Saved source words</p>', expectedBodyToken: body.bodyToken, writingDay: '2026-11-12' });
  const archived = await service.create(bookId, { operationId: 'o-archived', title: 'Research' });
  await service.organize(bookId, { operationId: 'o-trash', action: 'trashNote', noteId: archived.noteId });
  body = await service.read(bookId, note.noteId);
  files.set(note.noteId + '.html', '<p>External source version</p>');
  await service.refresh(bookId, note.noteId, { baseBodyToken: body.bodyToken, localHtml: '<p>Saved source words plus local writing</p>' });
  if (pending) {
    body = await service.read(bookId, note.noteId);
    await assert.rejects(service.save(bookId, note.noteId, { operationId: 'o-pending', html: '<p>Prepared words</p>', expectedBodyToken: body.bodyToken, writingDay: '2026-11-12' }), { code: 'EIO' });
  }
  for (const [p, text] of files) write(directory, 'notes/' + p, text);
  for (const [p, text] of [['recovery/observed.bak', 'Observed backup'], ['recovery/interrupted.tmp', 'Observed interrupted writing'], ['recovery/book.json', '{"opaque":"preserve unchanged"}']]) write(directory, 'notes/' + p, text);
  return note;
}
async function backup(t, libraryDir) {
  const target = path.join(libraryDir, 'neo-transfer-test.zip');
  const child = fork(path.join(root, 'backup-worker.js'), [], { env: { ...process.env, NEO_TEST_SPARSE_IS_CLOUD: '1' }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  t.after(() => child.kill());
  const result = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Backup timed out')); }, 10000);
    child.once('message', msg => { clearTimeout(timeout); resolve(msg); });
    child.once('error', err => { clearTimeout(timeout); reject(err); });
    child.once('exit', code => { clearTimeout(timeout); if (code) reject(new Error('Backup exited: ' + code)); });
    child.send({ libraryDir, target, keep: 3, fileLimitMs: 500 });
  });
  assert.equal(result.ok, true, result.error); return { result, zip: await JSZip.loadAsync(fs.readFileSync(target)) };
}
test('shared policy preserves notes evidence without changing non-notes spare policy', () => {
  for (const p of ['notes/index.json', 'notes/recovery/interrupted.tmp', 'notes/recovery/saved.bak', 'notes/recovery/book.json']) assert.equal(bookCopyPolicy(p, 'file'), 'include');
  assert.equal(bookCopyPolicy('book.json', 'file'), 'skip'); assert.equal(bookCopyPolicy('chapters/ch-one.html.tmp', 'file'), 'skip');
  assert.equal(bookCopyPolicy('notes/.n-one.html.icloud', 'file'), 'unavailable');
  for (const [p, type] of [['notes/../escape', 'file'], ['notes/link', 'symlink'], ['notes/pipe', 'other']]) assert.throws(() => bookCopyPolicy(p, type), { code: 'EINVAL' });
});
test('desktop duplication preserves every notes byte, including opaque recovery evidence', async t => {
  const d = library(t); await material(d.book.id, d.bookDir); const before = contents(d.bookDir);
  const duplicate = await main.call('book:duplicate', d.book.id, 'Copy');
  assert.deepEqual(contents(path.join(d.dir, duplicate.id, 'notes')), contents(path.join(d.bookDir, 'notes')));
  assert.deepEqual(contents(d.bookDir), before);
});
test('a duplicated prepared command replays only within the independent duplicate', async t => {
  const d = library(t); const note = await material(d.book.id, d.bookDir, true); const before = contents(d.bookDir);
  const duplicate = await main.call('book:duplicate', d.book.id, 'Replay copy');
  const adapter = createDesktopNotesAdapter(path.join(d.dir, duplicate.id, 'notes'), { availability: async () => 'local' });
  const store = createNotesStore(adapter); const service = createNotesService({ enabled: true, getBook: async () => ({ adapter, store }) });
  assert.equal((await service.read(duplicate.id, note.noteId)).html, '<p>Prepared words</p>');
  assert.deepEqual(contents(d.bookDir), before);
  const body = await service.read(duplicate.id, note.noteId);
  await service.save(duplicate.id, note.noteId, { operationId: 'o-independent', html: '<p>Only the duplicate</p>', expectedBodyToken: body.bodyToken, writingDay: '2026-11-12' });
  assert.deepEqual(contents(d.bookDir), before);
});
test('desktop duplication rejects linked notes evidence without modifying the source', async t => {
  const d = library(t); await material(d.book.id, d.bookDir);
  const outside = path.join(d.dir, 'private.txt'); fs.writeFileSync(outside, 'Outside evidence');
  fs.symlinkSync(outside, path.join(d.bookDir, 'notes/link.html'));
  const before = fs.readdirSync(d.dir).filter(name => name.startsWith('book-')).sort();
  await assert.rejects(() => main.call('book:duplicate', d.book.id, 'Unsafe copy'));
  assert.deepEqual(fs.readdirSync(d.dir).filter(name => name.startsWith('book-')).sort(), before); assert.equal(fs.readFileSync(outside, 'utf8'), 'Outside evidence');
});
test('desktop duplication refuses placeholders and leaves no half-made copy', async t => {
  const d = library(t); await material(d.book.id, d.bookDir);
  write(d.bookDir, 'notes/revisions/.r-cloud.html.icloud', ''); const before = fs.readdirSync(d.dir).filter(name => name.startsWith('book-')).sort();
  await assert.rejects(() => main.call('book:duplicate', d.book.id, 'Cloud copy'), /iCloud|downloading/);
  assert.deepEqual(fs.readdirSync(d.dir).filter(name => name.startsWith('book-')).sort(), before);
});
test('library backup includes the complete regular notes directory byte-for-byte', async t => {
  const d = library(t); await material(d.book.id, d.bookDir); const expected = contents(path.join(d.bookDir, 'notes'));
  const { result, zip } = await backup(t, d.dir); assert.deepEqual(result.missed, []);
  for (const [p, bytes] of expected) { const entry = zip.file(d.book.id + '/notes/' + p); assert.ok(entry, p); assert.deepEqual(await entry.async('nodebuffer'), bytes); }
});
test('backup reports cloud notes placeholders rather than claiming complete coverage', async t => {
  const d = library(t); await material(d.book.id, d.bookDir); write(d.bookDir, 'notes/revisions/.r-cloud.html.icloud', '');
  const { result, zip } = await backup(t, d.dir);
  assert.ok(result.missed.some(p => p.includes('notes/revisions/.r-cloud.html.icloud')));
  assert.match(await zip.file('_left-out-of-this-backup.txt').async('string'), /notes\/revisions\/\.r-cloud\.html\.icloud/);
  assert.ok(zip.file(d.book.id + '/notes/index.json'));
});
test('backup rejects notes symlinks and reports their omission without copying outside data', async t => {
  const d = library(t); await material(d.book.id, d.bookDir); const outside = path.join(d.dir, 'outside.txt'); fs.writeFileSync(outside, 'Do not follow');
  fs.symlinkSync(outside, path.join(d.bookDir, 'notes/link.html'));
  const { result, zip } = await backup(t, d.dir);
  assert.equal(zip.file(d.book.id + '/notes/link.html'), null); assert.ok(result.missed.some(p => p.includes('notes/link.html')));
});

function pocket() {
  // Exercise the actual duplicateBook method with an injected Capacitor contract,
  // rather than writing a second copier in the test.
  const source = fs.readFileSync(path.join(root, 'pocket/www/pocket-bridge.js'), 'utf8');
  const start = source.indexOf('    duplicateBook: async');
  const end = source.indexOf('    // the folder moves', start);
  assert.ok(start >= 0 && end > start);
  const files = new Map([['book-source/book.json', Buffer.from(JSON.stringify({ id: 'book-source', title: 'Source', chapterOrder: [] }))], ['book-source/notes/index.json', Buffer.from('{}')], ['book-source/notes/recovery/raw.tmp', Buffer.from('Observed writing')], ['book-source/notes/recovery/raw.bak', Buffer.from([0, 1, 255])], ['book-source/notes/recovery/book.json', Buffer.from('{}')]]);
  const away = new Set(); const links = new Set(); const directories = new Set(); let failWrite = false; let corruptWrite = false; let afterWrite = () => {};
  const plugin = {
    async readdir({ path: directory }) {
      const entries = new Map();
      for (const file of files.keys()) if (file.startsWith(directory + '/')) { const rest = file.slice(directory.length + 1); const name = rest.split('/')[0]; entries.set(name, { name, type: rest.includes('/') ? 'directory' : links.has(file) ? 'symlink' : 'file' }); }
      return { files: [...entries.values()] };
    },
    async stat({ path: file }) { if (files.has(file)) return { type: links.has(file) ? 'symlink' : 'file' }; if (directories.has(file) || [...files.keys()].some(p => p.startsWith(file + '/'))) return { type: 'directory' }; throw Object.assign(new Error('Missing'), { code: 'ENOENT' }); },
    async readFile({ path: file }) { if (away.has(file)) throw Object.assign(new Error('Cloud'), { code: 'ECLOUD' }); if (!files.has(file)) throw Object.assign(new Error('Missing'), { code: 'ENOENT' }); return { data: files.get(file).toString('base64') }; },
    async writeFile({ path: file, data }) { if (failWrite) throw Object.assign(new Error('Interrupted copy'), { code: 'EIO' }); files.set(file, corruptWrite ? Buffer.from('Corrupted') : Buffer.from(data, 'base64')); afterWrite(file); },
    async mkdir({ path: directory, recursive }) { if (!recursive && (directories.has(directory) || [...files.keys()].some(p => p.startsWith(directory + '/')))) throw Object.assign(new Error('Occupied'), { code: 'EEXIST' }); directories.add(directory); },
    async rmdir({ path: directory }) { for (const file of [...files.keys()]) if (file.startsWith(directory + '/')) files.delete(file); for (const dir of directories) if (dir === directory || dir.startsWith(directory + '/')) directories.delete(dir); }
  };
  const context = { ready: Promise.resolve(), fetchCloud: async () => {}, readText: async file => files.get(file).toString('utf8'), p: (...parts) => parts.join('/'), at: path => ({ path, directory: 'DOCUMENTS' }), FS: () => plugin,
    slugify: s => String(s).toLowerCase(), ensureDir: async () => {}, writeJSONFile: async (file, value) => { files.set(file, Buffer.from(JSON.stringify(value))); }, t: s => s, window: { NeoPlanetNotesTransfer: require('../planet-notes-transfer'), NeoPlanetNotesHistory: require('../planet-notes-history') }, notesAvailability: async file => away.has(file) ? 'unavailable' : 'local' };
  const bridge = vm.runInNewContext('({' + source.slice(start, end) + '})', context);
  return { files, away, links, duplicate: title => bridge.duplicateBook('book-source', title), failWrite: () => { failWrite = true; }, corruptWrite: () => { corruptWrite = true; }, afterWrite: fn => { afterWrite = fn; } };
}
test('Pocket duplication preserves all notes evidence byte-for-byte', async () => {
  const d = pocket(); const before = new Map(d.files); const copy = await d.duplicate('Copy');
  for (const [file, bytes] of before) if (file.startsWith('book-source/notes/')) assert.deepEqual(d.files.get(copy.id + file.slice('book-source'.length)), bytes, file);
  for (const [file, bytes] of before) assert.deepEqual(d.files.get(file), bytes);
});
test('Pocket duplication refuses links and unavailable files instead of a partial success', async () => {
  for (const kind of ['link', 'cloud']) {
    const d = pocket(); const before = new Map(d.files);
    (kind === 'link' ? d.links : d.away).add('book-source/notes/index.json');
    await assert.rejects(d.duplicate('Copy'));
    assert.deepEqual(d.files, before);
  }
});
test('failed Pocket copying removes its partial destination and preserves the source', async () => {
  const d = pocket(); const before = new Map(d.files); d.failWrite();
  await assert.rejects(d.duplicate('Copy')); assert.deepEqual(d.files, before);
});
test('failed desktop copying rolls back the destination without changing source bytes', async t => {
  const d = library(t); await material(d.book.id, d.bookDir); const before = contents(d.bookDir);
  const bookNames = fs.readdirSync(d.dir).filter(name => name.startsWith('book-')).sort();
  const writer = main.run('writeFileDurable'); main.context.transferSource = d.bookDir; main.context.transferWriter = writer;
  main.run("writeFileDurable = (file, text, temporaryPath) => { if (file.endsWith('/notes/index.json') && !file.startsWith(transferSource + '/')) throw Object.assign(new Error('Interrupted copy'), {code:'EIO'}); return transferWriter(file, text, temporaryPath); }");
  try { await assert.rejects(() => main.call('book:duplicate', d.book.id, 'Interrupted'), /Interrupted copy/); }
  finally { main.context.transferRestoreWriter = writer; main.run('writeFileDurable = transferRestoreWriter'); }
  assert.deepEqual(contents(d.bookDir), before);
  assert.deepEqual(fs.readdirSync(d.dir).filter(name => name.startsWith('book-')).sort(), bookNames);
});
test('desktop copy verification rejects a corrupted destination instead of returning success', async t => {
  const d = library(t); await material(d.book.id, d.bookDir); const before = contents(d.bookDir);
  const bookNames = fs.readdirSync(d.dir).filter(name => name.startsWith('book-')).sort();
  const writer = main.run('writeFileDurable'); main.context.transferSource = d.bookDir; main.context.transferWriter = writer;
  main.run("writeFileDurable = (file, text, temporaryPath) => transferWriter(file, file.endsWith('/notes/index.json') && !file.startsWith(transferSource + '/') ? 'Corrupted destination' : text, temporaryPath)");
  try { await assert.rejects(() => main.call('book:duplicate', d.book.id, 'Corrupted')); }
  finally { main.context.transferRestoreWriter = writer; main.run('writeFileDurable = transferRestoreWriter'); }
  assert.deepEqual(contents(d.bookDir), before);
  assert.deepEqual(fs.readdirSync(d.dir).filter(name => name.startsWith('book-')).sort(), bookNames);
});
test('backup reports unavailable canonical note bodies while retaining available recovery', async t => {
  const d = library(t); const note = await material(d.book.id, d.bookDir);
  const file = path.join(d.bookDir, 'notes', note.noteId + '.html'); fs.unlinkSync(file); fs.closeSync(fs.openSync(file, 'w')); fs.truncateSync(file, 4096);
  assert.equal(fs.statSync(file).blocks, 0);
  const { result, zip } = await backup(t, d.dir);
  assert.ok(result.missed.some(p => p.includes('/notes/' + note.noteId + '.html')));
  assert.equal(zip.file(d.book.id + '/notes/' + note.noteId + '.html'), null);
  assert.ok(zip.file(d.book.id + '/notes/index.json'));
});

test('Pocket destination verification rejects corrupted bytes and rolls back', async () => {
  const d = pocket(); const before = new Map(d.files); d.corruptWrite();
  await assert.rejects(d.duplicate('Copy')); assert.deepEqual(d.files, before);
});
test('Pocket copying rolls back if a source becomes unavailable during the copy', async () => {
  const d = pocket(); const before = new Map(d.files);
  d.afterWrite(() => d.away.add('book-source/notes/index.json'));
  await assert.rejects(d.duplicate('Copy')); assert.deepEqual(d.files, before);
});
test('desktop destination collision never merges or removes an existing book', async t => {
  const d = library(t); await material(d.book.id, d.bookDir); const source = contents(d.bookDir);
  const now = main.run('Date.now'); const random = main.run('Math.random');
  main.run('Date.now = () => 123456789; Math.random = () => 0.5');
  const occupied = path.join(d.dir, 'book-copy-' + (123456789).toString(36) + '-' + (0.5).toString(36).slice(2,7));
  write(occupied, 'sentinel.txt', 'Existing book'); const before = contents(occupied);
  try { await assert.rejects(() => main.call('book:duplicate', d.book.id, 'Copy')); }
  finally { main.context.originalTransferNow = now; main.context.originalTransferRandom = random; main.run('Date.now = originalTransferNow; Math.random = originalTransferRandom'); }
  assert.deepEqual(contents(occupied), before); assert.deepEqual(contents(d.bookDir), source);
});
test('desktop copying detects observed source metadata changes and leaves the new source intact', async t => {
  const d = library(t); await material(d.book.id, d.bookDir);
  const bookNames = fs.readdirSync(d.dir).filter(name => name.startsWith('book-')).sort();
  const writer = main.run('writeFileDurable'); main.context.transferSource = d.bookDir; main.context.transferWriter = writer;
  main.run("writeFileDurable = (file, text, temporaryPath) => { transferWriter(file, text, temporaryPath); if (file.endsWith('/notes/index.json') && !file.startsWith(transferSource + '/')) { const metadata = JSON.parse(fs.readFileSync(transferSource + '/book.json','utf8')); metadata.title = 'Externally changed'; fs.writeFileSync(transferSource + '/book.json', JSON.stringify(metadata)); } }");
  try { await assert.rejects(() => main.call('book:duplicate', d.book.id, 'Changed source'), /changed during copying/); }
  finally { main.context.transferRestoreWriter = writer; main.run('writeFileDurable = transferRestoreWriter'); }
  assert.equal(JSON.parse(fs.readFileSync(path.join(d.bookDir,'book.json'),'utf8')).title, 'Externally changed');
  assert.deepEqual(fs.readdirSync(d.dir).filter(name => name.startsWith('book-')).sort(), bookNames);
});

test('desktop scratch writes cannot overwrite copied temporary artifacts or directories', async t => {
  const d = library(t); await material(d.book.id, d.bookDir);
  write(d.bookDir, 'notes/raw.html', 'Body'); write(d.bookDir, 'notes/raw.html.tmp/evidence.html', 'Nested evidence');
  write(d.bookDir, 'notes/recovery/state.tmp', 'Temporary evidence'); write(d.bookDir, 'notes/recovery/state.tmp.tmp', 'Second temporary evidence');
  const expected = contents(path.join(d.bookDir, 'notes'));
  const original = fs.readdirSync;
  fs.readdirSync = (directory, options) => {
    const entries = original(directory, options);
    if (String(directory).startsWith(d.bookDir) && options?.withFileTypes) return entries.sort((a,b) => Number(b.isDirectory()) - Number(a.isDirectory()) || b.name.localeCompare(a.name));
    return entries;
  };
  let copy;
  try { copy = await main.call('book:duplicate', d.book.id, 'Temporary evidence copy'); }
  finally { fs.readdirSync = original; }
  assert.deepEqual(contents(path.join(d.dir, copy.id, 'notes')), expected);
  assert.equal(fs.readdirSync(path.join(d.dir, copy.id)).some(name => name.startsWith('.neo-copy-')), false);
});

test('backup reports a wholly cloud-only notes directory', async t => {
  const d = library(t); write(d.bookDir, '.notes.icloud', '');
  const { result, zip } = await backup(t, d.dir);
  assert.ok(result.missed.some(p => p.includes(d.book.id + '/.notes.icloud')));
  assert.match(await zip.file('_left-out-of-this-backup.txt').async('string'), /\.notes\.icloud/);
});
test('backup reports a wholly cloud-only book instead of silently skipping its collection', async t => {
  const d = library(t); write(d.dir, '.book-cloud.icloud', '');
  const { result, zip } = await backup(t, d.dir);
  assert.ok(result.missed.some(p => p.includes('.book-cloud.icloud')));
  assert.match(await zip.file('_left-out-of-this-backup.txt').async('string'), /\.book-cloud\.icloud/);
});
for (const phase of ['destination', 'source fingerprint']) { test('desktop main loop stays responsive during ' + phase + ' verification', async t => {
  const d = library(t); const note = await material(d.book.id, d.bookDir); const sourceBefore = contents(d.bookDir);
  const originalRead = fs.promises.readFile; let reads = 0; let release; let entered;
  const blocked = new Promise(resolve => { release = resolve; }); const waiting = new Promise(resolve => { entered = resolve; });
  let ticks = 0; const timer = setInterval(() => ticks++, 5); let copyFinished = false;
  fs.promises.readFile = async (file, ...args) => {
    const filename = String(file); const isBody = filename.endsWith('/notes/' + note.noteId + '.html');
    const isSource = filename === path.join(d.bookDir, 'notes', note.noteId + '.html');
    if (isBody && isSource) reads++;
    if (isBody && (phase === 'destination' ? !isSource : isSource && reads === 2)) { entered(); await blocked; }
    return originalRead.call(fs.promises, file, ...args);
  };
  const copying = Promise.resolve(main.call('book:duplicate', d.book.id, 'Responsive copy'));
  copying.then(() => { copyFinished = true; }, () => { copyFinished = true; });
  try {
    await Promise.race([waiting, copying.then(() => { throw new Error('Verification never used asynchronous file reads'); })]);
    await new Promise(resolve => setTimeout(resolve, 45));
    assert.ok(ticks > 0, 'the main loop continues while the storage provider is pending');
    assert.equal(copyFinished, false);
    release(); const copy = await copying;
    assert.deepEqual(contents(path.join(d.dir, copy.id, 'notes')), contents(path.join(d.bookDir, 'notes')));
    assert.deepEqual(contents(d.bookDir), sourceBefore);
  } finally { release(); await copying.catch(() => {}); fs.promises.readFile = originalRead; clearInterval(timer); }
}); }
test('a stalled verification times out, rolls back the copy and leaves the source untouched', async t => {
  const d = library(t); const note = await material(d.book.id, d.bookDir); const before = contents(d.bookDir);
  const books = fs.readdirSync(d.dir).filter(name => name.startsWith('book-')).sort();
  const originalRead = fs.promises.readFile; const reader = main.run('readBookCopyFile');
  main.context.copyDefaultReader = reader; main.context.copySourceDirectory = d.bookDir;
  main.context.copyBodySuffix = '/notes/' + note.noteId + '.html';
  main.run("readBookCopyFile = file => copyDefaultReader(file, file.endsWith(copyBodySuffix) && !file.startsWith(copySourceDirectory + '/') ? 40 : 20000)");
  fs.promises.readFile = (file, ...args) => String(file).endsWith('/notes/' + note.noteId + '.html') && !String(file).startsWith(d.bookDir + '/') ? new Promise(() => {}) : originalRead.call(fs.promises, file, ...args);
  try { await assert.rejects(main.call('book:duplicate', d.book.id, 'Stalled copy'), err => err.code === 'ETIMEDOUT' && err.message.includes(note.noteId + '.html')); }
  finally { fs.promises.readFile = originalRead; main.context.copyRestoredReader = reader; main.run('readBookCopyFile = copyRestoredReader'); }
  assert.deepEqual(contents(d.bookDir), before);
  assert.deepEqual(fs.readdirSync(d.dir).filter(name => name.startsWith('book-')).sort(), books);
});

test('asynchronous duplications serialize their verification and editor-freeze windows', async t => {
  const d = library(t); const note = await material(d.book.id, d.bookDir); const before = contents(d.bookDir);
  const originalRead = fs.promises.readFile; let entered; let release; let verifications = 0;
  const waiting = new Promise(resolve => { entered = resolve; }); const blocked = new Promise(resolve => { release = resolve; });
  fs.promises.readFile = async (file, ...args) => {
    if (String(file).endsWith('/notes/' + note.noteId + '.html') && !String(file).startsWith(d.bookDir + '/')) { verifications++; entered(); await blocked; }
    return originalRead.call(fs.promises, file, ...args);
  };
  const first = main.call('book:duplicate', d.book.id, 'First copy'); let second;
  try {
    await Promise.race([waiting, first.then(() => { throw new Error('Asynchronous verification was not reached'); })]);
    second = main.call('book:duplicate', d.book.id, 'Second copy');
    await new Promise(resolve => setTimeout(resolve, 45)); assert.equal(verifications, 1);
    release(); const copies = await Promise.all([first, second]);
    assert.notEqual(copies[0].id, copies[1].id); assert.equal(verifications, 2);
    for (const copy of copies) assert.deepEqual(contents(path.join(d.dir, copy.id, 'notes')), contents(path.join(d.bookDir, 'notes')));
    assert.deepEqual(contents(d.bookDir), before);
  } finally { release(); await Promise.allSettled([first, second]); fs.promises.readFile = originalRead; }
});
