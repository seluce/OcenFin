// ============================================================
// Group-based focus model for D-pad navigation (webOS)
// ------------------------------------------------------------
// The navigation works with logical GROUPS instead of purely geometrically across the whole
// page — the robust approach for reliable D-pad focus on a TV.
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

import { perfEnabled, perfSample } from './utils.js';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const ARROWS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

// Last focused element per group (for re-entry).
const lastFocus = new WeakMap();

// ── Per-keypress measurement cache ────────────────────────────────────────────────────────
// getBoundingClientRect() forces layout, getComputedStyle() forces style resolution, and ONE
// arrow press asks for the same elements up to four times: isVisible() measures every focusable
// in the group, pickGeometric() then measures the very same candidates again, and the Left/Right
// fallback runs that whole pick a second time. The library group grows with paging (50 items per
// page, never trimmed — CODE-HEALTH §8), so this is several hundred elements × 4 in a long
// browsing session, which is exactly where D-pad latency creeps up.
//
// Caching is safe because the decision phase only READS layout: nothing writes to the DOM between
// the first measurement and the pick. The cache is opened when a navigation key is claimed and
// closed again in focusEl()/onFocusIn(), i.e. before anything scrolls or moves focus — so no
// cached value ever outlives the state it was measured in.
let measureCache = null;   // { rects: Map, vis: Map } while a pick is running, otherwise null
// t0 doubles as the "measure this press" flag; rects.size is the candidate count for free.
function beginMeasure() {
  measureCache = { rects: new Map(), vis: new Map(), t0: perfEnabled() ? performance.now() : 0 };
}
function endMeasure() {
  if (measureCache?.t0) perfSample('nav', performance.now() - measureCache.t0, { candMax: measureCache.rects.size });
  measureCache = null;
}

function isVisible(el) {
  if (!el) return false;
  const cached = measureCache?.vis.get(el);
  if (cached !== undefined) return cached;
  const r = rectOf(el);
  let visible = false;
  if (r.width !== 0 && r.height !== 0) {
    const s = getComputedStyle(el);
    visible = s.visibility !== 'hidden' && s.display !== 'none' && s.pointerEvents !== 'none';
  }
  measureCache?.vis.set(el, visible);
  return visible;
}

function groupOf(el) { return el ? el.closest('[data-focus-group]') : null; }

function activeTrap() {
  const traps = Array.from(document.querySelectorAll('[data-focus-trap]')).filter(isVisible);
  return traps.length ? traps[traps.length - 1] : null;
}

// Focusables that occupy a real box — WITHOUT the CSS check. Cheap: rects come from the
// measurement cache, so this is one layout flush for the whole set and no style resolution.
function focusableBoxes(root) {
  return Array.from(root.querySelectorAll(FOCUSABLE)).filter(el => {
    const r = rectOf(el);
    return r.width !== 0 && r.height !== 0;
  });
}

// First genuinely visible focusable. Iterates lazily and stops at the first hit — the previous
// focusablesIn(root)[0] ran the CSS check over EVERY element just to keep one of them.
function firstFocusable(root) {
  for (const el of root.querySelectorAll(FOCUSABLE)) if (isVisible(el)) return el;
  return null;
}

// Pick geometrically, then verify only the WINNER's CSS visibility.
//
// isVisible() needs getComputedStyle, which forces a style resolution per element. Checking the
// whole field cost ~187 of them per arrow press deep in a library — measured on the B4 at 20 ms
// average and 132 ms worst case for a single press. The geometry never lets a far-away element
// win, so all that work decided nothing.
//
// If the winner does turn out to be hidden it is dropped and the pick repeats over the fully
// filtered field. That costs the old price, but only where sized-yet-hidden focusables actually
// exist — the Player keeps its HUD controls laid out (pointer-events:none) while faded out, and
// that is a handful of elements, not a library grid.
function pickVisible(dir, from, candidates, exclude, strictRow = false, rowFirst = false) {
  const el = pickGeometric(dir, from, candidates, exclude, strictRow, rowFirst);
  if (!el || isVisible(el)) return el;
  return pickGeometric(dir, from, candidates.filter(isVisible), exclude, strictRow, rowFirst);
}

function rectOf(el) {
  if (!measureCache) return el.getBoundingClientRect();
  let r = measureCache.rects.get(el);
  if (!r) { r = el.getBoundingClientRect(); measureCache.rects.set(el, r); }
  return r;
}
function cx(r) { return r.left + r.width / 2; }
function cy(r) { return r.top + r.height / 2; }

// Three-stage geometric selection among candidates:
//  1) Overlap on the cross axis (same column/row) — ideal.
//  2) Cone: the direction dominates the cross-axis deviation.
//  3) Fallback: anything in the half-plane (heavily penalized by cross offset).
// rowFirst (Up/Down only): move to the NEAREST row and clamp horizontally within it, instead of
// letting a horizontally overlapping candidate win regardless of distance. Without it a short row
// (e.g. a watchlist with a single card) is skipped when focus sits further right, because the row
// below happens to have a card directly underneath — making that row unreachable from the right.
// Uniform grids are unaffected: their neighbouring row always has a card in the same column.
function pickGeometric(dir, from, candidates, exclude, strictRow = false, rowFirst = false) {
  const fX = cx(from), fY = cy(from);
  const vertical = dir === 'ArrowUp' || dir === 'ArrowDown';
  const band = [];   // rowFirst: every valid candidate, resolved in two steps after the loop
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

    if (rowFirst && vertical) { band.push({ el, r, along }); continue; }

    if (perp === 0)            { const s = along + align * 0.3; if (s < oS) { oS = s; overlap = el; } }
    else if (along >= perp)    { const s = along + perp * 2;    if (s < cS) { cS = s; cone = el; } }
    else                       { const s = along + perp * 4;    if (s < fS) { fS = s; fall = el; } }
  }
  if (rowFirst && vertical && band.length) {
    // 1) The closest candidate defines the next row …
    let near = band[0];
    for (const c of band) if (c.along < near.along) near = c;
    // 2) … and within that row take the horizontally closest element (a shorter row therefore
    //    clamps to its last card instead of being skipped).
    let best = null, bS = Infinity;
    for (const c of band) {
      if (Math.min(c.r.bottom, near.r.bottom) - Math.max(c.r.top, near.r.top) <= 0) continue;  // other row
      const gap = Math.min(from.right, c.r.right) - Math.max(from.left, c.r.left) > 0
        ? 0
        : Math.min(Math.abs(c.r.left - from.right), Math.abs(from.left - c.r.right));
      const s = gap * 10 + Math.abs(c.r.left - from.left);
      if (s < bS) { bS = s; best = c.el; }
    }
    if (best) return best;
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
  // Decision phase over — everything below moves focus and scrolls, so measurements taken
  // before it must not be reused afterwards.
  endMeasure();
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
    const first = firstFocusable(group);
    if (first) return first;
  }
  // Prefer the element marked as active (e.g. the current sidebar entry): switching into
  // the group thus always lands focus on the active element, not on the last focused one.
  const current = group.querySelector('[data-group-current]');
  if (current && isVisible(current)) return current;
  const remembered = lastFocus.get(group);
  if (remembered && group.contains(remembered) && isVisible(remembered)
      && !remembered.closest('[data-hbar-trailing]')) return remembered;
  // A trailing jump bar (the A-Z bar sits AFTER the grid on the right) is reached only by moving
  // into it from the grid — never as the landing spot when entering the group from outside (e.g.
  // the sidebar). Leading bars (settings category nav on the left) are NOT marked → stay valid.
  let cands = focusableBoxes(group).filter(el => !el.closest('[data-hbar-trailing]'));
  if (!cands.length) cands = focusableBoxes(group);
  if (!cands.length) return null;
  const byDir = pickVisible(dir, from, cands, null);
  if (byDir) return byDir;
  // Nothing in the direction → nearest overall. Only this rare path pays the full CSS check.
  // It now yields null rather than cands[0] when everything is hidden: handing back a hidden
  // element only moved focus somewhere invisible, whereas null lets the caller try its next route.
  let best = null, bd = Infinity;
  for (const el of cands) {
    if (!isVisible(el)) continue;
    const r = rectOf(el);
    const d = Math.hypot(cx(r) - cx(from), cy(r) - cy(from));
    if (d < bd) { bd = d; best = el; }
  }
  return best;
}

function nearestGroup(dir, from, currentGroup) {
  let groups = Array.from(document.querySelectorAll('[data-focus-group]'))
    .filter(g => g !== currentGroup && isVisible(g) && firstFocusable(g)
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
    endMeasure();   // focus moved → any pending measurement describes the state before that
    // If a modal/banner is open as a trap, focus must not leave it — not even via
    // a programmatic focus() of a view mounting in parallel (e.g. the Movies autofocus
    // while the "server unreachable" banner appears). In that case pull focus back into the modal.
    const trap = activeTrap();
    if (trap && !trap.contains(e.target)) {
      const back = firstFocusable(trap);
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

    // From here on spatial nav owns the navigation key and scrolls deterministically via
    // scrollIntoView — suppress the browser's native arrow-key scroll entirely. (A variable native
    // scroll caused inconsistent context reveal and unwanted page scrolling inside dropdowns.) Row
    // titles / section headers are revealed via scroll-padding-top on the scroll containers instead.
    e.preventDefault();
    beginMeasure();

    const hasActive = active && active !== document.body;
    const from = hasActive ? rectOf(active)
                           : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };

    const trap = activeTrap();
    const scope = trap || groupOf(active);

    // 1) Within the current group / modal
    if (scope) {
      const scopeCands = focusableBoxes(scope);
      let within = pickVisible(e.key, from, scopeCands, active, true, true);
      // Fallback for entering a "start-at-top" area (data-enter-top): if the strict
      // row binding found nothing because at the source's height the target area has only NON-focusable
      // content (e.g. the server-info card above "Clear cache" in Account & Server), retry without row
      // binding and enter at its top. Only applies when transitioning into a foreign enter-top area.
      if (!within && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const loose = pickVisible(e.key, from, scopeCands, active, false);
        // Leaving a jump bar toward the grid (Left from the A-Z bar; its focused letter may sit
        // below the last card, so the strict-row pick found nothing) → nearest content element,
        // so focus can't skip the grid and jump straight to the sidebar.
        const _activeHbar = active.closest('[data-hbar]');
        if (_activeHbar && e.key === 'ArrowLeft' && loose && !_activeHbar.contains(loose)) within = loose;
        const top = loose?.closest('[data-enter-top]');
        if (!within && top && !top.contains(active)) {
          within = firstFocusable(top) || null;
        } else if (!within) {
          // Leaving a start-at-top content area toward a jump bar (data-hbar) in the SAME group —
          // e.g. Left from the settings detail area back to the category navigation. Content rows
          // below the last bar item find no vertically overlapping target, so the strict-row pick
          // returns nothing; without this the group transition would jump past the bar straight to
          // the sidebar. Enter the bar at its current item instead.
          const bar = loose?.closest('[data-hbar]');
          if (bar && !bar.contains(active))
            within = bar.querySelector('[data-hbar-current]') || firstFocusable(bar) || null;
        }
        // Final safety net: leaving a start-at-top content area (data-enter-top) via Left with still
        // no target means the loose pick landed on another content row instead of the leading category
        // bar (happens for options near the top, where a nearby content row is closer than the bar).
        // Bind directly to that bar so Left from the options can never skip past it to the sidebar,
        // wherever the option sits vertically.
        if (!within && e.key === 'ArrowLeft' && active.closest('[data-enter-top]')) {
          const leadingBar = [...scope.querySelectorAll('[data-hbar]')].find(b => !b.contains(active));
          if (leadingBar) within = leadingBar.querySelector('[data-hbar-current]') || firstFocusable(leadingBar) || null;
        }
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
          const first = firstFocusable(top);
          if (first) within = first;
        }
      }
      if (within) { focusEl(within); return; }
      if (trap) {
        // Safety net: nothing is focused at all (the previously focused node was removed while the
        // trap stayed — e.g. an overlay fading out during a view remount). Returning here would make
        // the modal boundary swallow every key press, and since the Player's key handler sits on its
        // container rather than on window, OK and the arrows would stay dead until Back is pressed.
        // So re-enter the trap: its first visible focusable, otherwise the trap itself if it can take
        // focus (the Player container is tabindex="0" and its controls are pointer-events-none while
        // the HUD is hidden, so they don't count as focusable).
        if (!hasActive) {
          const back = firstFocusable(trap) || (trap.tabIndex >= 0 ? trap : null);
          if (back) focusEl(back);
        }
        return;   // modal boundary: stay put
      }
    }

    // 2) Transition to the next group in the direction
    const tgt = nearestGroup(e.key, from, groupOf(active));
    if (tgt) {
      const entry = entryOf(tgt, e.key, from);
      if (entry) { focusEl(entry); return; }
    }

    // 3) No focus at all yet → take the first focusable element
    if (!hasActive) {
      const any = firstFocusable(document.body);
      if (any) { focusEl(any); return; }
    }

  }

  window.addEventListener('focusin', onFocusIn);
  window.addEventListener('keydown', onKeyDown);
  return () => {
    window.removeEventListener('focusin', onFocusIn);
    window.removeEventListener('keydown', onKeyDown);
  };
}
