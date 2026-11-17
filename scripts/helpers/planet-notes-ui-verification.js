'use strict';
(function () {
function assertNoRendererErrors(errors) {
  if (errors.length) throw new Error('Renderer errors during stress run:\n' + errors.join('\n'));
}
function assertEndDestination(actualId, visibleIds) {
  const expected = visibleIds.at(-1);
  if (!expected || actualId !== expected) throw new Error('Keyboard End destination: expected ' + expected + ', received ' + actualId);
}
/** Renderer event-loop/input-delivery probe, not OS/hardware typing latency.
 * Schedule before starting work so its first synchronous block is included.
 * Dispatch input without changing the editor's words. Stop only after a pending
 * delivery, ensuring even entirely synchronous work produces a sample.
 */
async function measureInputDuring(target, work, {
  now = () => performance.now(), schedule = (fn, delay) => setTimeout(fn, delay),
  cancel = timer => clearTimeout(timer), event = () => new Event('input', { bubbles: true }), intervalMs = 16
} = {}) {
  const samples = []; let timer; let stopping = false; let deliverFinal;
  const finalDelivery = new Promise(resolve => { deliverFinal = resolve; });
  const arm = delay => {
    const due = now() + delay;
    timer = schedule(() => {
      const started = now();
      target.dispatchEvent(event());
      samples.push({ deliveryDelayMs: Math.max(0, started - due), handlerMs: now() - started });
      if (stopping) deliverFinal();
      else arm(intervalMs);
    }, delay);
  };
  arm(0);
  try {
    const value = await work();
    stopping = true;
    await finalDelivery;
    const delays = samples.map(sample => sample.deliveryDelayMs).sort((a, b) => a - b);
    return { value, inputDelay: { kind: 'renderer scheduled input delivery; not hardware latency', sampleCount: samples.length, p50Ms: delays[Math.floor((delays.length - 1) * .5)], p95Ms: delays[Math.ceil((delays.length - 1) * .95)], maxMs: delays.at(-1), samples } };
  } finally { stopping = true; cancel(timer); }
}
const api = { assertNoRendererErrors, assertEndDestination, measureInputDuring };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else globalThis.NeoPlanetNotesUIVerification = api;
})();
