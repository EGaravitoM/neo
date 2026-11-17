#!/usr/bin/env node
'use strict';
// Plan by default. --run is deliberately explicit; this tool never enables NEO.
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const { fork, execFileSync } = require('node:child_process');
const { profiles } = require('./helpers/planet-notes-stress-fixtures');
const { createReleaseReport, assessRelease, markdownReport } = require('./helpers/planet-notes-release-report');
function options(argv) {
  const result = { profile: 'smoke', seed: 7301, runs: 3, timeoutMs: 120000, run: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--run') result.run = true;
    else if (arg === '--plan') result.run = false;
    else if (['--profile', '--seed', '--runs', '--timeout-ms', '--out'].includes(arg)) {
      const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error('Missing value for ' + arg);
      const name = { '--profile': 'profile', '--seed': 'seed', '--runs': 'runs', '--timeout-ms': 'timeoutMs', '--out': 'out' }[arg];
      result[name] = ['seed','runs','timeoutMs'].includes(name) ? Number(value) : value;
    } else throw new Error('Unknown stress option: ' + arg);
  }
  if (!Object.hasOwn(profiles, result.profile)) throw new Error('Unknown stress profile');
  for (const key of ['seed','runs','timeoutMs']) if (!Number.isSafeInteger(result[key]) || result[key] < (key === 'seed' ? 0 : 1)) throw new Error('Invalid ' + key);
  return result;
}
function environment() {
  let commit = null; let dirty = null;
  try { const cwd = path.join(__dirname, '..'); commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim(); dirty = !!execFileSync('git', ['status', '--porcelain'], { cwd, encoding: 'utf8' }).trim(); } catch { /* report unknown rather than invent a revision */ }
  return { node: process.version, platform: process.platform, arch: process.arch, osRelease: os.release(), cpu: os.cpus()[0]?.model || null, commit, dirty };
}
function plan(config, host = environment()) {
  const report = createReleaseReport({ seed: config.seed, profile: config.profile, environment: host });
  report.execution = 'not-run'; report.runs = config.runs; report.caseTimeoutMs = config.timeoutMs;
  report.cases = profiles[config.profile].map(definition => ({ ...definition, status: 'not-run' }));
  report.storageScenarios = ['each-save-write-checkpoint', 'unavailable-index-and-body', 'repeated-external-versions', 'history-scaling'];
  return report;
}
function worker(job, timeoutMs) {
  return new Promise(resolve => {
    const child = fork(__filename, ['--worker', JSON.stringify(job)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let settled = false; let stderr = '';
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); resolve(result); };
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-8192); });
    const timer = setTimeout(() => { child.kill(); finish({ id: job.id, status: 'failed', error: 'Worker timed out after ' + timeoutMs + 'ms; fixture size is not a product limit' }); }, timeoutMs);
    child.once('message', finish);
    child.once('error', err => finish({ id: job.id, status: 'failed', error: err.message }));
    child.once('exit', (code, signal) => finish({ id: job.id, status: 'failed', error: 'Worker exited without results: ' + (signal || code) + ' ' + stderr }));
  });
}
async function execute(config, runWorker = worker) {
  const report = plan(config); if (!config.run) return report;
  report.execution = 'completed';
  const jobs = [...profiles[config.profile].map(definition => ({ id: definition.id, type: 'domain', definition, seed: config.seed, runs: config.runs })), { id: 'storage-faults', type: 'storage' }, { id: 'sync-races', type: 'sync' }, { id: 'history-scaling', type: 'history', checkpoints: config.profile === 'full' ? [0, 30, 300] : [0, 5, 15] }];
  for (const job of jobs) {
    const result = await runWorker(job, config.timeoutMs); report.results.push(result);
    if (result.status !== 'passed') report.findings.push({ id: job.id, status: 'open', evidence: result.error || 'Case did not pass', scope: 'Node/simulated I/O' });
    process.stderr.write(job.id + ': ' + result.status + '\n');
  }
  for (const [gateId, ids] of [['domain-stress', profiles[config.profile].map(c => c.id)], ['storage-faults', ['storage-faults']], ['sync-races', ['sync-races']]]) {
    const gate = report.gates.find(g => g.id === gateId); const results = report.results.filter(r => ids.includes(r.id));
    if (results.some(r => r.status !== 'passed')) gate.status = 'failed';
    else if (config.profile === 'full') gate.status = 'passed';
    if (gate.status !== 'not-run') gate.evidence = ['Node/simulated I/O only: ' + results.map(r => r.id).join(', ')];
  }
  for (const entry of report.cases) entry.status = report.results.find(r => r.id === entry.id)?.status || 'not-run';
  report.releaseReady = assessRelease(report).releaseReady;
  return report;
}
function writeReport(report, output) {
  const base = path.resolve(output).replace(/\.json$/i, ''); const json = base + '.json'; const markdown = base + '.md';
  if (fs.existsSync(json) || fs.existsSync(markdown)) throw new Error('Report output exists; choose a fresh evidence path');
  fs.mkdirSync(path.dirname(json), { recursive: true });
  fs.writeFileSync(json, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  fs.writeFileSync(markdown, markdownReport(report), { flag: 'wx' }); return { json, markdown };
}
async function main(argv) {
  if (argv[0] === '--worker') {
    const job = JSON.parse(argv[1]); const cases = require('./helpers/planet-notes-stress-scenarios'); let result;
    try { result = job.type === 'domain' ? await cases.runDomainCase(job.definition, job) : job.type === 'storage' ? await cases.runStorageFaults() : job.type === 'sync' ? await cases.runSyncRaces() : job.type === 'history' ? await cases.runHistoryScaling(job) : (() => { throw new Error('Unknown worker case'); })(); }
    catch (err) { result = { id: job.id, status: 'failed', error: err.stack || err.message }; }
    if (!process.send) throw new Error('Stress workers require the parent runner');
    process.send(result, () => process.disconnect()); return;
  }
  const config = options(argv); const report = await execute(config);
  if (config.out) process.stdout.write(JSON.stringify({ ...writeReport(report, config.out), execution: report.execution, releaseReady: report.releaseReady }) + '\n');
  else process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.results.some(r => r.status !== 'passed')) process.exitCode = 1;
}
if (require.main === module) main(process.argv.slice(2)).catch(err => { console.error(err.message); process.exitCode = 1; });
module.exports = { options, plan, worker, execute, writeReport };
