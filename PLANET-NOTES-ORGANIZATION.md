# Planet Notes — Stage 4 organization

Stages 4.1–4.4 add book-local organization to the existing Notes pane. Custom
Notes remains behind the isolated development gate; ordinary launches are still
unavailable pending search/recovery views, Pocket and the release verification.

## Ownership and public boundary

- `planet-notes-organization.js`: browser/Node pure domain rules. Validates actions,
  plans metadata, checks cycles/missing destinations, orders children with the app
  locale and stored stable ties, flattens visible trees and computes inverse
  metadata changes. No disk or editor access; traversal is iterative.
- `planet-notes-organization-service.js`: main-only durable operation plans,
  idempotent retries and per-window session undo. It shares the owning book's
  service queue with body saves. Prior prepared commands settle before a later
  command can advance the index. Existing Stage 2 storage writes the index and
  preserves ancestry/evidence. Trash and restore use the existing history store.
- `planet-notes-organization-resolution.js`: immutable retry attempts for each
  observed head, retirement of stale attempts, and undo revalidation against the
  latest index. Old attempt files are retained, including the earlier Stage 4
  resolution format. No body writes or renderer API are introduced.
- `planet-notes-tree.js`: Custom Notes section below fixed book/chapter entries.
  Owns expansion, selection, forms, drop previews and keyboard navigation, never
  bodies or raw filesystem operations. Reuses the existing Notes editor through
  app callbacks. DOM names use textContent; all interface text is translated.
- `app.js`: mounts the tree only for capable desktop profiles, provides editor
  capture/flush/open callbacks, and applies Show More Features to management.
  Existing custom content and label display stay accessible with the switch off.

Bridge additions:

| Method | Request | Result |
| --- | --- | --- |
| `notesOrganize(bookId, request)` | `operationId`, `action`, action-specific fields | saved/conflict, itemId, versionId, canUndo |
| `notesUndoOrganization(bookId, {operationId})` | One immutable undo identity | saved/conflict, canUndo |
| `notesOrganizationState(bookId)` | Book identity | canUndo |

Main supplies the window session identity from the authenticated IPC sender;
renderer requests cannot select another session or supply paths/indexes/versions.

Actions: `createGroup(title,parentId)`, `rename(itemId,title)`,
`move(itemId,parentId[,beforeId])`, `deleteGroup(itemId)`,
`sort(parentId,sortMode)`, `createLabel(name)`,
`renameLabel(labelId,name[,merge])`, `deleteLabel(labelId)`,
`assignLabel(noteId,labelId,assigned)`, `trashNote(noteId)`.
The bridge flattens these fields into the request object with action/operationId.
New notes reuse Stage 3 creation; choosing a group then moves the created note,
so an interrupted placement leaves a recoverable root note rather than losing it.

## Rules

Groups have no bodies, may share names, nest arbitrarily and move as subtrees.
Deletion lifts immediate children to the group's parent and preserves subtrees.
Missing destinations, self-parenting and descendant cycles are rejected again in
main, regardless of UI checks. Root and each group have independent sorting.
Alphabetical is groups first, using Intl.Collator in the app language; ties retain
stored relative order. Explicit reordering freezes the displayed sequence and
switches the destination parent to manual. New members append in manual mode.
Renaming does not change manual position. Plain moves do not change sort mode.

Labels are flat, trimmed and case-sensitive. Exact-name duplicates are rejected;
rename requires an explicit merge checkbox to combine an existing exact name.
Merging deduplicates note assignments; deleting a label removes assignments only.
All metadata operations leave HTML files unchanged. Note deletion alone uses
book-local trash, retaining the body and label/group snapshots.

The tree uses tree/treeitem roles, levels, sibling positions, expansion state and
roving focus. Arrow keys, Home/End and Enter/Space navigate; F2/Shift-F10 opens
management. Alt-Up/Down and Move up/down reorder; a Destination select and Move
button perform any hierarchical move without dragging. A focused tree's Ctrl/Cmd-Z
and the Undo organization button use the separate organization history. Editor
text undo and manuscript undo remain independent. Labels, sorting and creation
also have ordinary keyboard-accessible controls.

Drag onto a group's middle to move inside. Drop before/after rows to reorder.
Preview outlines/borders and a live destination description appear before drop.
The root target moves to the collection root. Invalid drops never reuse an earlier
preview; hierarchy validation runs again when the command reaches main. Native
pointer dragging is not yet automated; Electron tests dispatch browser drag events
through the real handlers, and use native keyboard input for writing/navigation.

## Undo and recovery

Undo stacks are session-local and book/window scoped. A successful no-op does not
create an undo step. Inverse patches operate against the latest index and touch
only fields changed by that action, leaving all newer HTML untouched. New siblings
and unrelated label assignments survive; a competing edit of a touched field or
an invalid resulting hierarchy rejects rather than silently replacing that edit.
Undoing group creation lifts any newly added children. Undoing label creation
removes its assignments. Undoing note trash uses history restoration, including
original-group fallback and label recovery. There is no permanent delete or expiry.

Each immutable plan lives at `recovery/organization-commands/<operation-id>.json`
with a SHA-256 digest and before/after metadata. Completion records bind to that
plan digest. A retry reuses its compiled request, including generated identities,
clock and version. These journals and archived indexes remain available after
restart even though the Undo button's stack does not. Retention and recovery UI
remain the Stage 5 scope. Safe concurrent metadata merging and conflict evidence
reuse Stage 3 observation and Stage 2 reconciliation; organizing never duplicates
note bodies.

If a branch arrives after preparation, metadata-only commands reconcile the
intended local index with the incoming index before acknowledgment. The store
acknowledges an intermediate metadata command only after proving that its exact
snapshot is represented in the current ancestry; this cannot create/delete note
bodies. Interrupted receipts remain retryable without resurrecting an old index.
The first resolution remains at `recovery/organization-resolutions/<operation-id>.json`;
further attempts live below the same operation's subdirectory. Each has its own
operation/version identities and digest. A newer head never rewrites a prepared
attempt. Stale reconciliation intents are retired with their competing index at
`recovery/abandoned-reconciliations/`; stale metadata-only apply intents use
`recovery/abandoned-metadata/`. Recovery recognizes both as terminal preservation.
If a head changes again during an attempt, EPENDING keeps the original command
retryable; a subsequent retry or book-queue settlement uses the newly observed head.
Even a return to an older head receives a fresh attempt if its earlier attempt was
retired.

Undo retries do not use ordinary local-winner merging. The original action journal
is read and its inverse is revalidated against the latest metadata. A touched-field
conflict retires the rejected undo without consuming its session undo entry or
changing canonical files. An unrelated change is preserved by rebasing the checked
inverse onto that index, including newly added siblings and their bodies. The
intended inverse snapshot is archived as a parent before a rebased attempt can be
acknowledged, so restart/retry cannot apply the inverse twice.
A rejected trash/restore (or an independent initial metadata head without a proven
merge base) retains its command, inputs and competing index in durable abandoned
operation evidence and returns conflict. It does not claim the action succeeded,
change canonical files, or block future body saves. The author can retry the action
against the refreshed state. Recovery scans recognize this terminal preservation
state rather than repeatedly attempting a known rejected operation.

## Verification

- `npm test`: pure hierarchy/sorting/label/undo rules, durable retry and restart
  tests, main service session isolation, concurrent moves with both metadata
  versions retained, and unchanged HTML after move/edit/undo. Regression tests cover successive
  incoming heads before/after intent creation, undo conflicts after preparation,
  safe inverse rebasing over new notes, restart recovery, and legacy resolutions.
- `npm run test:custom-notes-organization`: actual Electron/IPC/Notes pane with a
  temporary library/profile: nested group/note creation, native text input, F2
  management, moves, labels, drag previews, undo, simple-mode browsing/editing,
  nonrecursive group deletion, trash restoration, and native typing during a
  delayed deletion (the newer writing stays visible as an active recovered note).
- `npm run test:custom-notes`: Stage 3 editor integration regression suite.
- `npm run test:custom-notes-disabled`: ordinary launches stay disabled.
- `npm run test:notes`: legacy book/chapter Notes regression suite.

The collection size and nesting remain unlimited by product policy. Full large/deep
collection stress testing, unavailable-cloud behavior and cross-device release
verification remain Stage 7 gates. No Pocket organization UI is introduced.


## Stage 4 visual integration

Custom Notes uses the existing Notes pane's navigation rows, 13px labels, muted
section headings, gold active-note edge and hover/focus action treatment. Inline
forms use the app's quiet buttons and input styling, including light/bright theme
and keyboard-focus states. Row actions use a compact ellipsis; right-click and
Shift-F10 reuse the app's existing popMenu, while F2 still opens inline management.
Destination choices display group paths; duplicate paths receive numbered display
suffixes rather than exposing storage IDs. The stored identity is unchanged.
The Electron suite checks context-menu keyboard navigation and cancellation along
with the existing organization and writing-preservation journeys.
