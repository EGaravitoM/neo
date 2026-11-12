'use strict';
(function () {
/**
 * Domain-only Pocket facade, installed inside pocket-bridge.js in implementation.
 * @param {Object} options
 * @param {boolean} options.enabled Explicit development gate; off in normal builds.
 * @param {Object} options.service Shared notes service with validated book contexts.
 * @returns {Object} window.neo methods; failures retain their code in the existing
 *   {status:'error', error:{code,message}} envelope. Mobile denies management and
 *   restoration even when a caller bypasses the UI. Internal recovery performed
 *   by editing/observation is still owned by the shared service.
 */
function createPocketNotesBridge({ enabled = false, service }) {
  const error = (code, message) => ({ status: 'error', error: { code, message } });
  const allowed = { notesLoad: 'load', notesRead: 'read', notesReadLegacy: 'readLegacy', notesSave: 'save', notesRefresh: 'refresh', notesRecoveryList: 'recoveryList', notesRecoveryRead: 'recoveryRead' };
  const bridge = { notesCapabilities: async () => ({ enabled: !!enabled, canManage: false, canRestore: false, fixtureInspection: false }) };
  for (const [name, method] of Object.entries(allowed)) { bridge[name] = async (...args) => {
    if (!enabled) return error('ENOTAVAILABLE', 'Custom Notes is not enabled');
    try { return await service[method](...args); }
    catch (err) { return error(err.code || 'EIO', err.message); }
  }; }
  for (const name of ['notesCreate', 'notesRename', 'notesCopy', 'notesOrganize', 'notesUndoOrganization', 'notesRecover']) bridge[name] = async () => error(enabled ? 'ENOTSUPPORTED' : 'ENOTAVAILABLE', 'This notes action requires desktop NEO');
  bridge.notesOrganizationState = async () => ({ canUndo: false });
  return bridge;
}

const api = { createPocketNotesBridge };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.NeoPlanetNotesPocketBridge = api;
})();
