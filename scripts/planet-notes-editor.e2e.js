'use strict';

// Real Electron IPC, existing Notes DOM and native close. Always isolated.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'neo-custom-editor-')));
app.setPath('documents', root); app.setPath('userData', path.join(root, 'profile'));
fs.mkdirSync(path.join(root, 'profile'));
const disabled = process.argv.includes('--disabled');
if (!disabled) { process.env.NEO_PLANET_NOTES_TEST = '1'; process.env.NEO_PLANET_NOTES_TEST_ROOT = root; }
else { delete process.env.NEO_PLANET_NOTES_TEST; delete process.env.NEO_PLANET_NOTES_TEST_ROOT; }
const library = path.join(root, 'NEO Library'); fs.mkdirSync(library);
fs.writeFileSync(path.join(library, 'library.json'), JSON.stringify({ firstRunDone: true, moreFeatures: true, authorName: '', penNames: [], shelves: [{ id: 'shelf-one', name: 'Tests', bookIds: [] }] }));
const loadFile = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = function (file, options) { return loadFile.call(this, path.resolve(__dirname, '..', file), options); };
let failSave = false; let holdSave = null;
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, fn) => handle(channel, async (...args) => {
  if (channel === 'notes:save') {
    if (failSave) { failSave = false; return { ok: false, error: { code: 'EIO', message: 'Injected save failure' } }; }
    if (holdSave && !holdSave.used) {
      holdSave.used = true; holdSave.entered(); await holdSave.promise;
    }
  }
  return fn(...args);
});
require('../main');
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
async function until(fn) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { if (await fn()) return; await tick(); }
  throw new Error('Integration condition timed out');
}
const deadline = setTimeout(() => { console.error('Integration runner timed out'); app.exit(1); }, 45000);
async function run() {
  await app.whenReady(); let win;
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return !!win; });
  const js = (code) => win.webContents.executeJavaScript(code, true);
  await until(() => js('typeof library !== "undefined" && !!library').catch(() => false));
  const capabilities = await js('window.neo.notesCapabilities()');
  assert.equal(capabilities.enabled, !disabled);
  const book = await js('window.neo.createBook({title:"Isolated Custom Notes",author:"Test"})');
  if (disabled) {
    const result = await js(`window.neo.notesCreate(${JSON.stringify(book.id)}, {operationId:'o-blocked',title:'Blocked'})`);
    assert.equal(result.status, 'error'); assert.equal(result.error.code, 'ENOTAVAILABLE');
    assert.equal(fs.existsSync(path.join(library, book.id, 'notes')), false);
    console.log('PASS: normal launch keeps Custom Notes disabled');
    return;
  }
  const note = await js(`window.neo.notesCreate(${JSON.stringify(book.id)}, {operationId:'o-create',title:'Mara'})`);
  await js(`document.getElementById('firstrun').hidden=true; openBook(${JSON.stringify(book.id)})`);
  await js(`openCustomNote(${JSON.stringify(note.noteId)})`);
  assert.equal(await js(`document.getElementById('aux-editor').contentEditable`), 'true');
  const attacks = ['<script>window.neoAttack=1</script><p>Words</p>', '<img src=x onerror="window.neoAttack=1">', '<svg onload="window.neoAttack=1"></svg>', '<p style="background:url(https://example.invalid)">Words</p>', '<a href="javascript:alert(1)">Words</a>', '<p data-x="y">Words</p>'];
  for (const html of attacks) {
    const result = await js(`NeoPlanetNotesHtml.inspect(${JSON.stringify(html)})`);
    assert.equal(result.status, 'unsupported'); assert.equal(result.html, undefined);
  }
  assert.equal(await js('window.neoAttack'), undefined);
  assert.equal((await js(`NeoPlanetNotesHtml.inspect('<p style="text-align: center"><b>Bold</b> <i>Italic</i><br>Words</p>')`)).status, 'editable');
  console.log('PASS: real HTML inspector accepts notes markup and rejects active/unsupported HTML');
  const sourcePath = path.join(library, book.id, 'notes', note.noteId + '.html');
  const original = '<article><h1>Original source</h1><script>window.neoAttack=1</script><p>Preserved words</p></article>';
  fs.writeFileSync(sourcePath, original);
  await js(`openCustomNote(${JSON.stringify(note.noteId)})`);
  assert.equal(await js(`document.getElementById('aux-editor').contentEditable`), 'false');
  assert.equal(await js(`document.getElementById('aux-editor').querySelector('script')`), null);
  assert.match(await js(`document.getElementById('aux-editor').textContent`), /Preserved words/);
  const copy = await js('NeoCustomNotes.createEditableCopy()');
  assert.notEqual(copy.noteId, note.noteId); assert.equal(fs.readFileSync(sourcePath, 'utf8'), original);
  assert.equal(await js(`document.getElementById('aux-editor').contentEditable`), 'true');
  fs.writeFileSync(sourcePath, '<p>External starting body</p>');
  await js(`openCustomNote(${JSON.stringify(note.noteId)})`);
  fs.writeFileSync(sourcePath, '<p>Refreshed external body</p>');
  await js('NeoCustomNotes.refresh()');
  assert.match(await js(`document.getElementById('aux-editor').innerHTML`), /Refreshed external body/);
  // Keep a caret in the paragraph across a later external refresh.
  await js(`(() => {const ed=document.getElementById('aux-editor');ed.focus();const r=document.createRange();r.setStart(ed.firstChild.firstChild,4);r.collapse(true);const s=getSelection();s.removeAllRanges();s.addRange(r);})()`);
  fs.writeFileSync(sourcePath, '<p>Refreshed external body plus more</p>');
  await js('NeoCustomNotes.refresh()');
  assert.equal(await js('getSelection().anchorOffset'), 4);
  assert.equal(await js('window.neoAttack'), undefined);
  console.log('PASS: safe preview, independent editable copy, external adoption and caret preservation');
  await js(`openCustomNote(${JSON.stringify(note.noteId)}, html => ({status:'editable',html}))`);
  assert.equal(await js(`document.getElementById('aux-editor').contentEditable`), 'true');
  await js(`switchTab('notes')`);
  assert.equal(await js(`document.getElementById('aux-editor').dataset.customNoteId`), note.noteId);
  const edit = (html) => js(`(() => {const ed=document.getElementById('aux-editor');ed.innerHTML=${JSON.stringify(html)};ed.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await edit('<p>Custom writing</p>'); await js('customNotesController.flush()');
  assert.match((await js(`window.neo.notesRead(${JSON.stringify(book.id)},${JSON.stringify(note.noteId)})`)).html, /Custom writing/);
  await js(`window.NeoCustomNotes.rename('Mara revised')`);
  assert.equal(await js(`document.getElementById('aux-title').textContent`), 'Mara revised');
  console.log('PASS: rename reaches the domain service without replacing writing');
  await js(`openNotesPage('book')`);
  await until(() => js(`document.getElementById('aux-editor').dataset.kind==='notes' && document.getElementById('aux-editor').contentEditable==='true'`));
  await edit('<p>Legacy notes</p>'); await js('flushAux()');
  await until(() => js(`window.neo.readAux(${JSON.stringify(book.id)},'notes').then(html=>html.includes('Legacy notes'))`));
  assert.match((await js(`window.neo.notesRead(${JSON.stringify(book.id)},${JSON.stringify(note.noteId)})`)).html, /Custom writing/);
  console.log('PASS: custom and legacy Notes use separate saving paths');
  await js(`openCustomNote(${JSON.stringify(note.noteId)}, html=>({status:'editable',html}))`);
  await js(`window.neo.notesCloseResult({token:'forged',status:'ready'})`);
  await tick(); assert.equal(win.isDestroyed(), false);
  console.log('PASS: forged close acknowledgment is ignored');
  await edit('<p>Failed close writing</p>'); failSave = true; win.close();
  await until(() => js(`!!document.getElementById('custom-notes-status') && document.getElementById('custom-notes-status').textContent.includes('stay open')`).catch(() => false));
  assert.equal(win.isDestroyed(), false);
  assert.equal(await js('customNotesController.hasPending()'), true);
  console.log('PASS: failed save keeps native window and pending writing open');
  let release; let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  holdSave = { used: false, entered: () => entered(), promise: new Promise((resolve) => { release = resolve; }) };
  const closed = new Promise((resolve) => win.once('closed', resolve));
  win.close(); await enteredPromise;
  assert.equal(win.isDestroyed(), false);
  await edit('<p>Final writing during close</p>'); release();
  await closed;
  const persisted = fs.readFileSync(path.join(library, book.id, 'notes', note.noteId + '.html'), 'utf8');
  assert.match(persisted, /Final writing during close/);
  assert.match(fs.readFileSync(path.join(library, book.id, 'notes.html'), 'utf8'), /Legacy notes/);
  console.log('PASS: native close waits for in-flight and newer edits to reach disk');
}
run().then(() => {
  clearTimeout(deadline); fs.rmSync(root, { recursive: true, force: true }); app.exit(0);
}, (err) => {
  clearTimeout(deadline); console.error(err.stack || err); console.error('Isolated fixture retained:', root); app.exit(1);
});
