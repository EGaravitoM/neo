'use strict';
const requiredGates = [
  ['domain-stress', 'Large/deep hierarchy, search and preserved material'],
  ['storage-faults', 'Every prepared-save write checkpoint and unavailable inputs'],
  ['sync-races', 'Repeated external edits without discarding observed versions'],
  ['desktop-ui', 'Large/deep real Notes interface and responsive editing/search'],
  ['accessibility', 'Keyboard alternatives, drag/drop destinations, focus and screen-reader checks'],
  ['fonts-themes', 'Inherited UI font, selected writing font, supported page themes'],
  ['backup-duplication', 'Complete notes recovery state and independent duplicates'],
  ['regressions', 'Existing Node and Electron suites, ordinary-launch feature gate'],
  ['pocket-ui', 'Required Pocket workflows in the shared interface'],
  ['native-ios', 'Native iCloud, replacement durability, links and suspension'],
  ['native-android', 'Native storage, permissions, links and suspension'],
  ['compatibility', 'Older-version limitations checked and documented'],
  ['performance-review', 'Measured findings resolved or explicitly reviewed']
];
const uiScenarios = [
  { id: 'large-tree', checks: ['all expanded items reachable', 'stable identities and duplicate names', 'no console errors'], metrics: ['loadMs', 'expandMs', 'domNodes', 'memoryBytes', 'inputDelayMs'] },
  { id: 'deep-tree', checks: ['leaf opens', 'ancestor navigation and move destinations', 'no stack overflow'], metrics: ['expandMs', 'leafOpenMs', 'inputDelayMs'] },
  { id: 'live-search', checks: ['unsaved words match', 'unavailable coverage explicit', 'screen-only highlights'], metrics: ['queryP50Ms', 'queryP95Ms', 'inputDelayMs'] },
  { id: 'keyboard-drag', checks: ['operations without dragging', 'destination preview', 'cycle rejected', 'focus returns'], metrics: ['operationMs'] },
  { id: 'fonts-themes', checks: ['computed UI font matches existing navigation', 'two selected body fonts match editor and recovery preview', 'Night/Paper/Light styling', 'no decoration in saved HTML'], metrics: [] },
  { id: 'pocket-recovery', checks: ['touch navigation and existing-note editing', 'read-only trash/conflicts', 'no management or restore commands', 'quiet failure and retry'], metrics: ['noteOpenMs', 'queryP95Ms'] }
];
function createReleaseReport({ seed, profile, environment = {} }) {
  return { schemaVersion: 1, seed, profile, createdAt: new Date().toISOString(), environment,
    fixtureSizesAreProductLimits: false, releaseReady: false,
    gates: requiredGates.map(([id, requirement]) => ({ id, requirement, status: 'not-run', evidence: [] })),
    results: [], findings: [], uiScenarios: uiScenarios.map(value => ({ ...value, status: 'not-run' })) };
}
function assessRelease(report) {
  const blockers = [];
  for (const [id] of requiredGates) {
    const rows = report.gates.filter(gate => gate.id === id);
    if (rows.length !== 1 || rows[0].status !== 'passed' || !Array.isArray(rows[0].evidence) || !rows[0].evidence.some(value => typeof value === 'string' && value.trim())) blockers.push(id);
  }
  for (const finding of report.findings) if (!['resolved', 'reviewed'].includes(finding.status) || !finding.evidence?.trim()) blockers.push('finding:' + finding.id);
  return { releaseReady: blockers.length === 0, blockers };
}
function markdownReport(report) {
  const assessment = assessRelease(report);
  return ['# Planet Notes release verification', '', 'Release ready: ' + (assessment.releaseReady ? 'yes' : 'no'), 'Profile: ' + report.profile + '; seed: ' + report.seed, '',
    'Fixture sizes are measurement inputs, not product limits.', '', '| Gate | Status | Evidence |', '| --- | --- | --- |',
    ...report.gates.map(g => '| ' + g.id + ' | ' + g.status + ' | ' + g.evidence.join('; ').replace(/\|/g, '\\|') + ' |'), '',
    '## Measurements', '', ...report.results.map(r => '- ' + r.id + ': ' + r.status + (r.error ? ' (' + r.error + ')' : r.samples ? '; query p50=' + r.queryP50Ms.toFixed(3) + 'ms, p95=' + r.queryP95Ms.toFixed(3) + 'ms; tree max=' + Math.max(...r.samples.map(s => s.treeMs)).toFixed(3) + 'ms; search-build max=' + Math.max(...r.samples.map(s => s.searchBuildMs)).toFixed(3) + 'ms' : '')), '',
    'Native and UI gates are not inferred from Node, mocked I/O, or synthetic evidence.', 'This report does not enable the feature.'].join('\n') + '\n';
}
module.exports = { requiredGates, uiScenarios, createReleaseReport, assessRelease, markdownReport };
