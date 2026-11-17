# Planet Notes — Stage 6.2: backup, duplication and compatibility

This slice implements verified whole-book duplication on desktop and Pocket and
honest notes omission reporting in library backups. Custom Notes remain gated;
Stage 7 and native verification still precede release. Fonts, stylesheets, note
HTML formats, collection identities and recovery schemas are unchanged.

## Copy policy and ownership

`planet-notes-transfer.js` is one pure Node/browser policy shared by desktop and
Pocket. It includes all regular descendants of notes/, including .tmp/.bak files,
nested book.json files and opaque recovery artifacts. Unsafe paths, links and
unsupported types reject EINVAL. Placeholders mean unavailable, never a silently
skipped file. Filtering of non-notes spares and book.json files keeps its prior
behavior. Only the destination's owning root book.json gets a new book ID/title.

A copy does not regenerate note/group/label IDs, rewrite immutable journals, or
recompute their checksums. Those IDs are book-local; source book IDs recorded in
journal semantics remain provenance. Actual service/store tests replay a prepared
editor command in the destination context and confirm that the original is not
modified. The actual Pocket page also edits a duplicated note without touching
the original collection.

## Desktop duplication

The existing IPC handler inventories the source, rejects unsafe types and cloud
placeholders, then claims a fresh destination with exclusive mkdir. It will not
merge into or clean up an already existing book on an identity collision. Files
are copied through the durable writer and compared byte-for-byte after writing.
Source and destination content reads use asynchronous filesystem calls with a
20-second limit per read. A stalled provider therefore leaves the main event loop
responsive and fails the attempt instead of holding editors indefinitely.
A private temporary directory isolates scratch writes from copied .tmp artifacts
and directories. Its name is checked against the source inventory and it is
removed before the copy is published.

Before publishing root book.json, the handler rechecks the source manifest and
SHA-256 fingerprints of observed source bytes, including the original metadata.
These fingerprints are ephemeral verification data, not a format or hashing
migration. A detected source change aborts rather than silently claiming a
consistent copy. Read guards recheck regular file types, ancestors, placeholders
and cloud availability. With the notes development runtime enabled, active notes
editors finish pending writes and remain frozen during the copy, then resume even
if it fails. Duplication requests are serialized so an earlier request cannot
resume editors while another copy is still verifying. The application also
explicitly flushes its pending Custom Notes
controller before invoking duplication.

On failure, only a destination created by this attempt is removed. Cleanup failure
is logged and the error identifies the incomplete copy's location. The copier
never rolls back or erases external changes observed in the source.

## Pocket duplication

Pocket loads the same policy through the existing asset-copy script. The existing
duplicateBook method uses guarded inventory and reads, claims a fresh directory,
copies base64 data without altering binary artifacts, verifies destination bytes,
and rechecks the observed source manifest/content before publishing metadata.
Unsupported links/types and unavailable files reject the operation. Partial-copy
cleanup failures identify the remaining destination. The generic notes editor
still receives only domain APIs through window.neo.

Capacitor I/O is covered by injected tests and the actual Pocket HTML/bridge in
an Electron fixture; these are not native device certification. The Stage 6.1
native cloud, permissions, link reporting, rename and suspension checks remain
required. No complete atomic snapshot against an arbitrary concurrent external
sync writer is claimed on either platform; observed changes are checked.

## Backups

The backup worker already included regular notes bodies/index and nested recovery
files. It now also reports unavailable notes placeholders, a wholly cloud-only
notes folder, and a wholly cloud-only book in its omission manifest. Within notes,
it uses lstat to reject links and unsupported entries instead of following or
silently skipping them. Available ordinary files remain byte-for-byte zip inputs,
including temporary recovery artifacts. Bounded reads and the existing
_left-out-of-this-backup.txt report keep incomplete archives explicit without
waiting indefinitely for cloud files. Existing non-notes backup behavior remains.

## Verification

The former contracts are now regular `scripts/planet-notes-transfer.test.js`
tests included in npm test. `npm run test:custom-notes-transfer-contract` remains
an alias for running these 25 checks separately. No checks are skipped.

They cover full notes preservation, opaque/binary data, interrupted-command replay,
duplicate independence, unavailable files/placeholders/folders/books, links,
rollback, corrupted destinations, source changes, destination collisions and
scratch-name collisions. They also hold destination/source verification reads
pending to prove main-loop responsiveness, verify timeout rollback, and check
serialized concurrent copies. Backup zip entries are compared byte-for-byte.

The expanded Pocket Electron test verifies whole-collection duplication through
the actual bridge and independent editing. The desktop explorer Electron test
verifies that IPC duplication captures pending writing and resumes the editor.
Existing desktop editor/organization/search/Pocket regressions remain required.
Translation extraction includes copy error messages; missing translations retain
English fallback. See PLANET-NOTES-COMPATIBILITY.md for the older-release audit.
