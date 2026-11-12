'use strict';
// Actual renderer components and shared CSS with a deterministic bridge fixture.
// Full-app/IPC and native evidence must be collected separately.
const { app, BrowserWindow } = require('electron'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const { pathToFileURL } = require('node:url');
const { createStressFixture, profiles } = require('./helpers/planet-notes-stress-fixtures');
const caseId = process.argv[process.argv.indexOf('--case')+1];
const definition = [...profiles.full,...profiles.smoke].find(c=>c.id===caseId); if(!definition)throw new Error('Unknown UI stress case');
const outAt=process.argv.indexOf('--out');const output=outAt>=0?path.resolve(process.argv[outAt+1]):null;
const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'neo-ui-stress-')));app.setPath('userData',path.join(root,'profile'));
const repository=path.resolve(__dirname,'..');const deadline=setTimeout(()=>{
  const evidence={id:caseId,status:'failed',error:'UI worker timed out after 120s',scope:'Renderer component stress',fixture:definition,fixtureDirectory:root};
  if(output&&!fs.existsSync(output)){fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});}
  console.error('UI worker timed out:',caseId,root);app.exit(1);
},120000);
async function run(){
  const scripts=['scripts/helpers/planet-notes-ui-verification.js','i18n.js','planet-notes.js','planet-notes-html.js','planet-notes-organization.js','planet-notes-search.js','planet-notes-recovery-selection.js','planet-notes-tree.js','planet-notes-explorer.js'];
  const page='<!doctype html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="'+pathToFileURL(path.join(repository,'styles.css')).href+'"></head><body><div id="editor-view" class="notes-tab"><aside id="nav-pane" class="open"><div class="nav-item"><div class="n-row"><span id="reference-font" class="n-label">Existing navigation</span></div></div><div id="notes-nav"></div></aside><div id="aux-editor" contenteditable="true"></div><div id="custom-notes-preview"></div></div>'+scripts.map(file=>'<script src="'+pathToFileURL(path.join(repository,file)).href+'"></script>').join('')+'</body></html>';
  fs.writeFileSync(path.join(root,'index.html'),page);await app.whenReady();
  const win=new BrowserWindow({width:1100,height:850,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false}});const errors=[];
  win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});await win.loadFile(path.join(root,'index.html'));
  const js=source=>win.webContents.executeJavaScript(source,true);const fixture=createStressFixture({...definition,seed:7301});
  await js('window.fixture='+JSON.stringify(fixture));
  const result=await js(`(async()=>{
    const assert=(value,message)=>{if(!value)throw new Error(message);};const t=NeoI18n.t;const host=document.getElementById('notes-nav');const ed=document.getElementById('aux-editor');
    let index=fixture.index;let active=null;let dirtyHtml=null;let unavailable=false;const problems=[];
    const api={notesCapabilities:async()=>({enabled:true}),notesLoad:async()=>{if(!unavailable)return {status:'ok',index};const copy=structuredClone(index);copy.notes.push({...index.notes[0],id:'n-cloud-only',title:'Cloud note',parentId:null,labelIds:[]});copy.root.childOrder.push('n-cloud-only');return {status:'ok',index:copy};},notesOrganizationState:async()=>({canUndo:false}),notesRead:async(_book,id)=>unavailable&&id==='n-cloud-only'?{status:'unavailable'}:{status:'ok',html:fixture.bodies[id].html},notesReadLegacy:async()=>({status:'missing'}),notesOrganize:async(_book,request)=>{index=NeoPlanetNotesOrganization.applyAction(index,request,{locale:'en'}).index;return {status:'saved'};}};
    const open=async id=>{active=id;dirtyHtml=null;ed.innerHTML=fixture.bodies[id].html;};
    const tree=NeoPlanetNotesTree.createNotesTree({api,t,locale:()=> 'en',currentBook:()=> 'book-stress',canManage:()=>true,openNote:open,createNote:async()=>{},flushEditor:async()=>{},removeOpenNote:async()=>{},activeNote:()=>active,titleChanged:()=>{},onError:error=>problems.push(error.message)});
    const start=performance.now();await tree.mount(host,'book-stress');const mountMs=performance.now()-start;
    const initialRows=new Map([...tree.root.querySelectorAll('[role="treeitem"]')].map(row=>[row.dataset.itemId,row]));
    const expandedAt=performance.now();
    const expansionProbe=await NeoPlanetNotesUIVerification.measureInputDuring(ed,async()=>{
    // Revealing a representative note in each parent expands every fixture group
    // without reaching into private tree state. Deep cases reveal the leaf.
    const targets=new Set(index.notes.map(n=>n.parentId));
    for(const parent of targets){const note=index.notes.find(n=>n.parentId===parent);if(note){tree.reveal(note.id);await new Promise(resolve=>setTimeout(resolve,0));}}
    // Wide fixtures can include an empty group; expand it through its real control.
    for(const group of index.groups){const row=tree.root.querySelector('[data-item-id="'+group.id+'"]');if(row?.getAttribute('aria-expanded')==='false')row.click();}
    });
    const expandMs=performance.now()-expandedAt;
    const rows=[...tree.root.querySelectorAll('[role="treeitem"]')];assert(rows.length===index.groups.length+index.notes.length,'Expanded hierarchy omitted material');assert(new Set(rows.map(r=>r.dataset.itemId)).size===rows.length,'Duplicate row identity');for(const [id,row]of initialRows)assert(tree.root.querySelector('[data-item-id="'+id+'"]')===row,'Expansion replaced an unchanged row');
    const leaf=index.notes.at(-1);const leafAt=performance.now();tree.root.querySelector('[data-item-id="'+leaf.id+'"]').click();await Promise.resolve();const leafOpenMs=performance.now()-leafAt;assert(active===leaf.id,'Leaf did not open');const leafRow=tree.root.querySelector('[data-item-id="'+leaf.id+'"]');leafRow.scrollIntoView({block:'nearest',inline:'nearest'});const labelWidth=leafRow.querySelector('.n-label').getBoundingClientRect().width;const shallow=leafRow.cloneNode(true);shallow.style.paddingInlineStart='18px';tree.root.append(shallow);const shallowWidth=shallow.querySelector('.n-label').getBoundingClientRect().width;shallow.remove();assert(labelWidth>=shallowWidth/2,'Deep leaf title is clipped: '+labelWidth+' vs shallow '+shallowWidth);
    const fonts=[];for(const selected of ['Georgia','Arial']){document.documentElement.style.setProperty('--body-font',selected);const ui=getComputedStyle(tree.root.querySelector('.n-label')).fontFamily;const reference=getComputedStyle(document.getElementById('reference-font')).fontFamily;assert(ui===reference,'Navigation font mismatch');assert(getComputedStyle(ed).fontFamily===getComputedStyle(document.getElementById('custom-notes-preview')).fontFamily,'Editor/recovery font mismatch');assert(getComputedStyle(ed).fontFamily.includes(selected),'Selected writing font did not reach the editor');fonts.push({selected,ui,writing:getComputedStyle(ed).fontFamily});}
    const themes=[];for(const theme of ['night','paper','light']){document.body.className=theme;const font=getComputedStyle(tree.root.querySelector('.n-label')).fontFamily;assert(font===getComputedStyle(document.getElementById('reference-font')).fontFamily,'Theme changed UI font');themes.push({theme,font,color:getComputedStyle(tree.root.querySelector('.n-label')).color});}
    const explorer=NeoPlanetNotesExplorer.createNotesExplorer({api,t,locale:()=> 'en',currentBook:()=> 'book-stress',catalogLegacy:()=>[],liveDocuments:()=>dirtyHtml?[{document:{bookId:'book-stress',kind:'custom',noteId:active},html:dirtyHtml}]:[],currentDocument:()=>({kind:'custom',noteId:active}),editorRoot:()=>ed,openDocument:doc=>open(doc.noteId),preview:async()=>{},closePreview:async()=>{},flush:async()=>{},dataChanged:async()=>{},onMode:()=>{},onError:error=>problems.push(error.message)});await explorer.mount(host,'book-stress');
    const searchAt=performance.now();const hydrationProbe=await NeoPlanetNotesUIVerification.measureInputDuring(ed,async()=>{explorer.root.querySelector('[data-explorer-action="search"]').click();await new Promise(resolve=>setTimeout(resolve,0));await explorer.settled();});const searchLoadMs=performance.now()-searchAt;
    const input=explorer.root.querySelector('[data-notes-search="query"]');const queries=[];
    for(let i=0;i<5;i++){const at=performance.now();input.value=fixture.bodies[leaf.id].marker;input.dispatchEvent(new Event('input',{bubbles:true}));queries.push(performance.now()-at);assert(explorer.root.querySelectorAll('.notes-search-result').length===1,'Search result identity/count mismatch');}
    explorer.root.querySelector('[data-explorer-action="open-result"]').click();await new Promise(resolve=>setTimeout(resolve,0));assert(CSS.highlights.has('neo-notes-search'),'Missing screen-only highlights');assert(!ed.innerHTML.includes('<mark'),'Highlight decoration entered HTML');
    dirtyHtml='<p>live_stress_words</p>';ed.innerHTML=dirtyHtml;explorer.edited();input.value='live_stress_words';input.dispatchEvent(new Event('input',{bubbles:true}));assert(explorer.root.querySelectorAll('.notes-search-result').length===1,'Live writing disappeared');
    unavailable=true;ed.focus();await explorer.refresh();assert(document.activeElement===ed,'Background refresh stole typing focus');
    const refreshedInput=explorer.root.querySelector('[data-notes-search="query"]');refreshedInput.value='no_such_words';refreshedInput.dispatchEvent(new Event('input',{bubbles:true}));
    assert(explorer.root.querySelector('.notes-explorer-status').textContent.includes('incomplete'),'Unavailable coverage was hidden');
    // Keyboard navigation operates through actual tree events and preserves focus.
    explorer.root.querySelector('[data-explorer-action="close"]').click();await new Promise(resolve=>setTimeout(resolve,0));
    const first=tree.root.querySelector('[role="treeitem"]');first.focus();first.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}));NeoPlanetNotesUIVerification.assertEndDestination(document.activeElement?.dataset.itemId,[...tree.root.querySelectorAll('[role="treeitem"]')].map(row=>row.dataset.itemId));
    assert(problems.length===0,problems.join('; '));queries.sort((a,b)=>a-b);
    return {inputDelay:{expansion:expansionProbe.inputDelay,hydration:hydrationProbe.inputDelay},mountMs,expandMs,leafOpenMs,leafLabelWidth:labelWidth,searchLoadMs,queryP50Ms:queries[2],queryP95Ms:queries[4],domNodes:document.querySelectorAll('*').length,rows:rows.length,fonts,themes,heapBytes:performance.memory?.usedJSHeapSize||null};
  })()`);
  assert.equal(errors.length,0,errors.join('\n'));const evidence={id:caseId,status:'passed',scope:'Actual renderer components/shared CSS; deterministic bridge, not full IPC/native I/O',fixture:definition,metrics:result};
  if(output){fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});}console.log(JSON.stringify(evidence));
  clearTimeout(deadline);win.destroy();fs.rmSync(root,{recursive:true,force:true});app.exit(0);
}
run().catch(error=>{const evidence={id:caseId,status:'failed',error:error.stack,scope:'Renderer component stress',fixture:definition,fixtureDirectory:root};if(output&&!fs.existsSync(output)){fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(evidence,null,2)+'\n');}console.error(error.stack);clearTimeout(deadline);app.exit(1);});
