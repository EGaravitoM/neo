'use strict';
(function () {
const words = (query) => [...new Set(String(query || '').trim().split(/\s+/u).filter(Boolean))];
const key = (document) => JSON.stringify([document.bookId, document.kind, document.noteId || document.chapterId || 'book']);
/** Derived memory only. Unknown bodies keep coverage incomplete, never blank. */
function createNotesSearch({ textOf = (html) => html, locale } = {}) {
  const records = new Map();
  const prepare = (record) => ({ ...record, content: record.status === 'ok' ? textOf(record.html || '') : '', groupPath: record.groupPath || '', labels: record.labels || [], labelIds: record.labelIds || [] });
  const upsert = (record) => records.set(key(record.document), prepare(record));
  const query = ({ text = '', scope = 'all', labelIds = [], live = [] } = {}) => {
    if (!['title', 'content', 'group', 'label', 'all'].includes(scope)) throw new TypeError('Invalid notes search scope');
    const snapshot = new Map(records);
    for (const record of live) {
      const id = key(record.document); const previous = snapshot.get(id);
      if (previous) snapshot.set(id, prepare({ ...previous, ...record, status: 'ok' }));
    }
    const lower = (value) => String(value || '').toLocaleLowerCase(locale || undefined);
    const terms = words(text).map(lower); const results = [];
    let pending = 0; let unavailable = 0;
    for (const record of snapshot.values()) {
      // Keep known, unwritten chapter pages available for live-buffer overlays.
      if (record.status === 'absent') continue;
      if (record.status === 'loading') pending++;
      else if (record.status !== 'ok') unavailable++;
      if ((scope === 'group' || scope === 'label' || labelIds.length) && record.document.kind !== 'custom' && record.document.kind !== 'trash') continue;
      if (!labelIds.every((id) => record.labelIds.includes(id))) continue;
      const fields = { title: record.title, content: record.content, group: record.groupPath, label: record.labels.join(' ') };
      const haystack = lower(scope === 'all' ? Object.values(fields).join(' ') : fields[scope]);
      if (!terms.every((term) => haystack.includes(term))) continue;
      const first = terms.map((term) => lower(record.content).indexOf(term)).find((at) => at >= 0) ?? 0;
      const start = Math.max(0, first - 45); const excerpt = record.content.slice(start, start + 170);
      results.push({ ...record, excerpt: (start ? '…' : '') + excerpt + (record.content.length > start + 170 ? '…' : '') });
    }
    return { results, coverage: { total: snapshot.size, pending, unavailable, complete: pending === 0 && unavailable === 0 } };
  };
  return { upsert, query, clear: () => records.clear(), remove: (document) => records.delete(key(document)) };
}
const api = { createNotesSearch, words, key };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.NeoPlanetNotesSearch = api;
})();
