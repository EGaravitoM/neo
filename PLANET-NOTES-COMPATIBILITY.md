# Planet Notes — older-version compatibility audit

## Scope and evidence

This is a source audit of the locally available upstream tag **v1.6.4**, not a
claim about every older NEO release or a packaged-app/native-device certification.
Evidence was read with `git show v1.6.4:<path>`. The current implementation keeps
book/chapter note paths unchanged and stores Custom Notes separately in `notes/`.
The Stage 6.2 fix can improve this checkout, not already-installed older builds.

| Operation in v1.6.4 | Finding and limitation |
| --- | --- |
| Desktop duplicate (`main.js`, book:duplicate) | Recurses into notes/, but drops any .tmp/.bak/.icloud filename and every file named book.json at any depth. Canonical bodies and ordinary journals can survive; complete recovery-state preservation is not guaranteed. Use the updated build for duplication. |
| Pocket duplicate (`pocket/www/pocket-bridge.js`, duplicateBook) | Recurses into notes/ but drops .tmp/.bak. Does not establish the stronger notes link/availability/verification contract. Do not treat an old-version duplicate as a complete collection backup. |
| Daily backup (`backup-worker.js`) | Includes regular files under notes/ including nested history/trash/conflicts; skips .icloud placeholders without naming them in the omission manifest. Also follows stat-resolved links. An old backup is not proof of complete cloud/recovery coverage. |
| Library move (`main.js`, moveLibrary) | Copies whole book trees using fs.cpSync and compares per-file sizes. The notes directory travels with the book. Equal sizes do not prove byte identity or a consistent concurrent cloud snapshot. |
| Desktop book deletion (`main.js`, book:delete) | Moves the whole book folder to system trash; on failure leaves it in place. Custom Notes travel with the book folder. Restore the complete folder using the system's recovery controls. |
| Pocket book deletion (`pocket/www/pocket-bridge.js`, deleteBook) | Renames the whole book into Deleted Books. Notes travel with it, but the existing desktop backup worker does not enumerate that root folder. Recover via the filesystem; do not assume active-book backups cover deleted books. |
| Manuscript snapshot handlers (`main.js`, snapshot:*) | Address files inside snapshots/, not notes/. Manuscript snapshots do not constitute Custom Notes recovery and cannot replace a complete book backup. |
| Existing notes editing | Book notes remain notes.html; chapter notes remain notes-<chapter-id>.html. The old Notes interface has no Custom Notes/group/label/recovery management. Files remain inspectable on disk. |

## Release guidance

- Prefer the updated version for duplication and backup verification of books
  containing Custom Notes. Older applications cannot expose or resolve the new
  collection's organization or recovery state.
- Preserve the entire book folder when transporting or restoring it. An export of
  the manuscript, a manuscript snapshot, or only the active note HTML bodies omits
  collection metadata and recovery material.
- Keep old source folders or backups until the copied collection has been checked.
  The feature remains gated while Stage 7 and native release checks finish.
- If support for another old release is required, audit that exact tag/build and
  add evidence here; do not extrapolate this table to uninspected versions.

These are documented limitations, not permission for current code to discard
unavailable files, overwrite competing writing, or claim an incomplete transfer
succeeded.

## Current checkout (Stage 6.2)

Desktop/Pocket duplication now preserves the complete regular notes directory,
including spares and recovery data, verifies the copied bytes, and rejects
unavailable sources and reported unsafe types. It detects observed source changes,
cleans up owned partial copies and leaves existing destination collisions alone.
The backup worker explicitly reports cloud-only notes/book placeholders and unsafe
notes entries. These fixes do not change the audited behavior of an installed
v1.6.4 build. Native Pocket verification remains a release gate.
