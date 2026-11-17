# Planet Notes — Stage 6.1: Pocket integration

Task 6.1 implements the shared runtime, Pocket adapter/facade, asset construction
and mobile UI capabilities. Custom Notes remain disabled in ordinary desktop and
Pocket launches. Pocket's `NOTES_ENABLED` constant stays false; only a disposable
fixture copy changes it for integration tests. Stage 6.2 backup/duplication and
compatibility auditing, Stage 7 stress testing, and native device verification
remain outstanding. No release enablement is included here.

## Ownership and portability

The existing service, observer, organization service/resolution and library-recovery
modules now use the project's Node/browser wrappers. They share asynchronous
SHA-256 from `planet-notes-history.js` (Node crypto on desktop, Web Crypto in the
browser), retaining the same serialization, checksums, IDs and disk schemas. There
is no second mobile merge implementation, bundler, Node polyfill or new dependency.
The cross-runtime tests load actual Node-created journals into a browser VM and
exercise editing, external conflicts and restart replay with Web Crypto.

`planet-notes-pocket.js` is the private Capacitor adapter. It implements the
existing read/writeDurable/remove/list contract under one book's `notes/` folder.
Its injected location resolver owns Documents versus encoded iCloud file URLs.
The adapter validates paths and reported file types, checks ancestor availability,
keeps missing and unavailable distinct, and ignores abandoned unique `.tmp`
siblings when listing canonical/recovery files. It refuses incomplete placeholder
listings rather than treating cloud entries as deletions.

A changed write checks the original, writes a unique sibling, verifies its content,
rechecks destination availability and the observed destination value, renames, and
verifies the result. A failed rename never falls back to direct overwrite. Failed
siblings remain evidence. A detected short write or newly observed competing value
leaves the destination alone. Existing store/history intents protect multi-file
operations and settle prepared saves after restart. This checks observed races;
it does not claim atomic compare-and-swap against an arbitrary external writer.

`planet-notes-pocket-bridge.js` exposes only domain operations. It preserves typed
error envelopes, denies management and restoration even to direct callers, and
does not touch the service when disabled. `pocket/www/pocket-bridge.js` creates
validated book contexts and installs this facade. iOS uses a new single-path
`LibraryHome.notesStatus` guard: unavailable ubiquitous files/placeholders trigger
a download request and remain unavailable; links under the library are rejected.
The existing generic Pocket writer is not used for Custom Notes.

## Mobile behavior

The shared tree, editor and explorer provide nested browsing, existing-note HTML
editing, label viewing, unified search, and read-only trash/revision/conflict
inspection. Management, label editing, drag/drop, organization undo, editable-copy
creation and restoration remain desktop operations. The explorer reads
`canRestore:false`; the facade also rejects those commands with ENOTSUPPORTED.
Unsupported HTML remains inert and read-only, with no inaccessible creation advice.

Background visibility changes start a controller flush. Failed saves retain pending
writing and support retry; Custom Notes diagnostics use quiet logging instead of
Pocket's error sheet during typing. This does not claim that the OS always waits
for a background callback to finish. Durable prepared commands replay on reopening.
Book navigation captures pending edits into the existing controller; its queued
saves finish against their original book-local adapter contexts. Identical note
IDs in different books remain independent.

`scripts/pocket-www.js` copies the shared plain scripts and the Pocket HTML loads
them in dependency order before initializing the bridge and application. Generated
copies are ignored by git; there is no compilation step.

## Verification

- `npm test` includes the former scaffolding contracts, now promoted to
  `scripts/planet-notes-pocket.test.js`. The dedicated
  `npm run test:custom-notes-pocket-contract` command runs the same 15 tests.
  These cover typed availability, unsafe paths, sibling verification, failed
  replacement, cloud races, unchanged writes, recursive isolation, observed
  competing writes, browser/desktop compatibility, conflicts, interrupted replay,
  mobile restrictions, disabled gating, error codes and asset ordering.
- `npm run test:custom-notes-pocket` constructs assets and opens the actual Pocket
  page/bridge in a narrow Electron window with simulated Capacitor I/O and a
  temporary library/profile. Native typing exercises grouped/labeled notes,
  background flush, quiet failure/retry, pending edits when switching books,
  unified search, read-only trash/metadata conflicts and inert unsupported HTML.
  The fixture alone enables the gate; it cannot enable a normal launch.
- Existing custom editor, organization and search/recovery Electron regressions
  run against the portable service. Translation extraction includes the new
  mobile messages; missing translations retain English fallback.

## Native release gates — not certified by these tests

The Electron fixture simulates Capacitor using Node filesystem calls. It is not an
Android/iOS emulator and does not prove platform replacement atomicity, fsync,
cloud behavior, native symlink reporting or kill/suspension durability. Verify
these on each supported native filesystem before enabling the feature. If a
platform's Filesystem rename operation cannot preserve the required guarantee,
provide a dedicated native replacement operation rather than enabling unsafe
fallbacks. Verify Android permissions and link handling on actual shared folders.

Swift syntax parsing is available here, but no iOS Simulator SDK is installed;
`LibraryHome.notesStatus` has not been compiled/type-checked against Capacitor/UIKit
or exercised with iCloud on this machine. Old native shells lacking this method
fail closed as unavailable. The release gate must not infer native readiness from
passing JavaScript tests.

Native error-code reference: [Capacitor Filesystem API](https://next.capacitorjs.com/docs/apis/filesystem).
Pocket maps the documented missing-file code to missing, while other I/O failures
remain errors. The adapter's stronger guarantees are its own tested protocol,
not an assertion that the plugin API promises crash durability.
