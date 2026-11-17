'use strict';
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const localRequire = createRequire(path.join(root, 'main.js'));
const source = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
function loadMain() {
  const handlers = new Map();
  const electron = {
    app: {
      commandLine: { appendSwitch() {} },
      getPath: () => os.tmpdir(),
      getLocale: () => 'en',
      requestSingleInstanceLock: () => true,
      whenReady: () => ({ then() {} }),
      on() {}
    },
    ipcMain: { on() {}, handle: (name, fn) => handlers.set(name, fn) },
    BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
    Menu: { buildFromTemplate: (items) => items, setApplicationMenu() {} },
    dialog: { showMessageBox: () => Promise.resolve({}) },
    // the backup's own process: the real backup-worker.js, as a Node child
    utilityProcess: {
      fork: (file) => {
        const child = require('node:child_process').fork(file, [], { env: { ...process.env, NEO_TEST_SPARSE_IS_CLOUD: '1' } });
        return {
          on: (ev, fn) => child.on(ev, ev === 'exit' ? (code) => fn(code || 0) : fn),
          postMessage: (m) => child.send(m),
          kill: () => child.kill()
        };
      }
    },
    screen: {}
  };
  const asked = [];
  const context = vm.createContext({
    require: (name) => name === 'electron' ? electron : localRequire(name),
    __dirname: root,
    process: { platform: 'darwin', on() {} },
    console,
    setTimeout,
    clearTimeout,
    libraryRoot: os.tmpdir(),
    asked,
    arrivals: new Map() // file → words iCloud brings down when asked
  });
  vm.runInContext(source, context, { filename: path.join(root, 'main.js') });
  // a placeholder is a file with a size and no blocks; asking for one brings
  // its words down a moment later, if iCloud has them to give
  vm.runInContext(`
    cloudOnlyAmong = (files) => new Set(files.filter((f) => {
      try { const st = fs.statSync(f); return st.size > 0 && st.blocks === 0; } catch { return false; }
    }));
    requestDownload = (files) => {
      for (const f of files) {
        asked.push(f);
        if (arrivals.has(f)) setTimeout(() => fs.writeFileSync(f, arrivals.get(f)), 50);
      }
    };
    CLOUD_WAIT = 600;
  `, context);
  return {
    context,
    asked,
    call: (name, ...args) => handlers.get(name)(null, ...args),
    run: (code) => vm.runInContext(code, context),
    pointAt(dir) {
      context.libraryRoot = dir;
      vm.runInContext('LIBRARY_DIR = libraryRoot; LIBRARY_FILE = require("path").join(libraryRoot, "library.json");', context);
    }
  };
}

module.exports = { loadMain };
