// Shared helper functions (used by App and components)
import { tick } from 'svelte';
import { fade } from 'svelte/transition';
import { dependencies as deps } from '../package.json';   // for the version display on the status page
import { session } from './session.svelte.js';   // server URL centralized for getItemImageUrl

// Fade in/out for overlays that respects the "reduce animations" toggle (App maintains
// body.dataset.reduceMotion). With reduced motion: duration 0 → instantly visible/gone, no animation.
export function uiFade(node, params = {}) {
  const reduced = document.body.dataset.reduceMotion === '1';
  return fade(node, { ...params, duration: reduced ? 0 : (params.duration ?? 150) });
}

// On outro start, remove the focus trap in the subtree. While a modal fades out (~150 ms) it stays
// in the DOM; without this the focus returning via makeFocusReturn would be pulled by onFocusIn back
// into the fading modal. After removal the trap is immediately inactive and the modal fades out.
export function dropTrapOnOutro(e) {
  const root = e?.currentTarget;
  if (!root) return;
  if (root.hasAttribute?.('data-focus-trap')) root.removeAttribute('data-focus-trap');
  root.querySelectorAll?.('[data-focus-trap]').forEach((el) => el.removeAttribute('data-focus-trap'));
}

// Focus return after closing a modal/overlay: on open remember the trigger, on close
// jump back to it. capture()/restore() (incl. tick timing) are unified here;
// WHEN restore() runs is decided by each component via its own reactive statement,
// because the close condition differs (a single bool vs. several menus).
export function makeFocusReturn() {
  let saved = null;
  return {
    capture(el) { saved = el || document.activeElement; },
    restore() {
      const el = saved; saved = null;
      if (el && typeof el.focus === 'function') tick().then(() => el.focus());
    },
    get pending() { return !!saved; },
  };
}

// Detects the "back" action: Escape, Backspace OR the webOS remote
// (Magic Remote "Back" sends keyCode 461). Backspace in a text input field
// deletes a character and therefore does NOT count as back.
export function isBackKey(e) {
  if (e.key === 'Escape' || e.keyCode === 461) return true;
  if (e.key === 'Backspace') {
    const el = e.target;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return false;
    return true;
  }
  return false;
}

// Svelte attachment (factory): focuses the element on mount (for webOS D-pad navigation)
export function focusOnMount(enabled = true) {
  return (node) => { if (enabled) node.focus(); };
}

// Svelte attachment: On the TV a focused <input> opens the on-screen keyboard
// IMMEDIATELY — even when you only navigate to it. This attachment keeps the field readonly
// (focus opens no keyboard) and only makes it writable on OK/Enter; then
// the keyboard opens. When the field loses focus, it becomes readonly again.
export function tvKeyboard(node) {
  let activating = false;
  node.readOnly = true;
  function activate() {
    if (!node.readOnly) return;
    activating = true;
    node.readOnly = false;
    node.blur();
    node.focus();          // editable + focused → webOS opens the keyboard
    activating = false;
  }
  function onKeyDown(e) {
    if ((e.key === 'Enter' || e.keyCode === 13) && node.readOnly) {
      e.preventDefault(); e.stopPropagation();
      activate();
    }
  }
  // Touch / mouse / Magic Remote click: make the field editable directly so you can type.
  // Pure D-pad focus stays read-only (pointerdown doesn't fire there) → OK activates it.
  function onPointerDown() { if (node.readOnly) node.readOnly = false; }
  function onBlur() { if (!activating) node.readOnly = true; }
  node.addEventListener('keydown', onKeyDown);
  node.addEventListener('pointerdown', onPointerDown);
  node.addEventListener('blur', onBlur);
  return () => {
    node.removeEventListener('keydown', onKeyDown);
    node.removeEventListener('pointerdown', onPointerDown);
    node.removeEventListener('blur', onBlur);
  };
}

// Svelte attachment (factory): detects a "long press" (holding OK, or holding mouse/touch).
// PROBLEM: Enter on a focused <button> fires a click on webOS IMMEDIATELY — and REPEATEDLY
// while held down. A timer never gets a chance against that.
// SOLUTION: suppress the automatic click via preventDefault and drive the action
// ourselves. The 'longpress' event fires via a timer already WHILE holding (the desired
// behavior). So that the still-held OK key doesn't immediately trigger the first menu entry,
// the context menu only "arms" itself after release / a short delay.
// When the element loses focus (menu opens), the press state is reset.
export function longPress(duration = 500) {
  return (node) => {
    let pressing = false;
    let fired = false;
    let timer = null;
    let suppressClick = false;

    function startTimer() {
      clearTimeout(timer);
      timer = setTimeout(() => { fired = true; node.dispatchEvent(new CustomEvent('longpress')); }, duration);
    }
    function reset() { pressing = false; fired = false; clearTimeout(timer); timer = null; }

    // ── Keyboard (OK in 5-way mode) ────────────────────────────
    function onKeyDown(e) {
      if (e.key !== 'Enter' && e.keyCode !== 13) return;
      e.preventDefault();          // suppresses the automatic / repeated click
      if (pressing) return;        // ignore auto-repeat
      pressing = true; fired = false;
      startTimer();
    }
    function onKeyUp(e) {
      if (e.key !== 'Enter' && e.keyCode !== 13) return;
      if (!pressing) return;
      clearTimeout(timer);
      const wasLong = fired;
      pressing = false; fired = false;
      if (!wasLong) node.click();  // short press → normal action (long already fired 'longpress')
    }

    // ── Pointer (Magic Remote cursor / mouse) ──────────────────
    function onPointerDown() { pressing = true; fired = false; suppressClick = false; startTimer(); }
    function onPointerUp() {
      if (!pressing) return;
      clearTimeout(timer);
      if (fired) suppressClick = true;   // long pointer press → swallow the following click
      pressing = false; fired = false;
    }
    function onClickCapture(e) {
      if (suppressClick) { e.preventDefault(); e.stopImmediatePropagation(); suppressClick = false; }
    }

    node.addEventListener('keydown', onKeyDown);
    node.addEventListener('keyup', onKeyUp);
    node.addEventListener('pointerdown', onPointerDown);
    node.addEventListener('pointerup', onPointerUp);
    node.addEventListener('pointerleave', reset);
    node.addEventListener('blur', reset);                    // focus gone (menu opens) → clear state
    node.addEventListener('click', onClickCapture, true);    // capture phase: before the normal click

    return () => {
      clearTimeout(timer);
      node.removeEventListener('keydown', onKeyDown);
      node.removeEventListener('keyup', onKeyUp);
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('pointerup', onPointerUp);
      node.removeEventListener('pointerleave', reset);
      node.removeEventListener('blur', reset);
      node.removeEventListener('click', onClickCapture, true);
    };
  };
}

// Person image URL. The search (/Persons) returns ImageTags.Primary,
// the cast (item.People) returns PrimaryImageTag — both fields are checked.
export function personImageUrl(serverUrl, person) {
  const tag = person.PrimaryImageTag || person.ImageTags?.Primary;
  return tag
    ? `${serverUrl}/Items/${person.Id}/Images/Primary?tag=${tag}&fillHeight=300&quality=80&format=webp`
    : null;
}

// Card image URL for grid items (Library, Favorites, Person, Collection). 'portrait' = 2:3 poster,
// 'landscape' = 16:9 still (episode Primary, otherwise series Thumb as fallback). Centralized because it was
// previously duplicated identically across several grids. (Search deliberately uses its own variant with a backdrop fallback.)
export function getItemImageUrl(item, format = 'portrait') {
  if (format === 'landscape') {
    if (item.ImageTags?.Primary)
      return `${session.serverUrl}/Items/${item.Id}/Images/Primary?tag=${item.ImageTags.Primary}&maxWidth=600&quality=80&format=webp`;
    if (item.SeriesId && item.SeriesThumbImageTag)
      return `${session.serverUrl}/Items/${item.SeriesId}/Images/Thumb?tag=${item.SeriesThumbImageTag}&maxWidth=600&quality=80&format=webp`;
    return null;
  }
  if (item.ImageTags?.Primary)
    return `${session.serverUrl}/Items/${item.Id}/Images/Primary?tag=${item.ImageTags.Primary}&fillHeight=400&fillWidth=266&quality=80&format=webp`;
  return null;
}

// Progress 0–100: resume position (movies/episodes) or share of watched episodes
// (series, via Jellyfin's PlayedPercentage). For progress bars.
// Card badge "Watched" (top left; top right belongs to the episode-counter opt-in, or in the
// details strips to the green check there): ONLY a check, ONLY when fully watched.
// Jellyfin sets Played on series/seasons/collections only once ALL contained titles are watched
// — exactly the desired semantics. Deliberately NO unwatched counter: it would visually
// duplicate the episode counter in the top right.
export function itemBadge(item) {
  return item?.UserData?.Played ? { check: true } : null;
}
export function itemProgress(item) {
  if (item.UserData?.PlaybackPositionTicks && item.RunTimeTicks)
    return (item.UserData.PlaybackPositionTicks / item.RunTimeTicks) * 100;
  if (item.UserData?.PlayedPercentage) return item.UserData.PlayedPercentage;
  return 0;
}

// Card/grid subtitle: episode → "S1:E2 – Title"; series → year range
// ("2016 – 2019" / "2024 – today"); otherwise the production year.
// `todayLabel` = localized "today" ($t.today), since $t isn't available here.
export function getItemSubtitle(item, todayLabel = '') {
  if (item.Type === 'Episode') {
    const s = item.ParentIndexNumber ?? '?';
    const e = item.IndexNumber ?? '?';
    return `S${s}:E${e} – ${item.Name}`;
  }
  if (item.Type === 'Series') {
    const start = item.ProductionYear || '';
    const end   = item.Status === 'Continuing'
      ? todayLabel
      : (item.EndDate ? new Date(item.EndDate).getFullYear() : '');
    if (start && end && start != end) return `${start} – ${end}`;
    return start.toString();
  }
  return item.ProductionYear?.toString() ?? '';
}

// ============================================================
// SIDEBAR NAVIGATION (dynamic + customizable per profile)
// ============================================================
// Icon palette for the navigation: type defaults (dashboard/search/settings/movies/tvshows/
// folder) + a decorative selection the user can choose per entry. Exported
// so the settings editor renders the same icons.
export const NAV_ICON_PALETTE = {
  dashboard: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
  search:    'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
  settings:  'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
  movies:    'M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z',
  tvshows:   'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z',
  folder:    'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z',
  tv:        'M6 20.25h12m-7.5-3v3m3-3v3m-10.125-3h17.25c.621 0 1.125-.504 1.125-1.125V4.875c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125z',
  star:      'M11.48 3.5a.562.562 0 011.04 0l2.125 5.111a.563.563 0 00.475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 00-.182.557l1.285 5.385a.562.562 0 01-.84.61l-4.725-2.884a.562.562 0 00-.586 0L6.982 20.54a.562.562 0 01-.84-.61l1.285-5.386a.562.562 0 00-.182-.557l-4.204-3.602a.562.562 0 01.321-.988l5.518-.442a.563.563 0 00.475-.345L11.48 3.5z',
  heart:     'M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z',
  book:      'M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25',
  globe:     'M12 21a9 9 0 100-18 9 9 0 000 18zm0 0c2.485 0 4.5-4.03 4.5-9S14.485 3 12 3m0 18c-2.485 0-4.5-4.03-4.5-9S9.515 3 12 3M3.6 9h16.8M3.6 15h16.8',
  music:     'M9 9l10.5-3m0 6.553v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 11-.99-3.467l2.31-.66a2.25 2.25 0 001.632-2.163zm0 0V2.25L9 5.25v10.303m0 0v3.75a2.25 2.25 0 01-1.632 2.163l-1.32.377a1.803 1.803 0 01-.99-3.467l2.31-.66A2.25 2.25 0 009 15.553z',
  photo:     'M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 001.5-1.5V6a1.5 1.5 0 00-1.5-1.5H3.75A1.5 1.5 0 002.25 6v12a1.5 1.5 0 001.5 1.5zm10.5-11.25h.008v.008h-.008V8.25zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z',
  sparkles:  'M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09zM18.259 8.715L18 9.75l-.259-1.035a3.375 3.375 0 00-2.455-2.456L14.25 6l1.036-.259a3.375 3.375 0 002.455-2.456L18 2.25l.259 1.035a3.375 3.375 0 002.456 2.456L21.75 6l-1.035.259a3.375 3.375 0 00-2.456 2.456z',
  bolt:      'M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z',
  ticket:    'M16.5 6v.75m0 3v.75m0 3v.75m0 3V18m-9-5.25h5.25M7.5 15h3M3.375 5.25c-.621 0-1.125.504-1.125 1.125v3.026a2.999 2.999 0 010 5.198v3.026c0 .621.504 1.125 1.125 1.125h17.25c.621 0 1.125-.504 1.125-1.125v-3.026a2.999 2.999 0 010-5.198V6.375c0-.621-.504-1.125-1.125-1.125H3.375z',
  syncplay:  'M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z',
  home:      'm2.25 12 8.954-8.955c.44-.439 1.152-.439 1.591 0L21.75 12M4.5 9.75v10.125c0 .621.504 1.125 1.125 1.125H9.75v-4.875c0-.621.504-1.125 1.125-1.125h2.25c.621 0 1.125.504 1.125 1.125V21h4.125c.621 0 1.125-.504 1.125-1.125V9.75M8.25 21h8.25',
  play:      'M21 12a9 9 0 11-18 0 9 9 0 0118 0zM15.91 11.672a.375.375 0 010 .656l-5.603 3.113A.375.375 0 019.75 15.113V8.887c0-.286.307-.466.557-.327l5.603 3.112z',
  clock:     'M12 6v6h4.5m4.5 0a9 9 0 11-18 0 9 9 0 0118 0z',
  calendar:  'M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 012.25-2.25h13.5A2.25 2.25 0 0121 7.5v11.25m-18 0A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75m-18 0v-7.5A2.25 2.25 0 015.25 9h13.5A2.25 2.25 0 0121 11.25v7.5',
  fire:      'M15.362 5.214A8.252 8.252 0 0112 21 8.25 8.25 0 016.038 7.047 8.287 8.287 0 009 9.601a8.983 8.983 0 013.361-6.867 8.21 8.21 0 003 2.48z M12 18a3.75 3.75 0 00.495-7.468 5.99 5.99 0 00-1.925 3.547 5.975 5.975 0 01-2.133-1.001A3.75 3.75 0 0012 18z',
  bookmark:  'M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0z',
  queue:     'M3.75 12h16.5m-16.5 3.75h16.5M3.75 19.5h16.5M5.625 4.5h12.75a1.875 1.875 0 010 3.75H5.625a1.875 1.875 0 010-3.75z',
  grid:      'M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25a2.25 2.25 0 01-2.25-2.25v-2.25z',
  building:  'M12 21v-8.25M15.75 21v-8.25M8.25 21v-8.25M3 9l9-6 9 6m-1.5 12V10.332A48.36 48.36 0 0012 9.75c-2.551 0-5.056.2-7.5.582V21M3 21h18M12 6.75h.008v.008H12V6.75z',
  newspaper: 'M12 7.5h1.5m-1.5 3h1.5m-7.5 3h7.5m-7.5 3h7.5m3-9h3.375c.621 0 1.125.504 1.125 1.125V18a2.25 2.25 0 01-2.25 2.25M16.5 7.5V18a2.25 2.25 0 002.25 2.25M16.5 7.5V4.875c0-.621-.504-1.125-1.125-1.125H4.125C3.504 3.75 3 4.254 3 4.875V18a2.25 2.25 0 002.25 2.25h13.5M6 7.5h3v3H6v-3z',
  download:  'M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5M16.5 12L12 16.5m0 0L7.5 12m4.5 4.5V3',
  microphone:'M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z',
  puzzle:    'M14.25 6.087c0-.355.186-.676.401-.959.221-.29.349-.634.349-1.003 0-1.036-1.007-1.875-2.25-1.875s-2.25.84-2.25 1.875c0 .369.128.713.349 1.003.215.283.401.604.401.959v0a.64.64 0 01-.657.643 48.39 48.39 0 01-4.163-.3c.186 1.613.293 3.25.315 4.907a.656.656 0 01-.658.663v0c-.355 0-.676-.186-.959-.401-.29-.221-.634-.349-1.003-.349-1.036 0-1.875 1.007-1.875 2.25s.84 2.25 1.875 2.25c.369 0 .713-.128 1.003-.349.283-.215.604-.401.959-.401v0c.31 0 .555.26.532.57a48.039 48.039 0 01-.642 5.056c1.518.19 3.058.309 4.616.354a.64.64 0 00.657-.643v0c0-.355-.186-.676-.401-.959-.221-.29-.349-.634-.349-1.003 0-1.035 1.008-1.875 2.25-1.875 1.243 0 2.25.84 2.25 1.875 0 .369-.128.713-.349 1.003-.215.283-.4.604-.4.959v0c0 .333.277.599.61.58a48.1 48.1 0 005.427-.63 48.05 48.05 0 00.582-4.717.532.532 0 00-.533-.57v0c-.355 0-.676.186-.959.401-.29.221-.633.349-1.002.349-1.036 0-1.875-1.007-1.875-2.25s.84-2.25 1.875-2.25c.37 0 .713.128 1.003.349.283.215.604.401.959.401v0a.656.656 0 00.659-.663 47.703 47.703 0 00-.31-4.82A48.183 48.183 0 0118 6.75v0a.64.64 0 01-.658-.643z',
  flag:      'M3 3v1.5M3 21v-6m0 0l2.77-.693a9 9 0 016.208.682l.108.054a9 9 0 006.086.71l3.114-.732a48.524 48.524 0 01-.005-10.499l-3.11.732a9 9 0 01-6.085-.711l-.108-.054a9 9 0 00-6.208-.682L3 4.5M3 15V4.5',
  tag:       'M9.568 3H5.25A2.25 2.25 0 003 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 005.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 009.568 3z M6 6h.008v.008H6V6z',
  cloud:     'M2.25 15a4.5 4.5 0 004.5 4.5H18a3.75 3.75 0 001.332-7.257 3 3 0 00-3.758-3.848 5.25 5.25 0 00-10.233 2.33A4.502 4.502 0 002.25 15z',
  bell:      'M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0',
  bolt2:     'M12 18v-5.25m0 0a6.01 6.01 0 001.5-.189m-1.5.189a6.01 6.01 0 01-1.5-.189m3.75 7.478a12.06 12.06 0 01-4.5 0m3.75 2.383a14.406 14.406 0 01-3 0M14.25 18v-.192c0-.983.658-1.823 1.508-2.316a7.5 7.5 0 10-7.517 0c.85.493 1.509 1.333 1.509 2.316V18',
};
// Order in the icon picker.
export const NAV_ICON_KEYS = ['dashboard','search','settings','movies','tvshows','tv','folder','star','heart','book','globe','music','photo','sparkles','bolt','ticket','syncplay','home','play','clock','calendar','fire','bookmark','queue','grid','building','newspaper','download','microphone','puzzle','flag','tag','cloud','bell','bolt2'];

// Music is deliberately left out (needs its own view, currently unsupported).
const NAV_HIDDEN_TYPES = ['music', 'musicvideos'];

// Builds the full entry list: fixed views (translated, dashboard/settings locked)
// + one entry per real library (server name, language-independent). `iconOverrides` (per profile,
// {entryId: paletteKey}) wins over the type default. One source for sidebar and editor.
export function buildNavEntries(libraries, t, iconOverrides = {}) {
  const pick = (id, fallbackKey) =>
    NAV_ICON_PALETTE[iconOverrides[id]] || NAV_ICON_PALETTE[fallbackKey] || NAV_ICON_PALETTE.folder;
  const libItems = (libraries || [])
    .filter(l => !NAV_HIDDEN_TYPES.includes((l.CollectionType || '').toLowerCase()))
    .map(l => {
      const id = 'lib:' + l.Id;
      const type = (l.CollectionType || '').toLowerCase();
      return { id, kind: 'library', lib: l, label: l.Name,
               icon: pick(id, NAV_ICON_PALETTE[type] ? type : 'folder'), locked: false };
    });
  return [
    { id: 'dashboard', kind: 'view', target: 'dashboard', label: t.dashboard, icon: pick('dashboard', 'dashboard'), locked: true },
    { id: 'search',    kind: 'view', target: 'search',    label: t.search,    icon: pick('search', 'search'),       locked: false },
    { id: 'favorites', kind: 'view', target: 'favorites', label: t.favorites, icon: pick('favorites', 'heart'),      locked: false },
    { id: 'syncplay',  kind: 'view', target: 'syncplay',  label: t.syncPlay,  icon: pick('syncplay', 'syncplay'),   locked: false },
    ...libItems,
    { id: 'settings',  kind: 'view', target: 'settings',  label: t.settings,  icon: pick('settings', 'settings'),   locked: true },
  ];
}

// Applies the profile configuration: first by saved order, appending new/unknown
// entries at the end; ignoring orphaned ids. Annotates a `hidden` flag
// (locked entries can never be hidden).
export function applyNavConfig(entries, order = [], hidden = []) {
  const byId = new Map(entries.map(e => [e.id, e]));
  const ordered = [];
  for (const id of (order || [])) if (byId.has(id)) { ordered.push(byId.get(id)); byId.delete(id); }
  for (const e of entries) if (byId.has(e.id)) ordered.push(e);
  return ordered.map(e => ({ ...e, hidden: !e.locked && (hidden || []).includes(e.id) }));
}

// ============================================================
// PROFILE-PICTURE PRESETS (on TV there is no file picker → prebuilt avatars).
// Avatar = white icon on a colored background, rendered to PNG via canvas and uploaded
// as the Jellyfin profile picture (syncs across all clients). Shared paths reused.
export const AVATAR_ICONS = {
  person:     'M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z',
  users:      'M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z',
  academicCap:'M4.26 10.147a60.438 60.438 0 00-.491 6.347A48.62 48.62 0 0112 20.904a48.62 48.62 0 018.232-4.41 60.46 60.46 0 00-.491-6.347m-15.482 0a50.636 50.636 0 00-2.658-.813A59.906 59.906 0 0112 3.493a59.903 59.903 0 0110.399 5.84c-.896.248-1.783.52-2.658.814m-15.482 0A50.717 50.717 0 0112 13.489a50.702 50.702 0 017.74-3.342M6.75 15a.75.75 0 100-1.5.75.75 0 000 1.5zm0 0v-3.675A55.378 55.378 0 0112 8.443m-7.007 11.55A5.981 5.981 0 006.75 15.75v-1.5',
  trophy:     'M16.5 18.75h-9m9 0a3 3 0 013 3h-15a3 3 0 013-3m9 0v-3.375c0-.621-.503-1.125-1.125-1.125h-.871M7.5 18.75v-3.375c0-.621.504-1.125 1.125-1.125h.872m5.007 0H9.497m5.007 0a7.454 7.454 0 01-.982-3.172M9.497 14.25a7.454 7.454 0 00.981-3.172M5.25 4.236c-.982.143-1.954.317-2.916.52A6.003 6.003 0 007.73 9.728M5.25 4.236V4.5c0 2.108.966 3.99 2.48 5.228M5.25 4.236V2.721C7.456 2.41 9.71 2.25 12 2.25c2.291 0 4.545.16 6.75.47v1.516M7.73 9.728a6.726 6.726 0 002.748 1.35m8.272-6.842V4.5c0 2.108-.966 3.99-2.48 5.228m2.48-5.492a46.32 46.32 0 012.916.52 6.003 6.003 0 01-5.395 4.972m0 0a6.726 6.726 0 01-2.749 1.35m0 0a6.772 6.772 0 01-3.044 0',
  smiley:     'M15.182 15.182a4.5 4.5 0 01-6.364 0M21 12a9 9 0 11-18 0 9 9 0 0118 0zM9.75 9.75c0 .414-.168.75-.375.75S9 10.164 9 9.75 9.168 9 9.375 9s.375.336.375.75zm5.25 0c0 .414-.168.75-.375.75s-.375-.336-.375-.75.168-.75.375-.75.375.336.375.75z',
  heart:      NAV_ICON_PALETTE.heart,
  star:       NAV_ICON_PALETTE.star,
  rocket:     'M15.59 14.37a6 6 0 01-5.84 7.38v-4.8m5.84-2.58a14.98 14.98 0 006.16-12.12A14.98 14.98 0 009.63 8.41m5.96 5.96a14.93 14.93 0 01-5.84 2.58m-.12-8.54a6 6 0 00-7.38 5.84h4.8m2.58-5.84a14.93 14.93 0 00-2.58 5.84m2.7 2.7c-.1.02-.21.04-.31.06a15.1 15.1 0 01-2.45-2.45 14.9 14.9 0 01.06-.31m-2.24 2.39a4.49 4.49 0 00-1.76 4.31 4.49 4.49 0 004.31-1.76M16.5 9a1.5 1.5 0 11-3 0 1.5 1.5 0 013 0z',
  puzzle:     'M14.25 6.087c0-.355.186-.676.401-.959.221-.29.349-.634.349-1.003 0-1.036-1.007-1.875-2.25-1.875s-2.25.84-2.25 1.875c0 .369.128.713.349 1.003.215.283.401.604.401.959v0a.64.64 0 01-.657.643 48.39 48.39 0 01-4.163-.3c.186 1.613.293 3.25.315 4.907a.656.656 0 01-.658.663v0c-.355 0-.676-.186-.959-.401-.29-.221-.634-.349-1.003-.349-1.036 0-1.875 1.007-1.875 2.25s.84 2.25 1.875 2.25c.369 0 .713-.128 1.003-.349.283-.215.604-.401.959-.401v0c.31 0 .555.26.532.57a48.039 48.039 0 01-.642 5.056c1.518.19 3.058.309 4.616.354a.64.64 0 00.657-.643v0c0-.355-.186-.676-.401-.959-.221-.29-.349-.634-.349-1.003 0-1.035 1.008-1.875 2.25-1.875 1.243 0 2.25.84 2.25 1.875 0 .369-.128.713-.349 1.003-.215.283-.4.604-.4.959v0c0 .333.277.599.61.58a48.1 48.1 0 005.427-.63 48.05 48.05 0 00.582-4.717.532.532 0 00-.533-.57v0c-.355 0-.676.186-.959.401-.29.221-.633.349-1.002.349-1.036 0-1.875-1.007-1.875-2.25s.84-2.25 1.875-2.25c.37 0 .713.128 1.003.349.283.215.604.401.959.401v0a.656.656 0 00.659-.663 47.703 47.703 0 00-.31-4.82A48.183 48.183 0 0118 6.75v0a.64.64 0 01-.658-.643z',
  bolt:       NAV_ICON_PALETTE.bolt,
  sparkles:   NAV_ICON_PALETTE.sparkles,
  music:      NAV_ICON_PALETTE.music,
  globe:      NAV_ICON_PALETTE.globe,
  book:       NAV_ICON_PALETTE.book,
  photo:      NAV_ICON_PALETTE.photo,
  fire:       NAV_ICON_PALETTE.fire,
  cloud:      NAV_ICON_PALETTE.cloud,
  play:       NAV_ICON_PALETTE.play,
  ticket:     NAV_ICON_PALETTE.ticket,
  moon:       'M21.752 15.002A9.718 9.718 0 0118 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 003 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 009.002-5.998z',
  sun:        'M12 3v2.25m6.364.386l-1.591 1.591M21 12h-2.25m-.386 6.364l-1.591-1.591M12 18.75V21m-4.773-4.227l-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0z',
  gift:       'M21 11.25v8.25a1.5 1.5 0 01-1.5 1.5H5.25a1.5 1.5 0 01-1.5-1.5v-8.25M12 4.875A2.625 2.625 0 109.375 7.5H12m0-2.625V7.5m0-2.625A2.625 2.625 0 1114.625 7.5H12m0 0V21m-8.625-9.75h18c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125h-18c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125z',
  paintBrush: 'M9.53 16.122a3 3 0 00-5.78 1.128 2.25 2.25 0 01-2.4 2.245 4.5 4.5 0 008.4-2.245c0-.399-.078-.78-.22-1.128zm0 0a15.998 15.998 0 003.388-1.62m-5.043-.025a15.994 15.994 0 011.622-3.395m3.42 3.42a15.995 15.995 0 004.764-4.648l3.876-5.814a1.151 1.151 0 00-1.597-1.597L14.146 6.32a15.996 15.996 0 00-4.649 4.763m3.42 3.42a6.776 6.776 0 00-3.42-3.42',
  beaker:     'M9.75 3.104v5.714a2.25 2.25 0 01-.659 1.591L5 14.5M9.75 3.104c-.251.023-.501.05-.75.082m.75-.082a24.301 24.301 0 014.5 0m0 0v5.714c0 .597.237 1.17.659 1.591L19.8 15.3M14.25 3.104c.251.023.501.05.75.082M19.8 15.3l-1.57.393A9.065 9.065 0 0112 15a9.065 9.065 0 00-6.23-.693L5 14.5m14.8.8l1.402 1.402c1.232 1.232.65 3.318-1.067 3.611A48.309 48.309 0 0112 21c-2.773 0-5.491-.235-8.135-.687-1.718-.293-2.3-2.379-1.067-3.61L5 14.5',
};
export const AVATAR_ICON_KEYS = ['person', 'users', 'academicCap', 'trophy', 'smiley', 'heart', 'star', 'rocket', 'puzzle', 'bolt', 'sparkles', 'music', 'globe', 'book', 'photo', 'fire', 'cloud', 'play', 'ticket', 'moon', 'sun', 'gift', 'paintBrush', 'beaker'];
// OLED-friendly, vivid background colors (aligned with the accent palette).
export const AVATAR_COLORS = ['#3b82f6', '#0ea5e9', '#14b8a6', '#10b981', '#6366f1', '#8b5cf6', '#d946ef', '#f43f5e', '#f97316', '#f59e0b'];

// Renders an image (movie/series poster) center-cropped to a square into an avatar (PNG).
// The image is fetched as a Blob and drawn via an ObjectURL → no canvas CORS taint,
// so toDataURL works. imageUrl must contain the token (ApiKey parameter).
export function renderImageAvatarPng(imageUrl, size = 256) {
  return new Promise((resolve, reject) => {
    fetch(imageUrl)
      .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.blob(); })
      .then(blob => {
        const objUrl = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = size;
          const ctx = canvas.getContext('2d');
          const s = Math.min(img.width, img.height);          // center square crop (cover)
          ctx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
          URL.revokeObjectURL(objUrl);
          resolve(canvas.toDataURL('image/png').split(',')[1]);
        };
        img.onerror = (e) => { URL.revokeObjectURL(objUrl); reject(e); };
        img.src = objUrl;
      })
      .catch(reject);
  });
}

// Renders an avatar (icon on a colored surface) to a PNG base64 string via canvas (without the data: prefix).
// Browser-only (uses document/canvas). Returns a Promise.
export function renderAvatarPng(iconKey, bgColor, size = 256) {
  return new Promise((resolve, reject) => {
    const path = AVATAR_ICONS[iconKey] || AVATAR_ICONS.person;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, size, size);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
    const img = new Image();
    img.onload = () => {
      const pad = size * 0.22;                          // icon centered on ~56% of the surface
      ctx.drawImage(img, pad, pad, size - 2 * pad, size - 2 * pad);
      resolve(canvas.toDataURL('image/png').split(',')[1]);
    };
    img.onerror = reject;
    img.src = 'data:image/svg+xml;base64,' + btoa(svg);
  });
}

// Returns true if the Jellyfin server version delivers VobSub/DVD subtitles externally as .mks
// (server PR #16552, merged for the 12.0 / 10.12 line). On older servers false → DVD subs
// must be burned in. Robust parsing: supports major 12 OR 10.12+.
export function serverSupportsVobSub(version) {
  if (!version || typeof version !== 'string') return false;
  const m = version.match(/(\d+)\.(\d+)/);
  if (!m) return false;
  const major = parseInt(m[1], 10), minor = parseInt(m[2], 10);
  if (major > 12) return true;
  if (major === 12) return true;            // "Jellyfin 12.0"
  if (major === 10 && minor >= 12) return true;  // 10.12.x
  return false;
}

// Standard authentication header for Jellyfin API calls (token + JSON content type).
// CONVENTION for list queries (/Items, /Persons, /Genres, NextUp, Resume …):
// always append &EnableTotalRecordCount=false — otherwise the server runs a COUNT
// query over the library per request. Exceptions (that really need the counter): the library
// main query + letterStartIndex (pagination/A-Z) and the person-count check of the search
// (Limit=0). Audit one-liner:  grep -rn "Items?" --include=*.svelte | grep -v EnableTotalRecordCount
// Centralized so that not every component maintains its own copy.
export function authHeaders(token) {
  return {
    "Authorization": `MediaBrowser Token="${token}"`,
    "Content-Type": "application/json",
  };
}

// --- Diagnostic logging (opt-in, device-wide) ----------------------------------------------
// A central switch gates all diagnostic output. dlog() replaces console.log at the
// diagnostic sites (video, SyncPlay, PlaybackInfo, libbitsub …). console.error stays always active.
// Module state is shared by all importers → one setDebug() takes effect everywhere immediately.
let _debug = false;
export function setDebug(on) { _debug = !!on; }

// --- In-app log buffer ----------------------------------------------------------------------
// Ring buffer so users can see/share logs without 'ares inspect'. console.error/warn
// are ALWAYS captured (even without debug mode → after an error the log is already there);
// dlog lines only when debug is active. The original console behavior stays unchanged.
const LOG_BUFFER_MAX = 300;
let _logBuffer = [];
function _stringify(args) {
  return args.map(a => {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.message || String(a);
    try { return JSON.stringify(a); } catch { return String(a); }
  }).join(' ');
}
function _pushLog(level, args) {
  try {
    _logBuffer.push({ t: Date.now(), level, msg: _stringify(args) });
    if (_logBuffer.length > LOG_BUFFER_MAX) _logBuffer.shift();
  } catch {}
}
// Focus/hover hint for icon-only buttons on TV: shows the node's aria-label as a small
// tooltip above it — on FOCUS (D-pad) and hover (pointer), since a TV rarely hovers.
// Reuses aria-label so dynamic labels (watched <-> unwatched) stay correct (read at show
// time). Body-appended + position:fixed so scroll/overflow containers can't clip it; a short
// delay avoids flashing while quickly moving across a button row. {@attach} factory signature.
export function hint(delay = 220) {
  return (node) => {
    let tip = null;
    let timer = null;

    function build() {
      const label = node.getAttribute('aria-label');
      if (!label) return;
      destroy();
      tip = document.createElement('div');
      tip.textContent = label;
      Object.assign(tip.style, {
        position: 'fixed', zIndex: '650', pointerEvents: 'none',   // above modals (<=600), below the screensaver (700)
        background: 'rgba(17,24,39,0.97)', color: '#fff',
        padding: '0.4rem 0.7rem', borderRadius: '0.5rem',
        fontSize: '0.95rem', fontWeight: '600', whiteSpace: 'nowrap',
        border: '1px solid rgba(255,255,255,0.12)',
        boxShadow: '0 6px 20px rgba(0,0,0,0.55)',
        opacity: '0', transition: 'opacity 120ms ease',
      });
      document.body.appendChild(tip);
      position();
      requestAnimationFrame(() => { if (tip) tip.style.opacity = '1'; });
    }
    // Center above the button; flip below near the top edge; clamp to the viewport.
    function position() {
      if (!tip) return;
      const r = node.getBoundingClientRect();
      const tw = tip.offsetWidth, th = tip.offsetHeight, gap = 8, pad = 8;
      let left = r.left + r.width / 2 - tw / 2;
      left = Math.max(pad, Math.min(left, window.innerWidth - tw - pad));
      let top = r.top - th - gap;
      if (top < pad) top = r.bottom + gap;
      tip.style.left = `${left}px`;
      tip.style.top = `${top}px`;
    }
    function show() { clearTimeout(timer); timer = setTimeout(build, delay); }
    function destroy() { clearTimeout(timer); if (tip) { tip.remove(); tip = null; } }

    // Keep the visible hint in sync when the button's aria-label changes while it is shown
    // (e.g. after clicking "mark as watched", the label flips to "mark as unwatched").
    const observer = new MutationObserver(() => {
      const label = node.getAttribute('aria-label');
      if (tip && label) { tip.textContent = label; position(); }
    });
    observer.observe(node, { attributes: true, attributeFilter: ['aria-label'] });

    node.addEventListener('focus', show);
    node.addEventListener('blur', destroy);
    node.addEventListener('mouseenter', show);
    node.addEventListener('mouseleave', destroy);
    return () => {
      observer.disconnect();
      destroy();
      node.removeEventListener('focus', show);
      node.removeEventListener('blur', destroy);
      node.removeEventListener('mouseenter', show);
      node.removeEventListener('mouseleave', destroy);
    };
  };
}

export function dlog(...args) { if (_debug) { _pushLog('log', args); console.log(...args); } }
export function clearLogBuffer() { _logBuffer = []; }
export function formatLog(maxChars = 0) {
  const pad = (n) => String(n).padStart(2, '0');
  let lines = _logBuffer.map(e => {
    const d = new Date(e.t);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${e.level.toUpperCase().padEnd(5)} ${e.msg}`;
  });
  let text = lines.join('\n');
  // For the QR code: return only the end (most recent lines) up to maxChars.
  if (maxChars > 0 && text.length > maxChars) text = '…\n' + text.slice(text.length - maxChars);
  return text;
}
// Also mirror console.error/warn into the buffer (once; the original stays active).
if (typeof console !== 'undefined' && !console.__ocenfinLogHook) {
  const _origErr = console.error.bind(console);
  const _origWarn = console.warn.bind(console);
  console.error = (...a) => { _pushLog('error', a); _origErr(...a); };
  console.warn  = (...a) => { _pushLog('warn', a); _origWarn(...a); };
  console.__ocenfinLogHook = true;
}

// --- Versions for the status/diagnostics page --------------------------------------------------
// Chromium/WebView from the user agent; dependency versions directly from package.json (updates
// automatically on a bump, immediately available, no runtime detection needed).
export function runtimeVersions() {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  const m = ua.match(/Chrom(?:e|ium)\/(\d+(?:\.\d+)*)/);
  const dep = (name) => (deps?.[name] || '').replace(/^[\^~]/, '');
  return { chromium: m ? m[1] : '', hls: dep('hls.js'), libbitsub: dep('libbitsub'), assjs: dep('assjs') };
}

// --- TV capabilities ---------------------------------------------------------------------------
// Panel ground truth via webOSTV.js (webOS.deviceInfo). Provides hard flags (HDR10/Dolby Vision/
// Atmos/UHD/OLED) directly from the TV. Capability flags may be missing depending on firmware → we
// pass them through raw (true/false/undefined) so the UI can distinguish "✓ / ✗ / unknown".
// In browser dev (no window.webOS) → { available:false }.
export function getTvDeviceInfo() {
  return new Promise((resolve) => {
    try {
      const w = typeof window !== 'undefined' ? window : null;
      if (!w || !w.webOS || typeof w.webOS.deviceInfo !== 'function') {
        dlog('[DeviceInfo] webOS.deviceInfo unavailable (browser / no webOS)');
        resolve({ available: false }); return;
      }
      let done = false;
      const finish = (info) => { if (!done) { done = true; resolve(info); } };
      w.webOS.deviceInfo((d) => {
        dlog('[DeviceInfo] detected:', { modelName: d?.modelName, webos: d?.versionMajor, uhd: d?.uhd, oled: d?.oled, hdr10: d?.hdr10, dolbyVision: d?.dolbyVision, dolbyAtmos: d?.dolbyAtmos });
        finish({
          available: true,
          modelName:   d?.modelName || null,
          webosMajor:  (typeof d?.versionMajor === 'number') ? d.versionMajor : null,
          screenWidth: d?.screenWidth || null,
          screenHeight:d?.screenHeight || null,
          uhd:         d?.uhd,
          uhd8K:       d?.uhd8K,
          oled:        d?.oled,
          hdr10:       d?.hdr10,
          dolbyVision: d?.dolbyVision,
          dolbyAtmos:  d?.dolbyAtmos,
        });
      });
      // Some firmware never calls the callback → give up after 2 s.
      setTimeout(() => {
        if (!done) console.warn('[DeviceInfo] no response from webOS.deviceInfo after 2 s — panel detection degraded');
        finish({ available: false });
      }, 2000);
    } catch (e) { console.warn('[DeviceInfo] error:', e); resolve({ available: false }); }
  });
}

// Codec probe via the browser pipeline (canPlayType / MediaSource). NOTE: reflects the
// browser decoder, NOT necessarily the TV hardware (on old webOS this underestimates HEVC). Hence
// labeled "browser decoder" in the UI. true = playable according to the browser.
export function probeBrowserCodecs() {
  if (typeof document === 'undefined') return {};
  const v = document.createElement('video');
  const ok = (mime) => {
    try {
      const c = v.canPlayType(mime);
      const m = (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported) ? MediaSource.isTypeSupported(mime) : false;
      return c === 'probably' || c === 'maybe' || m;
    } catch { return false; }
  };
  return {
    h264: ok('video/mp4; codecs="avc1.640028"'),
    hevc: ok('video/mp4; codecs="hev1.1.6.L153.B0"') || ok('video/mp4; codecs="hvc1.1.6.L153.B0"'),
    vp9:  ok('video/mp4; codecs="vp09.00.10.08"')    || ok('video/webm; codecs="vp9"'),
    av1:  ok('video/mp4; codecs="av01.0.08M.08"')    || ok('video/webm; codecs="av01.0.08M.08"'),
  };
}

// --- BlurHash: modern "blur-up" placeholders for images ----------------------------------------
// Jellyfin provides a BlurHash for every image. We decode it (compact, no dependency) into
// a tiny 32×32 preview and place it as the background behind the <img> (via {@attach blurUp}). Until the
// sharp image loads, the blurry preview shows instead of a gray box.
const B83 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';
function b83(str) { let v = 0; for (const c of str) v = v * 83 + B83.indexOf(c); return v; }
function sRGBtoLin(v) { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }
function linToSRGB(v) { const x = Math.max(0, Math.min(1, v)); return x <= 0.0031308 ? Math.round(x * 12.92 * 255 + 0.5) : Math.round((1.055 * x ** (1 / 2.4) - 0.055) * 255 + 0.5); }

export function decodeBlurHash(hash, width = 32, height = 32, punch = 1) {
  if (!hash || hash.length < 6 || typeof document === 'undefined') return null;
  try {
    const sizeFlag = b83(hash[0]);
    const numY = Math.floor(sizeFlag / 9) + 1, numX = (sizeFlag % 9) + 1;
    const maxAC = (b83(hash[1]) + 1) / 166 * punch;
    const colors = [];
    for (let i = 0; i < numX * numY; i++) {
      if (i === 0) { const v = b83(hash.substr(2, 4)); colors.push([sRGBtoLin(v >> 16), sRGBtoLin((v >> 8) & 255), sRGBtoLin(v & 255)]); }
      else { const v = b83(hash.substr(4 + (i - 1) * 2, 2)); const q = n => { const c = (n - 9) / 9; return Math.sign(c) * c * c * maxAC; };
             colors.push([q(Math.floor(v / (19 * 19))), q(Math.floor(v / 19) % 19), q(v % 19)]); }
    }
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d'); const imgData = ctx.createImageData(width, height); const d = imgData.data;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0;
      for (let j = 0; j < numY; j++) for (let i = 0; i < numX; i++) {
        const basis = Math.cos(Math.PI * x * i / width) * Math.cos(Math.PI * y * j / height);
        const c = colors[i + j * numX]; r += c[0] * basis; g += c[1] * basis; b += c[2] * basis;
      }
      const idx = 4 * (x + y * width);
      d[idx] = linToSRGB(r); d[idx + 1] = linToSRGB(g); d[idx + 2] = linToSRGB(b); d[idx + 3] = 255;
    }
    ctx.putImageData(imgData, 0, 0);
    return canvas.toDataURL();
  } catch { return null; }
}

// Returns the BlurHash of an item for an image type ('Primary'/'Backdrop'), or null.
export function itemBlurHash(item, type = 'Primary') {
  if (!item?.ImageBlurHashes) return null;
  const tag = type === 'Backdrop' ? item.BackdropImageTags?.[0] : item.ImageTags?.[type];
  return tag ? (item.ImageBlurHashes[type]?.[tag] || null) : null;
}

// Svelte attachment (factory): set the decoded BlurHash as the background of an <img> (cached per hash).
// No update needed anymore — on hash change the attachment re-runs automatically (reactive effect).
const _blurCache = new Map();
export function blurUp(hash) {
  return (node) => {
    if (!hash) { node.style.backgroundImage = ''; return; }
    let url = _blurCache.get(hash);
    if (url === undefined) {
      // Cap: the app runs on the TV for days without a reload — unbounded, the cache would grow with
      // every hash ever seen. Clearing is cheap (only a few re-decodes afterward).
      if (_blurCache.size > 500) _blurCache.clear();
      url = decodeBlurHash(hash); _blurCache.set(hash, url);
    }
    if (url) { node.style.backgroundImage = `url(${url})`; node.style.backgroundSize = 'cover'; node.style.backgroundPosition = 'center'; }
  };
}
