// ============================================================
// Group-based focus model for D-pad navigation (webOS)
// ------------------------------------------------------------
// Like mature TV clients (LiteFin's FocusManager, Enact's Spotlight), the
// navigation works with logical GROUPS instead of purely geometrically across the whole page.
//
// Groups = elements with [data-focus-group].
//   • Within the current group: geometric selection (overlap → cone → fallback).
//   • At the group edge (no target in the direction): transition to the next group in the
//     direction; there the last focused entry is restored (or the geometrically
//     nearest one). This keeps e.g. the sidebar OUT of the content's vertical
//     navigation.
//   • Modals ([data-focus-trap]): only this group is navigable (no leaving).
//   • Sliders (type=range): Left/Right control them, Up/Down leaves them.
// ============================================================

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const ARROWS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

// Last focused element per group (for re-entry).
const lastFocus = new WeakMap();

function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 || r.height === 0) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none' && s.pointerEvents !== 'none';
}

function groupOf(el) { return el ? el.closest('[data-focus-group]') : null; }

function activeTrap() {
  const traps = Array.from(document.querySelectorAll('[data-focus-trap]')).filter(isVisible);
  return traps.length ? traps[traps.length - 1] : null;
}

function focusablesIn(root) {
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter(isVisible);
}

function rectOf(el) { return el.getBoundingClientRect(); }
function cx(r) { return r.left + r.width / 2; }
function cy(r) { return r.top + r.height / 2; }

// Three-stage geometric selection among candidates:
//  1) Overlap on the cross axis (same column/row) — ideal.
//  2) Cone: the direction dominates the cross-axis deviation.
//  3) Fallback: anything in the half-plane (heavily penalized by cross offset).
function pickGeometric(dir, from, candidates, exclude, strictRow = false) {
  const fX = cx(from), fY = cy(from);
  // A horizontal jump bar (e.g. A-Z) is only reachable via Left/Right. When focus is
  // outside it, its buttons are ignored on Up/Down — so focus doesn't jump sideways
  // to the A-Z bar while the next grid row is still loading. Inside the bar, Up/
  // Down stays normal (letter navigation).
  const fromHbar = exclude ? exclude.closest('[data-hbar]') : null;
  let overlap = null, oS = Infinity;
  let cone = null, cS = Infinity;
  let fall = null, fS = Infinity;

  for (const el of candidates) {
    if (el === exclude) continue;
    if (dir === 'ArrowUp' || dir === 'ArrowDown') {
      const elHbar = el.closest('[data-hbar]');
      // Up/Down stays strictly within the same hbar group: from outside NOT into it (elHbar set,
      // fromHbar null) AND from inside NOT out of it (fromHbar set, elHbar null or a different group).
      // This keeps focus from jumping sideways into the content at the top-most/bottom-most category
      // of the settings navigation — only candidates of the same group (or both without) stay valid.
      if (elHbar !== fromHbar) continue;
    }
    const r = rectOf(el);
    const mX = cx(r), mY = cy(r);
    let along, perp, valid, ov, align;

    if (dir === 'ArrowDown') {
      valid = mY > fY + 1; along = mY - fY;
      ov = Math.min(from.right, r.right) - Math.max(from.left, r.left);
      perp = ov > 0 ? 0 : Math.min(Math.abs(r.left - from.right), Math.abs(from.left - r.right));
      align = Math.abs(r.left - from.left);
    } else if (dir === 'ArrowUp') {
      valid = mY < fY - 1; along = fY - mY;
      ov = Math.min(from.right, r.right) - Math.max(from.left, r.left);
      perp = ov > 0 ? 0 : Math.min(Math.abs(r.left - from.right), Math.abs(from.left - r.right));
      align = Math.abs(r.left - from.left);
    } else if (dir === 'ArrowRight') {
      valid = mX > fX + 1; along = mX - fX;
      ov = Math.min(from.bottom, r.bottom) - Math.max(from.top, r.top);
      perp = ov > 0 ? 0 : Math.min(Math.abs(r.top - from.bottom), Math.abs(from.top - r.bottom));
      align = Math.abs(r.top - from.top);
    } else { /* ArrowLeft */
      valid = mX < fX - 1; along = fX - mX;
      ov = Math.min(from.bottom, r.bottom) - Math.max(from.top, r.top);
      perp = ov > 0 ? 0 : Math.min(Math.abs(r.top - from.bottom), Math.abs(from.top - r.bottom));
      align = Math.abs(r.top - from.top);
    }
    if (!valid || along <= 0) continue;
    // Left/Right stays in the same row: candidates without vertical overlap (i.e. from another
    // row) are ignored. So at the row edge it doesn't jump up/down; instead the within-pick
    // returns nothing → the group transition (e.g. to the sidebar) takes over.
    if (strictRow && (dir === 'ArrowLeft' || dir === 'ArrowRight') && perp !== 0) continue;

    if (perp === 0)            { const s = along + align * 0.3; if (s < oS) { oS = s; overlap = el; } }
    else if (along >= perp)    { const s = along + perp * 2;    if (s < cS) { cS = s; cone = el; } }
    else                       { const s = along + perp * 4;    if (s < fS) { fS = s; fall = el; } }
  }
  return overlap || cone || fall;
}

function scrollableAncestor(el) {
  let p = el.parentElement;
  while (p) {
    const s = getComputedStyle(p);
    if (/(auto|scroll)/.test(s.overflowY) && p.scrollHeight > p.clientHeight + 4) return p;
    p = p.parentElement;
  }
  return null;
}

function focusEl(el) {
  el.focus();
  if (el.hasAttribute('data-scroll-top')) {
    const sc = scrollableAncestor(el);
    if (sc) { sc.scrollTo({ top: 0 }); return; }
  }
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

// Entry point of a group on transition: last focused (if still visible),
// otherwise geometrically nearest in the direction, otherwise nearest overall.
function entryOf(group, dir, from) {
  // Opt-in [data-enter-first]: When entering the group (Up/Down between sections) always land on
  // its FIRST card — stable and predictable, no matter which column you came from. Within the group
  // navigation stays geometric (this only applies on the group transition, not row by row).
  if (group.hasAttribute('data-enter-first')) {
    const first = focusablesIn(group)[0];
    if (first) return first;
  }
  // Prefer the element marked as active (e.g. the current sidebar entry): switching into
  // the group thus always lands focus on the active element, not on the last focused one.
  const current = group.querySelector('[data-group-current]');
  if (current && isVisible(current)) return current;
  const remembered = lastFocus.get(group);
  if (remembered && group.contains(remembered) && isVisible(remembered)) return remembered;
  const cands = focusablesIn(group);
  if (!cands.length) return null;
  const byDir = pickGeometric(dir, from, cands, null);
  if (byDir) return byDir;
  let best = cands[0], bd = Infinity;
  for (const el of cands) {
    const r = rectOf(el);
    const d = Math.hypot(cx(r) - cx(from), cy(r) - cy(from));
    if (d < bd) { bd = d; best = el; }
  }
  return best;
}

function nearestGroup(dir, from, currentGroup) {
  let groups = Array.from(document.querySelectorAll('[data-focus-group]'))
    .filter(g => g !== currentGroup && isVisible(g) && focusablesIn(g).length
              && !(currentGroup && g.contains(currentGroup)));   // Ancestor groups (e.g. the content container "main")
                                                                 // are not a jump target – you are already inside them.
  // Up/Down only transitions to groups that HORIZONTALLY overlap the source. Otherwise focus jumps
  // at the bottom edge of the library into the (full-height) sidebar on the left: its center then lies
  // below the last card, because the load-more area (sentinel/skeleton) pushes the card upward.
  // This keeps the sidebar reachable exclusively via Left/Right.
  if (dir === 'ArrowUp' || dir === 'ArrowDown') {
    groups = groups.filter(g => {
      const r = rectOf(g);
      return Math.min(from.right, r.right) - Math.max(from.left, r.left) > 0;
    });
  }
  return pickGeometric(dir, from, groups, null);
}

// Enables the navigation globally. isEnabled() may return false to temporarily
// disable it. Returns a cleanup function.
export function createFocusManager(isEnabled) {
  function onFocusIn(e) {
    // If a modal/banner is open as a trap, focus must not leave it — not even via
    // a programmatic focus() of a view mounting in parallel (e.g. the Movies autofocus
    // while the "server unreachable" banner appears). In that case pull focus back into the modal.
    const trap = activeTrap();
    if (trap && !trap.contains(e.target)) {
      const back = focusablesIn(trap)[0];
      if (back && back !== e.target) { back.focus(); return; }
    }
    const g = groupOf(e.target);
    if (g) lastFocus.set(g, e.target);
  }

  function onKeyDown(e) {
    if (!ARROWS.includes(e.key)) return;
    if (typeof isEnabled === 'function' && !isEnabled()) return;

    const active = document.activeElement;
    // Sliders: Left/Right control them (seeking); Up/Down keeps navigating.
    if (active && active.tagName === 'INPUT' && active.type === 'range' &&
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;

    // Text input fields: Left/Right moves the cursor WITHIN the text, as long as it's not
    // at the edge. Only at the start (Left) or end (Right) does focus leave the field. This way
    // you can correct what you typed without having to delete everything.
    if (active && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
        ((active.tagName === 'INPUT' && /^(text|password|search|email|url|tel|)$/.test(active.type)) ||
         active.tagName === 'TEXTAREA')) {
      let start, end, len;
      try { start = active.selectionStart; end = active.selectionEnd; len = (active.value || '').length; }
      catch { return; }                                              // no Selection API → leave it to the browser
      if (start === null) return;
      if (e.key === 'ArrowLeft'  && !(start === 0   && end === 0))   return;   // text remains to the left → move cursor
      if (e.key === 'ArrowRight' && !(start === len && end === len)) return;   // text remains to the right → move cursor
      // otherwise: cursor at the edge → focus may leave the field in this direction (normal navigation)
    }

    const hasActive = active && active !== document.body;
    const from = hasActive ? rectOf(active)
                           : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };

    const trap = activeTrap();
    const scope = trap || groupOf(active);

    // 1) Within the current group / modal
    if (scope) {
      let within = pickGeometric(e.key, from, focusablesIn(scope), active, true);
      // Fallback for entering a "start-at-top" area (data-enter-top): if the strict
      // row binding found nothing because at the source's height the target area has only NON-focusable
      // content (e.g. the server-info card above "Clear cache" in Account & Server), retry without row
      // binding and enter at its top. Only applies when transitioning into a foreign enter-top area.
      if (!within && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const loose = pickGeometric(e.key, from, focusablesIn(scope), active, false);
        const top = loose?.closest('[data-enter-top]');
        if (top && !top.contains(active)) within = focusablesIn(top)[0] || null;
      }
      // Entering a jump bar from outside (via Left/Right): jump directly onto the currently
      // marked element (data-hbar-current, e.g. the selected letter) instead of the
      // geometrically nearest one. Inside the bar the navigation stays normal.
      if (within && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const bar = within.closest('[data-hbar]');
        if (bar && !bar.contains(active)) {
          const cur = bar.querySelector('[data-hbar-current]');
          if (cur && isVisible(cur)) within = cur;
        }
        // When entering a "start-at-top" area (e.g. the settings detail area) from
        // outside, always go to its top-most focusable element instead of geometrically into the middle.
        const top = within.closest('[data-enter-top]');
        if (top && !top.contains(active)) {
          const first = focusablesIn(top)[0];
          if (first) within = first;
        }
      }
      if (within) { e.preventDefault(); focusEl(within); return; }
      if (trap) { e.preventDefault(); return; }   // don't leave the modal
    }

    // 2) Transition to the next group in the direction
    const tgt = nearestGroup(e.key, from, groupOf(active));
    if (tgt) {
      const entry = entryOf(tgt, e.key, from);
      if (entry) { e.preventDefault(); focusEl(entry); return; }
    }

    // 3) No focus at all yet → take the first focusable element
    if (!hasActive) {
      const any = focusablesIn(document.body)[0];
      if (any) { e.preventDefault(); focusEl(any); }
    }
  }

  window.addEventListener('focusin', onFocusIn);
  window.addEventListener('keydown', onKeyDown);
  return () => {
    window.removeEventListener('focusin', onFocusIn);
    window.removeEventListener('keydown', onKeyDown);
  };
}
