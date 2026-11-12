'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const roots = new Map();
const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * Create a book-local adapter. availability must use the app's cloud guards:
 * (absolutePath) => Promise<'local'|'unavailable'>. There is no unsafe default.
 * io is an injectable fs.promises adapter for native fault tests.
 * This module is not registered with Electron until the runtime integration task.
 */
function createDesktopNotesAdapter(root, { availability, io = fs.promises } = {}) {
  if (typeof availability !== 'function') throw fail('EINVAL', 'A cloud availability guard is required');
  const base = path.resolve(root);
  const checked = async (relative) => {
    if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes('\0') || relative.split('/').some((p) => !p || p === '.' || p === '..') || path.isAbsolute(relative)) throw fail('EINVAL', 'Unsafe notes path');
    const full = path.join(base, relative);
    // Check every ancestor, not just the final component. No symlink traversal.
    const parts = full.slice(path.parse(full).root.length).split(path.sep);
    let current = path.parse(full).root;
    for (const part of parts) {
      current = path.join(current, part);
      try {
        const stat = await io.lstat(current);
        if (stat.isSymbolicLink()) throw fail('EINVAL', 'Symbolic links are not allowed');
        if (current !== full && !stat.isDirectory()) throw fail('EINVAL', 'Non-directory ancestor');
        if (current === full && !stat.isFile() && !stat.isDirectory()) throw fail('EINVAL', 'Not a regular file or directory');
      } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
    return full;
  };
  const local = async (file) => {
    const state = await availability(file);
    if (state !== 'local') throw fail('ECLOUD', 'File unavailable: ' + file);
  };
  const syncDir = async (dir) => {
    if (process.platform === 'win32') return;
    const handle = await io.open(dir, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  };
  const serialize = (fn) => {
    const next = (roots.get(base) || Promise.resolve()).catch(() => {}).then(fn);
    roots.set(base, next);
    next.finally(() => { if (roots.get(base) === next) roots.delete(base); }).catch(() => {});
    return next;
  };
  return {
    async read(relative) {
      const file = await checked(relative);
      try {
        await local(file);
        return { status: 'ok', text: await io.readFile(file, 'utf8') };
      } catch (err) {
        if (err.code === 'ENOENT') return { status: 'missing' };
        if (err.code === 'ECLOUD') return { status: 'unavailable' };
        throw err;
      }
    },
    writeDurable(relative, text) {
      return serialize(async () => {
        if (typeof text !== 'string') throw fail('EINVAL', 'Expected text');
        const file = await checked(relative);
        await local(file);
        const dir = path.dirname(file);
        await io.mkdir(dir, { recursive: true });
        await checked(relative);
        const tmp = file + '.' + randomUUID() + '.tmp';
        let handle;
        try {
          handle = await io.open(tmp, 'wx', 0o600);
          const bytes = Buffer.from(text);
          for (let offset = 0; offset < bytes.length;) {
            const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
            if (!(bytesWritten > 0)) throw fail('EIO', 'Short write');
            offset += bytesWritten;
          }
          await handle.sync();
          await handle.close();
          handle = null;
          await checked(relative);
          await local(file);
          await io.rename(tmp, file);
          await syncDir(dir);
          // Persist newly created directory entries up through the notes root.
          let ancestor = path.dirname(dir);
          while (ancestor.startsWith(base + path.sep) || ancestor === base) {
            await syncDir(ancestor);
            ancestor = path.dirname(ancestor);
          }
          await syncDir(path.dirname(base));
        } finally {
          if (handle) await handle.close();
          await io.unlink(tmp).catch(() => {}); // An abandoned unique temp is never a canonical file.
        }
      });
    },
    remove(relative) {
      return serialize(async () => {
        const file = await checked(relative);
        await local(file);
        try { await io.unlink(file); await syncDir(path.dirname(file)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      });
    },
    async list(prefix = '') {
      await checked('index.json');
      const result = [];
      if (prefix) await checked(prefix);
      await local(base);
      let ancestor = base;
      for (const part of prefix.split('/').filter(Boolean)) { ancestor = path.join(ancestor, part); await local(ancestor); }
      const pending = [prefix];
      while (pending.length) {
        const relative = pending.pop();
        const dir = relative ? await checked(relative) : base;
        await local(dir);
        let entries;
        try { entries = await io.readdir(dir, { withFileTypes: true }); } catch (err) { if (err.code === 'ENOENT') continue; throw err; }
        for (const entry of entries) {
          const name = relative ? relative + '/' + entry.name : entry.name;
          if (entry.name.endsWith('.icloud')) throw fail('ECLOUD', 'Notes listing is incomplete');
          if (entry.isSymbolicLink()) throw fail('EINVAL', 'Symbolic link in notes');
          if (entry.isDirectory()) pending.push(name);
          else if (entry.isFile() && !entry.name.endsWith('.tmp')) result.push(name);
          else if (!entry.isFile()) throw fail('EINVAL', 'Nonregular notes file');
        }
      }
      return result.sort();
    }
  };
}
module.exports = { createDesktopNotesAdapter };
