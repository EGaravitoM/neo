# NG+ — Planet Notes release follow-up

Codex follow-up chat: `01a1d131-2680-7482-a91b-bf34bb1570c0` (NG+).

Status: deferred at the author's request. Stages 1–7 implementation and automated
verification are closed as a delivery milestone. The unfinished release checks
below belong to NG+; transferring them does not pass them or authorize release.

## Scope

- **Performance acceptance:** review or further improve the 10,000-note cold
  search (first result 322 ms; full hydration 179.1 s, including 116.5 s of durable
  observation writes). Review remaining large/deep tree input delays using the
  recorded profiles. Resolve or explicitly accept findings `full-app-hydration`
  and `repeated-tree-render`. No collection/nesting cap or weaker preservation
  guarantee is authorized by this handoff.
- **Native iOS and Android verification:** exercise required Pocket browsing,
  editing, search, read-only recovery/conflict inspection, cloud availability,
  durable replacement, supported links, permissions and suspension/resume.
  Verify complete backup/duplication behavior on the target platforms. Current
  prerequisites are missing: no iOS Simulator SDK/full Xcode, no connected
  Android device or available emulator/SDK configuration.
- **Manual interaction and accessibility:** verify real pointer drag/drop,
  destination previews and cycle rejection, keyboard alternatives and focus,
  screen-reader announcements/navigation, and the remaining deep hierarchy move
  and navigation matrix. Automated keyboard/DragEvent and Chromium accessibility
  tree checks already pass; they do not substitute for these manual checks.

## Evidence and current baseline

Repository: `/Users/juegos0038/Documents/personal/code/neo-planet-notes`.
Delivery commit at handoff: `c032202` (Optimize Planet Notes explorer rendering and
store caching). Read the current repository state and applicable instructions
before resuming; do not assume this commit remains HEAD.

- 635 Node tests pass; all seven renderer profiles and desktop/Pocket regression
  suites pass. Follow-up Standards and Spec reviews each have zero findings.
- `PLANET-NOTES-VERIFICATION.md` records measurements and limitations.
- `PLANET-NOTES-RELEASE-REPORT.json` retains open/partial/not-run gates and findings.
- `PLANET-NOTES-COMPATIBILITY.md` limits the older-version source audit to v1.6.4.
- Raw measurements and screenshots are in ignored local `stress-results/`;
  preserve existing artifacts and choose fresh paths when rerunning evidence.

## Completion criteria

Resolve or explicitly review the recorded performance findings; complete required
native and manual verification; fix failures and run relevant regressions. Update
the verification documents and report with genuine evidence and assess all release
gates again. Keep normal-user feature gates off until the complete release scope
passes. Deferral, a longer benchmark budget, simulated native I/O, and transfer to
this task do not count as successful release verification.

Universe Notes, permanent deletion, retention cleanup and other new product scope
are not part of NG+. Do not start this deferred work until the author resumes it.
