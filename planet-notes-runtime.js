'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createNotesService } = require('./planet-notes-service');
const { createNotesStore } = require('./planet-notes-store');
const { createDesktopNotesAdapter } = require('./planet-notes-desktop');
const fail = (code, message) => Object.assign(new Error(message), { code });

/** Registers only domain IPC. A disabled runtime never opens a notes directory. */
function createNotesRuntime({ app, ipcMain, enabled, libraryRoot, libName, availability, logError }) {
  let quitting = false;
  app.on('before-quit', () => { quitting = true; });
  const windows = new Map();
  const service = createNotesService({ enabled, getBook: async (bookId) => {
    libName(bookId);
    const root = await fs.realpath(libraryRoot());
    const dir = path.join(root, bookId);
    if ((await fs.lstat(dir)).isSymbolicLink()) throw fail('EINVAL', 'Linked book directories are not supported');
    const assertValid = async () => {
      const metadata = path.join(dir, 'book.json');
      if (await availability(metadata) !== 'local') throw fail('ECLOUD', 'Book metadata unavailable');
      const book = JSON.parse(await fs.readFile(metadata, 'utf8'));
      // As in main's readBookMeta, a copied/renamed folder owns its identity.
      if (!book || typeof book.id !== 'string' || !Array.isArray(book.chapterOrder)) throw fail('EINVAL', 'Invalid book metadata');
    };
    await assertValid();
    const adapter = createDesktopNotesAdapter(path.join(dir, 'notes'), { availability });
    return { adapter, store: createNotesStore(adapter), assertValid };
  } });
  const trusted = (event) => event && windows.has(event.sender) && event.senderFrame === event.sender.mainFrame;
  for (const [channel, method] of [['capabilities', 'capabilities'], ['load', 'load'], ['read', 'read'], ['create', 'create'], ['rename', 'rename'], ['save', 'save'], ['refresh', 'refresh'], ['copy', 'copy'], ['organize', 'organize'], ['undoOrganization', 'undoOrganization'], ['organizationState', 'organizationState']]) {
    ipcMain.handle('notes:' + channel, async (event, ...args) => {
      try {
        if (!trusted(event)) throw fail('EACCES', 'Untrusted notes request');
        const value = ['organize', 'undoOrganization'].includes(method)
          ? await service[method](args[0], args[1], event.sender.id)
          : method === 'organizationState' ? await service[method](args[0], event.sender.id) : await service[method](...args);
        return { ok: true, value: channel === 'capabilities' ? { ...value, fixtureInspection: !!enabled } : value };
      } catch (err) {
        logError('custom notes ' + channel, err);
        // Electron invoke normally strips custom error codes. Preserve them in a
        // typed envelope without routing typing failures through popup reporters.
        return { ok: false, error: { code: err.code || 'EIO', message: err.message } };
      }
    });
  }
  const prepare = (state, close) => {
    if (state.pending) { state.closeAfter = state.closeAfter || close; return state.promise; }
    if (state.win.webContents.isDestroyed()) return Promise.reject(fail('ECLOSED', 'Notes window disappeared'));
    state.pending = randomUUID(); state.closeAfter = close;
    state.promise = new Promise((resolve, reject) => { state.resolve = resolve; state.reject = reject; });
    state.win.webContents.send('notes:prepareClose', state.pending);
    return state.promise;
  };
  ipcMain.on('notes:closeResult', (event, result) => {
    if (!enabled || !trusted(event) || !result || typeof result.token !== 'string') return;
    const state = windows.get(event.sender);
    if (state.pending !== result.token) return;
    state.pending = null;
    if (result.status === 'ready') {
      state.resolve();
      if (state.closeAfter) { state.allow = true; if (quitting) app.quit(); else state.win.close(); }
    } else {
      quitting = false;
      state.reject(fail('EUNSAVED', 'Notes remain unsaved; window kept open'));
    }
  });
  return {
    async flushAll() {
      if (!enabled) return () => {};
      const states = [...windows.values()];
      const resume = () => { for (const state of states) if (!state.win.isDestroyed()) state.win.webContents.send('notes:resume'); };
      try { await Promise.all(states.map((state) => prepare(state, false))); }
      catch (err) { resume(); throw err; }
      return resume;
    },
    attach(win) {
      const contents = win.webContents;
      const state = { win, pending: null, allow: false, closeAfter: false };
      windows.set(contents, state);
      win.on('closed', () => { windows.delete(contents); if (state.pending) state.reject(fail('ECLOSED', 'Notes window disappeared')); });
      win.on('close', (event) => {
        if (!enabled) return;
        if (state.allow) { state.allow = false; return; }
        event.preventDefault();
        prepare(state, true).catch((err) => logError('custom notes close', err));
      });
    }
  };
}
module.exports = { createNotesRuntime };
