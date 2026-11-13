'use strict';
// Real Electron, temporary library/profile. Exercises Notes controls and native
// keyboard input; data assertions inspect the actual persisted index and bodies.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'neo-notes-explorer-')));
app.setPath('documents', root); app.setPath('userData', path.join(root, 'profile')); fs.mkdirSync(path.join(root, 'profile'));
process.env.NEO_PLANET_NOTES_TEST = '1'; process.env.NEO_PLANET_NOTES_TEST_ROOT = root;
const library = path.join(root, 'NEO Library'); fs.mkdirSync(library);
fs.writeFileSync(path.join(library, 'library.json'), JSON.stringify({ firstRunDone: true, moreFeatures: true, authorName: '', penNames: [], shelves: [{ id: 'shelf-one', name: 'Tests', bookIds: [] }] }));
const loadFile = BrowserWindow.prototype.loadFile;
BrowserWindow.prototype.loadFile = function (file, options) { return loadFile.call(this, path.resolve(__dirname, '..', file), options); };
require('../main');
const tick = () => new Promise((resolve) => setTimeout(resolve, 30));
async function until(fn) { const end = Date.now() + 15000; while (Date.now() < end) { if (await fn()) return; await tick(); } throw new Error('Explorer UI condition timed out'); }
const deadline = setTimeout(() => { console.error('Explorer timed out:', root); app.exit(1); }, 90000);
async function run() {
  await app.whenReady(); let win;
  await until(() => { win = BrowserWindow.getAllWindows()[0]; return !!win; });
  const js = (source) => win.webContents.executeJavaScript(source, true).catch((err) => { throw new Error(source + '\n' + err.message); });
  win.webContents.on('console-message', (event) => { if (event.level === 'error') console.error(event.message); });
  await until(() => js('typeof library !== "undefined" && !!library').catch(() => false));
  const book = await js('neo.createBook({title:"Explorer fixture",author:"Test"})');
  await js(`document.getElementById('firstrun').hidden=true; openBook(${JSON.stringify(book.id)})`);
  await js(`switchTab('notes'); document.getElementById('nav-pane').classList.add('open')`);
  await until(() => js(`!!document.querySelector('[data-explorer-action="search"]')`));
  const click = async (action) => {
    await until(() => js(`document.getElementById('notes-explorer').getAttribute('aria-busy')!=='true' && !!document.querySelector('[data-explorer-action="${action}"]')`));
    await js(`document.querySelector('[data-explorer-action="${action}"]').click()`);
  };
  const query = async (value) => {
    await until(() => js(`!!document.querySelector('[data-notes-search="query"]')`));
    await js(`(() => {const el=document.querySelector('[data-notes-search="query"]');el.focus();el.select();})()`);
    await win.webContents.insertText(value);
  };
  const note = await js(`neo.notesCreate(${JSON.stringify(book.id)},{operationId:'o-fixture',title:'Mara'})`);
  assert.equal(note.status,'saved');
  await js(`(async()=>{const r=await neo.notesRead(${JSON.stringify(book.id)},'${note.noteId}');return neo.notesSave(${JSON.stringify(book.id)},'${note.noteId}',{operationId:'o-write',html:'<p>Secret orchard</p>',expectedBodyToken:r.bodyToken,writingDay:'2026-11-11'});})()`);
  await js(`openCustomNote('${note.noteId}')`);
  await until(() => js(`document.getElementById('aux-editor').dataset.customNoteId==='${note.noteId}'`));
  await click('search'); await js('notesExplorer.settled()'); await query('orchard');
  await until(() => js(`document.querySelectorAll('.notes-search-result').length===1`));
  await click('open-result');
  await until(() => js(`CSS.highlights.has('neo-notes-search')`));
  const bodyPath=path.join(library,book.id,'notes',note.noteId+'.html');
  assert.equal(fs.readFileSync(bodyPath,'utf8'),'<p>Secret orchard</p>');
  await js(`document.getElementById('aux-editor').focus()`); await win.webContents.insertText(' lantern');
  await query('lantern');
  assert.equal(await js(`document.querySelectorAll('.notes-search-result').length`),1);
  await js(`document.getElementById('aux-editor').focus(); notesExplorer.refresh()`);
  assert.equal(await js(`document.activeElement.id`),'aux-editor');
  await click('close');
  assert.equal(await js(`CSS.highlights.has('neo-notes-search')`),false);
  await js('customNotesController.flush()');
  console.log('PASS: native query/input, live writing, screen-only highlights, background focus and closing search');

  fs.writeFileSync(path.join(library,book.id,'notes.html'),'<p>Legacy book reference</p>');
  await js('createChapterAt(0)');
  await until(()=>JSON.parse(fs.readFileSync(path.join(library,book.id,'book.json'),'utf8')).chapterOrder.length===1);
  const metadata=JSON.parse(fs.readFileSync(path.join(library,book.id,'book.json'),'utf8'));
  fs.writeFileSync(path.join(library,book.id,'notes-'+metadata.chapterOrder[0]+'.html'),'<p>Legacy chapter reference</p>');
  await click('search'); await js('notesExplorer.settled()'); await query('legacy reference');
  await until(()=>js(`document.querySelectorAll('.notes-search-result').length===2`));
  await click('open-result');
  await until(()=>js(`document.getElementById('aux-editor').dataset.kind==='notes' && document.getElementById('aux-editor').textContent.includes('Legacy book')`));
  await click('close');
  assert.equal(await js(`document.getElementById('aux-editor').dataset.kind`),'notes');
  await js(`openCustomNote('${note.noteId}')`);
  console.log('PASS: existing book/chapter notes participate in unified search and keep familiar entry points');
  await click('history'); await js('notesExplorer.settled()');
  // More than one daily revision may exist when a fixed fixture date differs
  // from today's writing day. Select the intended source, not a random ID order.
  const revisionPosition=await js(`(async()=>{const list=await neo.notesRecoveryList('${book.id}',{kind:'revisions',noteId:'${note.noteId}'});return list.entries.findIndex(entry=>entry.html==='<p><br></p>');})()`);
  assert.ok(revisionPosition>=0);
  await js(`document.querySelectorAll('.notes-recovery-list [data-explorer-action="preview"]')[${revisionPosition}].click()`);
  await until(() => js(`!!document.getElementById('custom-notes-preview')`));
  assert.equal(await js(`document.getElementById('aux-editor').hidden`),true);
  assert.equal(await js(`document.getElementById('custom-notes-preview').isContentEditable`),false);
  await click('restore-new');
  await until(() => js(`document.getElementById('notes-explorer').getAttribute('aria-busy')==='false'`));
  const indexPath=path.join(library,book.id,'notes','index.json');
  const index=()=>JSON.parse(fs.readFileSync(indexPath,'utf8'));
  await until(()=>index().notes.length===2);
  const copy=index().notes.find(n=>n.id!==note.noteId);
  assert.match(fs.readFileSync(bodyPath,'utf8'),/lantern/);
  assert.equal(fs.readFileSync(path.join(library,book.id,'notes',copy.id+'.html'),'utf8'),'<p><br></p>');
  console.log('PASS: read-only revision preview and restore as independent note preserve current writing');
  await click('close');
  const trash = await js(`neo.notesOrganize(${JSON.stringify(book.id)},{operationId:'o-trash',action:'trashNote',noteId:'${note.noteId}'})`);
  assert.equal(trash.status,'saved');
  await click('trash'); await js('notesExplorer.settled()'); await click('preview');
  await until(() => js(`document.getElementById('custom-notes-preview')?.textContent.includes('lantern')`));
  await click('restore'); await until(()=>index().notes.some(n=>n.id===note.noteId));
  await until(() => js(`document.getElementById('notes-explorer').getAttribute('aria-busy')==='false'`));
  assert.match(fs.readFileSync(bodyPath,'utf8'),/lantern/);
  await click('close');
  await js(`library.moreFeatures=false;renderNotesNav()`);
  await until(() => js(`!!document.querySelector('[data-explorer-action="search"]')`));
  await click('search'); await js('notesExplorer.settled()'); await query('lantern');
  await until(() => js(`document.querySelectorAll('.notes-search-result').length===1`));
  console.log('PASS: trash restores writing and recovery/search remain accessible with More Features off');
  await click('close');
  const groupA=await js(`neo.notesOrganize(${JSON.stringify(book.id)},{operationId:'o-group-a',action:'createGroup',title:'People',parentId:null})`);
  const groupB=await js(`neo.notesOrganize(${JSON.stringify(book.id)},{operationId:'o-group-b',action:'createGroup',title:'Places',parentId:null})`);
  const base=index();
  await js(`neo.notesOrganize(${JSON.stringify(book.id)},{operationId:'o-local-move',action:'move',itemId:'${note.noteId}',parentId:'${groupA.itemId}'})`);
  const incoming=require('../planet-notes-organization').applyAction(base,{operationId:'o-remote',action:'move',itemId:note.noteId,parentId:groupB.itemId}).index;
  incoming.versionId='v-remote';incoming.parentVersionIds=[base.versionId];fs.writeFileSync(indexPath,JSON.stringify(incoming));
  await js(`neo.notesLoad(${JSON.stringify(book.id)})`);
  await click('conflicts');await js('notesExplorer.settled()'); await click('preview');
  await until(()=>js(`!!document.querySelector('[data-explorer-action="apply-values"]')`));
  assert.equal(await js(`document.querySelector('[data-explorer-action="apply-values"]').disabled`),true);
  await js(`(() => {const label=Array.from(document.querySelectorAll('.notes-recovery-actions label')).find(n=>n.textContent.startsWith('Mara · '+NeoI18n.t('Group')));if(!label)throw new Error('Missing move choice');const select=label.querySelector('select');select.value='incoming';select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await click('apply-values');
  await until(()=>index().notes.find(n=>n.id===note.noteId).parentId===groupB.itemId);
  assert.match(fs.readFileSync(bodyPath,'utf8'),/lantern/);
  console.log('PASS: metadata-conflict controls apply recorded moves without changing note bodies');
  // Controlled bridge responses reproduce cloud and first-save races while
  // exercising the real explorer DOM, event handlers and search implementation.
  await js(`(async () => {
    const fixtureBook='book-regressions'; const chapter={bookId:fixtureBook,kind:'chapter',chapterId:'ch-first'};
    let live=[]; let metadataStatus='ok'; let orphanDiscovery; let throwCloud=false; let closePreviewTask=Promise.resolve();let noteReadTask=null;
    const metadata={schemaVersion:1,versionId:'v-fixture',parentVersionIds:[],root:{sortMode:'alphabetical',childOrder:['n-fixture']},groups:[],notes:[{id:'n-fixture',title:'Mara',parentId:null,labelIds:['l-old'],createdAt:'2026-11-11T10:00:00.000Z'}],labels:[{id:'l-old',name:'plot'}],tombstones:[]};
    const errors=[];const api={
      notesCapabilities:async()=>({enabled:true}),
      notesLoad:async()=>{if(throwCloud)throw Object.assign(new Error('Cloud unavailable'),{code:'ECLOUD'});return metadataStatus==='ok'?{status:'ok',index:structuredClone(metadata),orphanDiscovery}:{status:metadataStatus};},
      notesRead:async()=>noteReadTask||({status:'ok',html:'<p>Orchard</p>'}),
      notesReadLegacy:async(_book,{page})=>page==='book'?{status:'ok',html:'<p>Local legacy reference</p>'}:{status:'missing'}
    };
    const host=document.createElement('aside');document.body.append(host);
    const explorer=NeoPlanetNotesExplorer.createNotesExplorer({api,t:NeoI18n.t,locale:()=> 'en',currentBook:()=>fixtureBook,
      catalogLegacy:()=>[{document:{kind:'book'},title:'The Book'},{document:{kind:'chapter',chapterId:'ch-first'},title:'First chapter'}],
      liveDocuments:()=>live,currentDocument:()=>null,editorRoot:()=>null,openDocument:async()=>{},preview:async()=>{},closePreview:()=>closePreviewTask,flush:async()=>{},dataChanged:async()=>{},onMode:()=>{},onError:error=>errors.push(error)});
    await explorer.mount(host,fixtureBook);
    const action=async(name)=>{explorer.root.querySelector('[data-explorer-action="'+name+'"]').click();await new Promise(resolve=>setTimeout(resolve,0));await explorer.settled();};
    const query=(value)=>{const input=explorer.root.querySelector('[data-notes-search="query"]');input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));};
    const count=()=>explorer.root.querySelectorAll('.notes-search-result').length;
    const check=(value,message)=>{if(!value)throw new Error(message);};
    // A pending preview close belongs to the transition. settled must wait,
    // and closing search before it finishes must cancel its late continuation.
    let releasePreview;closePreviewTask=new Promise(resolve=>{releasePreview=resolve;});
    explorer.root.querySelector('[data-explorer-action="search"]').click();await Promise.resolve();await Promise.resolve();
    let premature=false;const opening=explorer.settled().then(()=>{premature=true;});
    await Promise.resolve();await Promise.resolve();check(!premature,'settled resolved before preview closure');
    explorer.root.querySelector('[data-explorer-action="close"]').click();await Promise.resolve();await Promise.resolve();
    releasePreview();await opening;await explorer.settled();closePreviewTask=Promise.resolve();
    check(!explorer.isOpen()&&!explorer.root.querySelector('[data-notes-search="query"]'),'Abandoned search restarted after closing');
    let finishRead;noteReadTask=new Promise(resolve=>{finishRead=resolve;});
    explorer.root.querySelector('[data-explorer-action="search"]').click();await new Promise(resolve=>setTimeout(resolve,30));
    check(![...explorer.root.querySelectorAll('.notes-search-result .n-label')].some(label=>label.textContent==='Mara'),'Empty All view eagerly rendered pending placeholders');
    check(explorer.root.querySelector('.notes-explorer-status').textContent.includes('incomplete'),'Pending note coverage was hidden');
    live=[{document:{bookId:fixtureBook,kind:'custom',noteId:'n-fixture'},html:'<p>Immediate live words</p>'}];explorer.edited();
    check([...explorer.root.querySelectorAll('.notes-search-result .n-label')].some(label=>label.textContent==='Mara'),'Live writing should appear before the body read settles');
    finishRead({status:'ok',html:'<p>Orchard</p>'});await explorer.settled();noteReadTask=null;live=[];await action('close');
    await action('search');query('dragon');check(count()===0,'Unwritten chapter should not invent a saved match');
    live=[{document:chapter,html:'<p>Unsaved dragon writing</p>'}];explorer.edited();
    check(count()===1,'Missing-file chapter must match live writing after hydration');
    check(explorer.root.querySelector('.n-label').textContent==='First chapter','Live chapter keeps its catalog title');
    live=[];explorer.edited();check(count()===0,'Live overlay must not mutate saved search records');
    query('orchard');const filter=explorer.root.querySelector('[data-label-id="l-old"]');filter.click();check(count()===1,'Assigned label filter should match');
    await action('close');metadata.labels=[];metadata.notes[0].labelIds=[];
    await action('search');check(count()===1,'Deleted label must not leave an invisible filter');
    check(!explorer.root.querySelector('[data-label-id="l-old"]'),'Deleted label checkbox removed');
    await action('close');metadata.labels=[{id:'l-old',name:'plot'},{id:'l-new',name:'Plot'}];metadata.notes[0].labelIds=['l-old'];
    await action('search');explorer.root.querySelector('[data-label-id="l-old"]').click();
    await action('close');metadata.labels=[{id:'l-new',name:'Plot'}];metadata.notes[0].labelIds=['l-new'];
    await action('search');check(count()===1,'Merged label must not retain obsolete ID');
    await action('close');orphanDiscovery='unavailable';await action('search');query('orchard');
    check(count()===1,'Incomplete orphan inventory must not hide indexed notes');
    check(explorer.root.querySelector('.notes-explorer-status').textContent.includes('incomplete'),'Incomplete orphan discovery must be disclosed');
    orphanDiscovery=undefined;
    for(const state of ['unavailable','invalid','throw']){
      await action('close');metadataStatus=state;throwCloud=state==='throw';
      await action('search');query('local legacy');check(count()===1,'Local legacy search blocked by '+state+' metadata');
      check(explorer.root.querySelector('.notes-explorer-status').textContent.includes('incomplete'),'Unknown custom coverage must be indicated');
    }
    await action('close');metadataStatus='ok';throwCloud=false;await action('search');query('local legacy');
    check(!explorer.root.querySelector('.notes-explorer-status').textContent.includes('incomplete'),'Coverage recovers after cloud metadata becomes local');
    check(errors.length===1 && errors[0].code==='ECLOUD','Thrown cloud error stays diagnosable');
    await action('close');explorer.detach();metadataStatus='unavailable';await explorer.mount(host,fixtureBook);
    await action('search');query('local legacy');check(count()===1,'Initial cloud failure must not require a cached index');
    check(explorer.root.querySelector('.notes-explorer-status').textContent.includes('incomplete'),'Initial unknown collection keeps coverage incomplete');
    await action('close');metadataStatus='ok';
    for(let i=0;i<5;i++){const extra={...metadata.notes[0],id:'n-extra'+i,title:'Extra '+i};metadata.notes.push(extra);metadata.root.childOrder.push(extra.id);}
    await action('search');query('');
    const retained=[...explorer.root.querySelectorAll('.notes-search-result')].find(row=>row.querySelector('.n-label').textContent==='Mara');
    check(count()>2&&!!retained,'Bulk-result fixture is incomplete');retained.focus();query('Mara');
    check(count()===1&&explorer.root.querySelector('.notes-search-result')===retained,'Large result reduction replaced retained identity');
    check(document.activeElement===retained,'Bulk result reduction lost keyboard focus');
    query('nothing_matches_here');check(count()===0,'Empty reduction left stale results');
    explorer.detach();host.remove();
  })()`);
  console.log('PASS: unsaved first chapter notes, deleted/merged filter cleanup, partial cloud coverage and retry');
  await click('close'); await js(`openCustomNote('${note.noteId}')`);
  await js(`document.getElementById('aux-editor').focus()`); await win.webContents.insertText(' before desktop copy');
  const originalRead=fs.promises.readFile; let verificationEntered=false; let releaseVerification;
  const blockedVerification=new Promise(resolve=>{releaseVerification=resolve;});
  fs.promises.readFile=async(file,...args)=>{
    const name=String(file);
    if(name.endsWith('/notes/'+note.noteId+'.html') && name.startsWith(library+path.sep) && !name.startsWith(path.join(library,book.id)+path.sep)) { verificationEntered=true; await blockedVerification; }
    return originalRead.call(fs.promises,file,...args);
  };
  const copying=js(`neo.duplicateBook('${book.id}','Desktop verified copy')`);let bookCopy;
  try {
    await until(()=>verificationEntered);
    assert.equal(await js(`document.getElementById('aux-editor').contentEditable`),'false');
    releaseVerification();bookCopy=await copying;
  } finally {releaseVerification();await copying.catch(()=>{});fs.promises.readFile=originalRead;}

  assert.notEqual(bookCopy.id,book.id);
  const sourceBody=fs.readFileSync(bodyPath,'utf8'); assert.match(sourceBody,/before desktop copy/);
  assert.equal(fs.readFileSync(path.join(library,bookCopy.id,'notes',note.noteId+'.html'),'utf8'),sourceBody);
  await until(()=>js(`document.getElementById('aux-editor').contentEditable==='true'`));
  console.log('PASS: desktop duplication flushes pending writing, stays responsive during verification, and resumes afterward');
  clearTimeout(deadline); fs.rmSync(root,{recursive:true,force:true}); app.exit(0);
}
run().catch(err=>{console.error(err.stack);console.error('Fixture retained:',root);clearTimeout(deadline);app.exit(1);});
