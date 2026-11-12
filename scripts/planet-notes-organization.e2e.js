'use strict';
// Real Electron, temporary library/profile. Exercises Notes controls and native
// keyboard input; data assertions inspect the actual persisted index and bodies.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'neo-notes-organization-')));
app.setPath('documents', root); app.setPath('userData', path.join(root, 'profile')); fs.mkdirSync(path.join(root, 'profile'));
process.env.NEO_PLANET_NOTES_TEST = '1'; process.env.NEO_PLANET_NOTES_TEST_ROOT = root;
const library = path.join(root, 'NEO Library'); fs.mkdirSync(library);
fs.writeFileSync(path.join(library, 'library.json'), JSON.stringify({ firstRunDone: true, moreFeatures: true, authorName: '', penNames: [], shelves: [{ id: 'shelf-one', name: 'Tests', bookIds: [] }] }));
const loadFile = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = function (file, options) { return loadFile.call(this, path.resolve(__dirname, '..', file), options); };
let heldTrash = null;
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => handle(channel, async (...args) => {
  if (channel === 'notes:organize' && args[2]?.action === 'trashNote' && heldTrash) {
    const pending = heldTrash; heldTrash = null; pending.entered(); await pending.promise;
  }
  return handler(...args);
});
require('../main');
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
async function until(fn) { const end = Date.now() + 12000; while (Date.now() < end) { if (await fn()) return; await tick(); } throw new Error('Organization UI condition timed out'); }
const deadline = setTimeout(() => { console.error('Organization test timed out:', root); app.exit(1); }, 60000);
async function run() {
  await app.whenReady(); let win;
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return !!win; });
  const js = (source) => win.webContents.executeJavaScript(source, true).catch((err) => { throw new Error(source + '\n' + err.message); });
  win.webContents.on('console-message', (event) => { if (event.level === 'error') console.error(event.message); });
  await until(() => js('typeof library !== "undefined" && !!library').catch(() => false));
  const book = await js('neo.createBook({title:"Organization fixture",author:"Test"})');
  await js(`document.getElementById('firstrun').hidden=true; openBook(${JSON.stringify(book.id)})`);
  await js(`switchTab('notes'); document.getElementById('nav-pane').classList.add('open')`);
  await until(() => js(`!!document.querySelector('#custom-notes-nav [data-action="new-group"]')`));
  const click = async (selector) => {
    await until(() => js(`document.getElementById('custom-notes-nav').getAttribute('aria-busy')!=='true'`));
    return js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  };
  const input = async (selector, text) => {
    await until(() => js(`document.getElementById('custom-notes-nav').getAttribute('aria-busy')!=='true' && !!document.querySelector(${JSON.stringify(selector)})`));
    await js(`(() => {const el=document.querySelector(${JSON.stringify(selector)});el.focus();el.select?.();})()`);
    await win.webContents.insertText(text);
  };
  const key = (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
    if (keyCode === 'Return' || keyCode === 'Enter') win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  };
  const indexPath = path.join(library, book.id, 'notes', 'index.json');
  const index = () => fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : null;
  await click('[data-action="new-group"]'); await input('.custom-notes-form input', 'Characters');
  await click('.custom-notes-form button[type="submit"]'); await until(() => index()?.groups.length === 1);
  const characters = index().groups[0].id;
  await click('[data-action="new-group"]'); await input('.custom-notes-form input', 'Antagonists');
  await click('.custom-notes-form button[type="submit"]'); await until(() => index()?.groups.length === 2);
  const nested = index().groups.find((g) => g.id !== characters).id;
  assert.equal(index().groups.find((g) => g.id === nested).parentId, characters);
  await until(() => js(`!!document.querySelector('[data-item-id="${nested}"]')`));
  await click('[data-action="new-note"]'); await input('.custom-notes-form input', 'Mara');
  await click('.custom-notes-form button[type="submit"]'); await until(() => index()?.notes.length === 1 && index().notes[0].parentId === nested);
  const noteId = index().notes[0].id;
  await until(() => js(`document.getElementById('aux-editor').dataset.customNoteId===${JSON.stringify(noteId)}`));
  assert.equal(await js(`document.querySelectorAll('#notes-nav > .notes-item.current').length`), 0, 'Legacy notes must not remain marked current while a Custom Note is open');
  await js(`document.getElementById('aux-editor').focus()`); await win.webContents.insertText('Writing to preserve');
  await js('customNotesController.flush()');
  const bodyPath = path.join(library, book.id, 'notes', noteId + '.html');
  assert.match(fs.readFileSync(bodyPath, 'utf8'), /Writing to preserve/);
  console.log('PASS: Notes controls create nested groups and a note, native input saves its writing');

  await until(() => js(`!!document.querySelector('[data-item-id="${noteId}"]') && document.getElementById('custom-notes-nav').getAttribute('aria-busy')!=='true'`));
  await js(`document.querySelector('[data-item-id="${noteId}"]').focus()`); key('F2');
  await until(() => js(`!!document.querySelector('.custom-notes-form [data-action="move"]')`));
  const choices = await js(`Array.from(document.querySelector('.custom-notes-form select').options).map(o=>o.value)`);
  assert.ok(choices.includes(characters));
  await js(`document.querySelector('.custom-notes-form select').value=${JSON.stringify(characters)}`); await click('.custom-notes-form [data-action="move"]');
  await until(() => index().notes[0].parentId === characters);
  await click('[data-action="undo"]'); await until(() => index().notes[0].parentId === nested);
  assert.match(fs.readFileSync(bodyPath, 'utf8'), /Writing to preserve/);
  console.log('PASS: keyboard management and organization undo preserve writing');
  await until(() => js(`document.getElementById('custom-notes-nav').getAttribute('aria-busy')!=='true'`));
  await js(`document.querySelector('[data-item-id="${noteId}"]').focus()`);
  key('F10', ['shift']);
  await until(() => js(`!!document.querySelector('.pop-menu[role="menu"]')`));
  key('Down');
  await until(() => js(`document.activeElement?.textContent===NeoI18n.t('Move')`));
  key('Return');
  await until(() => js(`document.activeElement===document.querySelector('.custom-notes-form select')`));
  key('Escape');
  await until(() => js(`!document.querySelector('.custom-notes-form') && document.activeElement?.dataset.itemId==='${noteId}'`));
  await js(`(() => {const row=document.querySelector('[data-item-id="${noteId}"]');const r=row.getBoundingClientRect();row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:r.left+20,clientY:r.top+10}));})()`);
  await until(() => js(`!!document.querySelector('.pop-menu[role="menu"]')`));
  key('Escape');
  await until(() => js(`!document.querySelector('.pop-menu')`));
  console.log('PASS: the existing context menu supports keyboard actions and right-click cancellation');


  await click('[data-action="labels"]'); await input('.custom-notes-form [data-field="label-name"]', 'plot');
  await click('.custom-notes-form button[type="submit"]'); await until(() => index().labels.length === 1);
  await until(() => js(`!!document.querySelector('.custom-label-row input[type="checkbox"]')`));
  await click('.custom-label-row input[type="checkbox"]'); await until(() => index().notes[0].labelIds.length === 1);
  await input('.custom-notes-form [data-field="label-name"]', 'Plot'); await click('.custom-notes-form button[type="submit"]'); await until(() => index().labels.length === 2);
  assert.deepEqual(index().labels.map((l) => l.name), ['plot', 'Plot']);
  await click('.custom-notes-form [data-action="cancel"]');

  // Browser drag events exercise the same destination calculation and handlers
  // as a drag, including preview. Native pointer dragging is a later harness gate.
  await until(() => js(`!!document.querySelector('[data-item-id="${noteId}"]')`));
  const unchangedVersion = index().versionId;
  const invalidPreview = await js(`(() => {
    const from=document.querySelector('[data-item-id="${characters}"]');const to=document.querySelector('[data-item-id="${nested}"]');
    const transfer=new DataTransfer();from.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));
    document.querySelector('.custom-notes-root').dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer}));
    const r=to.getBoundingClientRect();to.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer,clientY:r.top+r.height/2}));
    const preview=to.dataset.drop;to.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer}));return preview;
  })()`);
  assert.equal(invalidPreview, undefined); assert.equal(index().versionId, unchangedVersion);
  const preview = await js(`(() => {
    const from=document.querySelector('[data-item-id="${noteId}"]');const to=document.querySelector('[data-item-id="${characters}"]');
    const transfer=new DataTransfer();from.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));
    const r=to.getBoundingClientRect();to.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:transfer,clientY:r.top+r.height/2}));
    const preview=to.dataset.drop;to.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer,clientY:r.top+r.height/2}));return preview;
  })()`);
  assert.equal(preview, 'inside'); await until(() => index().notes[0].parentId === characters);
  console.log('PASS: case-sensitive labels, assignment and drag destination preview persist');

  await js(`library.moreFeatures=false; renderNotesNav()`);
  await until(() => js(`document.querySelector('.custom-notes-tools').hidden`));
  assert.ok(await js(`!!document.querySelector('[data-item-id="${noteId}"]')`));
  await click(`[data-item-id="${noteId}"]`);
  await until(() => js(`document.getElementById('aux-editor').contentEditable==='true'`));
  assert.equal(await js(`document.getElementById('aux-editor').contentEditable`), 'true');
  await js(`library.moreFeatures=true;renderNotesNav()`);
  await until(() => js(`!document.querySelector('.custom-notes-tools').hidden`));
  await click(`[data-item-id="${characters}"] [data-action="organize"]`);
  await click('[data-action="delete-group"]'); await until(() => index().groups.length === 1);
  assert.equal(index().groups[0].parentId, null); assert.equal(index().notes[0].parentId, null);
  assert.match(fs.readFileSync(bodyPath, 'utf8'), /Writing to preserve/);
  await click('[data-action="undo"]'); await until(() => index().groups.length === 2);
  assert.equal(index().notes[0].parentId, characters);
  console.log('PASS: simple-mode accessibility, nonrecursive group deletion and undo');
  await click(`[data-item-id="${noteId}"] [data-action="organize"]`);
  await click('[data-action="trash-note"]'); await until(() => index().notes.length === 0);
  await click('[data-action="undo"]'); await until(() => index().notes.length === 1);
  assert.match(fs.readFileSync(bodyPath, 'utf8'), /Writing to preserve/);
  console.log('PASS: note trash and session undo restore writing');
  await click(`[data-item-id="${noteId}"]`);
  await until(() => js(`document.getElementById('aux-editor').contentEditable==='true' && document.getElementById('aux-editor').dataset.customNoteId==='${noteId}'`));
  await click(`[data-item-id="${noteId}"] [data-action="organize"]`);
  let releaseTrash; let enteredTrash;
  const entered = new Promise((resolve) => { enteredTrash = resolve; });
  heldTrash = { entered: enteredTrash, promise: new Promise((resolve) => { releaseTrash = resolve; }) };
  await click('[data-action="trash-note"]'); await entered;
  await js(`(() => {const ed=document.getElementById('aux-editor');ed.focus();const r=document.createRange();r.selectNodeContents(ed);r.collapse(false);const s=getSelection();s.removeAllRanges();s.addRange(r);})()`);
  await win.webContents.insertText(' New writing during deletion'); releaseTrash();
  await until(() => js(`document.getElementById('aux-editor').dataset.customNoteId!=='${noteId}' && document.getElementById('aux-editor').textContent.includes('New writing during deletion')`));
  const recovered = index().notes.find((n) => n.id !== noteId); assert.ok(recovered);
  assert.match(fs.readFileSync(path.join(library, book.id, 'notes', recovered.id + '.html'), 'utf8'), /New writing during deletion/);
  console.log('PASS: writing during a pending deletion stays visible in an active recovered note');
  await until(() => js(`document.getElementById('custom-notes-nav').getAttribute('aria-busy')!=='true'`));
  if (process.env.NEO_SHOT) {
    await js(`document.getElementById('nav-pane').classList.add('open');document.querySelector('#custom-notes-nav [role=treeitem]')?.focus()`);
    await new Promise((resolve) => setTimeout(resolve, 180));
    fs.writeFileSync(process.env.NEO_SHOT, (await win.webContents.capturePage()).toPNG());
    const selectedId = await js(`document.querySelector('[data-item-id][aria-selected="true"]').dataset.itemId`);
    await click(`[data-item-id="${selectedId}"] [data-action="organize"]`);
    fs.writeFileSync(process.env.NEO_SHOT.replace(/\.png$/, '-form.png'), (await win.webContents.capturePage()).toPNG());
    await js(`document.body.classList.add('light')`);
    fs.writeFileSync(process.env.NEO_SHOT.replace(/\.png$/, '-light.png'), (await win.webContents.capturePage()).toPNG());

  }
}
run().then(() => { clearTimeout(deadline); fs.rmSync(root, { recursive: true, force: true }); app.exit(0); }, (err) => { clearTimeout(deadline); console.error(err.stack || err); console.error('Fixture retained:', root); app.exit(1); });
