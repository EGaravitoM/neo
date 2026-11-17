# Planet Notes — Task 2.2 revisions and trash

Task 2.2 implements revision saves, recoverable trash, body restoration and
restore-as-new through the shared store. Task 2.1 remains compatible.
No bridge, editor integration, Pocket wiring, retention cleanup or UI is added.

## Domain interface

Methods belong to the existing book-scoped store, sharing its serialization and
recovery protocol. All write requests carry stable operationId,
baseVersionId, versionId and createdAt. An acknowledged retry is idempotent;
reusing an operation ID for another payload is invalid.

- `saveNote({noteId,html,expectedBodyToken,reason,writingDay,...})`: supported
  reasons are daily and external. Return `{status:'saved',versionId}` or conflict.
  Before a changed body, preserve the day's first previous saved body or an
  external-replacement revision as appropriate. No-op saves do not write anything.
  External is an operation reason, not permission to ignore divergence: external
  adoption where the disk already holds the incoming body will be integrated in
  Task 3.3 using the retained last-known body, never inferred from a newer disk read.
- `listRevisions(noteId)`: revision metadata array, deterministically sorted.
- `readRevision(noteId,revisionId)`: `{status:'ok',record,html}` or an explicit
  missing/unavailable/invalid result. Verify the body hash before returning ok.
- `trashNote({noteId,trashId,expectedBodyToken,...})`: preserve content and metadata,
  publish removal/tombstone, then cautiously clean up the active file. Return saved
  or conflict. Do not clear an externally changed body, including an empty string.
- `listTrash()`: active trash metadata array; restored sources remain readable
  but are not listed as deleted notes. No read/list operation rewrites metadata.
- `readTrash(trashId)`: `{status:'ok',record,html}` or explicit unavailable/missing/
  invalid result; never render unvalidated HTML here or modify the source.
- `restoreTrash({trashId,...})`: retain original note ID, parent if available,
  labels, and original relative position when manual sorting permits. Root is the
  fallback parent. Alphabetical parents retain alphabetical mode. Restore must
  refuse an occupied identity rather than silently replace active/unindexed words.
- `restoreRevision({noteId,revisionId,mode,newNoteId,expectedBodyToken,...})`:
  mode replace changes only body and snapshots current writing with reason restore;
  mode new creates an independent note under an explicit fresh newNoteId and leaves
  the current note unchanged. Source revisions remain readable in either case.

Read and validation statuses remain distinguishable; unsafe IDs reject with
EINVAL, unavailable inputs reject with ECLOUD, and missing required inputs reject
with ENOENT before persistence. No permanent deletion is exposed.

## Record schemas

JSDoc in planet-notes.js defines PlanetRevision, PlanetTrash and PlanetTombstone.
The three recovery validators return `{status:'ok',record}` or `{status:'invalid',issues}` without modifying input.
Future versioned records return unsupported-version, not an empty replacement.
`validateIndex` accepts validated note tombstones and rejects duplicate deletion
operation IDs. Restored notes retain their immutable deletion events.

Body hashes are lowercase 64-character SHA-256 hex over exact UTF-8 HTML. Browser
and Node implementations must agree. This is separate from the existing exact
source expectedBodyToken used to refuse observed divergence.

Revision bodies and records live at revisions/<noteId>/<revisionId>.html/.json;
trash uses trash/<trashId>/note.html and record.json. Commit the metadata record
only after its body is durable. Readers do not treat body-only partial records as
complete revisions/trash. Recovery retains and finishes interrupted operations.
Deletion tombstones are immutable event records retained through restoration.
A restored status/operation belongs in separate completion metadata so the original
trash record can remain immutable and verifiable.

## Durability and recovery gates

- Validate/preflight all required sources before writes.
- Preserve inputs and intent before changing canonical material.
- Ensure a complete verifiable trash copy exists before index removal.
- Publish deletion/tombstone before removing the active body; recheck content.
- Restore body before publishing its entry; retain the source recovery material.
- A failed revision preservation prevents the save/restore from proceeding.
- Before final acknowledgement, verify all changed content and metadata.
- Retry and recovery must not duplicate revision or trash identities.
- Never trim revisions/trash, even when records are old.

Pending records must be typed so recover() can dispatch core, revision, trash and
restore operations without mistaking one schema for another. Task 2.1 record
compatibility must remain intact.

## Writing day and integration

app.js writingDay() uses the writer's local clock and library.dayEndsAt. It supplies
YYYY-MM-DD to storage; storage must not recompute it from createdAt or UTC. Capture
that key for the edit rather than change it when an asynchronous retry crosses the
day boundary. Daily revision uniqueness is per note and writing-day key. External
and restore reasons are operation-scoped and do not suppress daily protection.

Task 2.3 now supplies explicit metadata and edit-versus-delete reconciliation.
Automatic external refresh and the conflict-resolution UI remain later tasks. Native adapter durability is covered by
Task 2.1 tests; the new fault simulator covers higher-level operation boundaries.

Restoration recreates missing label definitions from their snapshots, maps to an
existing exact-case name when present, and refuses IDs reused for different labels.
Copy titles retain the current source title (duplicate titles are supported);
copy parent and labels come from current metadata, not historical metadata.

## Checkpoint commands

- `node --test scripts/planet-notes*.test.js`: model, core storage, native adapter
  and history tests, including interruption injection and classic browser loading.
- `npm test`: full Node regression suite. Install the repository dependencies first.
- `npm run lint`: repository lint check.


## Persistence details and current limits

The implementation lives in planet-notes-history.js, lazily loaded by the store.
History intents and receipts use separate recovery/history-operations and
recovery/history-receipts directories; the existing core-operation format is
unchanged. History intents preserve their exact requested delta and replay only
that delta. Preflight validates references before writes. Immutable snapshots and
intents precede body publication; complete trash records precede index removal.
Completion receipts follow verification and cleanup. All records remain retained.

Readers validate metadata, identity and body hashes. Invalid, missing, unavailable
or future-version sources are not silently skipped by listings: listings reject
rather than falsely claim complete coverage. Partial body-only artifacts have no
committed metadata and are completed through their retained operation intent.

Daily revision deduplication is local to the observed per-note writing-day history;
independent offline devices can create distinct snapshots for the same day. No
snapshot is removed to force global deduplication. Distributed reconciliation is
still Task 2.3. The supplied writing-day key follows NEO's existing dayEndsAt rule.

Unavailable source content blocks operations. Conflicting external changes remain
in place with the history operation pending. Task 2.3 supplies explicit conflict
and edit-versus-delete recovery; automatic integration remains later work. A final read/remove or
read/replace sequence is not atomic against an external writer. Fault simulations
exercise completed mutation boundaries, not real power-cut hardware guarantees.

No automatic retention cleanup, permanent deletion or native mobile validation
was introduced. Runtime integration must load/copy the new history module for
both desktop and Pocket when those stages begin.


History writes participate in the shared published-receipt completion guard
(documented in PLANET-NOTES-STORAGE.md). Replay uses internal unqueued operations;
normal writes cannot publish a later version while an earlier current-version
receipt still fails. Same-version replay verifies body, metadata and recovery
material before finishing its receipt. Regression tests include reopening, an
orphan scan after the next save, persistent errors and genuine external divergence.
