'use strict';
// Actual Pocket page + bridge in a narrow Electron window. Capacitor I/O is
// simulated with temporary files; this is not native iOS/Android certification.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const { pathToFileURL } = require('node:url'); const assert = require('node:assert/strict');
const { createNotesService } = require('../planet-notes-service'); const { createNotesStore } = require('../planet-notes-store');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'neo-pocket-notes-')));
app.setPath('userData', path.join(root, 'profile'));
const repository = path.resolve(__dirname, '..');
const deadline = setTimeout(() => { console.error('Pocket timed out; fixture:', root); app.exit(1); }, 90000);
async function run() {
  const bookId = 'book-pocket'; const directory = path.join(root, 'NEO Library', bookId);
  fs.mkdirSync(path.join(directory, 'chapters'), { recursive: true });
  const files = new Map(); let sequence = 0;
  const adapter = { read: async p => files.has(p) ? { status: 'ok', text: files.get(p) } : { status: 'missing' }, writeDurable: async (p, text) => { files.set(p, text); }, remove: async p => { files.delete(p); }, list: async () => [...files.keys()] };
  const store = createNotesStore(adapter);
  const service = createNotesService({ enabled: true, getBook: async () => ({ adapter, store }), makeId: prefix => prefix + '-fixture' + (++sequence) });
  const note = await service.create(bookId, { operationId: 'o-note', title: 'Mara' });
  let read = await service.read(bookId, note.noteId);
  await service.save(bookId, note.noteId, { operationId: 'o-body', html: '<p>Pocket orchard</p>', expectedBodyToken: read.bodyToken, writingDay: '2026-11-12' });
  const group = await service.organize(bookId, { operationId: 'o-group', action: 'createGroup', title: 'Characters', parentId: null });
  const other = await service.organize(bookId, { operationId: 'o-other', action: 'createGroup', title: 'Places', parentId: null });
  const label = await service.organize(bookId, { operationId: 'o-label', action: 'createLabel', name: 'plot' });
  await service.organize(bookId, { operationId: 'o-assign', action: 'assignLabel', noteId: note.noteId, labelId: label.itemId, assigned: true });
  const base = (await store.load()).index;
  await service.organize(bookId, { operationId: 'o-move', action: 'move', itemId: note.noteId, parentId: group.itemId });
  const incoming = require('../planet-notes-organization').applyAction(base, { operationId: 'o-remote', action: 'move', itemId: note.noteId, parentId: other.itemId }).index;
  incoming.versionId = 'v-remote'; incoming.parentVersionIds = [base.versionId]; files.set('index.json', JSON.stringify(incoming)); await service.load(bookId);
  const trashed = await service.create(bookId, { operationId: 'o-trash-create', title: 'Archived research' });
  read = await service.read(bookId, trashed.noteId);
  await service.save(bookId, trashed.noteId, { operationId: 'o-trash-body', html: '<p>Preserved research</p>', expectedBodyToken: read.bodyToken, writingDay: '2026-11-12' });
  await service.organize(bookId, { operationId: 'o-trash', action: 'trashNote', noteId: trashed.noteId });
  const unsupported = await service.create(bookId, { operationId: 'o-unsupported', title: 'External document' });
  files.set(unsupported.noteId + '.html', '<script>window.pocketExecuted=true</script><h1>Unsupported reference</h1>');
  for (const [p, text] of files) { const full = path.join(directory, 'notes', p); fs.mkdirSync(path.dirname(full), { recursive: true }); fs.writeFileSync(full, text); }
  fs.writeFileSync(path.join(directory, 'book.json'), JSON.stringify({ id: bookId, title: 'Pocket fixture', author: '', chapterOrder: ['ch-one'], chapterTitles: { 'ch-one': 'First chapter' }, chapterNotes: {}, wordCount: 0 }));
  fs.writeFileSync(path.join(directory, 'chapters/ch-one.html'), '<p>Manuscript</p>');
  fs.writeFileSync(path.join(directory, 'notes.html'), '<p>Legacy reference</p>');
  const secondBook = 'book-other'; const secondDirectory = path.join(root, 'NEO Library', secondBook);
  fs.cpSync(directory, secondDirectory, { recursive: true });
  const secondMetadata = JSON.parse(fs.readFileSync(path.join(secondDirectory, 'book.json'), 'utf8'));
  secondMetadata.id = secondBook; secondMetadata.title = 'Another book';
  fs.writeFileSync(path.join(secondDirectory, 'book.json'), JSON.stringify(secondMetadata));
  fs.writeFileSync(path.join(secondDirectory, 'notes', note.noteId + '.html'), '<p>Other book untouched</p>');
  fs.writeFileSync(path.join(root, 'NEO Library/library.json'), JSON.stringify({ firstRunDone: true, moreFeatures: false, shelves: [{ id: 'shelf-one', name: 'Tests', bookIds: [bookId, secondBook] }], penNames: [], authorName: '' }));
  // No code in the shipped page can enable the gate. Only this disposable
  // fixture copy changes the constant for integration testing.
  const bridge = fs.readFileSync(path.join(repository, 'pocket/www/pocket-bridge.js'), 'utf8');
  assert.ok(bridge.includes('const NOTES_ENABLED = false;'));
  fs.writeFileSync(path.join(root, 'bridge.js'), bridge.replace('const NOTES_ENABLED = false;', 'const NOTES_ENABLED = true;'));
  const preload = path.join(root, 'preload.js');
  fs.writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('PocketFixture',{io:(method,options)=>ipcRenderer.invoke('pocket-fixture:io',method,options)});`);
  const capacitor = `<script>
    const filesystem=Object.fromEntries(['stat','readFile','writeFile','rename','deleteFile','mkdir','readdir','getUri'].map(method=>[method,async options=>{const result=await PocketFixture.io(method,options);if(result?.fixtureError)throw Object.assign(new Error(result.fixtureError.message),{code:result.fixtureError.code});return result;}]));
    filesystem.checkPermissions=async()=>({publicStorage:'granted'});filesystem.requestPermissions=filesystem.checkPermissions;
    window.Capacitor={getPlatform:()=> 'android',convertFileSrc:p=>p,Plugins:{Filesystem:filesystem},registerPlugin:()=>({keyboard:async()=>({hardware:false}),set:async()=>{},setKeyboard:async()=>{}})};
  </script>`;
  const full = (value) => { const file = path.resolve(root, value); if (!file.startsWith(root + path.sep)) throw new Error('Outside fixture'); return file; };
  let failNextRename = false;
  ipcMain.handle('pocket-fixture:io', async (event, method, options) => {
    if (win.isDestroyed()) return { fixtureError: { code: 'ECLOSED', message: 'Fixture closed' } };
    assert.equal(event.sender, win.webContents);
    try {
      if (method === 'failNextRename') { failNextRename = true; return {}; }
      const file = options.path ? full(options.path) : null;
      if (method === 'stat') { const stat = await fs.promises.lstat(file); return { type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : 'file', size: stat.size, mtime: stat.mtimeMs }; }
      if (method === 'readFile') return { data: await fs.promises.readFile(file, options.encoding === 'utf8' ? 'utf8' : 'base64') };
      if (method === 'writeFile') { if (options.recursive) await fs.promises.mkdir(path.dirname(file), { recursive: true }); await fs.promises.writeFile(file, options.data, options.encoding === 'utf8' ? 'utf8' : 'base64'); return {}; }
      if (method === 'rename') { if (failNextRename) { failNextRename = false; throw Object.assign(new Error('Simulated native failure'), { code: 'EIO' }); } await fs.promises.rename(full(options.from), full(options.to)); return {}; }
      if (method === 'deleteFile') { await fs.promises.unlink(file); return {}; }
      if (method === 'mkdir') { await fs.promises.mkdir(file, { recursive: options.recursive }); return {}; }
      if (method === 'readdir') return { files: (await fs.promises.readdir(file, { withFileTypes: true })).map(entry => ({ name: entry.name, type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file' })) };
      if (method === 'getUri') return { uri: pathToFileURL(file).href };
      throw new Error('Unsupported fixture method');
    } catch (err) { return { fixtureError: { code: err.code || 'EIO', message: err.message } }; }
  });
  const html = fs.readFileSync(path.join(repository, 'pocket/www/index.html'), 'utf8').replace('<head>', '<head>' + capacitor + '<base href="' + pathToFileURL(path.join(repository, 'pocket/www/')).href + '">').replace('src="pocket-bridge.js"', 'src="' + pathToFileURL(path.join(root, 'bridge.js')).href + '"');
  fs.writeFileSync(path.join(root, 'index.html'), html);
  await app.whenReady();
  const win = new BrowserWindow({ width: 430, height: 850, show: true, webPreferences: { preload, contextIsolation: true, nodeIntegration: false } });
  const messages = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') messages.push(event.message); });
  await win.loadFile(path.join(root, 'index.html'));
  const js = source => win.webContents.executeJavaScript(source, true).catch(err => { throw new Error(source + '\n' + err.message + '\n' + messages.join('\n')); });
  const until = async (fn) => { const end = Date.now() + 15000; while (Date.now() < end) { if (await fn()) return; await new Promise(resolve => setTimeout(resolve, 30)); } throw new Error('Pocket UI timed out: ' + messages.join('\n')); };
  await until(() => js('typeof library!=="undefined" && !!library').catch(() => false));
  await js(`document.getElementById('firstrun').hidden=true;openBook('${bookId}')`);
  await js(`switchTab('notes');document.getElementById('nav-pane').classList.add('open')`);
  await until(() => js(`!!document.querySelector('[data-item-id="${group.itemId}"]') && !!document.querySelector('.custom-notes-tools')`));
  await js(`document.querySelector('[data-item-id="${group.itemId}"]').click()`);
  await until(() => js(`!!document.querySelector('[data-item-id="${note.noteId}"]')`));
  await js(`document.querySelector('[data-item-id="${note.noteId}"]').click()`);
  await until(() => js(`document.getElementById('aux-editor').dataset.customNoteId==='${note.noteId}' && document.getElementById('aux-editor').contentEditable==='true' && document.getElementById('aux-editor').textContent.includes('Pocket orchard')`));
  assert.equal(await js('IS_POCKET'), true);
  assert.equal(await js(`document.querySelector('.custom-notes-tools').hidden`), true);
  assert.equal(await js(`document.querySelectorAll('.custom-note-row[draggable="true"]').length`), 0);
  assert.match(await js(`document.querySelector('[data-item-id="${note.noteId}"]').textContent`), /plot/);
  await js(`document.getElementById('aux-editor').focus()`); await win.webContents.insertText(' mobile typing');
  await js(`window.dispatchEvent(new Event('neo-notes-background'))`);
  const body = path.join(directory, 'notes', note.noteId + '.html');
  await until(() => fs.readFileSync(body, 'utf8').includes('mobile typing'));
  await js(`PocketFixture.io('failNextRename',{})`);
  await js(`document.getElementById('aux-editor').focus()`); await win.webContents.insertText(' retryable words');
  await js(`customNotesController.flush().catch(customNotesError)`);
  assert.equal(await js(`!!document.getElementById('pocket-error-detail')`), false);
  assert.match(await js(`document.getElementById('aux-editor').textContent`), /retryable words/);
  await js('customNotesController.flush()');
  await until(() => fs.readFileSync(body, 'utf8').includes('retryable words'));
  await js(`document.getElementById('aux-editor').focus()`); await win.webContents.insertText(' before switching books');
  assert.match(await js(`document.getElementById('aux-editor').textContent`), /before switching books/);
  await js(`openBook('${secondBook}')`); await js(`switchTab('notes');openCustomNote('${note.noteId}')`);
  await until(() => js(`document.getElementById('aux-editor').textContent.includes('Other book untouched')`));
  await until(() => fs.readFileSync(body, 'utf8').includes('before switching books'));
  assert.equal(fs.readFileSync(path.join(secondDirectory, 'notes', note.noteId + '.html'), 'utf8'), '<p>Other book untouched</p>');
  await js(`openBook('${bookId}')`); await js(`switchTab('notes');openCustomNote('${note.noteId}')`);
  console.log('PASS: actual Pocket page browses labeled grouped notes; background flush and quiet failed-save retry preserve typing');
  const click = async action => { await until(() => js(`!!document.querySelector('[data-explorer-action="${action}"]')`)); await js(`document.querySelector('[data-explorer-action="${action}"]').click()`); await new Promise(resolve => setTimeout(resolve, 30)); await js('notesExplorer.settled()'); };
  await click('search');
  await js(`document.querySelector('[data-notes-search="query"]').focus()`); await win.webContents.insertText('mobile typing');
  await until(() => js(`document.querySelectorAll('.notes-search-result').length===1`));
  await click('open-result'); await click('close');
  await click('trash'); await click('preview');
  await until(() => js(`document.getElementById('custom-notes-preview')?.textContent.includes('Preserved research')`));
  assert.equal(await js(`document.getElementById('custom-notes-preview').isContentEditable`), false);
  assert.equal(await js(`!!document.querySelector('[data-explorer-action="restore"]')`), false);
  await click('conflicts'); await click('preview');
  await until(() => js(`document.querySelector('.notes-recovery-actions')?.textContent.includes('Other version')`));
  assert.equal(await js(`document.querySelectorAll('.notes-recovery-actions select, [data-explorer-action="apply-values"]').length`), 0);
  assert.equal(await js(`(async()=>{const result=await neo.notesRecover('${bookId}',{});return result.error.code;})()`), 'ENOTSUPPORTED');
  await click('close'); await js(`openCustomNote('${unsupported.noteId}')`);
  await until(() => js(`document.getElementById('aux-editor').textContent.includes('Unsupported reference')`));
  assert.equal(await js(`document.getElementById('aux-editor').isContentEditable`), false);
  assert.equal(await js(`document.getElementById('custom-notes-copy').hidden`), true);
  assert.equal(await js('!!window.pocketExecuted'), false);
  console.log('PASS: Pocket search, read-only trash/conflict inspection, denied restoration and inert unsupported HTML');
  await js('backToShelf()');
  const opaque = path.join(directory, 'notes', 'recovery', 'copy-artifacts'); fs.mkdirSync(opaque, { recursive: true });
  fs.writeFileSync(path.join(opaque, 'observed.tmp'), 'Interrupted notes writing');
  fs.writeFileSync(path.join(opaque, 'observed.bak'), Buffer.from([0, 1, 255]));
  fs.writeFileSync(path.join(opaque, 'book.json'), '{"evidence":"unchanged"}');
  const noteFiles = folder => {
    const result = new Map(); const walk = (dir, rel = '') => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const sub = rel ? rel + '/' + entry.name : entry.name; if (entry.isDirectory()) walk(path.join(dir, entry.name), sub); else result.set(sub, fs.readFileSync(path.join(dir, entry.name))); } }; walk(folder); return result;
  };
  const sourceBefore = noteFiles(path.join(directory, 'notes'));
  const copy = await js(`neo.duplicateBook('${bookId}','Independent Pocket copy')`);
  assert.notEqual(copy.id, bookId);
  assert.deepEqual(noteFiles(path.join(root, 'NEO Library', copy.id, 'notes')), sourceBefore);
  await js(`(async()=>{const before=await neo.notesRead('${copy.id}','${note.noteId}');const result=await neo.notesSave('${copy.id}','${note.noteId}',{operationId:'o-copy-only',html:'<p>Only the duplicate</p>',expectedBodyToken:before.bodyToken,writingDay:'2026-11-12'});if(result.status!=='saved')throw new Error('Copy edit failed');})()`);
  assert.deepEqual(noteFiles(path.join(directory, 'notes')), sourceBefore);
  assert.equal(fs.readFileSync(path.join(root, 'NEO Library', copy.id, 'notes', note.noteId+'.html'),'utf8'),'<p>Only the duplicate</p>');
  console.log('PASS: actual Pocket duplication preserves every notes artifact and edits only the independent copy');
  clearTimeout(deadline); win.destroy(); fs.rmSync(root, { recursive: true, force: true }); app.exit(0);
}
run().catch(err => { console.error(err.stack); console.error('Fixture retained:', root); clearTimeout(deadline); app.exit(1); });
