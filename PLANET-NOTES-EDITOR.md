# Planet Notes — Stage 3 editor integration

Status: Tasks 3.1–3.3 implemented behind the development gate. The service, controller, typed IPC bridge and
normal-close lifecycle are wired behind an isolated development-profile gate.
Ordinary and packaged launches keep Custom Notes disabled. Organization controls remain deferred to Stage 4. HTML inspection and external
refresh are implemented below.

## Public seams

The main-process service factory in planet-notes-service.js accepts enabled,
getBook(bookId), makeId(prefix), now(). getBook returns a private {store,adapter}
context for an EXISTING validated library book, cached once per service/book.
Rejected context loads must not permanently poison the cache. The real callback
must validate book identities with libName and verify library membership/existence;
tests supply isolated in-memory book contexts with the actual Stage 2 store.

Service operations map to future window.neo methods:

| Service | Renderer bridge | Request |
| --- | --- | --- |
| capabilities() | notesCapabilities() | None |
| load(bookId) | notesLoad(bookId) | Valid book ID |
| read(bookId,noteId) | notesRead(bookId,noteId) | Valid IDs |
| create(bookId,request) | notesCreate(bookId,request) | operationId, title |
| rename(bookId,noteId,request) | notesRename(bookId,noteId,request) | operationId, title |
| save(bookId,noteId,request) | notesSave(bookId,noteId,request) | operationId, html, expectedBodyToken, writingDay |

Reject unknown request fields rather than accepting raw paths, indexes or client
version replacements. Main owns IDs, versions, clocks and the compiled storage
request. Keep raw file operations unavailable to the renderer. Return structured
missing/unavailable/disabled/conflict states; failures never acknowledge saves.
IPC failures cross preload as plain {status:"error",error:{code,message}} data,
because contextBridge strips custom fields from thrown Error objects. The
renderer controller reconstructs typed errors in its own realm.
Read results include bodyToken and title; saved bodies return their acknowledged
bodyToken. Empty note titles stay empty in storage and display as translated Untitled.

Creation starts a root-level custom note. It does not create groups, change book
metadata, rename chapter notes, or alter the manuscript. Renaming changes metadata
only. Group/label controls remain Stage 4.

## Stable commands and retries

A command must be durably prepared ONCE before execution. A private service ledger
under notes/recovery/editor-commands retains its semantic request, assigned IDs,
createdAt and exact compiled store request. Its immutable format and SHA-256 checksum are validated;
unknown/corrupt/unavailable evidence must not be replaced by freshly generated IDs.
The ledger is main-only, outside orphan candidate discovery.

The same semantic request/operationId must replay the same compiled command after
lost acknowledgment, service restart, or day rollover. Different content under
the same identity rejects with EINVAL. Use existing store receipt/recovery rules
rather than recomputing a request from a newer index after a retry. Preparation
failure must precede creation/saving; no note may be silently created twice.
Capture writingDay at the edit in the renderer and retain it through retries.

## Controller and view

planet-notes-ui.js is a browser/Node-compatible controller, independent of native
filesystem access. It receives api, view, inspect, writingDay, makeOperationId and
optional timer functions. Methods: open(document), leave(), create(bookId,title),
rename(title), edit(html), flush(), requestClose(), setComposing(boolean),
hasPending(), dispose(). A custom document is {bookId,kind:'custom',noteId}.

view.present(snapshot) receives document, status, title, editable and, ONLY when
approved for editing, html. view.capture() captures the mounted custom editor.
The main app still owns legacy book/chapter note rendering and auxiliary saving;
leave() invalidates custom loads and captures its outgoing content without ever
sending that content to writeAux. Existing notesPage/auxPending must not mistake
a custom-note ID for a chapter notes filename.

inspect(html) must approve content before it is mounted. No inspector means a
locked state with no raw HTML passed to the view. Node tests inject a trusted
fixture inspector. The production inspector/read-only preview is described in Task 3.2 below;
ordinary users remain behind the release gate.

Pending buffers are keyed by book AND note. Capture before switching documents,
including a missed input event. New read generations invalidate old asynchronous
responses. Pending local content wins over a stale disk read on reopening.

Keep one immutable in-flight request and a newer dirty buffer if typing continues.
A failed/uncertain request retries with the SAME operationId and original expected
body token; only its matching acknowledgment advances that token. Newer text is
then sent as a new operation based on the acknowledged body. Never clear newer
writing or redraw another book from an old acknowledgment. flush() drains all
pending books; composition prevents premature captures/saves of intermediate text.

Use the existing 800ms debounce convention, plus lifecycle flushes. Errors remain
retryable and retain the buffer, including EPENDING. Missing/unavailable/loading
views remain noneditable and are not interpreted as blank notes to save.

## Closing and feature gating: implementation gates

Normal close must use an explicit main/renderer handshake, not an async
beforeunload callback. Main prevents close; renderer captures and drains all
pending custom notes (including edits made during the wait); main closes only
for a matching successful response. Validate window sender and attempt token.
Keep the window open on failed saves. Capture the current IME composition only
after compositionend. Do not add typing-time popups or a force-close shortcut
that silently discards pending words. Forced process/OS termination is outside
this handshake guarantee.

The release gate stays OFF for normal users. A development/test capability must
not be available in packaged ordinary launches. Tests use temporary userData and
Documents directories; never enable the unfinished feature on a real library.
This release gate is distinct from Show More Features, which later controls
creation/organization while keeping existing content accessible.

scripts/planet-notes-editor.e2e.js exercises the real bridge, normal-launch
gating, legacy/custom routing, same-tab refresh, rename and native close.
The legacy scripts/notes.e2e.js suite remains unchanged. The
Node controller tests below DO NOT prove native window-close behavior, IPC sender
validation, browser DOM integration, caret behavior or mobile lifecycle safety.
Runtime unit tests additionally check sender/frame validation, flush-only
handshakes, failed flushes, close tokens and quit continuation. No Pocket
completion is claimed.

## Checkpoint verification

- `npm test` runs the full Node suite, including service/controller/runtime tests
  and the existing Stage 2 tests.
- `npm run test:custom-notes-disabled` checks the normal-launch release gate.
- `npm run test:custom-notes` checks isolated development-profile integration.
- Existing scripts/notes.e2e.js is the legacy editor regression suite; it must pass
  when runtime integration is implemented. No existing test is changed here.
- All new JavaScript must pass syntax/lint checks; no new dependencies/tooling.


## Implementation details and remaining gates

- planet-notes-runtime.js owns main IPC authorization, the canonical book root,
  cloud guards, and one service per application. Existing copied/renamed book
  folders retain folder identity even if book.json still names the original.
- The service caches contexts, retries failed context loads, and revalidates real
  book metadata so a cached context cannot silently recreate a deleted book.
- Prepared editor commands retain server-assigned IDs/clocks/versions. Even no-op
  commands record their semantic identity, so an acknowledged operation cannot
  be reused for a different payload after restart. No-op bodies/indexes/revisions
  are not rewritten. All transaction journal retention remains unchanged.
- app.js uses explicit custom-document markers and never passes custom writing
  to writeAux. Same-tab appearance refresh preserves the selected custom note;
  explicit book/chapter navigation leaves and captures it first. Opening books
  and returning to the shelf also detach the old custom view safely.
- Acknowledgments never repaint older writing. The view avoids replacing DOM
  when its HTML is unchanged, including title acknowledgments.
- Main prevents native close until a matching sender/frame/token response is
  ready; renderer drains newer edits and composition before freezing the editor.
  A failed save leaves the window open. App quit continues only after success.
- Flush-only handshakes protect library switching/moving, updates, and book trash
  paths that otherwise bypass native close. Book trash resumes the editor after
  the action. Forced process/OS termination is still outside the guarantee.
- Enabling the private harness requires an unpackaged app, explicit test flags,
  a canonical temporary Documents root and userData beneath that root. Fixture
  inspection is permitted only under this gate. It is not a release mechanism.
- The production HTML inspector and safe unsupported-content preview are supplied
  by Task 3.2 below. No user-facing creation/tree controls are added.
- Six new translated-source strings are added to locales/_template.json. French
  validation reports them as untranslated; existing English fallback applies.

When running Electron from a host that sets ELECTRON_RUN_AS_NODE, unset that
variable for the test invocation. All integration tests create temporary library
and profile directories; they do not use the writer's real NEO library.


## Tasks 3.2–3.3: HTML and observed external changes

`planet-notes-html.js` parses into an inert template. Supported external markup
is paragraphs/divisions/breaks and inline bold, italic, underline, strike,
subscript/superscript and spans; paragraph alignment and a small explicit inline
style vocabulary are accepted. Other elements/attributes/CSS, document wrappers,
and comments make the document read-only. No arbitrary links, resources, scripts,
custom elements or manuscript data attributes enter the live editor. The preview
uses textContent, excluding script/style/template contents. Create editable copy
uses a fresh note identity with simplified paragraphs and retains the source file.
The same notes editor and paste handler continue to handle normal editing.

`notesRefresh(bookId,noteId,{baseBodyToken,localHtml})` is a domain operation;
`notesCopy(bookId,noteId,{operationId,expectedBodyToken,html})` creates a separate
editable copy. Neither accepts paths, indexes or renderer-generated versions.
The app checks on focus, becoming visible and every five seconds while the Notes
view is visible. Refresh is serialized against controller flushes and main's book
queue. Local edits made during a read remain pending. Composition postpones DOM
replacement; text offsets restore the selection where possible. Conflict notices
use the Notes status area after a quiet interval, without a popup.

`planet-notes-observer.js` saves content-addressed bodies under
`recovery/observed-bodies/<note-id>/<sha256>.html`, including newly observed external
content before replacement. Prior adopted content receives an external revision.
Supported clean changes are adopted without rewriting the body. Concurrent bodies
use the Stage 2 conflict plan: keep local in the original and put external writing
in an identified conflict note. Unindexed files use Stage 2 orphan recovery;
missing files remain indexed/unavailable. Competing deletions recover unsaved
editor writing to an active separate note, retaining trash. Metadata branches use
archived parentVersionIds and a proven common ancestor; unknown/corrupt ancestry
fails closed, preserving its files instead of guessing a merge base.

Editor completion records bind to the checksum of their immutable prepared
command. Before compiling any new command, the service scans and settles earlier
incomplete commands, including a preparation that failed before a store intent.
Completed commands still replay their original store receipt. A competing body
or version can use a separate checksummed resolution plan without modifying the
original ledger. Recovery artifacts are retained indefinitely with Stage 2 data.

Verification adds interrupted-save/restart/rename retry, repeated external reads,
body and metadata competition, deletion/edit recovery, orphan discovery, missing
and unavailable files, editable-copy idempotence, asynchronous typing and IME
refresh tests. The real Electron suite exercises the production HTML inspector,
active-content rejection, plain-text previews, copy/source separation, external
adoption and caret offsets, alongside the Task 3.1 close and legacy routing checks.
Stage 4 navigation controls, Stage 5 recovery views and Stage 6 Pocket remain
separate gates; ordinary launches still cannot activate Custom Notes.

### Review follow-up: normalization, availability, discovery and paste

Clean editor refreshes use the exact observed body token as the local version;
DOM normalization alone is not a competing edit. The displayed HTML separately
tracks typing during refresh. A restored unchanged body is reinspected and shown
again after temporary unavailability; unsupported HTML remains read-only.

Collection loads now run the same queued orphan discovery as note refreshes,
including when no custom note is open. Missing or invalid metadata is not replaced
with a guessed index. Incomplete cloud inventories retain indexed content and
mark search coverage incomplete while discovery waits for a later refresh.

Custom-note paste converts manuscript footnote markers to inert inline prose,
preserving their attribute-held words, and flattens placeholder markers. The same
conversion preserves footnote words in previews and editable copies of previously
saved unsupported documents. Existing legacy Notes paste behavior is unchanged.
