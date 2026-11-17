# Planet Notes — Stage 5: search and recovery

Custom Notes remain behind the existing development capability gate. Stage 5 does
not enable the collection for ordinary users or implement Pocket's storage bridge.
Stage 6 compatibility and Stage 7 release checks are still required.

## Ownership

- `planet-notes-search.js` owns an in-memory index, all-word text matching, exact
  label filters, excerpts and coverage. It writes no files. Book/chapter sources
  contribute only their titles and content. Custom sources also contribute their
  ancestor group paths and labels. Live editor buffers overlay saved documents.
  Unwritten chapter pages retain catalog entries for live buffers without appearing
  as saved notes. Unavailable custom metadata does not block legacy search; its
  unknown coverage remains explicit. Label filters are pruned only after a
  successful metadata read confirms that their IDs no longer exist.
- `planet-notes-explorer.js` owns the Notes navigation search and recovery views.
  It delegates opening, safe previewing and save flushing to `app.js`. Search
  highlights use `CSS.highlights`; neither highlights nor recovery controls enter
  saved HTML. Background refresh never focuses the search form.
- `planet-notes-recovery-selection.js` applies selected recorded metadata fields
  against the current index. It never substitutes a whole competing notebook or
  accepts arbitrary replacement values from the renderer. The completed selection
  is validated for cycles, missing destinations, identity and label integrity.
- `planet-notes-library-recovery.js` owns bridge-facing recovery commands. The
  existing store/history layer owns revisions, trash and durable file ordering.
  All run inside the same per-book queue as editor and organization operations.

## Bridge

`notesReadLegacy(bookId, {page})` reads the fixed book notes page or a chapter in
that book's chapter order. It does not permit arbitrary filenames.

`notesRecoveryList(bookId, {kind, noteId?})` lists `trash`, `revisions` (requiring
noteId), or `conflicts`. Individual unavailable items remain visible and make
coverage incomplete. Active search likewise reports loading/unavailable sources.

`notesRecoveryRead(bookId, ref)` reads a typed recovery reference:

```json
{"kind":"revision","noteId":"n-example","id":"r-example"}
```

Other reference kinds are `trash`, `conflict`, and `organization` (a rejected
organization command). A preview carries the current metadata version. Reading a
preview does not restore it. Opening a recovery view may finish a previously
prepared durable command, as other service reads already do.

`notesRecover(bookId, request)` takes a stable operationId and reference, plus:

- `mode: "replace" | "new"` for revisions;
- `selections: [{collection, id, field, side}]` for competing metadata;
- `expectedVersionId` from the displayed preview (required for metadata recovery).

Metadata sides are `local` or `incoming`. No note identity can be created or
removed through metadata-field recovery: use body-aware Trash or Recovered Notes.
Groups and labels may be recovered, and selected group removal lifts children.
Newer unselected fields and siblings remain intact. Restore-as-new creates one
stable independent note even if retried after restart. Restoring content preserves
the current body first, leaving its current title, group and labels unchanged.

## Durable recovery commands

Before invoking the lower-level store, the service preserves a digest-verified
command and its observed source in `notes/recovery/view-commands/<operation>.json`.
The command records allocated identities and compiled expected versions/tokens.
`view-completions/<operation>.json` records its terminal outcome. A restart settles
unfinished commands before accepting later writing. Unavailable completion files
retain ECLOUD, so retries keep the same operation identity. Lower-level immutable history
intents retain their own write-order guarantees. Rejected commands retain their
inputs and competing metadata; they do not claim success or overwrite changed
canonical files. Observed revision-restore destination content is also retained
when an operation must be abandoned. Evidence is not automatically expired.

Conflict records remain inspectable after application. This release provides no
permanent deletion, evidence cleanup, bulk resolution or automatic text merging.
Current originals and recovered competing body notes use the existing Stage 3
observer behavior. Recovery previews pass through the HTML inspector; unsupported
HTML renders as inert text rather than executable HTML.

## Checks

- `npm test`: pure search behavior, selected-field validation, queued recovery,
  interrupted/retried operations, preservation, partial availability, plus the
  existing storage/editor/organization suite.
- `npm run test:custom-notes-explorer`: real Electron window with isolated temporary
  library/profile; controls and native typing exercise live search, screen-only
  highlights, typing focus during refresh, read-only revision previews,
  restore-as-new, trash restoration, simple-mode access and metadata recovery.
- Existing `test:custom-notes`, `test:custom-notes-organization`, `test:notes`, and
  `test:custom-notes-disabled` cover integration regressions.
- Translation extraction includes the new UI module. Missing translations use
  English fallback; translation completeness is reported separately from tests.

No whole-library scan or persisted search database is introduced. Search reads
only the open book, in batches of four, so editor saves can enter the queue between
batches. Large/deep collection performance and cloud failure stress remain Stage 7.

## Large-collection search and transition settlement

The blank All view without label filters fills with available notes rather than
building a row for every still-loading body immediately. Loading bodies remain in
coverage totals and the incomplete-coverage notice. Explicit text queries, other
scopes and exact label filters can still show matches based on known metadata;
unavailable and missing notes are not silently discarded. Live unsaved content
is immediately eligible even before its disk read completes.

Initial populations and large result reductions use one attached-DOM update while
retaining keyed result nodes and restoring focused results when they still match.
This changes rendering cost, not result identity, search terms or storage.
`settled()` includes asynchronous preview closure; a transition abandoned through
close/navigation cannot restart a later search after its preview promise resolves.
