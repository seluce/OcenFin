// Platform diagnostics for the move to webOS 26 (the test plan in CODE-HEALTH §39, §71). Debug log
// only: every entry point returns at once unless the device-wide debug switch is on, and nothing here
// changes behaviour — it watches and writes lines starting with "[diag]". Run it once on webOS 25 (the
// baseline: after the update there is no webOS 25 device left to ask), once on webOS 26, compare.
// Listeners are app-lifetime and registered once (`started`), like the root's own globals.
import { dlog, perfEnabled } from './utils.js';

const FOC = 'button, [href], input, select, textarea, [tabindex]';
const label = (el) => {
  if (!el || el === document.body) return el ? 'BODY' : null;
  const t = (el.getAttribute?.('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30);
  return `${el.tagName}${t ? ' "' + t + '"' : ''}`;
};

// Counts per name, logged for the first few hits only — enough to answer "does it fire at all?".
const counts = new Map();
export function diagCount(name, max = 3) {
  if (!perfEnabled()) return;
  const n = (counts.get(name) || 0) + 1;
  counts.set(name, n);
  if (n <= max) dlog(`[diag] ${name} #${n}`);
}

let started = false;
export function startPlatformDiagnostics() {
  if (started || !perfEnabled()) return;
  started = true;

  // Engine and library: webOS 25 = Chromium 120, webOS 26 = Chromium 132 (LG's web-engine table).
  dlog('[diag] engine', {
    chromium: /Chrome\/(\d+)/.exec(navigator.userAgent)?.[1] || null,
    webOSTVjs: window.webOS?.libVersion ?? null,
    webOSSystem: typeof window.webOSSystem,
    resizableWasmMemory: typeof WebAssembly?.Memory?.prototype?.toResizableBuffer === 'function',   // JASSUB: Chromium 136+
    rvfcPresent: typeof HTMLVideoElement.prototype.requestVideoFrameCallback === 'function',
  });

  // Magic Remote — what the device reports. Tailwind's hover: rules apply only under (hover: hover).
  const queries = ['(hover: hover)', '(any-hover: hover)', '(pointer: fine)', '(any-pointer: fine)'];
  dlog('[diag] pointer media', Object.fromEntries(queries.map(q => [q, matchMedia(q).matches])));
  for (const q of queries) matchMedia(q).addEventListener?.('change', (e) => dlog('[diag] pointer media changed', q, e.matches));

  // Cursor shown / hidden (LG: cursorStateChange on document, detail.visibility).
  let cursorVisible = null, cursorEvents = 0;
  document.addEventListener('cursorStateChange', (e) => {
    cursorVisible = !!e.detail?.visibility;
    if (++cursorEvents <= 20) dlog('[diag] cursorStateChange', cursorVisible ? 'visible' : 'hidden');
  });

  // OK while pointing: does the TV send keydown 13 to the FOCUSED element, a click at the CURSOR, or both?
  // A click made from Enter has detail 0 and no coordinates; a pointer click has detail ≥ 1.
  let lastPointer = null, lastOk = null, okSeen = 0, clicksSeen = 0;
  window.addEventListener('pointermove', (e) => { lastPointer = [e.clientX, e.clientY]; }, { capture: true, passive: true });
  window.addEventListener('keydown', (e) => {
    if (e.keyCode !== 13 || okSeen >= 10) return;
    okSeen++;
    const under = lastPointer ? document.elementFromPoint(lastPointer[0], lastPointer[1]) : null;
    lastOk = { t: performance.now(), focus: label(document.activeElement), underPointer: label(under?.closest(FOC) || under), cursor: cursorVisible };
    dlog('[diag] OK keydown', lastOk);
  }, true);
  window.addEventListener('click', (e) => {
    const near = lastOk && performance.now() - lastOk.t < 600;
    if (++clicksSeen > 20) return;
    dlog('[diag] click', { afterOk: !!near, target: label(e.target?.closest?.(FOC) || e.target), at: `${Math.round(e.clientX)},${Math.round(e.clientY)}`, detail: e.detail, pointerType: e.pointerType ?? null });
    if (near) lastOk = null;
  }, true);
}

// requestVideoFrameCallback: on webOS 25 present but silent (the Player replaces it with a rAF stand-in
// on the element). This asks the NATIVE one, from the prototype, once per app run, for 3 s of playback.
let rvfcAsked = false;
export function diagVideoFrames(video) {
  if (rvfcAsked || !perfEnabled() || !video) return;
  rvfcAsked = true;
  const native = HTMLVideoElement.prototype.requestVideoFrameCallback;
  if (typeof native !== 'function') { dlog('[diag] requestVideoFrameCallback: not present'); return; }
  let n = 0;
  const t0 = performance.now(), m0 = video.currentTime;
  const tick = () => { n++; if (performance.now() - t0 < 3000) native.call(video, tick); };
  native.call(video, tick);
  setTimeout(() => dlog('[diag] native requestVideoFrameCallback:', n, 'callbacks in 3 s, video advanced',
    (video.currentTime - m0).toFixed(1), 's →', n ? 'FIRES' : 'silent (the rAF stand-in is needed)'), 3100);
}
