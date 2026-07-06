// ============================================================
// Gruppen-basiertes Fokus-Modell für D-Pad-Navigation (WebOS)
// ------------------------------------------------------------
// Wie ausgereifte TV-Clients (LiteFins FocusManager, Enacts Spotlight) arbeitet
// die Navigation mit logischen GRUPPEN statt rein geometrisch über die ganze Seite.
//
// Gruppen = Elemente mit [data-focus-group].
//   • Innerhalb der aktuellen Gruppe: geometrische Auswahl (Überlappung → Kegel → Rückfall).
//   • An der Gruppenkante (kein Ziel in Richtung): Übergang zur nächsten Gruppe in der
//     Richtung; dort wird der zuletzt fokussierte Eintrag wiederhergestellt (oder der
//     geometrisch nächste). Dadurch mischt sich z.B. die Sidebar NICHT in die vertikale
//     Navigation des Inhalts ein.
//   • Modale ([data-focus-trap]): nur diese Gruppe ist navigierbar (kein Verlassen).
//   • Schieberegler (type=range): Links/Rechts steuern sie selbst, Hoch/Runter verlässt sie.
// ============================================================

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const ARROWS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

// Zuletzt fokussiertes Element je Gruppe (für Wiedereintritt).
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

// Dreistufige geometrische Auswahl unter Kandidaten:
//  1) Überlappung in der Querachse (gleiche Spalte/Zeile) — ideal.
//  2) Kegel: Richtung dominiert die Querabweichung.
//  3) Rückfall: irgendetwas in der Halbebene (stark nach Querversatz bestraft).
function pickGeometric(dir, from, candidates, exclude, strictRow = false) {
  const fX = cx(from), fY = cy(from);
  // Horizontale Sprungleiste (z.B. A-Z) ist nur per Links/Rechts erreichbar. Steht der Fokus
  // außerhalb, werden ihre Buttons bei Hoch/Runter ignoriert — so springt es nicht seitlich
  // zur A-Z-Leiste, wenn die nächste Grid-Reihe noch lädt. Innerhalb der Leiste bleibt Hoch/
  // Runter normal (Buchstabennavigation).
  const fromHbar = exclude ? exclude.closest('[data-hbar]') : null;
  let overlap = null, oS = Infinity;
  let cone = null, cS = Infinity;
  let fall = null, fS = Infinity;

  for (const el of candidates) {
    if (el === exclude) continue;
    if (dir === 'ArrowUp' || dir === 'ArrowDown') {
      const elHbar = el.closest('[data-hbar]');
      // Hoch/Runter bleibt strikt in derselben hbar-Gruppe: von außen NICHT hinein (elHbar gesetzt,
      // fromHbar null) UND von innen NICHT hinaus (fromHbar gesetzt, elHbar null oder andere Gruppe).
      // Dadurch springt der Fokus an der obersten/untersten Kategorie der Settings-Navigation nicht
      // seitlich in den Inhalt — nur Kandidaten derselben Gruppe (bzw. beide ohne) bleiben gültig.
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
    // Links/Rechts bleibt in derselben Zeile: Kandidaten ohne vertikale Überlappung (also aus einer
    // anderen Reihe) werden ignoriert. So springt es am Zeilenrand nicht hoch/runter, sondern der
    // Within-Pick liefert nichts → der Gruppen-Übergang (z.B. zur Sidebar) greift.
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

// Eintrittspunkt einer Gruppe beim Übergang: zuletzt fokussiert (falls noch sichtbar),
// sonst geometrisch nächstes in Richtung, sonst überhaupt nächstes.
function entryOf(group, dir, from) {
  // Opt-in [data-enter-first]: Beim Betreten der Gruppe (Hoch/Runter zwischen Sektionen) immer auf
  // deren ERSTE Karte – stabil und vorhersehbar, egal aus welcher Spalte man kam. Innerhalb der Gruppe
  // bleibt die Navigation geometrisch (greift nur beim Gruppen-Übergang, nicht zeilenweise).
  if (group.hasAttribute('data-enter-first')) {
    const first = focusablesIn(group)[0];
    if (first) return first;
  }
  // Als aktiv markiertes Element bevorzugen (z.B. der aktuelle Sidebar-Eintrag): Beim Wechsel in
  // die Gruppe landet der Fokus so immer auf dem aktiven Element, nicht auf dem zuletzt fokussierten.
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
  const groups = Array.from(document.querySelectorAll('[data-focus-group]'))
    .filter(g => g !== currentGroup && isVisible(g) && focusablesIn(g).length
              && !(currentGroup && g.contains(currentGroup)));   // Vorfahr-Gruppen (z.B. der Inhalts-Container "main")
                                                                 // sind kein Sprungziel – man ist bereits darin.
  return pickGeometric(dir, from, groups, null);
}

// Aktiviert die Navigation global. isEnabled() darf false liefern, um sie zeitweise
// abzuschalten. Gibt eine Aufräumfunktion zurück.
export function createFocusManager(isEnabled) {
  function onFocusIn(e) {
    // Ist ein Modal/Banner als Trap offen, darf der Fokus es nicht verlassen — auch nicht durch
    // einen programmatischen focus() einer parallel mountenden Ansicht (z. B. Filme-Autofokus,
    // während der "Server nicht erreichbar"-Banner erscheint). Dann Fokus zurück ins Modal holen.
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
    // Schieberegler: Links/Rechts steuern sie selbst (Spulen); Hoch/Runter navigiert weiter.
    if (active && active.tagName === 'INPUT' && active.type === 'range' &&
        (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return;

    // Text-Eingabefelder: Links/Rechts bewegt den Cursor INNERHALB des Textes, solange er nicht
    // am Rand steht. Erst am Anfang (Links) bzw. Ende (Rechts) verlässt der Fokus das Feld. So
    // kann man Geschriebenes korrigieren, ohne alles löschen zu müssen.
    if (active && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') &&
        ((active.tagName === 'INPUT' && /^(text|password|search|email|url|tel|)$/.test(active.type)) ||
         active.tagName === 'TEXTAREA')) {
      let start, end, len;
      try { start = active.selectionStart; end = active.selectionEnd; len = (active.value || '').length; }
      catch { return; }                                              // keine Selection-API → dem Browser überlassen
      if (start === null) return;
      if (e.key === 'ArrowLeft'  && !(start === 0   && end === 0))   return;   // links steht noch Text → Cursor bewegen
      if (e.key === 'ArrowRight' && !(start === len && end === len)) return;   // rechts steht noch Text → Cursor bewegen
      // sonst: Cursor am Rand → Fokus darf das Feld in diese Richtung verlassen (normale Navigation)
    }

    const hasActive = active && active !== document.body;
    const from = hasActive ? rectOf(active)
                           : { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };

    const trap = activeTrap();
    const scope = trap || groupOf(active);

    // 1) Innerhalb der aktuellen Gruppe / des Modals
    if (scope) {
      let within = pickGeometric(e.key, from, focusablesIn(scope), active, true);
      // Fallback für den Eintritt in einen "oben-anfangen"-Bereich (data-enter-top): Fand die strikte
      // Zeilen-Bindung nichts, weil auf Höhe der Quelle im Zielbereich nur NICHT-fokussierbarer Inhalt
      // steht (z.B. die Server-Info-Karte über "Cache leeren" in Konto & Server), ohne Zeilen-Bindung
      // nachfassen und dort oben einsteigen. Greift nur beim Übergang in einen fremden enter-top-Bereich.
      if (!within && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const loose = pickGeometric(e.key, from, focusablesIn(scope), active, false);
        const top = loose?.closest('[data-enter-top]');
        if (top && !top.contains(active)) within = focusablesIn(top)[0] || null;
      }
      // Eintritt von außen IN eine Sprungleiste (per Links/Rechts): direkt auf das aktuell
      // markierte Element (data-hbar-current, z.B. der ausgewählte Buchstabe) springen statt
      // auf das geometrisch nächste. Innerhalb der Leiste bleibt die Navigation normal.
      if (within && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const bar = within.closest('[data-hbar]');
        if (bar && !bar.contains(active)) {
          const cur = bar.querySelector('[data-hbar-current]');
          if (cur && isVisible(cur)) within = cur;
        }
        // Betritt man einen "oben-anfangen"-Bereich (z.B. den Einstellungs-Detailbereich) von
        // außen, immer auf dessen oberstes fokussierbares Element statt geometrisch in die Mitte.
        const top = within.closest('[data-enter-top]');
        if (top && !top.contains(active)) {
          const first = focusablesIn(top)[0];
          if (first) within = first;
        }
      }
      if (within) { e.preventDefault(); focusEl(within); return; }
      if (trap) { e.preventDefault(); return; }   // Modal nicht verlassen
    }

    // 2) Übergang zur nächsten Gruppe in der Richtung
    const tgt = nearestGroup(e.key, from, groupOf(active));
    if (tgt) {
      const entry = entryOf(tgt, e.key, from);
      if (entry) { e.preventDefault(); focusEl(entry); return; }
    }

    // 3) Noch kein Fokus überhaupt → erstes fokussierbares Element nehmen
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
