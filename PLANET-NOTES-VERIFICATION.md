# Planet Notes — Stage 7 verification

Status: the full domain/failure campaign and all seven renderer profiles have
run. Desktop, Pocket bridge and existing Notes regressions pass after the fixture
corrections described below. **Release is not approved**: large-collection
performance needs review, native verification and manual accessibility remain
outstanding. No collection/nesting cap or normal-launch feature gate was changed.

## Measured fixes and remaining findings

Measurements are seed 7301 on an Apple M1 Pro, macOS arm64, Node 22 / Electron 43.
They are initial observations, not portable performance guarantees. Local raw JSON
and logs live in ignored `stress-results/`; this document preserves the conclusions.

- Expanded-tree construction built lookup tables repeatedly. Sharing lookup tables
  and collation within one traversal reduced the 5,000-level domain traversal from
  about 2,328 ms to 6 ms, and 10,000-note traversal from 90 ms to 7 ms.
- Deep UI indentation consumed the entire note-title width. Adaptive visual
  indentation now reserves title space while preserving real paths, parentage and
  ARIA depth. The 5,000-level leaf has about 92 px of readable title space.
- Search rebuilt every result after every loaded body. Keyed rows and coalesced
  hydration updates reduced the deterministic 1,000-note UI load from 4,321 ms to
  142 ms. Live input remains synchronous and highlights remain screen-only.
- Full-app reads traversed unrelated observed-body/recovery directories repeatedly.
  Checked directory-prefix listings retain root-relative paths and cloud ancestor
  validation. Full-app 1,000-note loading improved from a 120-second timeout to
  38.3 seconds, with first results in 0.28 seconds, with the retained scoped-listing implementation.
- A bounded-read API experiment did not resolve the 10,000-note timeout and
  delayed first results to 37 seconds. It was removed; no batch API is shipped.
  Search keeps the existing four-read scheduling and durable observations.
- **Open performance finding:** expanding all 100 groups of the 10,000-note
  renderer fixture cumulatively took 38.6 seconds; the 3,000-note mixed fixture
  took 27.4 seconds across its 200 groups. Rows remain reachable, but repeated
  full tree rendering needs optimization or explicit performance review.
- Full-app 10,000-note hydration exceeded the 120-second test budget and
  remained over budget in the discarded batch experiment.
  Functional renderer success alone does not close this storage finding.

The Pocket duplication regression initially raced its own shelf-transition
metadata save. The copier correctly rejected the changing source. The fixture
now awaits the actual pending promise before asserting a stable-source copy;
no production conflict check was relaxed. The isolated rerun passes. A legacy
Notes pane-pin timeout during concurrent windows passed on isolated rerun (14/14).

The explorer timeout investigation found that `settled()` could return the
previous load while a recovery preview was still closing. The full transition now
owns its promise and checks its generation before starting a new load. A
controlled pending-preview regression proves that settlement waits and abandoned
search cannot restart; three repeated complete explorer runs pass. Earlier failed
logs remain evidence of the issue, not current successful verification.

## Reproducible profiles

`scripts/helpers/planet-notes-stress-fixtures.js` builds valid, deterministic
book-local metadata and synthetic HTML. It includes blank note titles, duplicate
titles, case-distinct labels, manual/alphabetical containers and unique body tokens.
No writer's library is read or modified. Fixture sizes are not application limits.

| Profile | Cases |
| --- | --- |
| smoke | 20 notes, 4 groups, depth 2 |
| full wide | 100 / 1,000 / 10,000 notes; group counts derived from each case |
| full deep | 100 / 1,000 / 5,000 nested groups with a leaf note |
| full mixed | 3,000 notes, 200 groups, depth 40 |

The seed defaults to 7301 and can be set explicitly. Sizes remain configurable in
the fixture definitions; invalid values reject rather than silently clamp. Passing
the largest planned case does not prove unlimited capacity, and failing it does
not automatically authorize a product limit.

## Runner and measurements

`scripts/planet-notes-stress.js` **plans by default**. Each explicitly executed case
runs in its own Node subprocess with a configurable time budget. A stalled/crashed
case produces a failed result and open finding rather than blocking the parent or
being silently omitted. The default 120-second case budget is a test budget, not
a NEO product limit. Runs record seed, fixture size, iteration, first/repeat phase,
Node/OS/CPU information, source revision/dirty state and raw samples.

Domain measurements cover schema validation, expanded-tree construction, in-memory
search construction and query, heap delta, process peak RSS and scheduled timer
delay inside the worker. Queries verify identity and immediate live-buffer matches;
checks also assert tree completeness and unchanged source metadata. These are
algorithm measurements, **not renderer paint time or Electron main-loop evidence**.
The fixture HTML extractor only handles the synthetic markup used here; the real
Notes HTML inspector remains covered separately.

Query p50/p95 values summarize the available samples; the default three iterations
are an initial observation, not a statistically strong tail-latency claim. Increase
--runs when reviewing performance. Heap deltas depend on garbage collection and
are not, by themselves, evidence of a memory leak. No latency threshold or size
cap is imposed without measurements and explicit review.

Failure scenarios use the real service/store with injected memory I/O:

- Dry-run a save to discover its durable-write count; fail each write boundary in
  turn, restart, retry the same operation, and verify current writing, revisions
  and metadata remain valid. A failure before any durable intent does not invent
  recovery of words never persisted; the explicit retry still supplies them.
- Make canonical body/index inputs unavailable and verify ECLOUD with no overwrite.
- Observe repeated competing local/external bodies, preserving each competing
  version and avoiding duplicate notes on an unchanged repeated refresh.

These simulations do not certify native fsync, iCloud/Syncthing, permissions or
process-death behavior. Backup/duplication, full controller/IPC and other established
regressions remain separate required gates.

## UI evidence and remaining contracts

The component driver uses real tree/explorer modules and shared CSS with a deterministic bridge. The app driver uses the actual desktop app, IPC and temporary on-disk books. These scopes are deliberately reported separately.

| Scenario | Required checks and measurements |
| --- | --- |
| Large/deep tree | All material reachable; stable identities; leaf/ancestor navigation; no stack overflow; DOM count, load/expand/open time, memory and input delay |
| Live search | Unsaved text, scopes/labels, partial cloud coverage, screen-only highlights; query p50/p95 and input delay |
| Keyboard/drag | All organization actions without dragging; drag destination preview and cycle rejection; focus restoration; screen-reader inspection |
| Fonts/themes | Computed UI font matches existing navigation; two selected body fonts match editor/recovery preview; Night/Paper/Light checks; saved HTML contains no decoration |
| Pocket | Required browsing/editing/search/recovery inspection; no management/restoration; quiet failures and retries |

Existing functional Electron tests are a baseline, not substitutes for collecting
these measurements on large/deep fixtures. All seven planned component profiles passed identity/reachability, leaf opening,
live search, incomplete coverage, screen-only highlights and computed-font checks.
The functional organization suite also passed keyboard management, drag destination
preview, label assignment, deletion, undo and preservation of newer writing.
Manual screen-reader and visual inspections remain required.

## Release report

`scripts/helpers/planet-notes-release-report.js` creates JSON and Markdown reports.
Every required gate starts not-run. Results from Node/simulated I/O can pass only
their own domain/storage/sync gates after a full-profile run. They never pass UI,
native, font/theme, compatibility, regression or performance-review gates.
Smoke runs cannot establish a full domain pass. Failed cases remain open findings.

Assessment requires every required gate to pass with evidence, and every finding
to be resolved or explicitly reviewed with evidence. Synthetic unit-test evidence
used to test this validator is not actual release evidence. There is no command
that toggles or publishes the feature. Even a fully annotated report is advisory;
the application's development gates remain unchanged.

The iOS Simulator SDK is unavailable on this machine (`xcrun` cannot locate it).
`adb devices -l` succeeds but lists no devices. Both native gates remain not-run.
Native fsync/replacement, cloud behavior, permissions, suspension and device links
are not certified by the simulated Capacitor integration test.

## Commands and evidence

Prepare/inspect the full plan without running benchmarks:

```sh
npm run test:custom-notes-stress
npm run test:custom-notes-stress-harness
```

Execute a campaign and write fresh evidence files:

```sh
npm run test:custom-notes-stress -- --run --seed 7301 --runs 3 --out stress-results/stage7-full.json
```

A focused smoke execution can use `node scripts/planet-notes-stress.js --run
--profile smoke`; it still runs the storage/sync simulations and cannot certify
full release readiness. The ordinary unit suite runs only fixture/report tests,
a tiny domain measurement and two external-edit rounds, not the full campaign.

JSON/Markdown outputs refuse to overwrite existing evidence. Local stress-results/
artifacts are ignored by git; retain a reviewed summary/evidence references for
release decisions. Any proposed product limit or other product tradeoff returns to the author for
an explicit decision. Stage 7 remains open until all release gates are satisfied.

Run component or full-app measurements in isolated Electron fixtures:

```sh
npm run test:custom-notes-ui-stress -- --case deep-5000 --out stress-results/ui-example.json
npm run test:custom-notes-app-stress -- --case wide-10000 --out stress-results/app-example.json
```

The domain campaign after the fixes is `stage7-domain-final.json` (all seven
profiles × three samples, durable failure boundaries, unavailable inputs and
repeated observed conflicts). The Node suite passes **635 tests**. Planet Notes
lint and `git diff --check` pass. Whole-repository lint still reports pre-existing
findings outside this change; it is not reported as a clean global gate.

Final integration logs use `*-verified-final.log` after removing the unsuccessful
batch experiment; explorer also has `test-custom-notes-explorer-isolated-final.log`.
Ordinary-launch disabled-feature behavior passes. Backup/duplication contracts run
inside `npm test`, including unavailable files, source races, independent copies,
rollback and main-loop responsiveness. The existing v1.6.4 source compatibility audit remains in
`PLANET-NOTES-COMPATIBILITY.md`; it does not certify other old builds. Manual
accessibility remains a release review item.

`PLANET-NOTES-RELEASE-REPORT.json` consolidates measurements, evidence scopes and
open findings. Its release assessment remains false.

## Task 7 review corrections

The real-app stress driver now refuses a passing result when any captured renderer
console error exists. An explicit `--inject-renderer-error` fixture option proves
that a real Chromium console error produces a failed artifact and nonzero exit;
the clean smoke fixture still passes. This option only affects the test driver.

The component driver now checks End against the exact final visible row, rather
than accepting any focused row. Unit coverage explicitly rejects unchanged first-row
focus. The same assertion runs against every hierarchy profile.

Expansion and hydration each record `inputDelay` samples: a timer is scheduled
before work begins, dispatches an input event without changing editor words, and
records scheduled delivery delay plus synchronous handler duration. Samples include
work that blocks the first timer, and a final pending delivery is awaited before
the probe stops. Each phase reports sample count, p50/p95/max and raw samples.
These are renderer event-loop/input-dispatch observations, not trusted OS input,
physical typing latency or a substitute for manual/native accessibility checks.
No responsiveness threshold or product limit is inferred from a functional pass.

Fresh artifacts use `ui-<profile>-review-fixed.json`;
`app-smoke-review-clean.json` passes and `app-smoke-review-injected.json` fails
intentionally with the injected error recorded. Previous evidence remains intact.
The review adds four regression tests; the complete Node suite passes 635 tests.
Release readiness remains false until the previously recorded open findings and
manual/native gates are addressed.

Observed maximum scheduled input delivery delays in the review-fixed run:

| Profile | Expansion max (ms) | Hydration max (ms) |
| --- | --- | --- |
| wide-100 | 17.8 | 89.9 |
| wide-1000 | 55.8 | 116.2 |
| wide-10000 | 1101.4 | 1087.0 |
| deep-100 | 1.9 | 29.5 |
| deep-1000 | 46.3 | 43.0 |
| deep-5000 | 470.2 | 124.4 |
| mixed-3000 | 212.0 | 353.5 |

These are one instrumented run per profile. Probe scheduling adds overhead; do
not treat these as hardware latency or a statistical tail-latency guarantee. The
measured stalls reinforce the existing open performance finding.

## Final-stage follow-up

- The tree retains attached rows with stable identity instead of rebuilding all
  listeners on each expansion. Row actions read current item/position data;
  management controls update when capabilities change. Exact End navigation and
  row identity preservation pass on all seven profiles. In the latest run,
  cumulative wide-10,000 expansion fell from 38.6 to 8.7 seconds, with maximum
  expansion input delay about 194 ms; mixed-3,000 fell from 27.4 to 6.0 seconds.
  Deep-5,000 still records a 333 ms expansion delay. These remain observations for
  performance review, not imposed limits or automatic acceptance thresholds.
- Repeated body reads no longer reload/adopt metadata after observing a body.
  Read-only metadata snapshots reuse parsing and validation only after exact-byte
  rereads establish unchanged input. Deep freezing protects the baseline while
  public loads retain caller-owned copies. Regression tests cover external heads
  arriving during body reads, cloud availability, changed invalid bytes and
  attempted snapshot mutation. No observed body is returned without preservation.
- Visual inspection exposed a stale Book/Chapter current marker while a Custom
  Note was active. It is cleared when presenting the Custom Note; organization
  integration checks that a legacy entry is not simultaneously marked current.
- Actual desktop smoke inspection captures named searchbox/tree/treeitem roles
  through Chromium's accessibility tree and Night/Paper/Light screenshots under
  `stress-results/release-ui-inspection-final/`. These are automated role checks
  and desktop visual observations, not a manual screen-reader pass or native
  mobile certification. Existing UI/body font inheritance remains unchanged.
- Node tests: 635 passed. Full domain/fault/conflict campaign is
  `stage7-release-domain-final.json`; final renderer profiles use
  `ui-<profile>-release-final.json`. Explorer transition repeats are
  `explorer-transition-repeat-0.log` through `-2.log`. Updated editor/Pocket/disabled
  regressions use `*-immutable-final.log`; organization and legacy Notes also have
  `*-release-final.log`.
- Native availability was rechecked: Android has no attached device and no
  emulator binary at the conventional SDK path; iOS Simulator SDK is absent.
  Installation and physical-device/cloud/suspension checks remain outstanding.

The app driver now accepts `--timeout-ms` to collect an actual cold-load duration
beyond the default two-minute budget. A longer run never erases the original
120-second failure or establishes acceptable responsiveness. No size/nesting cap
or release gate was relaxed.

Orphan-refresh profiling also found that every open-note focus refresh ran a full
collection-wide orphan transaction even without unindexed root HTML. A root-only
preflight now avoids unrelated body reads when no candidate exists; actual orphan
candidates still enter the existing validated recovery path. Tests cover unrelated
unavailable writing, root placeholders, nonrecursive desktop/Pocket enumeration,
real orphan discovery and preservation of missing indexed notes. This does not
weaken native durable writes or replace unavailable files with empty results.

The final search follow-up batches initial populations and large reductions in
attached DOM. Blank All search fills with available results while pending coverage
remains explicit, avoiding thousands of initial loading-placeholder rows. Explicit
queries/filters retain known metadata matches; unsaved live results appear before
the read settles. A deferred-body regression checks these cases and a bulk-result
reduction checks retained identity, keyboard focus and removal of stale results.

A final two-axis read-only review of Task 7 and the follow-up working diff found
zero actionable Standards findings and zero actionable Spec findings. That review
does not close native, manual screen-reader or performance acceptance gates.

### Final cold-load observation

The final actual-app/IPC/storage run (`app-wide-10000-incremental-results.json`)
completed all 10,000 notes within an explicit 360-second test budget. First matching
results appeared in **322 ms** and full cold hydration finished in **179.1 seconds**.
Adapter diagnostics attribute **116.5 seconds** to 10,001 durable observation
writes. Queue-inclusive service timings overlap and must not be summed with
adapter timings as independent wall time. Five post-load query dispatches measured
about **6.9–7.9 ms** across IPC. These are single-run observations, not guarantees.

The prior bulk-DOM run took 35.7 seconds to its first result and 215.7 seconds to
full hydration. Available-first blank results remove that initial placeholder wall
while keeping incomplete coverage explicit. Earlier 120-second failures remain in
the record. Completion with a longer budget does **not** establish acceptable cold
loading or implicitly authorize a size cap. Performance acceptance remains open.

At 1,000 notes, the profiled read-only/preflight path completed cold hydration in
17.0 seconds, versus the earlier 38.3 seconds after scoped listings alone. First
results appeared in 435 ms. The full 635-test Node suite and latest full domain,
fault and conflict campaign pass. Native device and manual screen-reader checks
remain unavailable/outstanding, so ordinary-user enablement stays off.
