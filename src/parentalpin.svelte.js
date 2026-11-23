// The parental PIN (CODE-HEALTH §151). One per television, kept in localStorage like every device-wide setting:
//   ocenfin_parental_pin = { salt, hash, kid, fails, until }
//   kid         — the profile entered last has an age limit. With a PIN set, that is what locks the profiles without
//                 one (App's enterProfile) — siblings switch between their own profiles freely.
//   fails/until — wrong tries in a row and the wait they earned. Stored, or closing the app would reset the count.
// Checked here and only here, never by the server, so a wrong guess costs no sign-in attempt (Jellyfin disables an
// account after a few). The hash only keeps the four digits out of plain sight: 10 000 candidates are tried in a blink,
// and whoever can read this storage can just as well delete it — which is the last way out of a forgotten PIN anyway
// (FAQ). Set, changed and removed in Settings → Profile & Account of a profile without an age limit.

const KEY = 'ocenfin_parental_pin';
export const PIN_LENGTH = 4;
const FREE_TRIES = 2;                  // wrong tries before the first wait
const WAITS = [30, 60, 120, 300];      // seconds: after the 3rd, 4th, 5th and every further wrong try in a row

function read() {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) || 'null');
    return r && typeof r.hash === 'string' && typeof r.salt === 'string' ? r : null;
  } catch { return null; }
}
function write(r) {
  try { if (r) localStorage.setItem(KEY, JSON.stringify(r)); else localStorage.removeItem(KEY); }
  catch { /* storage unavailable — the state below still reflects the attempt for this run */ }
  parental.hasPin = !!r;
  parental.kid = !!r?.kid;
}

// The stored record's two answers, as state: Settings shows "set" or "change / remove" from hasPin, the profile picker
// marks the profiles that will ask, App asks only while both are true.
const initial = read();
export const parental = $state({ hasPin: !!initial, kid: !!initial?.kid });

// cyrb53 (public domain): 53 bits, plenty for telling four digits apart behind a salt.
function digest(salt, pin) {
  const s = `${salt}:${pin}`;
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** A new PIN — over an existing one too (the reset after a password sign-in). The count of wrong tries starts again;
 *  `kid` stays what it was: a PIN is only ever set in a profile without an age limit or in an unlocked one. */
export function setPin(pin) {
  const old = read();
  const salt = Array.from(crypto.getRandomValues(new Uint32Array(2)), n => n.toString(36)).join('');
  write({ salt, hash: digest(salt, pin), kid: !!old?.kid, fails: 0, until: 0 });
}

export function clearPin() { write(null); }

/** Seconds still to wait after too many wrong tries, 0 = free. A clock set back (the TV's time comes from the
 *  network and can jump) must not turn five minutes into hours: a wait longer than the longest is cut to it. */
export function pinWaitLeft() {
  const r = read();
  if (!r?.until) return 0;
  const left = Math.ceil((r.until - Date.now()) / 1000);
  if (left <= 0) return 0;
  const max = WAITS[WAITS.length - 1];
  if (left > max) { write({ ...r, until: Date.now() + max * 1000 }); return max; }
  return left;
}

/** { ok, wait } — wait = seconds the NEXT try has to wait (a wrong one that earned it, or one already running). */
export function checkPin(pin) {
  const r = read();
  if (!r) return { ok: true, wait: 0 };         // removed in the meantime: nothing left to protect
  const wait = pinWaitLeft();
  if (wait) return { ok: false, wait };
  if (digest(r.salt, pin) === r.hash) {
    if (r.fails || r.until) write({ ...r, fails: 0, until: 0 });
    return { ok: true, wait: 0 };
  }
  const fails = (r.fails || 0) + 1;
  const secs = fails > FREE_TRIES ? WAITS[Math.min(fails - FREE_TRIES - 1, WAITS.length - 1)] : 0;
  write({ ...r, fails, until: secs ? Date.now() + secs * 1000 : 0 });
  return { ok: false, wait: secs };
}

/** Does entering a profile without an age limit need the PIN now? */
export function kidLockOn() { return parental.hasPin && parental.kid; }

/** Every profile that is entered (App's finishLogin) says whether it has an age limit. */
export function noteProfileEntered(restricted) {
  const r = read();
  if (r && r.kid !== restricted) write({ ...r, kid: restricted });
}
