'use strict';
(function () {
const node = typeof module !== 'undefined' && module.exports;
const { t } = node ? require('./i18n') : globalThis.NeoI18n;
/**
 * Shared book-copy policy; callers own I/O, verification and rollback.
 * @param {string} relative Slash-separated path relative to the owning book.
 * @param {'file'|'directory'|'symlink'|'other'} type Source entry type.
 * @returns {'include'|'skip'|'unavailable'} Include all regular notes/ descendants,
 *   including .tmp/.bak and nested book.json; skip non-notes book.json files and
 *   existing non-notes spares. Placeholders mean unavailable, never skip.
 *   Unsafe paths, links and unsupported types reject EINVAL before file reads.
 * The copier owns availability checks, destination verification and rollback.
 * Policy does not read, rewrite or re-identify recovery journals or note bodies.
 */
function bookCopyPolicy(relative, type) {
  const invalid = () => { throw Object.assign(new Error(t('Unsafe book copy entry')), { code: 'EINVAL' }); };
  if (typeof relative !== 'string' || !relative || /[\\\0]/.test(relative) || /^[A-Za-z]:/.test(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) invalid();
  if (!['file', 'directory'].includes(type)) invalid();
  const parts = relative.split('/'); const name = parts.at(-1);
  if (name.endsWith('.icloud')) return 'unavailable';
  if (parts[0] === 'notes') return 'include';
  if (/\.(tmp|bak)$/.test(name) || name === 'book.json') return 'skip';
  return 'include';
}
const api = { bookCopyPolicy };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.NeoPlanetNotesTransfer = api;
})();
