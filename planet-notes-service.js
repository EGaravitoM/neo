'use strict';
(function () {
const node = typeof module !== 'undefined' && module.exports;

const { hash } = node ? require('./planet-notes-history') : globalThis.NeoPlanetNotesHistory;
const model = node ? require('./planet-notes') : globalThis.NeoPlanetNotes;
const { t, getLocale } = node ? require('./i18n') : globalThis.NeoI18n;
const { validateAction } = node ? require('./planet-notes-organization') : globalThis.NeoPlanetNotesOrganization;
const { createLibraryRecovery } = node ? require('./planet-notes-library-recovery') : globalThis.NeoPlanetNotesLibraryRecovery;
const { createOrganizationService } = node ? require('./planet-notes-organization-service') : globalThis.NeoPlanetNotesOrganizationService;
const { createNotesObserver } = node ? require('./planet-notes-observer') : globalThis.NeoPlanetNotesObserver;
const fail = (code, message) => Object.assign(new Error(message), { code });
const clone = (value) => JSON.parse(JSON.stringify(value));
const json = (value) => JSON.stringify(value);
const integrity = (record) => {
  const { checksum: _checksum, ...content } = record;
  return hash(json(content));
};
const required = (value) => {
  if (value.status !== 'ok') throw fail(value.status === 'unavailable' ? 'ECLOUD' : value.status === 'missing' ? 'ENOENT' : 'EINVAL', 'Required editor data: ' + value.status);
  return value;
};

/** Shared domain service. A book context contains the private store and adapter. */
function createNotesService({ getBook, enabled = false, makeId = (prefix) => prefix + '-' + (node ? require('node:crypto').randomUUID() : globalThis.crypto.randomUUID()), now = () => new Date().toISOString() }) {
  const contexts = new Map(); const queues = new Map();
  const id = (value) => { if (!model.safeId(value)) throw fail('EINVAL', 'Invalid notes identity'); };
  const active = () => { if (!enabled) throw fail('ENOTAVAILABLE', 'Custom Notes is not enabled'); };
  const bookIdentity = (value) => {
    if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\\/\0]/.test(value)) throw fail('EINVAL', 'Invalid book identity');
  };
  const context = (bookId) => {
    bookIdentity(bookId);
    if (!contexts.has(bookId)) {
      const pending = Promise.resolve().then(() => getBook(bookId)).catch((err) => { contexts.delete(bookId); throw err; });
      contexts.set(bookId, pending);
    }
    return contexts.get(bookId);
  };
  const serial = (bookId, fn) => {
    const next = (queues.get(bookId) || Promise.resolve()).catch(() => {}).then(async () => {
      const ctx = await context(bookId);
      if (ctx.assertValid) await ctx.assertValid();
      return fn(ctx);
    });
    queues.set(bookId, next);
    next.finally(() => { if (queues.get(bookId) === next) queues.delete(bookId); }).catch(() => {});
    return next;
  };
  const normalize = (kind, request) => {
    const fields = kind === 'copy' ? ['operationId', 'html', 'expectedBodyToken'] : kind === 'save' ? ['operationId', 'html', 'expectedBodyToken', 'writingDay'] : ['operationId', 'title'];
    if (!request || typeof request !== 'object' || Array.isArray(request) || Object.keys(request).some((key) => !fields.includes(key))) throw fail('EINVAL', 'Invalid editor command fields');
    id(request.operationId);
    if (kind === 'copy') {
      if (typeof request.html !== 'string' || typeof request.expectedBodyToken !== 'string') throw fail('EINVAL', 'Invalid editable copy');
      return { operationId: request.operationId, html: request.html, expectedBodyToken: request.expectedBodyToken };
    }
    if (kind === 'save') {
      if (typeof request.html !== 'string' || typeof request.expectedBodyToken !== 'string' || !model.validDay(request.writingDay)) throw fail('EINVAL', 'Invalid note save');
      return { operationId: request.operationId, html: request.html, expectedBodyToken: request.expectedBodyToken, writingDay: request.writingDay };
    }
    if (request.title !== undefined && typeof request.title !== 'string') throw fail('EINVAL', 'Invalid note title');
    return { operationId: request.operationId, title: (request.title || '').trim() };
  };
  const freshId = (prefix) => { const value = makeId(prefix); id(value); return value; };
  const validatePrepared = async (record, semantic) => {
    if (!record || typeof record.checksum !== 'string' || record.checksum !== await integrity(record) || record.schemaVersion !== 1 || json(record.semantic) !== json(semantic) || !model.safeId(record.noteId) || !model.validDate(record.createdAt)) throw fail('EINVAL', 'Invalid or reused prepared command');
    const compiled = record.compiled;
    if (!compiled || !compiled.request || !model.safeId(record.versionId)) throw fail('EINVAL', 'Invalid compiled command');
    const r = compiled.request;
    if (r.operationId !== semantic.request.operationId) throw fail('EINVAL', 'Mismatched operation identity');
    if (compiled.method === 'noop') {
      if (semantic.kind === 'create' || semantic.noteId !== record.noteId || r.baseVersionId !== record.versionId || !model.safeId(r.baseVersionId)) throw fail('EINVAL', 'Invalid no-op command');
      return;
    }
    if (semantic.kind === 'save') {
      if (compiled.method !== 'saveNote' || r.noteId !== record.noteId || r.versionId !== record.versionId || !model.safeId(r.baseVersionId) || r.versionId === r.baseVersionId || r.reason !== 'daily' || r.createdAt !== record.createdAt || r.html !== semantic.request.html || r.expectedBodyToken !== semantic.request.expectedBodyToken || r.writingDay !== semantic.request.writingDay) throw fail('EINVAL', 'Invalid compiled save');
    } else {
      if (compiled.method !== 'apply' || model.validateIndex(r.nextIndex).status !== 'ok' || r.nextIndex.versionId !== record.versionId || !Array.isArray(r.bodies) || (r.baseVersionId !== null && !model.safeId(r.baseVersionId))) throw fail('EINVAL', 'Invalid compiled metadata');
      const note = r.nextIndex.notes.find((n) => n.id === record.noteId);
      if (!note || (semantic.kind !== 'copy' && note.title !== semantic.request.title)) throw fail('EINVAL', 'Invalid compiled title');
      if (semantic.kind === 'create' || semantic.kind === 'copy') {
        if (note.parentId !== null || note.createdAt !== record.createdAt || r.bodies.length !== 1 || r.bodies[0].noteId !== record.noteId || r.bodies[0].expectedBodyToken !== null || r.bodies[0].html !== (semantic.kind === 'copy' ? semantic.request.html : '<p><br></p>')) throw fail('EINVAL', 'Invalid compiled creation');
      } else if (r.bodies.length || semantic.noteId !== record.noteId) throw fail('EINVAL', 'Invalid compiled rename');
    }
    if (!['create', 'copy'].includes(semantic.kind) && semantic.noteId !== record.noteId) throw fail('EINVAL', 'Mismatched target');
  };
  const completionPath = (record) => 'recovery/editor-completions/' + record.semantic.request.operationId + '.json';
  const completed = async (ctx, record) => {
    const result = await ctx.adapter.read(completionPath(record));
    if (result.status === 'missing') return false;
    const saved = required(result);
    if (saved.text !== json({ checksum: record.checksum })) throw fail('EINVAL', 'Invalid editor completion');
    return true;
  };
  const execute = async (ctx, record) => {
    let result = record.compiled.method === 'noop' ? { status: 'saved', versionId: record.versionId } : await ctx.store[record.compiled.method](record.compiled.request);
    if (result.status === 'conflict' && record.semantic.kind === 'save') {
      // A proven competing version needs a new durable plan, never mutation of
      // the original command. The original identity still owns its completion.
      const path = 'recovery/editor-resolutions/' + record.semantic.request.operationId + '.json';
      let source = await ctx.adapter.read(path); let resolution;
      if (source.status === 'missing') {
        const loaded = required(await ctx.store.load());
        const body = required(await ctx.store.read(record.noteId));
        const request = record.semantic.request;
        await observer(ctx).observe(record.noteId, body.html);
        await observer(ctx).observe(record.noteId, request.html);
        const common = { operationId: 'o-resolution-' + record.checksum, versionId: freshId('v'), createdAt: now(), baseVersionId: loaded.index.versionId, noteId: record.noteId };
        resolution = body.html !== request.expectedBodyToken && body.html !== request.html
          ? { method: 'preserveBodyConflict', request: { ...common, localHtml: request.html, incomingHtml: body.html, expectedBodyToken: request.expectedBodyToken } }
          : { method: 'saveNote', request: { ...common, html: request.html, expectedBodyToken: body.html, writingDay: request.writingDay, reason: 'daily' } };
        const envelope = { checksum: record.checksum, resolution, digest: await hash(json(resolution)) };
        await ctx.adapter.writeDurable(path, json(envelope));
        source = await ctx.adapter.read(path);
      }
      let envelope;
      try { envelope = JSON.parse(required(source).text); } catch { throw fail('EINVAL', 'Invalid command resolution'); }
      if (envelope.checksum !== record.checksum || envelope.digest !== await hash(json(envelope.resolution)) || !['saveNote', 'preserveBodyConflict'].includes(envelope.resolution?.method) || envelope.resolution.request?.noteId !== record.noteId) throw fail('EINVAL', 'Invalid command resolution');
      resolution = envelope.resolution;
      result = await ctx.store[resolution.method](resolution.request);
    }
    if (result.status !== 'saved') return result;
    if (!await completed(ctx, record)) await ctx.adapter.writeDurable(completionPath(record), json({ checksum: record.checksum }));
    return { ...result, noteId: record.noteId, ...(record.semantic.kind === 'save' ? { bodyToken: record.semantic.request.html } : { title: record.semantic.request.title }) };
  };
  // A prepared command may not yet have a store intent. Settle it before ANY
  // later command is compiled, including after a service restart.
  const settle = async (ctx, except = null) => {
    for (const path of (await ctx.adapter.list()).filter((p) => /^recovery\/editor-commands\/[^/]+\.json$/.test(p)).sort()) {
      const source = required(await ctx.adapter.read(path));
      let record;
      try { record = JSON.parse(source.text); } catch { throw fail('EINVAL', 'Corrupt prepared editor command'); }
      await validatePrepared(record, record.semantic);
      if (record.semantic.request.operationId === except || await completed(ctx, record)) continue;
      if ((await execute(ctx, record)).status !== 'saved') throw fail('EPENDING', 'An earlier editor command needs recovery');
    }
  };
  const observer = (ctx) => ctx.observer || (ctx.observer = createNotesObserver({ ...ctx, makeId: freshId, now }));
  const organizations = new WeakMap();
  const organization = (ctx) => {
    if (!organizations.has(ctx)) organizations.set(ctx, createOrganizationService({ ...ctx, makeId: freshId, now, remember: () => observer(ctx).remember(), locale: getLocale }));
    return organizations.get(ctx);
  };
  const recoveries = new WeakMap();
  const recovery = (ctx) => {
    if (!recoveries.has(ctx)) recoveries.set(ctx, createLibraryRecovery({ ...ctx, makeId: freshId, now, remember: () => observer(ctx).remember() }));
    return recoveries.get(ctx);
  };
  const settleAll = async (ctx) => { await settle(ctx); await organization(ctx).settle(); await recovery(ctx).settle(); };
  const command = async (kind, bookId, noteId, request) => {
    active(); bookIdentity(bookId); if (noteId !== null) id(noteId);
    const normalized = normalize(kind, request);
    const semantic = { kind, bookId, noteId, request: normalized };
    return serial(bookId, async (ctx) => {
      const path = 'recovery/editor-commands/' + normalized.operationId + '.json';
      const old = await ctx.adapter.read(path);
      if (old.status === 'unavailable') throw fail('ECLOUD', 'Prepared editor command unavailable');
      if (old.status === 'ok') {
        let record;
        try { record = JSON.parse(old.text); } catch { throw fail('EINVAL', 'Corrupt prepared editor command'); }
        await validatePrepared(record, semantic);
        return execute(ctx, record);
      }
      await settleAll(ctx);
      await observer(ctx).metadata();
      const loaded = await ctx.store.load();
      if (loaded.status !== 'ok' && !(kind === 'create' && loaded.status === 'missing')) required(loaded);
      const createdAt = now(); if (!model.validDate(createdAt)) throw fail('EINVAL', 'Invalid editor clock');
      let versionId = freshId('v');
      const target = ['create', 'copy'].includes(kind) ? freshId('n') : noteId;
      const nextIndex = loaded.status === 'ok' ? clone(loaded.index) : { schemaVersion: 1, versionId, parentVersionIds: [], root: { sortMode: 'alphabetical', childOrder: [] }, groups: [], notes: [], labels: [], tombstones: [] };
      const baseVersionId = loaded.status === 'ok' ? loaded.index.versionId : null;
      if (versionId === baseVersionId) throw fail('EINVAL', 'Version ID was reused');
      let compiled;
      if (kind === 'save') {
        if (!nextIndex.notes.some((n) => n.id === noteId)) throw fail('ENOENT', 'Note is not indexed');
        const body = required(await ctx.store.read(noteId));
        await observer(ctx).observe(noteId, body.html);
        if (body.bodyToken !== normalized.expectedBodyToken) return { status: 'conflict' };
        if (body.html === normalized.html) {
          versionId = baseVersionId;
          compiled = { method: 'noop', request: { operationId: normalized.operationId, baseVersionId } };
        } else compiled = { method: 'saveNote', request: { ...normalized, noteId, baseVersionId, versionId, createdAt, reason: 'daily' } };
      } else {
        nextIndex.versionId = versionId; nextIndex.parentVersionIds = baseVersionId === null ? [] : [baseVersionId];
        if (kind === 'create' || kind === 'copy') {
          if ([...nextIndex.notes, ...nextIndex.groups, ...nextIndex.labels].some((item) => item.id === target)) throw fail('EINVAL', 'Note ID was reused');
          const existing = await ctx.store.read(target);
          if (existing.status !== 'missing') throw fail(existing.status === 'unavailable' ? 'ECLOUD' : 'ECONFLICT', 'Creation destination unavailable');
          let title = normalized.title;
          if (kind === 'copy') {
            const source = nextIndex.notes.find((n) => n.id === noteId);
            if (!source) throw fail('ENOENT', 'Copy source missing');
            const body = required(await ctx.store.read(noteId));
            if (body.bodyToken !== normalized.expectedBodyToken) return { status: 'conflict' };
            await observer(ctx).observe(noteId, body.html);
            title = t('{title} (editable copy)', { title: source.title });
          }
          nextIndex.notes.push({ id: target, title, parentId: null, labelIds: [], createdAt });
          nextIndex.root.childOrder.push(target);
        } else {
          const note = nextIndex.notes.find((n) => n.id === target);
          if (!note) throw fail('ENOENT', 'Note is not indexed');
          if (note.title === normalized.title) {
            versionId = baseVersionId;
            compiled = { method: 'noop', request: { operationId: normalized.operationId, baseVersionId } };
          }
          note.title = normalized.title;
        }
        // All body references must be known before preparing a command.
        for (const note of nextIndex.notes) if (!['create', 'copy'].includes(kind) || note.id !== target) required(await ctx.store.read(note.id));
        if (!compiled) compiled = { method: 'apply', request: { operationId: normalized.operationId, baseVersionId, nextIndex, bodies: ['create', 'copy'].includes(kind) ? [{ noteId: target, html: kind === 'copy' ? normalized.html : '<p><br></p>', expectedBodyToken: null }] : [] } };
      }
      const record = { schemaVersion: 1, semantic, noteId: target, createdAt, versionId, compiled };
      record.checksum = await integrity(record);
      await validatePrepared(record, semantic);
      // Never replace even a malformed ledger: a retry must use the same plan.
      const check = await ctx.adapter.read(path);
      if (check.status === 'unavailable') throw fail('ECLOUD', 'Prepared command unavailable');
      if (check.status === 'ok' && check.text !== json(record)) throw fail('ECONFLICT', 'Prepared command identity collision');
      if (check.status === 'missing') await ctx.adapter.writeDurable(path, json(record));
      if (required(await ctx.adapter.read(path)).text !== json(record)) throw fail('EIO', 'Prepared command verification failed');
      const result = await execute(ctx, record);
      if (result.status === 'saved') await observer(ctx).remember();
      return result;
    });
  };
  return {
    capabilities: async () => ({ enabled: !!enabled, canManage: !!enabled, canRestore: !!enabled }),
    load: async (bookId) => { bookIdentity(bookId); return enabled ? serial(bookId, async (ctx) => { await settleAll(ctx); return observer(ctx).metadata(); }) : { status: 'disabled' }; },
    read: async (bookId, noteId) => {
      active(); bookIdentity(bookId); id(noteId);
      return serial(bookId, async (ctx) => {
        await settleAll(ctx); await observer(ctx).metadata();
        const loaded = await ctx.store.load(); if (loaded.status !== 'ok') return loaded;
        const note = loaded.index.notes.find((n) => n.id === noteId); if (!note) return { status: 'missing' };
        const body = await ctx.store.read(noteId);
        if (body.status === 'ok') { await observer(ctx).observe(noteId, body.html); await observer(ctx).remember(); }
        return body.status === 'ok' ? { ...body, title: note.title, versionId: loaded.index.versionId } : body;
      });
    },
    refresh: (bookId, noteId, request) => {
      active(); bookIdentity(bookId); id(noteId);
      if (!request || Object.keys(request).some((k) => !['baseBodyToken', 'localHtml'].includes(k)) || typeof request.baseBodyToken !== 'string' || typeof request.localHtml !== 'string') throw fail('EINVAL', 'Invalid refresh request');
      return serial(bookId, async (ctx) => { await settleAll(ctx); return observer(ctx).refresh(noteId, request); });
    },
    copy: (bookId, noteId, request) => command('copy', bookId, noteId, request),
    organize: async (bookId, request, session = 'default') => {
      active(); bookIdentity(bookId);
      const normalized = validateAction(request);
      return serial(bookId, async (ctx) => { await settleAll(ctx); await observer(ctx).metadata(); return organization(ctx).organize(normalized, session); });
    },
    undoOrganization: async (bookId, request, session = 'default') => {
      active(); bookIdentity(bookId);
      if (!request || !model.safeId(request.operationId) || Object.keys(request).some((key) => key !== 'operationId')) throw fail('EINVAL', 'Invalid organization undo');
      const normalized = { operationId: request.operationId };
      return serial(bookId, async (ctx) => { await settleAll(ctx); await observer(ctx).metadata(); return organization(ctx).undo(normalized, session); });
    },
    organizationState: async (bookId, session = 'default') => {
      active(); bookIdentity(bookId);
      return serial(bookId, async (ctx) => ({ canUndo: organization(ctx).canUndo(session) }));
    },
    readLegacy: async (bookId, request) => {
      active(); bookIdentity(bookId);
      if (!request || Object.keys(request).some((key) => key !== 'page') || typeof request.page !== 'string' || /[\\/\0]/.test(request.page)) throw fail('EINVAL', 'Invalid legacy notes page');
      const normalized = { page: request.page };
      return serial(bookId, (ctx) => ctx.readLegacy ? ctx.readLegacy(normalized) : { status: 'missing' });
    },
    recoveryList: async (bookId, request) => {
      active(); bookIdentity(bookId); const snapshot = clone(request);
      return serial(bookId, async (ctx) => { await settleAll(ctx); return recovery(ctx).list(snapshot); });
    },
    recoveryRead: async (bookId, request) => {
      active(); bookIdentity(bookId); const snapshot = clone(request);
      return serial(bookId, async (ctx) => { await settleAll(ctx); return recovery(ctx).read(snapshot); });
    },
    recover: async (bookId, request) => {
      active(); bookIdentity(bookId); const snapshot = clone(request);
      return serial(bookId, async (ctx) => { await settleAll(ctx); await observer(ctx).metadata(); return recovery(ctx).perform(snapshot); });
    },
    create: (bookId, request) => command('create', bookId, null, request),
    rename: (bookId, noteId, request) => command('rename', bookId, noteId, request),
    save: (bookId, noteId, request) => command('save', bookId, noteId, request)
  };
}
const api = { createNotesService };
if (node) module.exports = api;
else globalThis.NeoPlanetNotesService = api;
})();
