# Planet Notes — Task 2.1 contract checkpoint

Status: Task 2.1 core implementation. Model validation, recoverable persistence
and a standalone asynchronous desktop adapter are implemented. No Electron
handlers, bridge exposure, UI or Pocket wiring have been added.

## Interfaces under test

- `validateIndex(input)`: non-mutating validation, unsupported schema detection,
  hierarchy integrity, stable identity, labels and ordering. It does not repair.
- `createNotesStore(adapter)`: read state, apply an internal persistence request,
  recover interrupted operations. Tests use a fault-injectable filesystem adapter.
  This does not prove native filesystem durability or cloud-provider behavior.

The approved renderer interface remains domain-specific. The store's `apply`
request is private: never expose arbitrary index replacement or paths over IPC.
JSDoc in the scaffold records the adapter and result contracts. The model and store support classic browser scripts as well as Node; they are
not loaded by either editor yet.

## Strict durability protocol

1. Validate all input and read relevant current state. Unavailable is not absent.
2. Preserve every observed body/index version that could be displaced.
3. Persist an operation intent with ID, expected versions and recoverable inputs.
4. Persist destination bodies and required recovery records.
5. Publish the valid index only after its referenced material is durable.
6. Verify persisted results before acknowledging. Retire intent only after this.

Every step can stop. Replaying one operation ID must be idempotent. A completed
operation must remain recognizable after its intent is retired; the implementation
must define durable receipt retention before adding cleanup. Version ancestry is
not a distributed lock, and read/check/write is not cross-device atomic.

Creation writes body before index. A published active entry must have its body.
Trash (Task 2.2) first preserves body AND metadata in trash, then publishes a
tombstone/removal, and only then removes the active body. Restore first preserves
any destination, writes restored content, publishes metadata, then marks the trash
record restored. Operation recovery must precede orphan discovery (Task 2.3).
These latter operations are specified here but not implemented or claimed tested.

The adapter must serialize local writes, enforce per-book containment (including
ancestor symlinks), distinguish missing/unavailable/I/O errors, and never fall back
to destructive direct replacement of the only copy. Tests for the real desktop
adapter, partial native writes, rename errors, fsync failures, containment and
Pocket fallback remain necessary when those adapters are implemented.

## Validation contract

Schema 1 requires unique IDs, version ancestry, root/group sort modes and child
order, notes, groups, labels and tombstones. Parents are groups or null; cycles
are invalid. Each active child occurs exactly once in its parent's order. Traversal
must be iterative without imposing a nesting cap. Label names are trimmed,
nonempty and exact-case unique; assignments refer to label IDs. Titles can
duplicate; only note titles can be blank. Input is never silently normalized.
Unknown future schemas must not be written. Malformed recovery/tombstone records
must be rejected; their detailed schemas are finalized with Tasks 2.2 and 2.3.

## Verification at this checkpoint

Run `node --test scripts/planet-notes.test.js scripts/planet-notes-store.test.js`.
Expected: passing behavioral tests. Native adapter tests also live in
`scripts/planet-notes-desktop.test.js` and are included by the ordinary test glob.

Task 2.1 includes native adapter checks for partial writes, fsync/rename errors,
cloud refusal and containment. Revisions/trash execution, distributed reconciliation,
HTML safety inspection and runtime bridge integration remain later tasks.


## Implementation limits

- Store instances sharing one adapter serialize all operations. Runtime integration
  must share one store/adapter per book. Native writes also serialize by root.
- Intent and completion receipts are retained without cleanup. Receipt payloads
  identify retries exactly, even after later versions publish.
- Body tokens are exact source strings, not shortened fingerprints. They are not
  persisted as editable metadata or used to claim distributed atomicity.
- Tombstones remain empty-only until their schema and semantics are implemented
  in Tasks 2.2/2.3. Removal through the core persistence request is refused.
- Recovery refuses observed conflicts and retains intents. Creating conflict notes,
  metadata merging and orphan discovery belong to Task 2.3.
- Desktop adapter requires an injected cloud guard, uses asynchronous I/O and
  unique temporary files, and has no destructive write fallback. Directory fsync
  is used on non-Windows systems; native Windows directory durability is limited.
- Ancestor symlinks are rejected. Callers must pass a canonical absolute root
  (macOS temporary-directory aliases also need canonicalization). These checks
  cannot exclude malicious concurrent path substitution; this is not an OS sandbox.
- Simulated crashes exercise operation boundaries, not physical power-cut hardware
  guarantees. No background sync provider or native Pocket validation has run.


## Task 2.1 review corrections

- Canonical body and index replacements compare their final reread with the exact
  source observed during preflight. Newly observed differences return conflict;
  external content stays in place and the local intent remains recoverable.
  This is not distributed atomic compare-and-swap: an unobserved write after the
  last check remains outside the guarantee.
- All untouched body references are checked before any persistence mutations.
  Post-write reference checks still protect publication if availability changes.
- Model/store declarations are scoped independently so classic browser loading
  does not collide. A browser-context regression exercises both exported modules.
