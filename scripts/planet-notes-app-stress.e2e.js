'use strict';
// Real desktop app, IPC, storage and editor; every byte belongs to a temp fixture.
const { app,BrowserWindow }=require('electron');const fs=require('node:fs');const path=require('node:path');const os=require('node:os');const assert=require('node:assert/strict');const {performance}=require('node:perf_hooks');
const {createStressFixture,profiles}=require('./helpers/planet-notes-stress-fixtures');
const { assertNoRendererErrors } = require('./helpers/planet-notes-ui-verification');
const arg=name=>process.argv[process.argv.indexOf(name)+1];const definition=[...profiles.full,...profiles.smoke].find(c=>c.id===arg('--case'));if(!definition)throw new Error('Unknown app stress case');
const output=process.argv.includes('--out')?path.resolve(arg('--out')):null;const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'neo-app-stress-')));
app.setPath('documents',root);app.setPath('userData',path.join(root,'profile'));fs.mkdirSync(path.join(root,'profile'));
process.env.NEO_PLANET_NOTES_TEST='1';process.env.NEO_PLANET_NOTES_TEST_ROOT=root;
const library=path.join(root,'NEO Library');const bookId='book-stress';const folder=path.join(library,bookId);fs.mkdirSync(path.join(folder,'notes'),{recursive:true});fs.mkdirSync(path.join(folder,'chapters'));
const fixture=createStressFixture({...definition,seed:7301});fs.writeFileSync(path.join(folder,'notes/index.json'),JSON.stringify(fixture.index));
for(const [id,body] of Object.entries(fixture.bodies))fs.writeFileSync(path.join(folder,'notes',id+'.html'),body.html);
fs.writeFileSync(path.join(folder,'book.json'),JSON.stringify({id:bookId,title:'Synthetic stress book',author:'Test',chapterOrder:['ch-one'],chapterTitles:{'ch-one':'Chapter'},chapterNotes:{},wordCount:0}));
fs.writeFileSync(path.join(folder,'chapters/ch-one.html'),'<p>Synthetic manuscript</p>');fs.writeFileSync(path.join(folder,'notes.html'),'<p>Legacy reference</p>');
fs.writeFileSync(path.join(library,'library.json'),JSON.stringify({firstRunDone:true,moreFeatures:true,authorName:'',penNames:[],shelves:[{id:'shelf-one',name:'Tests',bookIds:[bookId]}]}));
const loadFile=BrowserWindow.prototype.loadFile;BrowserWindow.prototype.loadFile=function(file,options){return loadFile.call(this,path.resolve(__dirname,'..',file),options);};
let win;const metrics={};const errors=[];let phase='startup';
const finish=(status,error)=>{const evidence={id:definition.id,status,scope:'Actual desktop app/IPC/storage with temporary files',fixture:definition,metrics,error,phase,consoleErrors:errors,fixtureDirectory:status==='passed'?undefined:root};if(output){fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});}console.log(JSON.stringify(evidence));if(status==='passed'){win?.destroy();fs.rmSync(root,{recursive:true,force:true});}app.exit(status==='passed'?0:1);};
const deadline=setTimeout(()=>finish('failed','App stress timed out after 120s'),120000);
require('../main');
async function run(){
 await app.whenReady();const js=source=>win.webContents.executeJavaScript(source,true);const until=async(fn,ms=110000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await fn())return;await new Promise(resolve=>setTimeout(resolve,25));}throw new Error('Timed out in '+phase);};
 await until(()=>{win=BrowserWindow.getAllWindows()[0];return !!win;});win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});await until(()=>js('typeof library!=="undefined"&&!!library').catch(()=>false));
 phase='open book';let at=performance.now();await js(`document.getElementById('firstrun').hidden=true;openBook('${bookId}')`);await js(`switchTab('notes');document.getElementById('nav-pane').classList.add('open')`);await until(()=>js(`!!document.querySelector('#custom-notes-nav [role="treeitem"]')`));metrics.bookOpenMs=performance.now()-at;
 phase='open leaf';at=performance.now();await js(`openCustomNote('${fixture.index.notes.at(-1).id}')`);await until(()=>js(`document.getElementById('aux-editor').contentEditable==='true'`));metrics.leafOpenMs=performance.now()-at;
 phase='search hydration';at=performance.now();await js(`document.querySelector('[data-explorer-action="search"]').click()`);await until(()=>js(`!!document.querySelector('[data-notes-search="query"]')`));
 await js(`(()=>{const input=document.querySelector('[data-notes-search="query"]');input.value='${fixture.bodies[fixture.index.notes[0].id].marker}';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await until(()=>js(`document.querySelectorAll('.notes-search-result').length===1`));metrics.firstResultMs=performance.now()-at;
 await js('notesExplorer.settled()');metrics.searchLoadMs=performance.now()-at;
 assert.equal(await js(`document.querySelector('.notes-explorer-status').textContent.includes('incomplete')`),false);
 metrics.query=[];for(let i=0;i<5;i++){at=performance.now();await js(`document.querySelector('[data-notes-search="query"]').dispatchEvent(new Event('input',{bubbles:true}))`);metrics.query.push(performance.now()-at);}
 // Explicit fault injection proves a real renderer console failure cannot pass.
 if(process.argv.includes('--inject-renderer-error')){await js(`console.error('Injected renderer stress failure')`);await until(()=>errors.includes('Injected renderer stress failure'),5000);}
 metrics.domNodes=await js('document.querySelectorAll("*").length');assertNoRendererErrors(errors);phase='completed';clearTimeout(deadline);finish('passed');
}
run().catch(error=>{clearTimeout(deadline);finish('failed',error.stack);});
