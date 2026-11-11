'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict');
const { createNotesSearch } = require('../planet-notes-search');
const doc = (kind, noteId) => ({ bookId: 'book-one', kind, noteId });
function fixture() {
  const index = createNotesSearch();
  index.upsert({ document: doc('custom', 'n-mara'), title: 'Mara', html: 'A coastal traveller', status: 'ok', groupPath: 'People / Antagonists', labels: ['plot', 'Travel'], labelIds: ['l-lower', 'l-travel'] });
  index.upsert({ document: doc('custom', 'n-port'), title: 'The port', html: 'Ships and markets', status: 'ok', groupPath: 'Locations', labels: ['Plot'], labelIds: ['l-upper'] });
  index.upsert({ document: doc('book', 'book'), title: 'The Book', html: 'Mara arrives', status: 'ok' });
  return index;
}
test('every query word must match somewhere across selected fields', () => {
  const index = fixture();
  assert.equal(index.query({ text: 'MARA coastal people travel' }).results.length, 1);
  assert.equal(index.query({ text: 'Mara nowhere' }).results.length, 0);
  assert.equal(index.query({ text: 'Mara', scope: 'title' }).results.length, 1);
  assert.equal(index.query({ text: 'Mara', scope: 'content' }).results[0].document.kind, 'book');
});
test('ancestor group names cover descendant notes and legacy notes have no group or label fields', () => {
  const index = fixture(); assert.equal(index.query({ text: 'People', scope: 'group' }).results.length, 1);
  assert.equal(index.query({ scope: 'group' }).results.some((r) => r.document.kind === 'book'), false);
  assert.equal(index.query({ scope: 'label' }).results.some((r) => r.document.kind === 'book'), false);
});
test('text labels ignore case while exact label selections distinguish case and require all labels', () => {
  const index = fixture(); assert.equal(index.query({ text: 'PLOT', scope: 'label' }).results.length, 2);
  assert.equal(index.query({ labelIds: ['l-lower', 'l-travel'] }).results[0].title, 'Mara');
  assert.equal(index.query({ labelIds: ['l-lower', 'l-upper'] }).results.length, 0);
});
test('live edits participate immediately without modifying indexed saved content', () => {
  const index = fixture(); const live = [{ document: doc('book', 'book'), html: 'Unsaved dragon writing' }];
  assert.equal(index.query({ text: 'dragon', live }).results.length, 1);
  assert.equal(index.query({ text: 'dragon' }).results.length, 0);
});
test('loading and unavailable bodies remain explicit incomplete coverage', () => {
  const index = fixture(); index.upsert({ document: doc('custom', 'n-cloud'), title: 'Cloud title', status: 'unavailable' });
  index.upsert({ document: doc('custom', 'n-pending'), title: 'Loading title', status: 'loading' });
  const result = index.query({ text: 'unknown content' });
  assert.equal(result.results.length, 0); assert.equal(result.coverage.complete, false);
  assert.equal(result.coverage.pending, 1); assert.equal(result.coverage.unavailable, 1);
  assert.equal(index.query({ text: 'Cloud title', scope: 'title' }).results[0].status, 'unavailable');
});
test('unwritten chapter pages retain immediate live matches without inventing saved notes', () => {
  const index = createNotesSearch(); const document = { bookId: 'book-one', kind: 'chapter', chapterId: 'ch-new' };
  index.upsert({ document, title: 'New chapter', status: 'absent', html: '' });
  assert.equal(index.query().results.length, 0);
  const live = [{ document, html: 'Unsaved dragon writing' }];
  const found = index.query({ text: 'dragon', live });
  assert.equal(found.results.length, 1); assert.equal(found.results[0].title, 'New chapter');
  assert.equal(found.coverage.complete, true);
  assert.equal(index.query({ text: 'dragon' }).results.length, 0);
});
