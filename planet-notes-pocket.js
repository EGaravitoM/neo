'use strict';
(function () {
/**
 * Capacitor adapter contract. All supplied locations are library-relative inputs
 * to the bridge-owned resolver; the renderer receives no raw file operations.
 *
 * @typedef {Object} PocketNotesAdapterOptions
 * @property {Object} filesystem Capacitor Filesystem plugin (injectable in tests).
 * @property {function(string): Object} location Maps a library-relative path to
 *   plugin options: {path, directory?}; owns Documents/iCloud URL encoding.
 * @property {function(string): Promise<string>} availability Required cloud guard;
 *   returns 'local' or 'unavailable'. Missing files are identified by the plugin.
 * @property {function(): string} makeTemporaryId Fresh sibling-write identity.
 *
 * @typedef {Object} PocketNotesAdapter
 * @property {function(string): Promise<Object>} read Returns ok/text, missing,
 *   or unavailable; malformed paths reject EINVAL before accessing the plugin.
 * @property {function(string, string): Promise<void>} writeDurable Writes and
 *   verifies a unique sibling, rechecks availability, renames and verifies the
 *   destination. Failed rename must never fall back to an in-place write.
 * @property {function(string): Promise<void>} remove Removes only the checked
 *   book-local file, respecting cloud guards. Internal protocol cleanup only.
 * @property {function(string=, boolean=): Promise<string[]>} list Lists root-relative regular files
 *   under an optional checked directory prefix,
 *   preserving unavailable entries and rejecting links/unsupported file types.
 */
const fail = (code, message) => Object.assign(new Error(message), { code });
const safePart = (value) => typeof value === 'string' && !!value && value !== '.' && value !== '..' && !/[\\/\0:%]/.test(value);
const missing = (err) => ['ENOENT', 'OS-PLUG-FILE-0008'].includes(err?.code);
function createPocketNotesAdapter(bookId, { filesystem, location, availability, makeTemporaryId = () => globalThis.crypto.randomUUID() } = {}) {
  if (!safePart(bookId) || !filesystem || typeof location !== 'function' || typeof availability !== 'function') throw fail('EINVAL', 'Invalid Pocket notes adapter');
  const root = bookId + '/notes'; let queue = Promise.resolve();
  const serial = (fn) => { const next = queue.catch(() => {}).then(fn); queue = next; return next; };
  const checked = (relative) => {
    if (typeof relative !== 'string' || !relative.split('/').every(safePart)) throw fail('EINVAL', 'Unsafe notes path');
    return root + '/' + relative;
  };
  const local = async (path) => { if (await availability(path) !== 'local') throw fail('ECLOUD', 'Notes file unavailable'); };
  const validate = async (path, directory = false) => {
    const parts = path.split('/');
    for (let length = 1; length <= parts.length; length++) {
      const current = parts.slice(0, length).join('/'); await local(current);
      let stat; try { stat = await filesystem.stat(location(current)); } catch (err) { if (missing(err)) continue; throw err; }
      const wanted = length < parts.length || directory ? 'directory' : 'file';
      if (stat.type !== wanted) throw fail('EINVAL', 'Unsupported notes file type');
    }
  };
  const read = async (relative) => {
    const path = checked(relative);
    try {
      await validate(path);
      const result = await filesystem.readFile({ ...location(path), encoding: 'utf8' });
      if (typeof result.data !== 'string') throw fail('EIO', 'Invalid notes file response');
      return { status: 'ok', text: result.data };
    } catch (err) { if (err.code === 'ECLOUD') return { status: 'unavailable' }; if (missing(err)) return { status: 'missing' }; throw err; }
  };
  return {
    read,
    writeDurable(relative, text) {
      const path = checked(relative);
      return serial(async () => {
        if (typeof text !== 'string') throw fail('EINVAL', 'Expected notes text');
        const before = await read(relative);
        if (before.status === 'unavailable') throw fail('ECLOUD', 'Notes file unavailable');
        if (before.status === 'ok' && before.text === text) return;
        const suffix = makeTemporaryId(); if (!safePart(suffix)) throw fail('EINVAL', 'Unsafe temporary identity');
        const temporary = path + '.' + suffix + '.tmp';
        await validate(temporary);
        try { await filesystem.stat(location(temporary)); throw fail('ECONFLICT', 'Temporary file identity occupied'); } catch (err) { if (!missing(err)) throw err; }
        const parent = path.slice(0, path.lastIndexOf('/'));
        try { await filesystem.mkdir({ ...location(parent), recursive: true }); }
        catch (err) { const stat = await filesystem.stat(location(parent)); if (stat.type !== 'directory') throw err; }
        await validate(temporary);
        await filesystem.writeFile({ ...location(temporary), data: text, encoding: 'utf8', recursive: true });
        if ((await filesystem.readFile({ ...location(temporary), encoding: 'utf8' })).data !== text) throw fail('EIO', 'Notes sibling verification failed');
        await validate(path);
        // Refuse a newly observed competing value rather than overwrite it.
        const current = await read(relative);
        if (current.status === 'unavailable') throw fail('ECLOUD', 'Notes file unavailable');
        if (current.status !== before.status || current.text !== before.text) throw fail('ECONFLICT', 'Notes changed during replacement');
        const from = location(temporary); const to = location(path);
        await filesystem.rename({ from: from.path, to: to.path, directory: from.directory, toDirectory: to.directory });
        const saved = await read(relative);
        if (saved.status !== 'ok' || saved.text !== text) throw fail(saved.status === 'unavailable' ? 'ECLOUD' : 'EIO', 'Notes replacement verification failed');
        // Failed unique siblings remain evidence and are excluded from list().
      });
    },
    remove(relative) {
      const path = checked(relative);
      return serial(async () => {
        await validate(path);
        try { await filesystem.deleteFile(location(path)); } catch (err) { if (!missing(err)) throw err; }
      });
    },
    async list(prefix = '', recursive = true) {
      const result = []; const pending = [prefix ? checked(prefix) : root];
      while (pending.length) {
        const path = pending.pop(); await validate(path, true);
        let entries; try { entries = (await filesystem.readdir(location(path))).files; } catch (err) { if (missing(err)) continue; throw err; }
        if (!Array.isArray(entries)) throw fail('EIO', 'Invalid notes listing');
        for (const entry of entries) {
          if (!safePart(entry.name)) throw fail('EINVAL', 'Unsafe notes listing');
          const child = path + '/' + entry.name;
          if (entry.name.endsWith('.icloud')) throw fail('ECLOUD', 'Notes listing is incomplete');
          if (entry.type === 'directory') { if (recursive) pending.push(child); }
          else if (entry.type === 'file') { if (!entry.name.endsWith('.tmp')) result.push(child.slice(root.length + 1)); }
          else throw fail('EINVAL', 'Unsupported notes listing type');
        }
      }
      return result.sort();
    }
  };
}

const api = { createPocketNotesAdapter };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.NeoPlanetNotesPocket = api;
})();
