'use strict';
(function () {
const node = typeof module !== 'undefined' && module.exports;

const { hash } = node ? require('./planet-notes-history') : globalThis.NeoPlanetNotesHistory;
const domain = node ? require('./planet-notes-organization') : globalThis.NeoPlanetNotesOrganization;
const model = node ? require('./planet-notes') : globalThis.NeoPlanetNotes;
const json = JSON.stringify;
const digest = (value) => hash(json(value));
const fail = (code, message) => Object.assign(new Error(message), { code });
const required = (value) => {
  if (value.status !== 'ok') throw fail(value.status === 'unavailable' ? 'ECLOUD' : value.status === 'missing' ? 'ENOENT' : 'EINVAL', 'Organization resolution source: ' + value.status);
  return value;
};

/** Runs inside the book queue. Each observed head gets its own immutable attempt;
 * stale attempts remain evidence, not a permanent precondition on future saves. */
function createOrganizationResolution({ adapter, store, makeId, now, readPlan }) {
  const artifact = async (path, text) => {
    const old = await adapter.read(path);
    if (old.status === 'missing') await adapter.writeDurable(path, text);
    else if (required(old).text !== text) throw fail('EINVAL', 'Organization resolution identity collision');
    if (required(await adapter.read(path)).text !== text) throw fail('EIO', 'Organization resolution verification failed');
  };
  const archive = (index) => artifact('recovery/index-versions/' + index.versionId + '.json', json(index));
  const decodeAttempt = async (text, plan) => {
    let envelope;
    try { envelope = JSON.parse(text); } catch { throw fail('EINVAL', 'Invalid organization resolution'); }
    let attempt = envelope.attempt;
    // Keep previously prepared Stage 4 resolutions readable and immutable.
    if (!attempt && envelope.resolution && envelope.digest === await digest(envelope.resolution)) attempt = { schemaVersion: 1, planDigest: await digest(plan), method: 'reconcileMetadata', request: envelope.resolution, incomingIndex: envelope.resolution.incomingIndex };
    else if (!attempt || envelope.digest !== await digest(attempt)) throw fail('EINVAL', 'Invalid organization resolution digest');
    const r = attempt.request;
    if (attempt.schemaVersion !== 1 || attempt.planDigest !== await digest(plan) || !r || !model.safeId(r.operationId) || model.validateIndex(attempt.incomingIndex).status !== 'ok') throw fail('EINVAL', 'Invalid organization resolution identity');
    if (attempt.method === 'reconcileMetadata') {
      let observed;
      try { observed = JSON.parse(r.expectedIndexToken); } catch { throw fail('EINVAL', 'Invalid organization observation token'); }
      if (json(r.localIndex) !== json(plan.after) || json(r.incomingIndex) !== json(attempt.incomingIndex) || typeof r.expectedIndexToken !== 'string' || json(observed) !== json(r.incomingIndex)) throw fail('EINVAL', 'Invalid organization merge snapshots');
    } else if (attempt.method === 'apply') {
      if (plan.kind !== 'undo' || model.validateIndex(r.nextIndex).status !== 'ok' || r.baseVersionId !== attempt.incomingIndex.versionId || !Array.isArray(r.bodies) || r.bodies.length || !r.nextIndex.parentVersionIds.includes(plan.after.versionId)) throw fail('EINVAL', 'Invalid organization undo attempt');
    } else throw fail('EINVAL', 'Invalid organization resolution method');
    if (attempt.incomingToken !== undefined) {
      let observed;
      try { observed = JSON.parse(attempt.incomingToken); } catch { throw fail('EINVAL', 'Invalid undo observation token'); }
      if (typeof attempt.incomingToken !== 'string' || json(observed) !== json(attempt.incomingIndex)) throw fail('EINVAL', 'Invalid undo observation snapshot');
    }
    return attempt;
  };
  const attemptsFor = async (plan) => {
    const legacy = 'recovery/organization-resolutions/' + plan.request.operationId + '.json';
    const directory = 'recovery/organization-resolutions/' + plan.request.operationId + '/';
    const paths = (await adapter.list()).filter((path) => path.startsWith(directory) && path.endsWith('.json')).sort();
    const first = await adapter.read(legacy);
    const attempts = [];
    if (first.status !== 'missing') attempts.push({ path: legacy, attempt: await decodeAttempt(required(first).text, plan) });
    for (const path of paths) attempts.push({ path, attempt: await decodeAttempt(required(await adapter.read(path)).text, plan) });
    return { legacy, directory, attempts };
  };
  const retired = async (attempt) => {
    const prefix = attempt.method === 'apply' ? 'recovery/abandoned-metadata/' : 'recovery/abandoned-reconciliations/';
    const source = await adapter.read(prefix + attempt.request.operationId + '.json');
    if (source.status === 'missing') return false;
    required(source); // The store validates the marker before accepting it.
    return true;
  };
  const retire = (attempt) => attempt.method === 'apply' ? store.abandonMetadata(attempt.request) : store.abandonMetadataResolution(attempt.request);
  const expectedToken = (attempt) => attempt.method === 'reconcileMetadata' ? attempt.request.expectedIndexToken : attempt.incomingToken || json(attempt.incomingIndex);
  const originalRequest = (plan) => ({ operationId: plan.request.operationId, baseVersionId: plan.before.versionId, nextIndex: plan.after, bodies: [] });
  const undoIndex = async (plan, incoming) => {
    const source = await readPlan(plan.undoneOperationId);
    const before = source.before || { ...source.after, groups: [], notes: [], labels: [], root: { sortMode: 'alphabetical', childOrder: [] } };
    return domain.undoAction(incoming, before, source.after, source.request);
  };
  const resolve = async (plan) => {
    const original = originalRequest(plan);
    const represented = await store.acknowledgeMergedMetadata(original);
    if (represented.status === 'saved') return represented;
    const incoming = required(await store.load());
    const { legacy, directory, attempts } = await attemptsFor(plan);
    let undo;
    if (plan.kind === 'undo') {
      try { undo = await undoIndex(plan, incoming.index); }
      catch (err) {
        if (err.code !== 'ECONFLICT') throw err;
        // A rejected inverse must never be merged as the current device's winner.
        // Retire both its original intent and any interrupted attempts first.
        for (const entry of attempts) await retire(entry.attempt);
        return store.abandonMetadata(original);
      }
    }
    let selected;
    for (const entry of attempts) {
      const wasRetired = await retired(entry.attempt);
      if (wasRetired || expectedToken(entry.attempt) !== incoming.indexToken) await retire(entry.attempt);
      else selected = entry.attempt;
    }
    if (!selected) {
      const key = await digest({ planDigest: await digest(plan), incomingToken: incoming.indexToken, previousAttempts: attempts.length });
      let request; let method;
      // Preserve the exact snapshots before an attempt can become an ancestor.
      await archive(plan.after); await archive(incoming.index);
      if (plan.kind === 'undo') {
        undo.versionId = makeId('v');
        undo.parentVersionIds = [...new Set([incoming.index.versionId, plan.after.versionId])];
        request = { operationId: 'o-orgundo-' + key, baseVersionId: incoming.index.versionId, nextIndex: undo, bodies: [] };
        method = 'apply';
      } else {
        request = { operationId: 'o-orgmerge-' + key, versionId: makeId('v'), createdAt: now(), baseVersionId: plan.before.versionId, localIndex: plan.after, incomingIndex: incoming.index, expectedIndexToken: incoming.indexToken };
        method = 'reconcileMetadata';
      }
      selected = { schemaVersion: 1, planDigest: await digest(plan), method, request, incomingIndex: incoming.index, incomingToken: incoming.indexToken };
      const path = attempts.length ? directory + key + '.json' : legacy;
      await artifact(path, json({ attempt: selected, digest: await digest(selected) }));
    }
    const result = await store[selected.method](selected.request);
    if (result.status === 'conflict' || result.status === 'conflict-preserved') {
      await retire(selected);
      throw fail('EPENDING', 'Organization changed during resolution; retry the prepared command');
    }
    if (result.status !== 'saved') return result;
    return store.acknowledgeMergedMetadata(original);
  };
  return { resolve };
}
const api = { createOrganizationResolution };
if (node) module.exports = api;
else globalThis.NeoPlanetNotesOrganizationResolution = api;
})();
