# Planet Notes — Task 2.3 reconciliation and recovery

Status: implemented as explicit internal store operations. Tasks 2.1 and 2.2
remain compatible. No UI, refresh timer, bridge handlers, Pocket wiring or
automatic invocation has been added.

## Pure metadata reconciliation

`mergeNotesIndex({base,local,incoming,versionId})` returns either
`{status:'ok',index,conflicts}` or `{status:'invalid',issues}`. It never mutates
inputs, reads disk, invents a merge base, or chooses a winner using timestamps.

All branch inputs must validate. Independent changes to distinct items or distinct
fields merge. Competing field values keep local choices and retain complete
base/local/incoming snapshots. Parent membership and child order must agree.
Concurrent ordering conflicts preserve the local order and incoming evidence;
independent additions must not vanish merely because order lists differ.
Combined cycles, deleted parents, ID/name collisions or duplicate exact-case
labels require a valid fallback plus a conflict. Never publish an invalid tree
or silently merge label identities. Distinct-case names remain distinct.

A deletion of an unchanged item is adopted with its immutable tombstone. A
concurrent edit-versus-delete requires storage reconciliation: preserve trash and
expose edited writing as an active recovered note. It must not become an implicit
permanent deletion or an accidental resurrection of the unchanged deleted body.

`validateConflict(record)` is non-mutating. Versioned records have schemaVersion,
id, kind, operationId, createdAt and recoverable evidence. Metadata/hierarchy
records carry complete `variants: {base,local,incoming}` index snapshots. Body and
edit-delete records also identify source and recovered notes and preserved body
versions. Future schemas remain unsupported rather than being rewritten.
Body records preserve baseHtml/localHtml/incomingHtml, sourceNoteId and
recoveredNoteId. Edit-delete records preserve deletedHtml/incomingHtml, trashId
and both note identities. All persisted destinations derive from validated IDs;
orphan source names come only from the adapter directory inventory.

## Book-scoped storage entry points

These are internal domain interfaces, not arbitrary renderer filesystem access.
Writes share the existing per-book queue and accept copied requests. Operation IDs
are stable, retries are idempotent, and reuse for different content is invalid.

- `preserveBodyConflict({operationId,noteId,expectedBodyToken,localHtml,
  incomingHtml,baseVersionId,versionId,createdAt})` returns saved with conflictNoteId
  or conflict if the disk no longer holds the observed incoming version. Preserve
  the incoming body durably as a separate active note in the same group before
  restoring local content as the original. Identity of a source/incoming conflict
  remains stable across repeated refreshes, even with different operation IDs.
- `reconcileMetadata({operationId,baseVersionId,localIndex,incomingIndex,
  expectedIndexToken,versionId,createdAt})` reads the preserved base, validates all
  inputs and publishes a valid merge only against the expected disk version.
  Archive branch evidence and conflict records before publication. Merge bases
  must be proven ancestors via retained version history, not merely named IDs.
  A supplied base older than a provably newer common ancestor is rejected.
  A missing/unavailable base refuses writes; no automatic last-write-wins fallback.
- `recoverEditedDeletion({operationId,noteId,trashId,incomingHtml,baseVersionId,
  versionId,createdAt,expectedBodyToken?})` verifies the deletion and observed edit.
  An explicit null expectedBodyToken permits recovering unsaved in-memory writing
  when the source file is already missing; it never authorizes replacing a new
  file that appeared in its place. Preserve the
  existing trash record and tombstone; add active recovered writing without
  replacing another note or repeatedly duplicating the same observed edit.
- `recoverOrphans({operationId,versionId,createdAt,expectedIndexToken})` reconciles
  pending core/history/conflict operations before classifying files. Unresolved
  or invalid pending evidence defers discovery. Returns status and arrays
  recoveredNoteIds/unavailableNoteIds; missing and cloud-only indexed notes remain
  indexed. With no changes, do not write a new index version.
- `listConflicts()` and `readConflict(conflictId)` provide validated preserved
  evidence for the future recovery UI. Missing, invalid, unsupported and
  unavailable sources remain distinguishable; never silently report a complete
  listing when required recovery records cannot be read.

## Orphan discovery rules

Only direct regular HTML files in notes/ are candidates. Do not traverse recovery,
trash, revisions or conflict artifacts; do not treat temp/backup/cloud placeholders
as author notes. The adapter rejects unsafe paths and links.

Recover into a stable system-owned Recovered Notes group, initially titling from
the filename without .html. A user-created group with the same display name must
not be mistaken for that system group. Persist source-to-note recovery identity
so an unchanged rescan does not create another note. Preserve original bytes
until canonical content and index publication are verified. A later source change
is new evidence, not permission to overwrite already recovered writing.

Consult tombstones and trash before classifying leftover deleted files: identical
deleted content must not resurrect; divergent edited content takes the
edit-versus-delete path. A still-pending creation/deletion must be reconciled or
left deferred, never independently turned into an orphan note.

## Persistence and compatibility gates

Use the existing six-step durable protocol: preflight all sources, preserve observed
versions, persist a typed intent, write destination/recovery material, publish the
index, verify before acknowledgment. New intent types must replay through
store.recover() alongside existing core/history types. Conflict and mapping
records survive interruption and repeated refresh without duplicate notes.

No automatic text merge, permanent deletion, retention cleanup, notification UI
or conflict-resolution controls are included. Stage 4 will connect organization
operations to metadata reconciliation; Stage 5 supplies conflict-resolution views.
Read/check/write still cannot provide distributed atomicity or recover unseen
intermediate external writes.

## Tests and review gate

New test file: scripts/planet-notes-reconcile.test.js. It covers pure merge
behavior, branch preservation, bodies, edit-delete recovery, tombstones, orphan
classification, unavailable sources and mutation-boundary interruption.
All Planet Notes tests, including existing core/history/native tests, must pass.
The regression suite also covers classic browser loading and real filesystem
reopening. Full npm test requires the repository dependencies.

Before Stage 3, review the COMPLETE Stage 2 change set (Tasks 2.1–2.3), including
recovery ordering, schema compatibility and native-adapter limitations, as agreed.


## Implementation structure

planet-notes-reconcile.js owns pure merge and conflict-record validation.
planet-notes-recovery.js owns durable plans, branch evidence, conflict copies,
source mappings and discovery; it uses the shared hash implementation exported
from planet-notes-history.js. All browser declarations are isolated. The store
loads these modules lazily and runs every operation within its existing queue.

Reconciliation uses recovery/reconcile-operations and reconcile-receipts. Intents
carry a SHA-256-verified plan; recovery validates the digest and schemas before
replay. Snapshots are retained in index-versions. Expected overwritten bodies and
observed sources are retained under reconcile-inputs. These are immutable records;
collisions cause refusal rather than replacing evidence.

Orphan mappings and exact source copies live under recovery/orphans. Source name
plus content determines recovery identity; a changed original yields new evidence
and a new recovered note, leaving the earlier note intact. Root source files are
retained. The optional group systemRole='recovered' identifies the system group
without matching display names; validation rejects duplicate system roles.
Stage 3 must translate the default system title when presenting it and distinguish
conflict notes using their preserved conflict identities. No HTML is executed by
these storage modules; safe rendering remains a Stage 3 requirement.

A hierarchy/identity fallback keeps a valid local view and all incoming variants.
Storage still honors verified unrelated deletion events; it does not resurrect
unchanged writing just because another part of the combined tree conflicted.
Edited deleted writing gets a separate active identity with its edited metadata
when known. Old trash and deletion evidence remain readable.

## Limits carried into the combined Stage 2 review

- This implements observation and preservation, not distributed atomic writes.
- Unknown ancestry or a stale common base refuses a merge; the caller must obtain
  the appropriate preserved base rather than silently selecting one by time.
- A combined invalid tree may fall back to the local organization; incoming
  values remain available in conflict snapshots for the later resolution UI.
- Unresolved pending operations deliberately defer orphan classification. Their
  eventual resolution interface remains a later task, not an automatic text merge.
- Offline peers can create distinct recovery operations. Locally repeated scans
  and retried operations are deduplicated against their observed evidence.
- No native mobile validation, background refresh, retention cleanup or release
  activation is claimed by this implementation.


Reconciliation writes also participate in the shared published-receipt guard.
Its internal replay does not invoke the entry guard recursively. This prevents
clean final-receipt failures from becoming permanently deferred orphan scans
once another module writes a newer index. Genuinely unresolved evidence still
remains pending and must not be silently acknowledged as complete.
