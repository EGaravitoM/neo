'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { createNotesRuntime } = require('../planet-notes-runtime');
function fixture() {
  const handlers = new Map(); const ipcMain = new EventEmitter();
  ipcMain.handle = (name, handler) => handlers.set(name, handler);
  const app = new EventEmitter(); let quits = 0; app.quit = () => { quits++; };
  const messages = []; const contents = { mainFrame: {}, isDestroyed: () => false, send: (...args) => messages.push(args) };
  const win = new EventEmitter(); let destroyed = false;
  win.webContents = contents; win.isDestroyed = () => destroyed;
  win.close = () => {
    let prevented = false; win.emit('close', { preventDefault() { prevented = true; } });
    if (!prevented) { destroyed = true; win.emit('closed'); }
  };
  const runtime = createNotesRuntime({ app, ipcMain, enabled: true, libraryRoot: () => { throw new Error('No storage should open in this test'); }, libName: (name) => name, availability: async () => 'local', logError() {} });
  runtime.attach(win);
  const event = { sender: contents, senderFrame: contents.mainFrame };
  return { runtime, handlers, ipcMain, app, win, messages, event, quits: () => quits };
}

test('unknown windows and child frames cannot invoke notes operations', async () => {
  const d = fixture();
  for (const event of [{ sender: {}, senderFrame: {} }, { ...d.event, senderFrame: {} }]) {
    const response = await d.handlers.get('notes:create')(event, 'book-one', { operationId: 'o-create', title: 'Blocked' });
    assert.equal(response.ok, false); assert.equal(response.error.code, 'EACCES');
  }
});

test('flush-only handshake keeps the window open and returns an explicit resume action', async () => {
  const d = fixture(); const flushing = d.runtime.flushAll();
  const [channel, token] = d.messages.at(-1); assert.equal(channel, 'notes:prepareClose');
  d.ipcMain.emit('notes:closeResult', d.event, { token, status: 'ready' });
  const resume = await flushing;
  assert.equal(d.win.isDestroyed(), false);
  resume(); assert.equal(d.messages.at(-1)[0], 'notes:resume');
});

test('a failed lifecycle flush rejects and resumes rather than allowing destructive work', async () => {
  const d = fixture(); const flushing = d.runtime.flushAll();
  const token = d.messages.at(-1)[1];
  d.ipcMain.emit('notes:closeResult', d.event, { token, status: 'failed' });
  await assert.rejects(flushing, { code: 'EUNSAVED' });
  assert.equal(d.win.isDestroyed(), false); assert.equal(d.messages.at(-1)[0], 'notes:resume');
});

test('a forged native-close reply does not bypass the current token', async () => {
  const d = fixture(); d.win.close(); const token = d.messages.at(-1)[1];
  d.ipcMain.emit('notes:closeResult', d.event, { token: 'wrong', status: 'ready' });
  assert.equal(d.win.isDestroyed(), false);
  d.ipcMain.emit('notes:closeResult', { ...d.event, senderFrame: {} }, { token, status: 'ready' });
  assert.equal(d.win.isDestroyed(), false);
  d.ipcMain.emit('notes:closeResult', d.event, { token, status: 'ready' });
  assert.equal(d.win.isDestroyed(), true);
});

test('an app quit request is retried only after the matching successful flush', () => {
  const d = fixture(); d.app.emit('before-quit'); d.win.close();
  assert.equal(d.quits(), 0);
  d.ipcMain.emit('notes:closeResult', d.event, { token: d.messages.at(-1)[1], status: 'ready' });
  assert.equal(d.quits(), 1);
});
