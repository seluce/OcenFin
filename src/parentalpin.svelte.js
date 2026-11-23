// The parental PIN (CODE-HEALTH §151, §152). One per television, kept in localStorage like every device-wide setting:
//   ocenfin_parental_pin = { salt, hash, last, upTo, atStart, fails, until }
//   last        — the age limit of the profile entered last, null = none. Out of a CHILD'S profile, a profile with a
//                 higher limit or none asks for the PIN (App's enterProfile) — a younger child cannot open an older
//                 sibling's profile, the older one switches down freely.
//   upTo        — the highest age limit that still makes a profile a child's, null = every limit (the default). Above
//                 it a profile is outside the lock: grown-up enough to be protected by a password of its own.
//   atStart     — nobody is known to be in front of the TV after switching on and after a pause (App): then every
//                 profile above the children's asks too. On by default.
//   fails/until — wrong tries in a row and the wait they earned. Stored, or closing the app would reset the count.
// Checked here and only here, never by the server, so a wrong guess costs no sign-in attempt (Jellyfin disables an
// account after a few). The hash only keeps the four digits out of plain sight: 10 000 candidates are tried in a blink,
// and whoever can read this storage can just as well delete it — which is the last way out of a forgotten PIN anyway
// (FAQ). Set, changed and removed in Settings → Profile & Account of a profile without an age limit.

const KEY = 'ocenfin_parental_pin';
export const PIN_LENGTH = 4;
const FREE_TRIES = 2;                  // wrong tries before the first wait
const WAITS = [30, 60, 120, 300];      // seconds: after the 3rd, 4th, 5th and every further wrong try in a row

const asLimit = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function read() {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!r || typeof r.hash !== 'string' || typeof r.salt !== 'string') return null;
    // The first record (§151) only knew WHETHER the last profile had a limit — a child's it was, then.
    if ('kid' in r) { r.last = r.kid ? 0 : null; delete r.kid; }
    return { ...r, last: asLimit(r.last), upTo: asLimit(r.upTo), atStart: r.atStart !== false };
  } catch { return null; }
}
function write(r) {
  try { if (r) localStorage.setItem(KEY, JSON.stringify(r)); else localStorage.removeItem(KEY); }
  catch { /* storage unavailable — the state below still reflects the attempt for this run */ }
  Object.assign(parental, view(r));
}
const view = (r) => ({ hasPin: !!r, last: r?.last ?? null, upTo: r?.upTo ?? null, atStart: r ? r.atStart : true });

// The stored record's answers, as state: Settings shows the card from them, the profile picker marks the profiles that
// will ask, App asks from them.
export const parental = $state(view(read()));

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
 *  the rest stays what it was: a PIN is only ever set in a profile without an age limit or in an unlocked one. */
export function setPin(pin) {
  const old = read();
  const salt = Array.from(crypto.getRandomValues(new Uint32Array(2)), n => n.toString(36)).join('');
  write({ salt, hash: digest(salt, pin), last: old?.last ?? null, upTo: old?.upTo ?? null,
          atStart: old ? old.atStart : true, fails: 0, until: 0 });
}

/** Settings' two options: { upTo } (a number, null = every limit) and/or { atStart }. */
export function setPinOptions(o) {
  const r = read();
  if (!r) return;
  write({ ...r, ...('upTo' in o ? { upTo: asLimit(o.upTo) } : {}), ...('atStart' in o ? { atStart: !!o.atStart } : {}) });
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

/** A profile's age limit: Jellyfin's MaxParentalRating, a score that reads as an age (FSK 12 = 12, PG-13 = 13,
 *  R = 17); null = none. The public profile list carries it too (the full UserDto, §151). */
export function ageLimit(user) {
  const v = user?.Policy?.MaxParentalRating;
  return v == null ? null : asLimit(Number(v));
}
const childLimit = (l) => l != null && (parental.upTo == null || l <= parental.upTo);

/** A child's profile: an age limit up to the PIN's threshold. Its settings ask for the PIN. */
export const isKidProfile = (user) => childLimit(ageLimit(user));

/** Does entering this profile need the PIN? Out of a child's profile upward: into a profile with a higher limit or
 *  none. `unknown` — nobody is known to be in front of the TV (switched on, a pause): with "ask after switching on"
 *  every profile above the children's asks then as well. */
export function needsPin(user, unknown = false) {
  if (!parental.hasPin) return false;
  const to = ageLimit(user), from = parental.last;
  if (childLimit(from) && (to == null || to > from)) return true;
  return unknown && parental.atStart && !childLimit(to);
}

/** Every profile that is entered (App's finishLogin) leaves its limit behind. */
export function noteProfileEntered(user) {
  const r = read(), l = ageLimit(user);
  if (r && r.last !== l) write({ ...r, last: l });
}
