// Theme music for the details view. A single module-level <audio> element, deliberately OUTSIDE any
// component: Details keeps one instance across item changes (no {#key} around it in App), but the
// theme must also survive the async gap between two loads and keep fading after Details unmounts.
//
// Identity is the ThemeSongsResult.OwnerId — for episodes/seasons that is the SERIES (we query with
// inheritFromParent=true), so navigating within one series keeps the theme playing seamlessly
// instead of restarting it on every page.
//
// Playback is a plain static stream (theme.mp3 next to the media → Direct Play, no transcode).
// Volume is a percentage (5–100) from playbackPrefs; fades run ~700 ms so entering/leaving never
// cuts hard. All failures are silent by design: a missing or broken theme must never surface as an
// error on the details page.
import { session } from './session.svelte.js';
import { authHeaders, dlog } from './utils.js';

const FADE_MS   = 700;
const FADE_STEP = 50;    // ms per fade tick

let audio          = null;   // lazily created, reused for the whole session
let currentOwnerId = null;   // OwnerId of the playing theme (null = nothing active)
let targetVolume   = 0.4;    // 0..1, set from the pref on every play call
let fadeTimer      = null;
let suppressed     = false;  // screensaver up → keep state, but be silent
let fetchSeq       = 0;      // supersede guard for the ThemeMedia fetch

function ensureAudio() {
  if (!audio) {
    audio = new Audio();
    audio.loop = true;
    audio.preload = 'auto';
  }
  return audio;
}

function clearFade() { if (fadeTimer) { clearInterval(fadeTimer); fadeTimer = null; } }

// Fade the element's volume linearly to `to` (0..1); optional callback once there.
function fadeTo(to, done) {
  clearFade();
  if (!audio) { done?.(); return; }
  const from  = audio.volume;
  const steps = Math.max(1, Math.round(FADE_MS / FADE_STEP));
  let i = 0;
  fadeTimer = setInterval(() => {
    i++;
    audio.volume = Math.max(0, Math.min(1, from + (to - from) * (i / steps)));
    if (i >= steps) { clearFade(); done?.(); }
  }, FADE_STEP);
}

function releaseSource() {
  if (!audio) return;
  audio.pause();
  // Actually drop the network resource — pause() alone keeps the connection/buffer alive.
  audio.removeAttribute('src');
  try { audio.load(); } catch { /* webOS can throw on empty load; harmless */ }
}

/**
 * Play (or keep playing) the theme for `item`. Resolves the theme via /ThemeMedia with
 * inheritFromParent, so episodes and seasons find their series theme. Same OwnerId as the current
 * one → no restart, just adopt the (possibly changed) volume.
 */
export async function playThemeFor(item, userId, volumePercent) {
  targetVolume = Math.max(5, Math.min(100, volumePercent ?? 40)) / 100;
  const mySeq = ++fetchSeq;
  try {
    const res = await fetch(
      `${session.serverUrl}/Items/${item.Id}/ThemeMedia?userId=${userId}&inheritFromParent=true`,
      { headers: authHeaders(session.token) }
    );
    if (!res.ok || mySeq !== fetchSeq) return;
    const data  = await res.json();
    if (mySeq !== fetchSeq) return;                    // superseded while parsing
    const songs = data?.ThemeSongsResult?.Items || [];
    if (!songs.length) { stopTheme(); return; }        // this title has no theme → silence
    const ownerId = data.ThemeSongsResult.OwnerId || item.Id;

    if (ownerId === currentOwnerId && audio && !audio.paused) {
      // Same series/movie already playing (episode navigation) — just track the volume.
      if (!suppressed) fadeTo(targetVolume);
      return;
    }

    const el = ensureAudio();
    // A stop-fade may still be in flight (leaving a themed page and opening this one within
    // the ~700 ms fade window). Kill it BEFORE touching the element: its pending
    // releaseSource() would otherwise fire mid-setup — pausing the element and stripping the
    // src assigned below — and its remaining ticks would drag the freshly forced volume 0
    // back up (audible blip). The src swap below releases the old stream anyway.
    clearFade();
    currentOwnerId = ownerId;
    // First entry of ThemeSongs — multiple themes exist but rotating them adds nothing here.
    el.src = `${session.serverUrl}/Audio/${songs[0].Id}/stream?static=true&ApiKey=${session.token}`;
    el.volume = 0;
    if (!suppressed) {
      // Both callbacks are guarded by mySeq: switching to another themed title while THIS play()
      // is still pending makes the browser reject the older promise (AbortError on the src swap).
      // Without the guard that late rejection would null the ownerId the NEWER call just set —
      // after which stopTheme() considered the module idle and the music kept playing on the
      // dashboard forever. The then-side re-checks `suppressed` for the same reason: if the
      // screensaver kicked in while play() was settling, fading up here would undo its fade-down.
      el.play()
        .then(() => { if (mySeq === fetchSeq && !suppressed) fadeTo(targetVolume); })
        .catch(() => { if (mySeq === fetchSeq) currentOwnerId = null; });
    }
    dlog('[OcenFin] theme music start, owner', ownerId);
  } catch { /* network errors stay silent — see module header */ }
}

/** Fade out and fully release. Safe to call at any time, including mid-fetch. */
export function stopTheme() {
  fetchSeq++;                          // invalidate any in-flight ThemeMedia lookup
  currentOwnerId = null;
  // Release on the ELEMENT's state, not on currentOwnerId: an aborted play() rejection may have
  // nulled the owner while audio was (or was about to be) audible, and keying the early-return on
  // the owner would then leave an orphaned loop playing. Idle element (no src, paused) → true no-op,
  // which matters because the Details effect calls this for every non-fitting item.
  if (!audio) return;
  if (audio.paused && !audio.getAttribute('src')) return;
  fadeTo(0, releaseSource);
}

/**
 * Screensaver hook: true silences without losing state, false brings the theme back.
 * Suppress while nothing plays is a no-op; resume without prior suppress likewise.
 */
export function suppressTheme(on) {
  if (on === suppressed) return;
  suppressed = on;
  if (!audio || currentOwnerId === null) return;
  if (on) fadeTo(0, () => audio.pause());
  else audio.play().then(() => fadeTo(targetVolume)).catch(() => {});
}
