<script>
  import { onMount, tick } from 'svelte';
  import { fade } from 'svelte/transition';
  import { isBackKey, focusOnMount, serverSupportsVobSub, authHeaders, dlog, setDebug, uiFade, dropTrapOnOutro, installConnectionGuard, perfMark, startPerfSampler, asArray, asObject, asNumber } from './utils.js';
  import { buildPlayQueue } from './playback.js';
  import { session } from './session.svelte.js';
  import { initWatchlist, handlePlaylistDeleted, handlePlaylistItemsChanged } from './watchlist.svelte.js';
  import { APP_VERSION } from './version.js';
  import { createFocusManager } from './spatialnav.js';
  import { i18n, setLang, detectUiLang } from './i18n.svelte.js';
  import Clock       from './components/Clock.svelte';
  import Screensaver from './components/Screensaver.svelte';
  import Dashboard   from './components/Dashboard.svelte';
  import Sidebar     from './components/Sidebar.svelte';
  import Details     from './components/Details.svelte';
  import ContextMenu from './components/ContextMenu.svelte';
  import AddToPicker from './components/AddToPicker.svelte';
  import Search      from './components/Search.svelte';
  import Favorites   from './components/Favorites.svelte';
  import Person      from './components/Person.svelte';
  import Library     from './components/Library.svelte';
  import Collection  from './components/Collection.svelte';
  import { registerSession, listSyncGroups, createSyncGroup, joinSyncGroup, leaveSyncGroup, syncSocketUrl, setSyncIgnoreWait, measureClockOffset } from './syncplay.js';
  import { suppressTheme } from './thememusic.js';

  // Lazy-loaded views (Vite code-splitting): loaded only on first open, then cached.
  // Keeps the cold-start bundle small — especially the Player pulls the heavy deps (hls.js, assjs) only on
  // first playback instead of loading them on every app start.
  let _settingsP, _playerP, _syncP;
  const lazySettings = () => (_settingsP ??= import('./components/Settings.svelte').then(m => m.default));
  const lazyPlayer   = () => (_playerP   ??= import('./components/Player.svelte').then(m => m.default));
  const lazySyncPlay = () => (_syncP     ??= import('./components/SyncPlay.svelte').then(m => m.default));
  let _loginP;
  const lazyLogin    = () => (_loginP    ??= import('./components/Login.svelte').then(m => m.default));
  let loginRef = $state();   // bind:this → handleBackKey (back in login sub-dialogs)

  // ============================================================
  // APP PHASE
  // 'servers' → 'users' → 'app'
  // ============================================================
  let appPhase = $state('servers');   // current step in the onboarding flow

  // Search and Library stay mounted while inactive, hidden with display:none. Any document-wide
  // lookup therefore also sees THEIR cards — which cannot take focus (so focusing one fails
  // silently) and, worse, would be counted in the card occurrence index and shift it. Every focus
  // lookup in this file is filtered through this.
  const isShown = (el) => !!el && el.offsetParent !== null;

  const CONTENT_FOCUSABLE =
    'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

  // Focus the first usable element in the CONTENT area, outside the hero. The view it belongs to
  // may still be loading, so this retries in the bounded, self-terminating shape used throughout
  // this file — never an interval. Three callers share it, and they differ only in when to stand
  // down, which is why `heldByOther` is a parameter: at app start anything already focused wins,
  // while a sidebar selection has to take focus OUT of the sidebar and may only stop for focus that
  // has gone somewhere else entirely.
  function focusContent({ why, heldByOther, maxTries = 12, gap = 100, onGiveUp }) {
    let cancelled = false, tries = 0;
    const attempt = () => {
      if (cancelled) return;
      const active = document.activeElement;
      if (heldByOther(active)) {
        dlog('[focus]', why, '· stood down, already on', (active.textContent || '').trim().slice(0, 24));
        return;
      }
      const main   = document.querySelector('[data-focus-group="main"]');
      const shown  = main ? [...main.querySelectorAll(CONTENT_FOCUSABLE)].filter(isShown) : [];
      const target = shown.find(el => !el.closest('[data-hero]')) || shown[0];
      if (target) { target.focus(); dlog('[focus]', why, '→', (target.textContent || '').trim().slice(0, 24)); return; }
      if (++tries < maxTries) { setTimeout(attempt, gap); return; }
      onGiveUp?.();
    };
    tick().then(attempt);
    return () => { cancelled = true; };
  }

  // Stand-down rule for everything except the app start. A HIDDEN element never counts as holding
  // focus: Library and Search stay mounted under display:none, and until style is recomputed the
  // browser still reports the element they had — without isShown() a return to the dashboard would
  // stand down for a card that cannot be focused at all.
  const heldOutsideSidebar = (a) =>
    !!a && a !== document.body && isShown(a) && !a.closest('[data-focus-group="sidebar"]');

  // On first entering the app, put focus into the CONTENT — normally the first tile of "My media".
  // A freshly loaded app has no focus at all, and the first D-pad press would otherwise be spent
  // establishing it, landing top-left across hero and first row: with nothing focused, spatialnav
  // picks a group geometrically from a synthetic corner origin, and the sidebar owns x=0.
  //
  // This used to solve that by grabbing the sidebar's active entry one tick in — the only element
  // that reliably exists that early. It worked, but opened the app with the menu unfolded over the
  // artwork. The content is the app's default surface, so that entry is now the FALLBACK and the
  // first content tile is the target.
  //
  // Waiting is unavoidable: one tick in, the dashboard is still loading and its skeletons are plain
  // <div>s, so nothing there is focusable yet. Bounded retries in the shape of
  // restoreContextFocus() below — no interval, ends by itself, and cancelled if the phase changes
  // underneath it. The window is short in practice: the libraries row comes out of the FIRST
  // response round (Views/Resume), the same one that releases the rest of the screen.
  //
  // The hero ([data-hero]) is skipped deliberately: OK on its play button jumps into a rotating
  // random title, whereas a library tile is a calm and predictable landing spot. Rows are
  // configurable, so the pick is "first focusable that is not in the hero" rather than any fixed
  // assumption about what the page shows; with every row hidden the hero button is taken after all,
  // and with nothing focusable at all the sidebar entry closes the chain.
  //
  // Guard unchanged: it only ever acts while nothing holds focus, so it never steals from a modal,
  // the connection-lost retry button or a restore path.
  $effect(() => {
    if (appPhase !== 'app') return;
    return focusContent({
      why: 'start',
      heldByOther: (a) => !!a && a !== document.body,   // unchanged: at start, anyone else wins
      maxTries: 30, gap: 100,                           // ~3 s while the dashboard loads
      onGiveUp: () => {
        dlog('[focus] start → sidebar (no content to focus)');
        document.querySelector('[data-focus-group="sidebar"] [data-group-current]')?.focus();
      },
    });
  });
  let initializing = $state(true);    // splash screen until auto-login/startup is done
  let dashboardReloadKey = $state(0); // incrementing forces a fresh reload of the dashboard
  let resumeStale = $state(false);    // after playback: dashboard fetches Resume/NextUp fresh (cache stays otherwise)
  let currentLibrary     = $state(null);  // { Id, Name } — active library (to Library.svelte)
  let libraryReloadKey   = $state(0);     // increment → Library discards its view cache + reloads
  let libraryFocusFirst  = $state(false); // when opened from the menu, focus the first card
  let librarySharedOn    = $state(false); // "watch together" active (reported by Library)
  let libraryMounted     = $state(false); // permanently mounted from the first library visit on (state persists)
  let searchMounted      = $state(false); // same for Search — mounted from its first visit on
  let searchRef          = $state();      // bind:this → reset() on a fresh open, restoreView() on the way back
  let libraryRef = $state();              // bind:this → restoreView / grid mutations

  // Clear cache (settings): discard the in-memory cache and reload the dashboard fresh.
  function clearCache() {
    apiCache.dashboard = null;
    partnersPlayedCache = {};
    libraryReloadKey++;        // Library discards its own view cache + reloads
    dashboardReloadKey++;
    viewState = 'dashboard';
  }

  // ============================================================
  // SERVER MANAGEMENT
  // ============================================================
  let savedServers      = $state([]);   // [{ id, url, name }]
  let selectedServer    = $state(null); // currently connected server

  // Discovery

  // Manual entry in the add panel

  // ============================================================
  // AUTH / USERS
  // ============================================================
  let users            = $state([]);
  let selectedUser     = $state(null);
  let isLoggedIn       = $state(false);
  let serverVobSub     = $state(false);   // does the server deliver VobSub/DVD externally as .mks? (Jellyfin 12.0+)
  let serverVersion    = $state('');      // Jellyfin server version (for the status page)
  let savedTokens      = $state({});  // { serverId: { userId: token } } — quick switch (only via the profile switch)
  let sharedTokens     = $state({});  // { serverId: { userId: token } } — watch together, SEPARATE from quick switch

  // Login sub-views

  // Quick Connect (login flow — TV shows the code, phone scans it)

  // Device base ID: generated randomly once per installation and kept in localStorage so that
  // the same profile on two TVs does NOT get the same DeviceId (Jellyfin allows only one token per
  // DeviceId → otherwise the second TV would log out the first). Existing installations that already
  // have tokens keep the old fixed base so their tokens stay valid after the update.
  function randomDeviceBase() {
    try {
      const a = new Uint8Array(16); crypto.getRandomValues(a);   // needs NO secure context
      return 'ocenfin-' + Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      return 'ocenfin-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }
  }
  function loadDeviceBase() {
    try {
      const existing = localStorage.getItem('ocenfin_device_base');
      if (existing) return existing;
      const hasTokens = !!localStorage.getItem('jellyfin_tokens_v2')
                     || !!localStorage.getItem('jellyfin_tokens')
                     || !!localStorage.getItem('session_token');
      const base = hasTokens ? 'oceonfin-tv-001' : randomDeviceBase();
      localStorage.setItem('ocenfin_device_base', base);
      return base;
    } catch { return 'oceonfin-tv-001'; }
  }
  const BASE_DEVICE_ID = loadDeviceBase();
  // Unique DeviceId per user: Jellyfin allows only ONE token per DeviceId. Without this separation
  // signing in a second profile (e.g. for watch together) invalidates the first one's
  // token. The hashed username is the user-specific part — it also sanitizes
  // special characters that could break the header format (quoted values).
  function deviceIdHash(name) {
    let h = 5381; const s = String(name || '');
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
  function deviceIdFor(name) { return `${BASE_DEVICE_ID}-${deviceIdHash(name)}`; }
  function authHeaderFor(name) {
    return `MediaBrowser Client="OcenFin-TV", Device="LG Smart TV", DeviceId="${deviceIdFor(name)}", Version="${APP_VERSION}"`;
  }
  // Base header without user reference — only for Quick Connect, since the user is still unknown at initiate time.
  const CLIENT_AUTH_HEADER =
    `MediaBrowser Client="OcenFin-TV", Device="LG Smart TV", DeviceId="${BASE_DEVICE_ID}", Version="${APP_VERSION}"`;

  // Helpful: which user the current server token points to
  // Feed the app-wide stores (in parallel to the existing props; components are migrated step by step).
  // Derive session.serverUrl from the selected server — in the pre phase so children
  // (Dashboard etc.) already read the current URL on remount. The token is written imperatively on
  // login/switch/logout directly into session.token (no feed, no timing lag).
  $effect.pre(() => { session.serverUrl = selectedServer?.url ?? ''; });
  let isCurrentUserSaved = $derived(!!(
    selectedUser && selectedServer &&
    savedTokens[selectedServer.id]?.[selectedUser.Id]
  ));

  // ============================================================
  // ANIMATIONS
  // ============================================================
  let reduceAnimations = $state(false);

  // Display elements (clock, hero banner, episode count, libraries) — individually toggleable
  // ONE source for the profile-pref defaults, consumed twice: the $state initializers here and
  // the applyUserPrefs merge on login. A key added to only one copy ships its feature dead for
  // existing profiles (their stored prefs are spread over the OTHER copy) — that paste-twice trap
  // fired once already (theme music). Functions, not shared literals: navOrder/navHidden/navIcons
  // must be fresh references on every call.
  const defaultDisplaySettings = () => ({ clock: true, hero: true, episodeCount: true, libraries: true, history: true, nextUp: true, watchlist: true, recommendations: true, latest: true, collections: true, sharedSuggestions: true, backdropPreview: true, dashboardBackdrop: true, spoilerProtection: true, detailsBackdrop: true, detailsLogo: false, showChapters: true, clockFormat: 'auto', uiSize: 'medium', theme: 'blue', uiFont: 'system', showLogo: true, recommendationRows: 1, seekStep: 30, navOrder: [], navHidden: [], navIcons: {} });
  const defaultPlaybackPrefs   = () => ({ audioLanguage: 'default', subtitleLanguage: 'default', rememberAudioTrack: true, rememberSubtitleTrack: true, autoSkipIntro: false, autoSkipCredits: false, subtitleSize: 'normal', subtitleColor: 'white', subtitleEdge: 'shadow', subtitleBackground: 'none', subtitleFont: 'system', autoPlayNext: true, burnSubtitles: false, pgsRendering: true, assRendering: true, forcedGraphicSubs: true, stillWatching: true, stillWatchingEpisodes: 3, showPlaybackInfo: false, sleepButton: false, trickplay: true, themeMusic: false, themeMusicScope: 'both', themeMusicVolume: 40, remoteDigitSeek: true, remoteChannelZap: true, remoteColorRed: 'off', remoteColorGreen: 'off', remoteColorYellow: 'off', remoteColorBlue: 'off' });
  let displaySettings = $state(defaultDisplaySettings());

  // Default audio/subtitle language
  let playbackPrefs = $state(defaultPlaybackPrefs());

  // ── Profile-specific settings ───────────────────────────────
  // Language + display + playback + animations are stored PER USER.
  // Before login (server/user selection) there is no profile yet — there the
  // last chosen device language ('app_language') applies. The screensaver
  // stays device-wide (protects the physical OLED panel, user-independent).
  let activeUserId = $state(null);

  // Load (or reset) the user's watchlist whenever the active profile changes.
  $effect(() => { if (activeUserId) initWatchlist(activeUserId); });
  let prefsReady   = false;   // prevents saving during the initial load
  let applyingPrefs = false;  // prevents saving DURING applyUserPrefs (otherwise a half-finished state)

  // Persist language changes (including from the settings) centrally. Tracks i18n.lang reactively
  // and replaces the earlier currentLang.subscribe.
  $effect(() => {
    const v = i18n.lang;
    if (!prefsReady || applyingPrefs) return;
    localStorage.setItem('app_language', v);   // device language for pre-login screens
    saveUserPrefs();                            // + save in the active profile
  });

  // 12h/24h format for both clocks (top right + screensaver).
  // "auto" follows the language: German → 24h, English → 12h. Overridable.
  let use24h = $derived(displaySettings.clockFormat === '24h' ? true
            : displaySettings.clockFormat === '12h' ? false
            : i18n.lang !== 'en');

  // Safety net: never leave the grab lock active beyond the settings.
  $effect(() => { if (viewState !== 'settings' && navReordering) navReordering = false; });

  function userPrefsKey(userId) { return `user_prefs_${userId}`; }

  function loadUserPrefs(userId) {
    try { return asObject(JSON.parse(localStorage.getItem(userPrefsKey(userId)) || '{}')); } catch { return {}; }
  }

  function saveUserPrefs() {
    if (!activeUserId || applyingPrefs) return;
    localStorage.setItem(userPrefsKey(activeUserId), JSON.stringify({
      language: i18n.lang,
      displaySettings,
      playbackPrefs,
      reduceAnimations,
      librarySorts,
      sharedProfile
    }));
  }

  // On login, apply the profile's settings (or keep the device defaults)
  function applyUserPrefs(userId) {
    applyingPrefs = true;
    activeUserId = userId;
    const p = loadUserPrefs(userId);
    if (p.language) {
      setLang(p.language);
      localStorage.setItem('app_language', p.language);   // update "last used"
    }
    displaySettings  = { ...defaultDisplaySettings(), ...asObject(p.displaySettings) };
    // Three fields whose TYPE is load-bearing, so the merge above is not enough: a stored object
    // or number here crashed the sidebar outright (for..of over a non-iterable, .includes on a
    // non-array — both verified). Everything else in displaySettings is a flag or an enum that
    // simply falls back to its default at the point of use.
    displaySettings.navOrder  = asArray(displaySettings.navOrder);
    displaySettings.navHidden = asArray(displaySettings.navHidden);
    displaySettings.navIcons  = asObject(displaySettings.navIcons);
    playbackPrefs    = { ...defaultPlaybackPrefs(), ...asObject(p.playbackPrefs) };
    reduceAnimations = p.reduceAnimations ?? false;
    librarySorts     = asObject(p.librarySorts);   // remembered sort per library
    sharedProfile    = p.sharedProfile && Array.isArray(p.sharedProfile.members)
                       ? { enabled: !!p.sharedProfile.enabled,
                           members: [p.sharedProfile.members[0] || null, p.sharedProfile.members[1] || null] }
                       : { enabled: false, members: [] };
    // Migration: copy member tokens that (old) live only in the quick-switch store into the own
    // shared store → watch together runs independently, quick switch can be turned off freely.
    const _sid = selectedServer?.id;
    if (_sid) {
      let _changed = false;
      for (const m of sharedProfile.members) {
        if (m?.id && !sharedTokens[_sid]?.[m.id] && savedTokens[_sid]?.[m.id]) {
          if (!sharedTokens[_sid]) sharedTokens[_sid] = {};
          sharedTokens[_sid][m.id] = savedTokens[_sid][m.id];
          _changed = true;
        }
      }
      if (_changed) { sharedTokens = { ...sharedTokens }; persistSharedTokens(); }
    }
    librarySharedOn  = false;   // filter starts off per session
    partnersPlayedIds = null;
    partnersPlayedCache = {};   // partner cache belongs to the old session
    applyingPrefs = false;
  }

  $effect.pre(() => {
    if (typeof document !== 'undefined') {
      document.body.dataset.reduceMotion = reduceAnimations ? '1' : '0';
    }
  });

  // Apply appearance — lightweight via CSS: the root font size scales the
  // entire UI (Tailwind computes in rem), data-theme switches the accent color.
  // Runs reactively on every change of displaySettings (login, toggling, startup).
  $effect.pre(() => { if (typeof document !== 'undefined') {
    const sizes = { small: '16px', medium: '20px', large: '24px' };
    document.documentElement.style.fontSize = sizes[displaySettings.uiSize] || '20px';
    document.documentElement.setAttribute('data-theme', displaySettings.theme || 'blue');
    // UI font: set on the root, everything inherits (font-mono spots deliberately stay mono).
    // 'system' → remove the inline style → Chromium/webOS default as before. Does NOT apply to
    // ASS subtitles (their own fonts from the script), but does apply to the VTT display.
    const fonts = { arimo: "'Arimo', sans-serif", noto: "'Noto Sans', sans-serif" };
    document.documentElement.style.fontFamily = fonts[displaySettings.uiFont] || '';
  } });

  function onReduceAnimationsChange(v) {
    reduceAnimations = v;
    saveUserPrefs();
  }

  function onDisplayChange(v) {
    displaySettings = v;
    saveUserPrefs();
  }

  function onPlaybackPrefsChange(v) {
    playbackPrefs = v;
    saveUserPrefs();
  }

  let screensaverSettings = $state({ enabled: true, timeout: 90, mode: 'clock', artSource: 'watched', brightness: 0.45 });
  let showScreensaver     = $state(false);
  // Theme music yields to the screensaver: silence while it is up, resume when it goes.
  $effect(() => { suppressTheme(showScreensaver); });
  let screensaverTimer    = null;
  let playerPlaying       = $state(false);   // reported by the Player; true ONLY during active playback

  // Schedules the screensaver: show after `timeout` s of inactivity. Blocked only when it's off, not in
  // app operation, or the video is CURRENTLY PLAYING. Paused player, details, dashboard etc. → allowed
  // (important on OLED in particular: still images must not burn in).
  function scheduleScreensaver() {
    if (screensaverTimer) { clearTimeout(screensaverTimer); screensaverTimer = null; }
    if (!screensaverSettings.enabled || appPhase !== 'app' || playerPlaying) { showScreensaver = false; return; }
    screensaverTimer = setTimeout(() => { showScreensaver = true; }, screensaverSettings.timeout * 1000);
  }

  // Re-schedule reactively as soon as on/off, app phase or playback status change — so the
  // screensaver also kicks in WITHOUT a keypress (e.g. when the player pauses or is halted via SyncPlay).
  $effect(() => { scheduleScreensaver(); });

  // Every input = activity: screensaver away, timer reset.
  function resetActivity() {
    if (showScreensaver) showScreensaver = false;
    scheduleScreensaver();
  }

  // While the screensaver is running, use the first keypress ONLY to wake and swallow it
  // (capture phase + stopImmediatePropagation) so it doesn't also e.g. toggle the paused playback
  // or trigger something under the screensaver.
  $effect(() => {
    if (!showScreensaver) return;
    const swallow = (e) => { e.preventDefault(); e.stopImmediatePropagation(); resetActivity(); };
    window.addEventListener('keydown', swallow, true);
    return () => window.removeEventListener('keydown', swallow, true);
  });

  function onScreensaverSettingsChange(v) {
    screensaverSettings = v;
    localStorage.setItem('screensaver_settings', JSON.stringify(screensaverSettings));
    scheduleScreensaver();
  }

  // ============================================================
  // NAVIGATION (in-app)
  // ============================================================
  let viewState          = $state('dashboard');
  let currentDetailItem  = $state(null);
  let detailsRef         = $state();      // bind:this → ask its own navigation chain before leaving
  let navLibraries               = $state([]);    // real libraries for the menu (reported by the dashboard)
  let navReordering              = $state(false);  // true while a sidebar entry is "lifted"

  let activeAudioIndex    = $state(-1);
  let activeSubtitleIndex = $state(-1);
  let activeMediaSourceId = $state(null);   // chosen version (FullHD/4K), from Details
  let autoPlayStreak = $state(0);           // "still watching?": episodes auto-played in a row without interaction

  // Remember position: where was Details opened from (scroll/focus now live in Library.svelte)
  let detailsOrigin      = $state('dashboard');   // 'dashboard' | 'library' | 'search'
  // The card Details was opened from, so Back can hand focus straight back to it. Without this the
  // view returns but nothing is focused: activeElement falls to <body>, and the next D-pad press
  // then runs spatialnav's no-focus path, which picks geometrically from the screen corner and
  // lands in the sidebar — the menu flying open after every look at a title.
  let detailsReturnId    = null;
  let detailsReturnEl    = null;
  let detailsReturnNth   = 0;
  let detailsReturnScroll = 0;
  // Views that UNMOUNT cannot remember their own focus, so the card to return to is held here and
  // handed down as a prop. Favourites and Collection focus at the end of their own load, so an
  // outside call would race them — they take the id and decide themselves. The dashboard has no
  // such logic of its own and is served directly by focusCardAgain().
  let pendingCardFocusId = $state(null);
  let pendingCardScrollTop = $state(0);
  // Favourites and Collection each own a scroll container that unmounts WITH the view, so unlike
  // Library (which keeps its savedScroll internally) their offset has to be remembered out here.
  // The dashboard needs none: it scrolls in the persistent main container.
  function scrollTopOf(el) {
    for (let n = el?.parentElement; n; n = n.parentElement) {
      const oy = getComputedStyle(n).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) return n.scrollTop;
    }
    return 0;
  }
  // Same three things for a collection/watchlist, whose Back leads somewhere else entirely.
  let collectionReturnId = null, collectionReturnEl = null, collectionReturnNth = 0, collectionReturnScroll = 0;
  // A person page is reached from the cast list, from search and from favourites — same deal.
  let personReturnId = null, personReturnEl = null, personReturnNth = 0, personReturnScroll = 0;
  let personReturnDetails = null;   // the title page a person was opened FROM, with its own way out

  // ── Watch together ─────────────────────────────────────────────────────────
  // The logged-in (shared) profile references two other profiles. Their tokens
  // live in savedTokens (tied to "save token"); here only ID + name are remembered.
  let sharedProfile     = $state({ enabled: false, members: [] });  // members: [{ id, name }]
  // Set of item IDs watched by AT LEAST ONE member (a union — the loop below adds every member's
  // watched items to one Set). Library hides exactly these, which is the documented behaviour:
  // "hides movies or series that one of you has already seen", i.e. what is left is new to both.
  // The comment used to say "watched by BOTH" — the opposite; do not "fix" the union into an
  // intersection on the strength of a comment.
  let partnersPlayedIds = $state(null);
  let sharedReady = $derived(sharedProfile.enabled
                   && sharedProfile.members.filter(m => m && m.id).length >= 1);
  // Cleanup: option on, but no profile set → turn off again when leaving the settings.
  $effect(() => { if (viewState !== 'settings' && sharedProfile.enabled
         && sharedProfile.members.filter(m => m && m.id).length === 0) {
    sharedProfile = { ...sharedProfile, enabled: false };
    saveUserPrefs();
  } });
  // A member's token: own shared store first, otherwise (if the user enabled
  // the quick switch themselves) the quick-switch store.
  function memberToken(m) {
    const sid = selectedServer?.id;
    return m && (sharedTokens[sid]?.[m.id] || savedTokens[sid]?.[m.id]);
  }
  // Provide the profile list for setup if not loaded yet. ONE SHOT per settings visit:
  // fetchUsers() reassigns `users`, and a server that hides all public users returns [] —
  // without the latch the effect would re-fire on the fresh empty array (new reference,
  // same length) and hammer /Users/Public in an endless loop while Settings is open.
  let usersFetchTried = false;
  $effect(() => {
    if (viewState !== 'settings') { usersFetchTried = false; return; }
    if (users.length === 0 && session.serverUrl && !usersFetchTried) { usersFetchTried = true; fetchUsers(); }
  });

  // ── Shared suggestions (dashboard row "For you both") ──────────────────────
  let sharedSuggestions = $state([]);
  let _loadedSugKey     = null;
  let sharedSugKey = $derived((sharedReady && displaySettings.sharedSuggestions)
                    ? sharedProfile.members.filter(m => m?.id).map(m => m.id).join('|') : '');
  $effect(() => { if (!sharedSugKey && sharedSuggestions.length) sharedSuggestions = []; });
  $effect(() => { if (viewState === 'dashboard' && sharedSugKey && sharedSugKey !== _loadedSugKey) loadSharedSuggestions(); });

  // ── SyncPlay (group playback) — phase 1: manage groups ─────────────────────
  let showSyncPlay = $state(false);
  let syncMyGroup  = $state(null);    // { GroupId, GroupName, Participants } or null
  let syncGroups   = $state([]);      // available groups (excluding my own)
  let syncLoading  = $state(false);
  let syncPollTimer = null;
  let syncJoined   = $state(false);   // is THIS session in a group? (authoritative, not the profile name)
  let syncMyGroupId = $state(null);   // GroupId of my own group (set from the socket GroupJoined or on join)
  // Phase 2: received playback commands + current group queue state (passed on to the Player)
  let syncCommand = $state(null);   // last SyncPlayCommand { ...Data, _seq }
  let syncCmdSeq  = $state(0);
  let syncQueue   = $state(null);   // { itemId, playlistItemId, positionTicks, isPlaying }

  // Admin remote control (Jellyfin dashboard): Playstate/GeneralCommand over the same WebSocket.
  let remoteCommand = $state(null);   // { command, seekTicks?, args?, _seq } → to the Player
  let remoteCmdSeq  = $state(0);
  let remoteMessage = $state(null);   // { header, text } – admin message as an overlay
  let remoteMessageTimer = null;
  function showRemoteMessage(header, text, timeoutMs) {
    // Jellyfin's default header ("Message from Server") or an empty header → localize.
    // Keep a custom header from the admin unchanged.
    const h = (header || '').trim();
    const localized = (!h || h.toLowerCase() === 'message from server') ? i18n.t.messageFromServer : h;
    remoteMessage = { header: localized, text: text || '' };
    if (remoteMessageTimer) clearTimeout(remoteMessageTimer);
    const ms = timeoutMs && timeoutMs > 0 ? Math.min(timeoutMs, 30000) : 7000;
    remoteMessageTimer = setTimeout(() => { remoteMessage = null; }, ms);
  }
  function dismissRemoteMessage() { if (remoteMessageTimer) clearTimeout(remoteMessageTimer); remoteMessage = null; }
  let _lastSyncQueueItem = null;   // last auto-opened group item (no re-opening after leaving)
  let _syncOpeningId = null;       // currently opening (prevents double open)
  async function syncRefresh(silent = false) {
    if (!session.serverUrl || !session.token) return;
    // The 4s background poll refreshes SILENTLY (no loading flag): otherwise the empty state
    // ("no groups") would flip to a spinner and back on every poll, causing a flicker.
    if (!silent) syncLoading = true;
    const all = await listSyncGroups(session.serverUrl, session.token);
    syncLoading = false;
    // My group = the one THIS session joined (by GroupId) — NOT by profile name,
    // since the same user can be a member on multiple devices at once.
    const mine = (syncJoined && syncMyGroupId) ? all.find(g => g.GroupId === syncMyGroupId) || null : null;
    syncMyGroup = mine;
    syncGroups  = all.filter(g => g.GroupId !== syncMyGroupId);
  }
  // Focus return for the SyncPlay modal, same rule as the context menu: back onto the element that
  // opened it. Opened from the Player this is redundant (the Player restores its own controlOpener,
  // which is the very same button), but from the SIDEBAR nothing restored the focus at all: the
  // modal takes it, closing removes those nodes, and the focus fell back to document.body. The
  // next D-pad press then landed on whatever spatialnav found first instead of the sidebar entry.
  let syncReturnEl = null;
  function openSyncPlay() {
    const el = document.activeElement;
    if (el instanceof HTMLElement) syncReturnEl = el;
    showSyncPlay = true;
    syncRefresh();
    if (syncPollTimer) clearInterval(syncPollTimer);
    syncPollTimer = setInterval(() => syncRefresh(true), 4000);   // keep members live-updated while open (silent)
  }
  function closeSyncPlay() {
    showSyncPlay = false;
    if (syncPollTimer) { clearInterval(syncPollTimer); syncPollTimer = null; }
    const el = syncReturnEl;
    syncReturnEl = null;
    // tick() so the modal is really gone — focusing while it still holds the focus would be undone.
    if (el && document.contains(el)) tick().then(() => { if (document.contains(el)) el.focus(); });
  }

  // ── Auto-reconnect: while the server is unreachable, ping it lightly at regular intervals.
  // /System/Info/Public is unauthenticated → independent of the token state. When the server
  // comes back, the banner closes by itself (soft-clear, no reload → the spot stays).
  let reconnectTimer = null;
  function manageReconnect(lost) {
    if (lost && session.serverUrl) {
      if (reconnectTimer) return;
      reconnectTimer = setInterval(async () => {
        try {
          const r = await fetch(`${session.serverUrl}/System/Info/Public`, { cache: 'no-store' });
          if (r.ok) session.connectionLost = false;
        } catch { /* keep trying */ }
      }, 5000);
    } else if (reconnectTimer) {
      clearInterval(reconnectTimer); reconnectTimer = null;
    }
  }
  $effect(() => { manageReconnect(session.connectionLost); });

  // Banner buttons. "Try again" checks IMMEDIATELY, without a reload → your spot stays:
  // if the server is back, the banner closes; otherwise it stays (auto-reconnect keeps running).
  let retryBtnEl = $state();
  async function retryNow() {
    try {
      const r = await fetch(`${session.serverUrl}/System/Info/Public`, { cache: 'no-store' });
      if (r.ok) session.connectionLost = false;
    } catch { /* still gone → banner stays */ }
  }
  // Reliably put focus on the button when the banner appears (it mounts due to a
  // background event; focusOnMount didn't catch it there — tick() after the flush wins).
  $effect(() => { if (session.connectionLost) tick().then(() => retryBtnEl?.focus()); });
  async function syncCreate() { await createSyncGroup(session.serverUrl, session.token, selectedUser?.Name || 'OcenFin'); syncJoined = true; measureClockOffset(session.serverUrl, session.token); await setSyncIgnoreWait(session.serverUrl, session.token, false); await syncRefresh(); }
  async function syncJoin(groupId) { await joinSyncGroup(session.serverUrl, session.token, groupId); syncJoined = true; syncMyGroupId = groupId; measureClockOffset(session.serverUrl, session.token); await setSyncIgnoreWait(session.serverUrl, session.token, false); await syncRefresh(); }
  async function syncLeave() { await leaveSyncGroup(session.serverUrl, session.token); syncJoined = false; syncMyGroupId = null; syncQueue = null; _lastSyncQueueItem = null; await syncRefresh(); }

  // Auto-load: open the item the group is playing programmatically in the Player (jumps to the group position via Ready→Unpause).
  async function openItemInPlayer(itemId) {
    if (!itemId) return;
    const norm = (s) => (s || '').replace(/-/g, '');
    if (viewState === 'player' && norm(currentDetailItem?.Id) === norm(itemId)) return;  // already running
    if (_syncOpeningId === norm(itemId)) return;                                          // currently opening
    _syncOpeningId = norm(itemId);
    try {
      const res = await fetch(`${session.serverUrl}/Users/${selectedUser.Id}/Items/${itemId}`, { headers: getAuthHeaders() });
      if (res.ok) {
        currentDetailItem   = await res.json();
        activeAudioIndex    = -1;
        activeSubtitleIndex = -1;
        activeMediaSourceId = null;
        viewState = 'player';
        dlog('[SyncPlay] auto-load →', currentDetailItem?.Name);
      }
    } catch {}
    _syncOpeningId = null;
  }

  // ── SyncPlay WebSocket (Phase 2) ───────────────────────────────────────────
  // Real-time channel: group updates (join/leave) and – from step 2 on –
  // playback commands (Play/Pause/Seek). Connects after login, keeps itself
  // open via KeepAlive and reconnects automatically on drop.
  let syncSocket = null;
  let syncSocketWanted = false;
  let syncKeepAlive = null;
  let syncReconnect = null;
  function connectSyncSocket() {
    syncSocketWanted = true;
    if (!session.serverUrl || !session.token) return;
    if (syncSocket && (syncSocket.readyState === WebSocket.OPEN || syncSocket.readyState === WebSocket.CONNECTING)) return;
    let ws;
    try { ws = new WebSocket(syncSocketUrl(session.serverUrl, session.token, deviceIdFor(selectedUser?.Name))); }
    catch (e) { console.warn('[SyncPlay] socket could not be opened', e); return; }
    syncSocket = ws;
    ws.onopen = () => {
      dlog('[SyncPlay] socket connected');
      if (syncKeepAlive) clearInterval(syncKeepAlive);
      syncKeepAlive = setInterval(() => { try { ws.send(JSON.stringify({ MessageType: 'KeepAlive' })); } catch {} }, 30000);
    };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      handleSyncMessage(msg);
    };
    ws.onclose = () => {
      // Only the CURRENT socket may act here. The guard in connectSyncSocket() skips OPEN and
      // CONNECTING sockets, but not one already in CLOSING — that one gets replaced, and its late
      // onclose would then clear the NEW socket's KeepAlive interval and queue a pointless
      // reconnect. The new socket would run unwatched until the server drops it.
      // This also covers disconnectSyncSocket(), which nulls syncSocket before close() lands; that
      // path clears the timers itself and wants no reconnect, so returning early is correct there.
      if (ws !== syncSocket) { dlog('[SyncPlay] a superseded socket closed'); return; }
      if (syncKeepAlive) { clearInterval(syncKeepAlive); syncKeepAlive = null; }
      dlog('[SyncPlay] socket disconnected');
      if (syncSocketWanted) { clearTimeout(syncReconnect); syncReconnect = setTimeout(connectSyncSocket, 5000); }
    };
    ws.onerror = () => { /* onclose follows automatically → reconnect there */ };
  }
  function disconnectSyncSocket() {
    syncSocketWanted = false;
    if (syncReconnect) { clearTimeout(syncReconnect); syncReconnect = null; }
    if (syncKeepAlive) { clearInterval(syncKeepAlive); syncKeepAlive = null; }
    if (syncSocket) { try { syncSocket.close(); } catch {} syncSocket = null; }
  }
  function handleSyncMessage(msg) {
    if (!msg || !msg.MessageType) return;
    if (msg.MessageType === 'SyncPlayGroupUpdate') {
      const type = msg.Data?.Type;
      // Anchor my own membership authoritatively on the socket (GroupId), not on the name.
      if (type === 'GroupJoined') { syncJoined = true; syncMyGroupId = msg.Data?.GroupId || syncMyGroupId; measureClockOffset(session.serverUrl, session.token); syncRefresh(); }
      else if (['GroupLeft', 'NotInGroup', 'GroupDoesNotExist'].includes(type)) { syncJoined = false; syncMyGroupId = null; syncQueue = null; syncRefresh(); }
      else if (['UserJoined', 'UserLeft'].includes(type)) syncRefresh();
      else if (type === 'PlayQueue') {
        // Current group queue state (which item, which position) → passed on to the Player.
        const q = msg.Data?.Data;
        const entry = q?.Playlist?.[q?.PlayingItemIndex ?? 0];
        syncQueue = entry
          ? { itemId: entry.ItemId, playlistItemId: entry.PlaylistItemId, positionTicks: q.StartPositionTicks || 0, isPlaying: !!q.IsPlaying }
          : null;
        dlog('[SyncPlay] PlayQueue', syncQueue);
        // New group item → open automatically (only once per item; not again after manually leaving).
        const qid = syncQueue?.itemId || null;
        if (syncMyGroup && qid && qid !== _lastSyncQueueItem) {
          _lastSyncQueueItem = qid;
          openItemInPlayer(qid);
        }
      }
    } else if (msg.MessageType === 'SyncPlayCommand') {
      // Playback command (Play/Pause/Seek) → to the Player; _seq serves the Player as a dedupe marker.
      syncCommand = { ...msg.Data, _seq: ++syncCmdSeq };
      dlog('[SyncPlay] command received', syncCommand.Command, syncCommand.PositionTicks);
    } else if (msg.MessageType === 'Playstate') {
      // Admin remote control (dashboard): Pause/Unpause/Stop/Seek/PlayPause/NextTrack → to the Player.
      const cmd = msg.Data?.Command;
      if (cmd) { remoteCommand = { command: cmd, seekTicks: msg.Data?.SeekPositionTicks ?? null, _seq: ++remoteCmdSeq }; }
    } else if (msg.MessageType === 'GeneralCommand') {
      const name = msg.Data?.Name;
      if (name === 'DisplayMessage') {
        const a = msg.Data?.Arguments || {};
        showRemoteMessage(a.Header, a.Text, parseInt(a.TimeoutMs, 10) || 0);
      } else if (name) {
        // Volume/mute etc. → pass on to the Player.
        remoteCommand = { command: name, args: msg.Data?.Arguments || {}, _seq: ++remoteCmdSeq };
      }
    } else if (msg.MessageType === 'Play') {
      // Admin "Play on this device" → open the first item.
      const itemId = msg.Data?.ItemIds?.[0];
      if (itemId) openItemInPlayer(itemId);
    }
  }
  // Open the socket once logged in — covers regular login AND auto-recovery on reload.
  $effect(() => { if (isLoggedIn && session.token && session.serverUrl && !syncSocketWanted) {
    registerSession(session.serverUrl, session.token);   // register the session as controllable (for SyncPlay)
    connectSyncSocket();                        // open the SyncPlay real-time channel
  } });

  let showExitConfirm = $state(false);   // confirmation dialog "Exit app?" (back on the dashboard)
  let librarySorts = $state({});   // remembered sort per library (saved in the profile)
  let apiCache = { dashboard: null };   // dashboard only now; the library cache lives in Library.svelte

  // ============================================================
  // STORAGE HELPERS
  // ============================================================

  function loadSavedServers() {
    // asArray, not just the try/catch: a stored object parses fine and then breaks .filter().
    try { return asArray(JSON.parse(localStorage.getItem('jellyfin_servers') || '[]')); } catch { return []; }
  }
  function persistSavedServers() {
    localStorage.setItem('jellyfin_servers', JSON.stringify(savedServers));
  }
  function loadSavedTokens() {
    try { return asObject(JSON.parse(localStorage.getItem('jellyfin_tokens_v2') || '{}')); } catch { return {}; }
  }
  function persistSavedTokens() {
    localStorage.setItem('jellyfin_tokens_v2', JSON.stringify(savedTokens));
  }
  // Own store for watch together — deliberately separate from the quick switch (savedTokens),
  // so that setup NEVER affects a profile's quick-switch toggle.
  function loadSharedTokens() {
    try { return asObject(JSON.parse(localStorage.getItem('jellyfin_shared_tokens_v1') || '{}')); } catch { return {}; }
  }
  // Tell the server a token is finished with. Deleting our copy only throws away the key — the
  // token stays valid, and the TV keeps sitting in Dashboard → Devices as a working entry. Someone
  // who removes a server expects the access to END, not just to be forgotten locally.
  //
  // Fire and forget: an unreachable server, or a token the server already rejected, must never
  // block or delay the local removal. The user has decided; we only try to be tidy on the far side.
  async function revokeToken(baseUrl, token) {
    if (!baseUrl || !token) return;
    try {
      await fetch(`${baseUrl}/Sessions/Logout`, { method: 'POST', headers: authHeaders(token) });
      dlog('[auth] token revoked server-side');
    } catch (e) { dlog('[auth] revoke failed (server gone?):', e?.message || e); }
  }

  // Is this token STILL held somewhere after the deletion we just did? Revoking one that another
  // store shares would break that feature: setSharedMember happily reuses an existing quick-switch
  // token, and turning "remember me" off leaves the very same token running the live session.
  function tokenStillKept(sid, token) {
    if (!token) return true;
    if (token === session.token) return true;                       // the running session uses it
    return Object.values(savedTokens[sid]  || {}).includes(token)
        || Object.values(sharedTokens[sid] || {}).includes(token);
  }

  function persistSharedTokens() {
    localStorage.setItem('jellyfin_shared_tokens_v1', JSON.stringify(sharedTokens));
  }
  function loadScreensaverSettings() {
    try { return asObject(JSON.parse(localStorage.getItem('screensaver_settings') || '{}')); } catch { return {}; }
  }

  /**
   * One-time migration from the old format (single server, flat token map).
   * Runs once and then removes the old keys.
   */
  function migrateOldData() {
    // Sweep legacy plaintext token keys unconditionally FIRST. They predate jellyfin_url in some
    // installs, and the old early-return left live full-access tokens under keys nothing reads or
    // deletes again. removeItem on an absent key is a no-op, so this is safe on a clean install.
    const sweepLegacy = () => {
      for (const k of ['jellyfin_tokens', 'session_token', 'session_user']) localStorage.removeItem(k);
    };
    const oldUrl = localStorage.getItem('jellyfin_url');
    if (!oldUrl) { sweepLegacy(); return; }

    const serverId  = 'srv_migrated_' + Date.now();
    const newServer = { id: serverId, url: oldUrl, name: 'Jellyfin Server' };
    savedServers    = [newServer];
    persistSavedServers();

    const oldTokensStr = localStorage.getItem('jellyfin_tokens');
    if (oldTokensStr) {
      try {
        const old = JSON.parse(oldTokensStr);
        savedTokens = { [serverId]: old };
        persistSavedTokens();
      } catch { }
      localStorage.removeItem('jellyfin_tokens');
    }

    const oldUser  = localStorage.getItem('session_user');
    const oldToken = localStorage.getItem('session_token');
    if (oldUser && oldToken) {
      localStorage.setItem('current_session', JSON.stringify({
        serverId, userId: oldUser, token: oldToken
      }));
      localStorage.removeItem('session_user');
      localStorage.removeItem('session_token');
    }

    sweepLegacy();
    localStorage.removeItem('jellyfin_url');
  }

  function saveCurrentSession() {
    if (selectedServer && selectedUser && session.token) {
      localStorage.setItem('current_session', JSON.stringify({
        serverId: selectedServer.id,
        userId:   selectedUser.Id,
        token:    session.token
      }));
    }
  }
  function clearCurrentSession() {
    localStorage.removeItem('current_session');
  }

  // ============================================================
  // LIFECYCLE
  // ============================================================

  onMount(async () => {
    migrateOldData();
    savedServers        = loadSavedServers();
    savedTokens         = loadSavedTokens();
    sharedTokens        = loadSharedTokens();
    screensaverSettings = { enabled: true, timeout: 90, mode: 'clock', artSource: 'watched', brightness: 0.45, ...loadScreensaverSettings() };
    // timeout drives setTimeout: a non-numeric value makes that NaN, which fires IMMEDIATELY and
    // then again on every reschedule — a screensaver flashing over the whole interface, hard to
    // escape with a remote. Clamped rather than merely defaulted, so an absurd stored number
    // cannot disable it either. brightness likewise, since it reaches CSS.
    screensaverSettings.timeout    = asNumber(screensaverSettings.timeout, 90, 10, 3600);
    screensaverSettings.brightness = asNumber(screensaverSettings.brightness, 0.45, 0, 1);
    setDebug(localStorage.getItem('ocenfin_debug') === '1');   // device-wide diagnostic logging (opt-in)

    // Device language for pre-login screens (server/user selection): last chosen language →
    // otherwise device language → otherwise English. Validated against existing translations.
    // Profile-specific settings are only loaded on login via applyUserPrefs.
    setLang(detectUiLang());
    prefsReady = true;   // from now on changes are persisted

    // Global back key (webOS remote)
    window.addEventListener('keydown', handleGlobalBack);
    // D-pad navigation (group focus model) — active everywhere. The Player is its
    // own focus group; its slider handles Left/Right itself.
    createFocusManager(() => !navReordering);
    // Boot milestone: the shell is wired up (listeners, focus manager, connection guard). The
    // second milestone follows below when the splash actually goes away.
    perfMark('boot shell');
    // Long-session sampler. App-lifetime by design like the listeners above — the root never
    // unmounts — and it bails out immediately while debug is off, so it costs one timer.
    startPerfSampler();
    // Session died server-side (see session.svelte.js). Drop the token that just proved invalid —
  // otherwise auto-login reuses it on the next start, collects another 401 and bounces straight
  // back here — then run the normal profile teardown. No banner on purpose: the profile picker
  // says it better than any message could. Token revoked → the profile is still listed and you
  // sign in again; account deleted → it is simply gone.
  let _authTeardownRunning = false;
  $effect(() => {
    if (!session.authLost) return;
    // Only while the app is actually running. During restore/login the token is deliberately tried
    // out and a 401 is an expected answer there — those flows handle it themselves (clear the
    // session, show the profile list), and running this teardown on top would just repeat it.
    if (appPhase !== 'app') { session.authLost = false; return; }
    if (_authTeardownRunning) { session.authLost = false; return; }
    _authTeardownRunning = true;
    session.authLost = false;   // consume; the confirmation probe below decides
    (async () => {
      // CONFIRM before the destructive teardown. A single sporadic 401 — a reverse proxy reloading,
      // an auth_request backend flapping, an injected 401 on a plain-HTTP setup — must not delete
      // the saved token and force a password re-entry on the TV remote. Re-check the same token
      // once; only tear down if it is genuinely rejected again.
      const stillValid = await validateToken(session.token, session.serverUrl);
      if (!stillValid && appPhase === 'app') {
        const sid = selectedServer?.id, uid = selectedUser?.Id;
        if (sid && uid && savedTokens[sid]?.[uid]) { delete savedTokens[sid][uid]; persistSavedTokens(); }
        dlog('[auth] server rejected our token (confirmed) — returning to the profile selection');
        handleSwitchUser();
      } else {
        dlog('[auth] 401 was transient — token still valid, staying put');
      }
      _authTeardownRunning = false;
    })();
  });

  // Monitor network status (banner on connection loss). The offline/online events cover the
    // OS network state; the connection guard additionally catches "server unreachable while the
    // network is up" (NAS reboot etc.) by watching server fetches for network-level failures.
    installConnectionGuard();
    window.addEventListener('offline', () => session.connectionLost = true);
    window.addEventListener('online',  () => session.connectionLost = false);

    // webOS lifecycle: returning to the (suspended) app via Home fires webOSRelaunch.
    // On some builds/appinfo configs (handlesRelaunch:true) the app then stays stuck in the
    // background and appears not to start — so we explicitly bring it to the
    // foreground. Harmless if webOS handles it itself anyway.
    const toForeground = () => {
      dlog('[Lifecycle] webOSRelaunch → activate');
      try { window.PalmSystem?.activate?.(); } catch (e) { console.warn('[Lifecycle] activate failed:', e); }
      try { window.webOSSystem?.activate?.(); } catch { /* not present */ }
    };
    document.addEventListener('webOSRelaunch', toForeground, true);

    // Actively decline the webOS system screensaver while OcenFin's own screensaver is active —
    // otherwise two screensavers would stack and you'd have to press twice. webOS asks via
    // the Luna API before showing; we answer with ack:false (= please don't show, we
    // protect the OLED ourselves). If OcenFin's screensaver is off, we allow webOS (ack:true).
    if (window.webOS?.service?.request) {
      window.webOS.service.request('luna://com.webos.service.tvpower', {
        method: 'power/registerScreenSaverRequest',
        parameters: { subscribe: true, clientName: 'ocenfin' },
        subscribe: true,
        onSuccess: (res) => {
          // The first response only confirms the registration (without state); afterwards state comes per request.
          if (res?.state !== 'Active') { dlog('[Screensaver] Luna registered, returnValue=', res?.returnValue); return; }
          // Decline only while OcenFin's saver can actually take over: outside the app phase
          // (server/user selection) scheduleScreensaver refuses to run, so declining would leave
          // the static login screen with NO screensaver at all — the opposite of OLED protection.
          const decline = screensaverSettings.enabled && appPhase === 'app';
          dlog('[Screensaver] webOS request →', decline ? 'declined (ack:false)' : 'allowed (ack:true)');
          window.webOS.service.request('luna://com.webos.service.tvpower', {
            method: 'power/responseScreenSaverRequest',
            parameters: { clientName: 'ocenfin', ack: !decline, timestamp: res.timestamp },
            onFailure: (e) => console.warn('[Screensaver] response error:', e?.errorText || e?.errorCode || e),
          });
        },
        onFailure: (err) => console.warn('[Screensaver] Luna registration failed:', err?.errorText || err?.errorCode || err),
      });
    } else {
      dlog('[Screensaver] webOS service unavailable (no webOS / browser)');
    }

    try {
      // Auto-login via a saved session
      const sessionStr = localStorage.getItem('current_session');
      dlog('[restore] current_session present:', !!sessionStr);
      if (sessionStr) {
        try {
          const saved = JSON.parse(sessionStr);
          const server  = savedServers.find(s => s.id === saved.serverId);
          dlog('[restore] server found:', !!server, '| token:', !!saved.token, '| userId:', !!saved.userId);
          if (server && saved.token && saved.userId) {
            selectedServer = server;
            session.token    = saved.token;

            if (await validateToken(saved.token, server.url)) {
              const res = await fetch(`${server.url}/Users/${saved.userId}`, {
                headers: getAuthHeaders()
              });
              dlog('[restore] /Users/{id} HTTP', res.status);
              if (res.ok) {
                selectedUser = await res.json();
                isLoggedIn   = true;
                appPhase     = 'app';
                applyUserPrefs(selectedUser.Id);   // load profile settings
                fetchUsers(); // in the background for user switching
                scheduleScreensaver();
                dlog('[restore] auto-login successful:', selectedUser.Name);
                return;
              }
            }
            // Token expired → user screen for this server
            dlog('[restore] token invalid → back to user screen');
            clearCurrentSession();
            // selectedServer is set (above) — the Login component shows the profile selection
            // and loads the profiles itself (users effect in Login.svelte).
            appPhase = 'users';
            return;
          }
        } catch (e) { dlog('[restore] restore failed:', e?.message || e); clearCurrentSession(); }
      }

      // No auto-login → show server selection
      dlog('[restore] no auto-login → server selection');
      appPhase = 'servers';
    } finally {
      initializing = false;   // hide the splash screen (whichever path)
      perfMark('boot usable', `phase=${appPhase}`);   // splash gone → first screen is interactive
    }
  });

  // ============================================================
  // REMOVE SERVER — connect/discovery/login flow lives in
  // components/Login.svelte (lazy-loaded)
  // ============================================================

  function removeServer(id) {
    // Capture before deleting: the URL to send the revocations to, and every token this server
    // holds in either store. Nothing else can be keeping them — the server entry itself is going.
    const baseUrl = savedServers.find(s => s.id === id)?.url;
    const doomed  = [...new Set([
      ...Object.values(savedTokens[id]  || {}),
      ...Object.values(sharedTokens[id] || {}),
    ])].filter(t => t && t !== session.token);
    savedServers = savedServers.filter(s => s.id !== id);
    persistSavedServers();
    // Remove tokens for this server — BOTH stores. The quick-switch tokens and the watch-together
    // member tokens (sharedTokens) are full-access credentials; leaving the shared ones behind when
    // the server is gone stranded live secrets in localStorage with no UI left to remove them.
    if (savedTokens[id]) {
      delete savedTokens[id];
      savedTokens = { ...savedTokens };
      persistSavedTokens();
    }
    if (sharedTokens[id]) {
      delete sharedTokens[id];
      sharedTokens = { ...sharedTokens };
      persistSharedTokens();
    }
    for (const t of doomed) revokeToken(baseUrl, t);   // not awaited — see revokeToken
  }

  // ============================================================
  // AUTH
  // ============================================================

  const getAuthHeaders = () => authHeaders(session.token);

  async function fetchUsers() {
    try {
      const res = await fetch(`${session.serverUrl}/Users/Public`);
      if (res.ok) users = await res.json();
      else console.warn('[Server] user list HTTP', res.status);
    } catch (e) { console.warn('[Server] could not load user list:', e); }
  }

  // ── Watch together: members & data basis ──────────────────────────────────
  function toggleSharedEnabled() {
    sharedProfile = { ...sharedProfile, enabled: !sharedProfile.enabled };
    if (!sharedProfile.enabled) { librarySharedOn = false; partnersPlayedIds = null; partnersPlayedCache = {}; }
    saveUserPrefs();
  }

  // Set a profile as a member. Uses a valid saved token; otherwise it
  // authenticates once with pw. NO session switch — the shared profile stays active.
  // Returns: 'ok' | 'needPassword' | 'error'
  // presetToken: already authenticated elsewhere (Quick Connect), so no credentials are needed —
  // the token IS the proof. Everything after the acquisition is shared with the password path.
  async function setSharedMember(slot, user, pw = '', presetToken = null) {
    if (!user || !selectedServer) return 'error';
    const sid = selectedServer.id;
    // With Quick Connect the account is only known AFTER confirmation — whoever approves the code
    // decides it — so the "not yourself, not the other slot" rule cannot be enforced by filtering
    // the list beforehand and has to be checked here.
    if (user.Id && (user.Id === selectedUser?.Id || user.Id === sharedProfile.members[slot === 0 ? 1 : 0]?.id)) {
      return 'sameUser';
    }
    // Reuse an existing token (own store or self-enabled quick switch).
    let token = presetToken || (user.Id ? (sharedTokens[sid]?.[user.Id] || savedTokens[sid]?.[user.Id]) : null);
    if (token && !(await validateToken(token))) token = null;   // expired → re-authenticate
    if (!token) {
      // HasPassword from /Users/Public is only a hint for WHICH dialog to show first — never the
      // thing that decides access. The gate is AuthenticateByName below: a profile with a password
      // cannot be added without it, because the SERVER refuses. Treat a rejected attempt as "needs
      // a password" rather than a generic error, so the prompt still appears when that hint is
      // missing or wrong (older servers, a proxy trimming the DTO, a hidden profile typed by hand).
      if (user.HasPassword && !pw) return 'needPassword';
      try {
        const res = await fetch(`${session.serverUrl}/Users/AuthenticateByName`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': authHeaderFor(user.Name) },
          body:    JSON.stringify({ Username: user.Name, Pw: pw || '' })
        });
        if (res.status === 401) return pw ? 'error' : 'needPassword';
        if (!res.ok) return 'error';
        const data = await res.json();
        token = data.AccessToken;
        // A hand-typed profile (hidden ones are absent from /Users/Public) has no Id yet — take
        // the identity the server just confirmed rather than anything the user typed.
        if (!user.Id && data.User?.Id) user = { Id: data.User.Id, Name: data.User.Name };
        if (!user.Id) return 'error';
      } catch { return 'error'; }
    }
    // Store the token ONLY in the own shared store — NEVER in savedTokens. The quick switch
    // thus stays controllable solely via the profile switch (decided per user themselves).
    if (!sharedTokens[sid]) sharedTokens[sid] = {};
    sharedTokens[sid][user.Id] = token;
    sharedTokens = { ...sharedTokens };
    persistSharedTokens();
    const members = [sharedProfile.members[0] || null, sharedProfile.members[1] || null];
    members[slot] = { id: user.Id, name: user.Name };
    sharedProfile = { ...sharedProfile, members };
    _loadedSugKey = null;   // recompute suggestions
    saveUserPrefs();
    partnersPlayedCache = {};   // members changed → all cached unions invalid
    _sharedWarned = new Set();  // a re-added profile must be able to warn again if it breaks later
    if (librarySharedOn) loadPartnersPlayedIds(currentLibrary?.Id);
    return 'ok';
  }

  function removeSharedMember(slot) {
    const members = [sharedProfile.members[0] || null, sharedProfile.members[1] || null];
    const removed = members[slot];
    members[slot] = null;
    sharedProfile = { ...sharedProfile, members };
    // Remove only the own shared token — the quick-switch token (savedTokens) stays untouched.
    const sid = selectedServer?.id;
    if (removed?.id && sid && sharedTokens[sid]?.[removed.id]) {
      const tok = sharedTokens[sid][removed.id];
      delete sharedTokens[sid][removed.id];
      sharedTokens = { ...sharedTokens };
      persistSharedTokens();
      // setSharedMember may have adopted an existing quick-switch token — revoking it here would
      // break that profile's password-free login. Only revoke once nothing holds it any more.
      if (!tokenStillKept(sid, tok)) revokeToken(session.serverUrl, tok);
    }
    _loadedSugKey = null;   // recompute suggestions
    saveUserPrefs();
    partnersPlayedCache = {};   // members changed → all cached unions invalid
    _sharedWarned = new Set();  // a re-added profile must be able to warn again if it breaks later
    if (librarySharedOn) loadPartnersPlayedIds(currentLibrary?.Id);
  }

  // Union of the top-level titles fully watched by the members in the library.
  // Each profile with its own token (no admin). We fetch all titles with UserData and check
  // for Played=true ourselves — more reliable than Filters=IsPlayed, which doesn't always work for series.
  // Cache per library (TTL 10 min): the fetch is the heaviest query in the app (full catalog
  // per member) — don't reload every time when switching back and forth between libraries.
  // Invalidated on member change, profile-off, session switch and "clear cache".
  // One member's token being gone degrades "watch together" SILENTLY: the union below is then
  // built from the other member alone, so the library filters with half the data and simply shows
  // more than it should. The settings page marks the profile, but nobody browsing a library looks
  // there. Say it once per member per session — repeating it on every library switch would be
  // worse than saying nothing. Reuses the admin-message overlay and two existing strings, so this
  // costs no new translations.
  let _sharedWarned = new Set();
  function warnSharedMember(m) {
    console.warn('[Shared] no valid token for', m.name, '– please re-add profile.');
    if (_sharedWarned.has(m.id)) return;
    _sharedWarned.add(m.id);
    showRemoteMessage(i18n.t.sharedWatching, `${m.name}: ${i18n.t.sharedNeedsLogin}`, 9000);
  }

  let partnersPlayedCache = {};   // libraryId → { ids: Set, at: timestamp }
  const PARTNERS_CACHE_TTL = 10 * 60 * 1000;
  // The suggestion scan asks every member for their WHOLE catalogue, across all libraries, so its
  // union of watched IDs already contains every per-library one. It is parked in THIS cache under a
  // reserved key rather than in a variable of its own: every place that invalidates
  // partnersPlayedCache — sign-out, server switch, a changed member list — then invalidates it too,
  // with no second reset site to keep in step. Library IDs are GUIDs, so the key cannot collide.
  const PARTNERS_ALL_KEY = '__allLibraries';
  let _partnersSeq = 0;   // supersede guard: only the LATEST library switch may publish its result
  async function loadPartnersPlayedIds(libraryId) {
    const seq = ++_partnersSeq;
    partnersPlayedIds = null;
    if (!librarySharedOn || !sharedReady || !libraryId) return;
    const hit = partnersPlayedCache[libraryId];
    if (hit && Date.now() - hit.at < PARTNERS_CACHE_TTL) { partnersPlayedIds = hit.ids; return; }
    // Free if the dashboard already ran the suggestion scan. Item IDs are unique server-wide, so
    // the entries belonging to other libraries can never match anything in this one — the wider set
    // filters exactly like the narrow one would.
    const all = partnersPlayedCache[PARTNERS_ALL_KEY];
    if (all && Date.now() - all.at < PARTNERS_CACHE_TTL) {
      partnersPlayedIds = all.ids;
      dlog('[Shared] library filter reused the suggestion scan — no request');
      return;
    }
    const ids = new Set();
    const tAll = Date.now();
    // Side by side, not one after the other: two profiles are two independent catalogue scans, and
    // awaiting them in sequence simply doubled the wait before the library could be filtered.
    await Promise.all(sharedProfile.members.map(async (m) => {
      if (!m || !m.id) return;
      const token = memberToken(m);
      if (!token) { warnSharedMember(m); return; }
      const t0 = Date.now();
      try {
        const res = await fetch(
          `${session.serverUrl}/Users/${m.id}/Items?ParentId=${libraryId}&Recursive=true` +
          `&IncludeItemTypes=Movie,Series&Fields=UserData&EnableImages=false` +
          `&Limit=100000&EnableTotalRecordCount=false`,
          { headers: authHeaders(token) }
        );
        if (!res.ok) {
          console.warn('[Shared] query failed for', m.name, '· HTTP', res.status);
          if (res.status === 401 || res.status === 403) warnSharedMember(m);   // that member's token died
          return;
        }
        let n = 0;
        // Check UserData.Played client-side — more reliable than Filters=IsPlayed (doesn't always work for series).
        const list = (await res.json()).Items || [];
        list.forEach(i => { if (i.UserData?.Played) { ids.add(i.Id); n++; } });
        // Item count and duration are what settle whether a scan is worth avoiding on a given
        // library — guessing at it from a desktop browser says nothing about the television.
        dlog('[Shared]', m.name, '→', n, 'of', list.length, 'titles watched ·', Date.now() - t0, 'ms');
      } catch (e) { console.warn('[Shared] error for', m.name, e); }
    }));
    dlog('[Shared] library filter scanned in', Date.now() - tAll, 'ms (members in parallel)');
    partnersPlayedCache[libraryId] = { ids, at: Date.now() };   // cache stays valid for ITS library
    if (seq !== _partnersSeq) return;   // library switched while fetching → don't publish stale IDs
    partnersPlayedIds = ids;
  }

  // Load/discard partner IDs for "watch together" as soon as the library or toggle changes.
  $effect(() => {
    const lib = currentLibrary;
    if (lib && librarySharedOn) loadPartnersPlayedIds(lib.Id);
    else { _partnersSeq++; partnersPlayedIds = null; }   // also invalidates any in-flight load
  });

  // Suggestions that match the SHARED preference and that no one has watched yet.
  // Fetch the catalog once per member (with genres) → genre weights (only genres ALL like)
  // and the union of watched IDs. Then rank unwatched titles by genre score.
  async function loadSharedSuggestions() {
    if (!sharedSugKey) { sharedSuggestions = []; return; }
    _loadedSugKey = sharedSugKey;   // claim the key in advance → no double fetch
    // map + Promise.all rather than a loop: the members are fetched side by side, but the ORDER
    // survives, and memberData[0] supplying the suggestion pool depends on that.
    const memberData = (await Promise.all(sharedProfile.members.map(async (m) => {
      if (!m?.id) return null;
      const token = memberToken(m);
      if (!token) return null;
      const t0 = Date.now();
      try {
        const res = await fetch(
          `${session.serverUrl}/Users/${m.id}/Items?Recursive=true&IncludeItemTypes=Movie,Series` +
          `&Fields=Genres,CommunityRating,UserData&EnableImageTypes=Primary&Limit=100000&EnableTotalRecordCount=false`,
          { headers: authHeaders(token) }
        );
        if (!res.ok) return null;
        const items = (await res.json()).Items || [];
        const genreCount = {}; const watched = new Set();
        for (const it of items) {
          if (it.UserData?.Played) {
            // Exclude only fully watched titles + derive genre preferences from them.
            // Started series/movies deliberately stay as suggestions (no extra traffic).
            watched.add(it.Id);
            for (const g of it.Genres || []) genreCount[g] = (genreCount[g] || 0) + 1;
          }
        }
        dlog('[Shared] suggestion scan', m.name, '→', watched.size, 'of', items.length,
             'titles watched ·', Date.now() - t0, 'ms');
        return { items, genreCount, watched };
      } catch { return null; }
    }))).filter(Boolean);
    if (!memberData.length) { sharedSuggestions = []; return; }

    // Genre weights: genres that ALL members have watched (product of the counts → "both like it").
    const allGenres = new Set();
    memberData.forEach(d => Object.keys(d.genreCount).forEach(g => allGenres.add(g)));
    const weights = {};
    for (const g of allGenres) {
      if (memberData.length >= 2) {
        if (memberData.every(d => d.genreCount[g] > 0))
          weights[g] = memberData.reduce((p, d) => p * d.genreCount[g], 1);
      } else {
        weights[g] = memberData[0].genreCount[g];
      }
    }
    // Fallback: no real intersection → sum over all, so suggestions appear at all.
    if (!Object.keys(weights).length)
      for (const g of allGenres) weights[g] = memberData.reduce((s, d) => s + (d.genreCount[g] || 0), 0);

    const exclude = new Set();
    memberData.forEach(d => d.watched.forEach(id => exclude.add(id)));
    // Exactly what the library filter needs — see PARTNERS_ALL_KEY. Handing it over here spares it
    // a full catalogue request per member and per library.
    partnersPlayedCache[PARTNERS_ALL_KEY] = { ids: exclude, at: Date.now() };

    sharedSuggestions = memberData[0].items
      .filter(it => !exclude.has(it.Id))
      .map(it => ({ it, score: (it.Genres || []).reduce((s, g) => s + (weights[g] || 0), 0) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score || (b.it.CommunityRating || 0) - (a.it.CommunityRating || 0))
      .slice(0, 12)   // uniform dashboard row length (ROW_LIMIT in Dashboard.svelte)
      .map(x => ({ ...x.it, UserData: {} }));   // clear UserData → no progress bar of a member
    dlog('[Shared] suggestions:', sharedSuggestions.length);
  }

  // baseUrl can be passed explicitly: on auto-login the reactive session.serverUrl ($:) is not yet
  // updated (Svelte flushes reactivity only after the synchronous block), so
  // `${session.serverUrl}` would point to '' there → relative fetch to the app origin instead of the server.
  async function validateToken(token, baseUrl = session.serverUrl) {
    try {
      const res = await fetch(`${baseUrl}/Users/Me`, { headers: authHeaders(token) });
      if (!res.ok) dlog('[auth] token validation failed — HTTP', res.status);
      return res.ok;
    } catch (e) { dlog('[auth] token validation — network error:', e?.message || e); return false; }
  }

  function finishLogin(user, token) {
    selectedUser = user;
    session.token  = token;
    isLoggedIn   = true;
    appPhase     = 'app';
    applyUserPrefs(user.Id);   // load profile settings
    saveCurrentSession();
    scheduleScreensaver();
    detectServerCapabilities();
    refreshSharedMemberToken(user.Id, token);
  }

  // Jellyfin binds sessions to the DeviceId — if a profile signs in again on the same device,
  // its previous token expires. If this profile is a member of the shared profile, we refresh
  // its stored token snapshot to the new token, otherwise watch together later runs
  // into a 401. Only refresh profiles already recorded as a member.
  function refreshSharedMemberToken(userId, token) {
    const sid = selectedServer?.id;
    if (!sid || !token) return;
    if (sharedTokens[sid]?.[userId] && sharedTokens[sid][userId] !== token) {
      sharedTokens[sid][userId] = token;
      sharedTokens = { ...sharedTokens };
      persistSharedTokens();
    }
  }

  // Check the server version once → decides whether DVD/VobSub is renderable client-side (libbitsub via
  // .mks) or still has to be burned in. Faulty/old → false (safe burning).
  async function detectServerCapabilities() {
    serverVobSub = false;
    serverVersion = '';
    try {
      const res = await fetch(`${session.serverUrl}/System/Info/Public`);
      if (res.ok) {
        const info = await res.json();
        serverVersion = info?.Version || '';
        serverVobSub = serverSupportsVobSub(info?.Version);
      }
    } catch {}
    dlog('[OcenFin] server capabilities:', { version: serverVersion || '(unknown)', vobSub: serverVobSub });
  }

  function toggleCurrentUserSave() {
    if (!selectedUser || !selectedServer) return;
    const sid = selectedServer.id;
    if (!savedTokens[sid]) savedTokens[sid] = {};
    if (savedTokens[sid][selectedUser.Id]) {
      delete savedTokens[sid][selectedUser.Id];
    } else {
      savedTokens[sid][selectedUser.Id] = session.token;
    }
    savedTokens = { ...savedTokens };
    persistSavedTokens();
  }

  /** Back to the user screen (keeps the server connection) */
  function handleSwitchUser() {
    // Capture before the teardown clears them. Revoke AFTER session.token is empty, so the
    // connection guard cannot mistake the revocation's own response for our session dying.
    const _sid = selectedServer?.id, _url = session.serverUrl, _tok = session.token;
    isLoggedIn       = false;
    selectedUser     = null;
    session.token      = '';
    disconnectSyncSocket();              // close the SyncPlay socket
    closeSyncPlay(); syncMyGroup = null; syncGroups = []; syncQueue = null; syncCommand = null; _lastSyncQueueItem = null; syncJoined = false; syncMyGroupId = null;   // reset group state
    remoteCommand = null; dismissRemoteMessage();   // discard admin remote control/message
    viewState = 'dashboard';
    apiCache.dashboard = null;   // clear cache (property mutation instead of reassignment → shared reference stays)
    navLibraries = [];
    // The app branch unmounts with the phase, so no view keeps the old profile's DATA — but these
    // references survive, and libraryMounted would remount Library on the next login and load the
    // previous profile's library once for nothing, hidden behind the dashboard.
    currentLibrary = null; currentCollection = null; currentPerson = null; currentDetailItem = null;
    libraryMounted = false; searchMounted = false;
    collectionStack = []; personReturnDetails = null;
    libraryReturnId = null; libraryReturnEl = null; libraryReturnNth = 0;
    clearCurrentSession();
    // Only if nothing keeps it: with "remember me" on, the token stays in savedTokens for the
    // quick switch and must remain valid. Without it, this was the last reference — and leaving it
    // alive would strand a working key on the server for good.
    if (!tokenStillKept(_sid, _tok)) revokeToken(_url, _tok);
    // Back to the user screen, server stays connected
    appPhase = 'users';
  }

  /** Fully sign out + disconnect from the server */
  function handleLogout() {
    handleSwitchUser();
    selectedServer    = null;
    users             = [];
    appPhase          = 'servers';
  }

  // ============================================================
  // GLOBAL BACK KEY (webOS remote)
  // ============================================================

  // Back from a top-level view to the dashboard. These four used to assign the view and nothing
  // else, which left the page with NO focus: the dashboard remounts and restores nothing of its own
  // (CLAUDE.md), while the view being left takes its focus with it — Library and Search are hidden
  // with display:none, Favourites and Settings unmount. The next key press then opened the sidebar.
  // A library opened from a tile on the dashboard returns to that tile; the three views that can
  // only be reached from the menu have no card to return to and take the first content element.
  function backToDashboard(from) {
    viewState = 'dashboard';
    if (from === 'library' && libraryReturnId) {
      focusCardAgain(libraryReturnId, libraryReturnEl, '(back from library)', libraryReturnNth);
    } else {
      focusContent({ why: `back from ${from}`, heldByOther: heldOutsideSidebar });
    }
  }

  function handleGlobalBack(e) {
    if (!isBackKey(e)) return;   // Escape / Backspace (except in inputs) / remote 461
    if (appPhase === 'users') {
      e.preventDefault();
      // Sub-dialogs (password/manual/QC) are closed by the Login component itself;
      // otherwise back to the server selection. (Pattern like collectionRef.handleBackKey)
      if (!loginRef?.handleBackKey()) handleLogout();
      return;
    }
    if (appPhase !== 'app') return;
    // Confirmation dialog open → Back cancels it (instead of closing)
    if (showExitConfirm) { showExitConfirm = false; e.preventDefault(); return; }
    // Close open overlays first (applies to remote Back too)
    if (showSyncPlay)   { closeSyncPlay();         e.preventDefault(); return; }
    if (contextItem)    { contextItem = null;     e.preventDefault(); return; }
    // Navigate within the app; preventDefault stops webOS from closing the app.
    // At the dashboard (top level) show a confirmation instead of closing the app directly.
    if      (viewState === 'player')   { viewState = 'details';        e.preventDefault(); }
    else if (viewState === 'details')  { if (!detailsRef?.handleBackKey()) returnFromDetails(); e.preventDefault(); }
    else if (viewState === 'person')   { returnFromPerson();           e.preventDefault(); }
    else if (viewState === 'collection') { if (!collectionRef?.handleBackKey()) returnFromCollection(); e.preventDefault(); }
    else if (viewState === 'library')  { backToDashboard('library');   e.preventDefault(); }
    else if (viewState === 'settings') { backToDashboard('settings');  e.preventDefault(); }
    else if (viewState === 'search')   { backToDashboard('search');    e.preventDefault(); }
    else if (viewState === 'favorites') { backToDashboard('favorites'); e.preventDefault(); }
    else if (viewState === 'dashboard') { showExitConfirm = true;      e.preventDefault(); }
  }

  // Closes the app on webOS (platformBack at the root); window.close as a fallback.
  function exitApp() {
    try { window.webOSSystem?.platformBack?.(); } catch {}
    try { window.close(); } catch {}
  }

  // ============================================================
  // EPISODE NAVIGATION
  // ============================================================

  // The Player now sends the full episode object via dispatch('next/prev', episodeItem).
  // No separate API call needed anymore — just set currentDetailItem.
  // The Player sends { episode, resetStreak }. resetStreak=true → the user was awake (manual/interaction),
  // counter to 0; otherwise increment (for the "still watching?" sleep protection).
  function handleNextEpisode(detail) {
    const episodeItem = detail?.episode ?? detail;   // robustness: also accepts a bare episode object
    if (!episodeItem) return;
    autoPlayStreak = detail?.resetStreak ? 0 : autoPlayStreak + 1;
    activeMediaSourceId = null;   // new episode → its own default version, not the previous one's
    currentDetailItem = episodeItem;
    syncQueueIndex(episodeItem);
    // viewState stays 'player' — {#key currentDetailItem.Id} in the template forces a remount
  }

  function handlePrevEpisode(episodeItem) {
    if (!episodeItem) return;
    autoPlayStreak = 0;   // going back is a deliberate action → reset the counter
    activeMediaSourceId = null;
    currentDetailItem = episodeItem;
    syncQueueIndex(episodeItem);
  }

  // ── Person view (filmography) ───────────────────────────────
  let currentPerson      = $state(null);       // seed person for the person view (Person.svelte loads itself)
  let personReturnView   = $state('search');   // where "Back" leads

  // Collections (BoxSets) — own grid view, mirrored from the person view
  // Collections/playlists — own view (Collection.svelte loads itself).
  let currentCollection    = $state(null);          // seed BoxSet/playlist
  let collectionReturnView = $state('dashboard');   // where "Back" leads
  let collectionRef = $state();                     // bind:this → for the back key (handleBackKey)
  // Parent chain when a collection is opened from inside one. Each entry is a whole LEVEL, not
  // just its collection: collectionReturnId/El/Nth/Scroll describe the way out of the entire
  // chain, and a nested open overwrites them — so without carrying them here the last Back aimed
  // at the nested card instead of the one that opened the chain.
  let collectionStack = [];

  function openCollection(boxSet) {
    // Opened from INSIDE a collection (nested BoxSet/playlist card): push the parent so Back
    // returns there. Overwriting collectionReturnView with 'collection' made Back assign the
    // view it was already on — a no-op that trapped the user in the child collection.
    if (viewState === 'collection' && currentCollection) {
      collectionStack.push({
        collection: currentCollection,
        id: collectionReturnId, el: collectionReturnEl,
        nth: collectionReturnNth, scroll: collectionReturnScroll,
      });
    } else {
      collectionStack = [];
      collectionReturnView = viewState;
    }
    collectionReturnId  = boxSet?.Id ?? null;
    collectionReturnEl  = document.activeElement;
    collectionReturnNth = cardOrdinal(collectionReturnEl, collectionReturnId);
    collectionReturnScroll = scrollTopOf(collectionReturnEl);
    pendingCardFocusId  = null;
    currentCollection    = boxSet;
    viewState            = 'collection';
  }
  // One level up in a nested chain. The parent is the SAME mounted component, so it cannot restore
  // itself on mount the way a returning view does — it takes the card we descended through as a
  // prop, exactly like a return from Details. focusChild=false is for the case where that card is
  // gone (the child was deleted): the parent then lands on its first one.
  function popCollectionLevel(focusChild = true) {
    const up = collectionStack.pop();
    if (focusChild) { pendingCardFocusId = collectionReturnId; pendingCardScrollTop = collectionReturnScroll; }
    collectionReturnId  = up.id;  collectionReturnEl     = up.el;
    collectionReturnNth = up.nth; collectionReturnScroll = up.scroll;
    currentCollection   = up.collection;
    dlog('[collection] level up →', up.collection?.Name, '· card', focusChild ? pendingCardFocusId : '(first)',
         '· offset', focusChild ? pendingCardScrollTop : 0, '·', collectionStack.length, 'level(s) below');
  }

  function returnFromCollection() {
    // Nested collection: one level up, the view itself stays on screen.
    if (collectionStack.length) { popCollectionLevel(); return; }
    const id = collectionReturnId, el = collectionReturnEl, nth = collectionReturnNth;
    const sc = collectionReturnScroll;
    collectionReturnId = null; collectionReturnEl = null; collectionReturnNth = 0; collectionReturnScroll = 0;
    viewState = collectionReturnView;
    // Same split as returnFromDetails: Library restores itself, the two self-focusing views take
    // the id, and the dashboard is focused directly.
    if (collectionReturnView === 'search') searchRef?.restoreView();
    else if (collectionReturnView === 'library') libraryRef?.restoreView();
    else if (collectionReturnView === 'favorites' || collectionReturnView === 'collection') {
      pendingCardFocusId = id; pendingCardScrollTop = sc;
    }
    else focusCardAgain(id, el, '(back from collection)', nth);
  }

  // Cross effects from the collection view onto the library grid / sidebar:
  function onCollectionChildCount(id, count) {
    handlePlaylistItemsChanged(id);            // watchlist edited in the playlist view → re-sync
    libraryRef?.updateChildCount(id, count);
  }
  function onCollectionRenamed(id, name) { libraryRef?.renamePlaylist(id, name); refreshLibraries(); }
  async function onCollectionDeleted(id) {
    handlePlaylistDeleted(id);    // if it was the watchlist: clear its in-memory state
    libraryRef?.removeItem(id);   // immediately out of the grid
    await refreshLibraries();   // reload sidebar/menu (playlist disappears)
    // If it was the last playlist, Jellyfin removes the whole "Playlists" library.
    const playlistsLibGone = !navLibraries.some(l => l.CollectionType === 'playlists');
    if (playlistsLibGone) {
      // The dashboard keeps its library list cached — otherwise the "Playlists" folder would stay
      // in the "My Media" area until you reopen the dashboard. Discard cache + remount.
      apiCache.dashboard = null;
      dashboardReloadKey++;
    }
    if (collectionStack.length) { popCollectionLevel(false); }   // its card is gone → first one
    else if (collectionReturnView === 'library' && playlistsLibGone) { currentLibrary = null; viewState = 'dashboard'; }
    else viewState = collectionReturnView;
  }

  // After creating a playlist/collection a new library view may appear server-side
  // (e.g. "Playlists") – update the sidebar/menu immediately instead of only on restart.
  async function refreshLibraries() {
    try {
      const res = await fetch(`${session.serverUrl}/Users/${selectedUser.Id}/Views`, { headers: getAuthHeaders() });
      if (res.ok) navLibraries = (await res.json()).Items || [];
    } catch { }
  }

  // Favorites — own view (Favorites.svelte component). Loads itself on mount; this
  // key is incremented to reload after a change (e.g. a favorite removed in Details).
  let favReloadKey = $state(0);

  // Opens a person's filmography (from search, the cast in Details, or favorites).
  // Only sets the return view + seed person; Person.svelte loads person details + filmography itself.
  function openPerson(person) {
    personReturnView   = viewState;
    // Coming from a title page, remember WHICH title and its own way out. Opening another title
    // from the person's filmography overwrites currentDetailItem AND detailsOrigin — the same
    // single-variable trap the collection stack has (§22). Without this, Back came back to that
    // other title and then bounced between it and the person page forever, with no way out but the
    // sidebar, because detailsOrigin still said 'person'.
    personReturnDetails = viewState === 'details'
      ? { item: currentDetailItem, origin: detailsOrigin,
          id: detailsReturnId, el: detailsReturnEl, nth: detailsReturnNth, scroll: detailsReturnScroll }
      : null;
    personReturnId     = document.activeElement?.getAttribute?.('data-item-id') ?? null;
    personReturnEl     = document.activeElement;
    personReturnNth    = cardOrdinal(personReturnEl, personReturnId);
    personReturnScroll = scrollTopOf(personReturnEl);
    pendingCardFocusId = null;
    currentPerson    = person;
    viewState        = 'person';
  }

  // Back from a person page — routed exactly like returnFromDetails/returnFromCollection.
  function returnFromPerson() {
    const id = personReturnId, el = personReturnEl, nth = personReturnNth, sc = personReturnScroll;
    personReturnId = null; personReturnEl = null; personReturnNth = 0; personReturnScroll = 0;
    // Restore the title page as it was, BEFORE switching to it — Details mounts from
    // currentDetailItem, and detailsOrigin is what its own Back will read next.
    if (personReturnView === 'details' && personReturnDetails) {
      const d = personReturnDetails;
      currentDetailItem = d.item;      detailsOrigin       = d.origin;
      detailsReturnId   = d.id;        detailsReturnEl     = d.el;
      detailsReturnNth  = d.nth;       detailsReturnScroll = d.scroll;
    }
    personReturnDetails = null;
    viewState = personReturnView;
    if (personReturnView === 'search') searchRef?.restoreView();
    else if (personReturnView === 'library') libraryRef?.restoreView();
    // Details focuses its play button on mount, so it takes the target as a prop like the other
    // self-focusing views rather than being focused into from here.
    else if (personReturnView === 'favorites' || personReturnView === 'collection'
             || personReturnView === 'details') {
      pendingCardFocusId = id; pendingCardScrollTop = sc;
    } else focusCardAgain(id, el, '(back from person)', nth);
  }

  // After a selection in the sidebar, move focus into the content. Leaving
  // the sidebar collapses it automatically again (its focusout handler).
  // So focus lands right where things continue instead of in the open bar.
  // It used to be a single querySelector one tick later, with no isShown() filter — the one focus
  // lookup in this file that had neither. Both broke: Library and Search sit HIDDEN inside the same
  // main, so a view without a button of its own reached for one of theirs and the call silently did
  // nothing; and Settings is lazy-loaded, so one tick in there is only the await spinner, which has
  // no button at all. Choosing Settings from the menu therefore never got focus, not even on the
  // second open, because import() always resolves asynchronously.
  function focusMain() {
    focusContent({ why: 'sidebar \u2192 content', heldByOther: heldOutsideSidebar });
  }

  // Reloads the user object (e.g. after a profile-picture upload) → the avatar updates everywhere.
  async function refreshSelectedUser() {
    try {
      const res = await fetch(`${session.serverUrl}/Users/${selectedUser.Id}`, { headers: getAuthHeaders() });
      if (res.ok) selectedUser = await res.json();
    } catch { /* ignore */ }
  }

  // Where Back out of the library leads: opened from a tile on the dashboard, that tile is the
  // place to return to. From the menu there is none — the sidebar entry that was focused is NOT a
  // usable target (focusCardAgain would happily focus it again and leave the bar open), so only a
  // real card is remembered and everything else falls through to the content's first element.
  let libraryReturnId = null, libraryReturnEl = null, libraryReturnNth = 0;
  function navigateToLibrary(lib, focusFirstCard = false) {
    if (!lib) return;
    const from = document.activeElement;
    libraryReturnId  = from?.getAttribute?.('data-item-id') ?? null;
    libraryReturnEl  = libraryReturnId ? from : null;
    libraryReturnNth = cardOrdinal(libraryReturnEl, libraryReturnId);
    libraryMounted = true;                  // from now on Library stays mounted (scroll/items survive Details)
    libraryFocusFirst = focusFirstCard;     // Library focuses the first card itself after loading
    currentLibrary = { Id: lib.Id, Name: lib.Name };
    viewState = 'library';
  }

  function showItemDetails(item) {
    // Containers (collection/playlist) show their contents instead of a detail page
    if (item?.Type === 'BoxSet' || item?.Type === 'Playlist') { openCollection(item); return; }
    // Remember the origin so "Back" leads there again (not always the dashboard), and the card
    // itself so focus can return to it rather than to nothing.
    detailsOrigin   = viewState;
    pendingCardFocusId = null;   // a new trip — the previous view's card is no longer the target
    detailsReturnId  = item?.Id ?? null;
    detailsReturnEl  = document.activeElement;
    detailsReturnNth = cardOrdinal(detailsReturnEl, detailsReturnId);
    detailsReturnScroll = scrollTopOf(detailsReturnEl);
    currentDetailItem = item;
    viewState = 'details';
    lazyPlayer();   // preload the Player chunk in the background — playback is very likely from here
  }

  // ============================================================
  // CONTEXT MENU (long press on a card)
  // ============================================================
  let contextItem = $state(null);
  let contextReturnId = $state(null);     // item ID of the triggering card (focus return, survives reload)
  let contextReturnEl = $state(null);     // fallback: element reference if no data-item-id is present
  let contextReturnNth = 0;               // which occurrence of that id — see cardOrdinal()
  let contextPickerMode = $state(null);   // null | 'playlist' | 'collection' — AddToPicker from the context menu
  let contextPickerItem = $state(null);
  function openContextMenu(item) {
    contextReturnId  = item?.Id ?? null;
    contextReturnEl  = document.activeElement;
    contextReturnNth = cardOrdinal(contextReturnEl, contextReturnId);
    contextItem = item;
  }
  // Put focus back on a card that may not exist yet, because the view it belongs to can still be
  // reloading. Three routes, in order: the live element (instant where the view stayed mounted, e.g.
  // the dashboard after a context action), the item's data-item-id once its card is back, and only
  // then the first card in the view rather than losing focus altogether.
  //
  // Every attempt stands down if something else holds focus by then, so a poll running over half a
  // second can never fight a user who has already navigated on. Bounded and self-terminating — the
  // shape to copy for anything that must focus an element which does not exist yet (see CLAUDE.md).
  // The same title can sit in SEVERAL rows at once — "Continue watching" and the watchlist show it
  // together, and the two card snippets are reused across eight rows. data-item-id is therefore not
  // unique, and querySelector would always hand back the topmost row. So remember WHICH occurrence
  // the card was, and go back to that one.
  function cardOrdinal(el, id) {
    if (!el || !id) return 0;
    const all = [...document.querySelectorAll(`[data-item-id="${id}"]`)].filter(isShown);
    const i = all.indexOf(el);
    return i < 0 ? 0 : i;
  }

  function focusCardAgain(id, el, why = '', nth = 0) {
    let tries = 0;
    const attempt = () => {
      const active = document.activeElement;
      // isShown as well: a view hidden with display:none can still be reported as the active element
      // until style is recomputed, and standing down for a card that cannot be focused would leave
      // the page with no focus at all.
      if (active && active !== document.body && isShown(active)) {
        // Stood down — something else restored focus first. Logged with the reason, because that is
        // how we tell a needed call from a redundant one: every view but the dashboard owns this.
        dlog('[focus] card restore', why, '· stood down, already on',
             (active.textContent || active.tagName || '').trim().slice(0, 24));
        return;
      }
      if (el && document.contains(el) && isShown(el) && typeof el.focus === 'function') {
        el.focus(); dlog('[focus] card restore', why, '· live element'); return;
      }
      const matches = id ? [...document.querySelectorAll(`[data-item-id="${id}"]`)].filter(isShown) : [];
      if (matches.length > nth) {
        matches[nth].focus();
        dlog('[focus] card restore', why, '· by id, occurrence', nth, 'of', matches.length, 'after', tries, 'tries');
        return;
      }
      // Fewer occurrences than remembered: either rows are still coming in, or the one it sat in is
      // gone (row switched off, watchlist changed). Wait the window out before settling for another.
      if (++tries < 12) { setTimeout(attempt, 50); return; }   // wait up to ~600 ms for the reload
      if (matches.length) {
        matches[0].focus();
        dlog('[focus] card restore', why, '· occurrence', nth, 'gone, took the first of', matches.length);
        return;
      }
      dlog('[focus] card restore', why, '· fell back to the first card');
      [...document.querySelectorAll('[data-item-id]')].find(isShown)?.focus();
    };
    tick().then(attempt);
  }

  // After closing both the context menu AND the picker, put focus back on the card.
  function restoreContextFocus() {
    const id = contextReturnId, el = contextReturnEl, nth = contextReturnNth;
    contextReturnId = null; contextReturnEl = null; contextReturnNth = 0;
    focusCardAgain(id, el, '(context menu)', nth);
  }
  $effect(() => { if (!contextItem && !contextPickerMode && (contextReturnId || contextReturnEl)) restoreContextFocus(); });

  function onContextChanged() {
    // The ContextMenu already mutated item.UserData in place → deep reactivity updates
    // badges/progress immediately, without a full reload (no reshuffle, no focus loss).
    // Library: if the changed item no longer matches the active status filter, it's removed
    // from the list specifically (the server-loaded list stays untouched otherwise → no mismatch risk).
    // Dashboard/collection need no action (no membership-relevant status filter).
    if (viewState === 'library' && contextItem && libraryRef && !libraryRef.matchesStatusFilters(contextItem)) {
      libraryRef.removeItem(contextItem.Id);
    }
  }
  function contextOpenDetails(item) {
    contextReturnId = null; contextReturnEl = null;   // Details takes over the focus
    contextItem = null;
    showItemDetails(item);
  }
  // "Add to playlist" from the context menu → open AddToPicker (the focus-return ID stays
  // and only takes effect once the picker is also closed).
  function contextAddToList(item) { contextPickerItem = item; contextPickerMode = 'playlist'; }
  function contextAddToCollection(item) { contextPickerItem = item; contextPickerMode = 'collection'; }

  // "Play all" from a playlist's context menu → fetch its items, build the queue, play (returns to the
  // current view afterwards). Series/Season entries are expanded to episodes via buildPlayQueue.
  async function contextPlayPlaylist(item) {
    contextReturnId = null; contextReturnEl = null;   // playback takes over the focus
    contextItem = null;
    if (!item?.Id) return;
    detailsOrigin = viewState;
    try {
      const res   = await fetch(`${session.serverUrl}/Playlists/${item.Id}/Items?UserId=${activeUserId}&Limit=300&EnableTotalRecordCount=false`, { headers: getAuthHeaders() });
      if (!res.ok) { console.warn('play playlist: HTTP', res.status); return; }
      const data  = await res.json();
      const queue = await buildPlayQueue(data.Items || [], { serverUrl: session.serverUrl, userId: activeUserId, headers: getAuthHeaders() });
      if (queue.length) { playQueue = { items: queue, index: 0 }; startPlayback({ item: queue[0], audioIndex: -1, subtitleIndex: -1 }); }
    } catch (e) { console.error('play playlist:', e); }
  }

  // Back from Details/Player → to the origin, restore the library position
  // Starts playback of an item — used by Details (Play/From-start/Random-episode)
  // and Collection (random playback). One source instead of two inline copies.
  // "Play all" (collection/playlist): an ordered playback queue. Lives only while the
  // Player is open — it's cleared on leaving so later normal playbacks
  // don't accidentally advance.
  let playQueue = $state(null);   // { items: [...], index }
  let queueNext = $derived(playQueue && playQueue.index < playQueue.items.length - 1 ? playQueue.items[playQueue.index + 1] : null);
  let queuePrev = $derived(playQueue && playQueue.index > 0 ? playQueue.items[playQueue.index - 1] : null);
  $effect(() => { if (viewState !== 'player' && playQueue) playQueue = null; });

  // Carry the queue pointer along on title change in the Player (covers both next AND prev)
  function syncQueueIndex(playedItem) {
    if (!playQueue || !playedItem) return;
    const qi = playQueue.items.findIndex(x => x.Id === playedItem.Id);
    if (qi >= 0) playQueue = { ...playQueue, index: qi };
  }
  function startPlayback(p) {
    // Starting playback by hand is a deliberate action → the "still watching?" counter starts over.
    // Without this a stale streak from an earlier series session would carry into the new one and
    // could trigger the prompt far too early. Auto-advance never comes through here (it goes via
    // handleNextEpisode), so the sleep protection stays intact.
    autoPlayStreak = 0;
    if (p.item) currentDetailItem = p.item;
    activeAudioIndex    = p.audioIndex    ?? -1;
    activeSubtitleIndex = p.subtitleIndex ?? -1;
    activeMediaSourceId = p.mediaSourceId ?? null;
    viewState = 'player';
  }

  async function returnFromDetails() {
    const backId = detailsReturnId, backEl = detailsReturnEl, backNth = detailsReturnNth;
    const backScroll = detailsReturnScroll;
    detailsReturnId = null; detailsReturnEl = null; detailsReturnNth = 0; detailsReturnScroll = 0;
    viewState = detailsOrigin;
    if (detailsOrigin === 'library') {
      libraryRef?.restoreView();
      // Same mechanism as onContextChanged: Details carried item.UserData along in place
      // (favorite/watched toggles). If the item no longer matches the active status filter
      // (e.g. favorites filter on + favorite removed in Details), it's removed specifically from
      // the loaded list — instead of a full reload, so scroll position and focus are preserved.
      if (currentDetailItem && libraryRef && !libraryRef.matchesStatusFilters(currentDetailItem)) {
        libraryRef.removeItem(currentDetailItem.Id);
      }
    } else if (detailsOrigin === 'favorites') {
      // Reload favorites — e.g. when a favorite was removed in Details, it would otherwise
      // still be listed in the overview until you switched views. Increment the key → Favorites reloads.
      favReloadKey++;
    }
    // The dashboard is the ONLY origin that establishes no focus of its own when it comes back, so
    // it is the only one handed the card here. Every other view already owns this (see CLAUDE.md):
    // Library restores scroll AND focus in restoreView() above, Search focuses its input on mount,
    // and Favourites, Collection and Person each focus at the end of their own load. Calling this
    // for them would either be inert or fight their own logic.
    // Unlike those, the dashboard remounts from scratch, so focusing the card also brings its
    // scroll position back — the browser scrolls a focused element into view.
    if (detailsOrigin === 'search') searchRef?.restoreView();
    else if (detailsOrigin === 'dashboard') focusCardAgain(backId, backEl, '(back from details → dashboard)', backNth);
    // Favourites, Collection and Person focus themselves at the end of their load — hand them the
    // target instead of calling into them, so there is one decision rather than two racing ones.
    else if (detailsOrigin === 'favorites' || detailsOrigin === 'collection'
             || detailsOrigin === 'person') {
      pendingCardFocusId = backId; pendingCardScrollTop = backScroll;
    }
  }

</script>

<svelte:window
  onkeydown={resetActivity}
  onmousemove={resetActivity}
  onpointermove={resetActivity}
  onclick={resetActivity}
/>

<style>
  /* ── ASS subtitle fonts ──────────────────────────────────────────────────────
     assjs uses the browser fonts. ASS scripts almost always give the Windows names
     (Arial / Times New Roman / Courier New), which aren't installed on the TV →
     system fallback. We register metrically compatible open replacement fonts UNDER
     exactly these names: Arimo→Arial, Tinos→Times New Roman, Cousine→Courier New. This way
     assjs picks them up automatically without changing anything in the ASS script.
     The files (Latin woff2, 4 styles each) live in src/fonts/ and are bundled by Vite
     (base/path-correct, hashed). The UI itself uses none of these names,
     so no side effect. font-display: swap → the first line may briefly be in the fallback,
     cached afterwards. @font-face is emitted globally by Svelte anyway (not scoped). */
  @font-face { font-family: 'Arial'; font-style: normal; font-weight: 400; font-display: swap; src: url('./fonts/arimo-regular.woff2') format('woff2'); }
  @font-face { font-family: 'Arial'; font-style: normal; font-weight: 700; font-display: swap; src: url('./fonts/arimo-bold.woff2') format('woff2'); }
  @font-face { font-family: 'Arial'; font-style: italic; font-weight: 400; font-display: swap; src: url('./fonts/arimo-italic.woff2') format('woff2'); }
  @font-face { font-family: 'Arial'; font-style: italic; font-weight: 700; font-display: swap; src: url('./fonts/arimo-bolditalic.woff2') format('woff2'); }
  @font-face { font-family: 'Times New Roman'; font-style: normal; font-weight: 400; font-display: swap; src: url('./fonts/tinos-regular.woff2') format('woff2'); }
  @font-face { font-family: 'Times New Roman'; font-style: normal; font-weight: 700; font-display: swap; src: url('./fonts/tinos-bold.woff2') format('woff2'); }
  @font-face { font-family: 'Times New Roman'; font-style: italic; font-weight: 400; font-display: swap; src: url('./fonts/tinos-italic.woff2') format('woff2'); }
  @font-face { font-family: 'Times New Roman'; font-style: italic; font-weight: 700; font-display: swap; src: url('./fonts/tinos-bolditalic.woff2') format('woff2'); }
  @font-face { font-family: 'Courier New'; font-style: normal; font-weight: 400; font-display: swap; src: url('./fonts/cousine-regular.woff2') format('woff2'); }
  @font-face { font-family: 'Courier New'; font-style: normal; font-weight: 700; font-display: swap; src: url('./fonts/cousine-bold.woff2') format('woff2'); }
  @font-face { font-family: 'Courier New'; font-style: italic; font-weight: 400; font-display: swap; src: url('./fonts/cousine-italic.woff2') format('woff2'); }
  @font-face { font-family: 'Courier New'; font-style: italic; font-weight: 700; font-display: swap; src: url('./fonts/cousine-bolditalic.woff2') format('woff2'); }

  /* ── Other common fansub fonts (Tahoma / Verdana / Trebuchet MS) ──────────────
     For these there are NO metrically compatible clones like above. Instead a
     shared "pot": ONE neutral, modern sans (Noto Sans, latin + latin-ext,
     4 styles each) is registered under all three Windows names. Only visually
     similar, NOT metric-accurate — sufficient in practice for dialogue/signs.
     Noto is narrower than Tahoma/Verdana, but consistent with the rest of the font
     pipeline (gwfh, latin+latin-ext). The same 4 files for all three names →
     no extra storage per name. */
  @font-face { font-family: 'Tahoma'; font-style: normal; font-weight: 400; font-display: swap; src: url('./fonts/notosans-regular.woff2') format('woff2'); }
  @font-face { font-family: 'Tahoma'; font-style: normal; font-weight: 700; font-display: swap; src: url('./fonts/notosans-bold.woff2') format('woff2'); }
  @font-face { font-family: 'Tahoma'; font-style: italic; font-weight: 400; font-display: swap; src: url('./fonts/notosans-italic.woff2') format('woff2'); }
  @font-face { font-family: 'Tahoma'; font-style: italic; font-weight: 700; font-display: swap; src: url('./fonts/notosans-bolditalic.woff2') format('woff2'); }
  @font-face { font-family: 'Verdana'; font-style: normal; font-weight: 400; font-display: swap; src: url('./fonts/notosans-regular.woff2') format('woff2'); }
  @font-face { font-family: 'Verdana'; font-style: normal; font-weight: 700; font-display: swap; src: url('./fonts/notosans-bold.woff2') format('woff2'); }
  @font-face { font-family: 'Verdana'; font-style: italic; font-weight: 400; font-display: swap; src: url('./fonts/notosans-italic.woff2') format('woff2'); }
  @font-face { font-family: 'Verdana'; font-style: italic; font-weight: 700; font-display: swap; src: url('./fonts/notosans-bolditalic.woff2') format('woff2'); }
  @font-face { font-family: 'Trebuchet MS'; font-style: normal; font-weight: 400; font-display: swap; src: url('./fonts/notosans-regular.woff2') format('woff2'); }
  @font-face { font-family: 'Trebuchet MS'; font-style: normal; font-weight: 700; font-display: swap; src: url('./fonts/notosans-bold.woff2') format('woff2'); }
  @font-face { font-family: 'Trebuchet MS'; font-style: italic; font-weight: 400; font-display: swap; src: url('./fonts/notosans-italic.woff2') format('woff2'); }
  @font-face { font-family: 'Trebuchet MS'; font-style: italic; font-weight: 700; font-display: swap; src: url('./fonts/notosans-bolditalic.woff2') format('woff2'); }

  /* ── UI/VTT fonts (Settings → Appearance / → Subtitles) ───────────────────────
     The same files as above, just registered under their REAL names so
     UI and VTT subtitles can reference them cleanly ('Arimo' instead of going
     through the 'Arial' alias). Tinos (serif) selectable for VTT only. No extra
     storage — WOFF2 is loaded only once per file. */
  @font-face { font-family: 'Arimo'; font-style: normal; font-weight: 400; font-display: swap; src: url('./fonts/arimo-regular.woff2') format('woff2'); }
  @font-face { font-family: 'Arimo'; font-style: normal; font-weight: 700; font-display: swap; src: url('./fonts/arimo-bold.woff2') format('woff2'); }
  @font-face { font-family: 'Arimo'; font-style: italic; font-weight: 400; font-display: swap; src: url('./fonts/arimo-italic.woff2') format('woff2'); }
  @font-face { font-family: 'Arimo'; font-style: italic; font-weight: 700; font-display: swap; src: url('./fonts/arimo-bolditalic.woff2') format('woff2'); }
  @font-face { font-family: 'Noto Sans'; font-style: normal; font-weight: 400; font-display: swap; src: url('./fonts/notosans-regular.woff2') format('woff2'); }
  @font-face { font-family: 'Noto Sans'; font-style: normal; font-weight: 700; font-display: swap; src: url('./fonts/notosans-bold.woff2') format('woff2'); }
  @font-face { font-family: 'Noto Sans'; font-style: italic; font-weight: 400; font-display: swap; src: url('./fonts/notosans-italic.woff2') format('woff2'); }
  @font-face { font-family: 'Noto Sans'; font-style: italic; font-weight: 700; font-display: swap; src: url('./fonts/notosans-bolditalic.woff2') format('woff2'); }
  @font-face { font-family: 'Tinos'; font-style: normal; font-weight: 400; font-display: swap; src: url('./fonts/tinos-regular.woff2') format('woff2'); }
  @font-face { font-family: 'Tinos'; font-style: normal; font-weight: 700; font-display: swap; src: url('./fonts/tinos-bold.woff2') format('woff2'); }
  @font-face { font-family: 'Tinos'; font-style: italic; font-weight: 400; font-display: swap; src: url('./fonts/tinos-italic.woff2') format('woff2'); }
  @font-face { font-family: 'Tinos'; font-style: italic; font-weight: 700; font-display: swap; src: url('./fonts/tinos-bolditalic.woff2') format('woff2'); }

  /* TV scaling (10-foot UI): raises the rem-based base size so text and
     spacing look larger from couch distance. Standard browsers are 16px; 20px = +25%.
     Adjust further if needed, if still too small/large on the TV. */
  :global(html) { font-size: 20px; }

  /* Accent color themes: in Tailwind v4 all blue utilities use CSS variables.
     We override only these → the whole accent color switches without touching 100+
     classes. Red (favorite) and green (watched) stay untouched. The tones are
     chosen to be OLED-friendly (vivid, slightly desaturated, good on deep black). */
  :global(html[data-theme="emerald"]) {
    --color-blue-300:#6ee7b7; --color-blue-400:#34d399; --color-blue-500:#10b981; --color-blue-600:#059669; --color-blue-900:#064e3b;
  }
  :global(html[data-theme="violet"]) {
    --color-blue-300:#c4b5fd; --color-blue-400:#a78bfa; --color-blue-500:#8b5cf6; --color-blue-600:#7c3aed; --color-blue-900:#4c1d95;
  }
  :global(html[data-theme="amber"]) {
    --color-blue-300:#fcd34d; --color-blue-400:#fbbf24; --color-blue-500:#f59e0b; --color-blue-600:#d97706; --color-blue-900:#78350f;
  }
  :global(html[data-theme="rose"]) {
    --color-blue-300:#fda4af; --color-blue-400:#fb7185; --color-blue-500:#f43f5e; --color-blue-600:#e11d48; --color-blue-900:#881337;
  }
  :global(html[data-theme="sky"]) {
    --color-blue-300:#7dd3fc; --color-blue-400:#38bdf8; --color-blue-500:#0ea5e9; --color-blue-600:#0284c7; --color-blue-900:#0c4a6e;
  }
  :global(html[data-theme="teal"]) {
    --color-blue-300:#5eead4; --color-blue-400:#2dd4bf; --color-blue-500:#14b8a6; --color-blue-600:#0d9488; --color-blue-900:#134e4a;
  }
  :global(html[data-theme="indigo"]) {
    --color-blue-300:#a5b4fc; --color-blue-400:#818cf8; --color-blue-500:#6366f1; --color-blue-600:#4f46e5; --color-blue-900:#312e81;
  }
  :global(html[data-theme="fuchsia"]) {
    --color-blue-300:#f0abfc; --color-blue-400:#e879f9; --color-blue-500:#d946ef; --color-blue-600:#c026d3; --color-blue-900:#701a75;
  }
  :global(html[data-theme="orange"]) {
    --color-blue-300:#fdba74; --color-blue-400:#fb923c; --color-blue-500:#f97316; --color-blue-600:#ea580c; --color-blue-900:#7c2d12;
  }

  /* Splash screen: logo pulses gently, overlay fades out */
  .splash-logo { animation: splashPulse 1.6s ease-in-out infinite; }
  @keyframes splashPulse {
    0%, 100% { transform: scale(1);    opacity: 0.9; }
    50%      { transform: scale(1.07); opacity: 1; }
  }

  /* Reduce animations — controlled via data-reduce-motion on body */
  :global([data-reduce-motion="1"] *) {
    transition-duration: 0ms !important;
    animation-duration:  0ms !important;
  }
  /* backdrop-blur is the most expensive GPU effect — disable it under "reduce
     animations" so older/weaker TVs stay smooth. */
  :global([data-reduce-motion="1"] .backdrop-blur-sm),
  :global([data-reduce-motion="1"] .backdrop-blur-md),
  :global([data-reduce-motion="1"] .backdrop-blur-lg) {
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
</style>

<main class="h-screen w-full bg-gray-900 text-white overflow-hidden relative">

  <!-- ============================================================
       SPLASH SCREEN — until auto-login/startup is done
  ============================================================ -->
  {#if initializing}
    <div class="fixed inset-0 z-[600] bg-gray-900 flex flex-col items-center justify-center" out:fade={{ duration: 400 }}>
      <div class="splash-logo">
        <svg viewBox="0 0 512 512" class="w-28 h-28 drop-shadow-2xl">
          <defs>
            <linearGradient id="splashG" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stop-color="#3B82F6"/>
              <stop offset="1" stop-color="#1D4ED8"/>
            </linearGradient>
          </defs>
          <rect x="0" y="0" width="512" height="512" rx="118" ry="118" fill="url(#splashG)"/>
          <circle cx="256" cy="256" r="118" fill="none" stroke="#ffffff" stroke-width="64"/>
        </svg>
      </div>
      <p class="mt-6 text-2xl font-bold tracking-widest text-gray-300 uppercase">OcenFin</p>
      <div class="mt-8 w-10 h-10 border-4 border-gray-700 border-t-blue-500 rounded-full animate-spin"></div>
    </div>
  {/if}

  {#if session.connectionLost && !initializing}
    <div class="fixed inset-0 z-[500] bg-black/60 flex flex-col items-stretch" data-focus-trap transition:uiFade={{ duration: 200 }} onoutrostart={dropTrapOnOutro}>
      <div class="bg-red-600/95 text-white px-6 py-4 flex flex-wrap items-center justify-center gap-4 shadow-lg">
        <svg class="w-6 h-6 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M18.364 5.636a9 9 0 010 12.728m-3.536-3.536a4 4 0 010-5.656M12 12h.01M5.636 5.636a9 9 0 000 12.728"/></svg>
        <span class="font-bold text-lg">{i18n.t.connectionLostMsg}</span>
        <button onclick={retryNow} bind:this={retryBtnEl}
          class="bg-white text-red-700 font-bold px-5 py-2 rounded-lg focus:outline-none focus:ring-4 focus:ring-white/70 hover:bg-gray-100 transition-colors">
          {i18n.t.retry}
        </button>
        <button onclick={() => { session.connectionLost = false; handleLogout(); }}
          class="bg-red-800 text-white font-bold px-5 py-2 rounded-lg focus:outline-none focus:ring-4 focus:ring-white/70 hover:bg-red-900 transition-colors">
          {i18n.t.switchServer}
        </button>
      </div>
    </div>
  {/if}

  <!-- Exit-app confirmation (Back at the dashboard) -->
  {#if showExitConfirm}
    <div class="fixed inset-0 z-[600] flex items-center justify-center bg-black/70 backdrop-blur-sm" data-focus-trap transition:uiFade={{ duration: 150 }} onoutrostart={dropTrapOnOutro}>
      <div class="bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl p-8 w-full max-w-md mx-6 flex flex-col gap-6">
        <div>
          <h2 class="text-2xl font-bold text-white">{i18n.t.exitTitle}</h2>
          <p class="text-gray-400 mt-2">{i18n.t.exitMessage}</p>
        </div>
        <div class="flex gap-3">
          <button onclick={() => showExitConfirm = false} {@attach focusOnMount()}
            class="flex-1 bg-gray-700 text-white font-bold py-3 rounded-xl focus:outline-none focus:ring-4 focus:ring-white hover:bg-gray-600 transition-colors">
            {i18n.t.cancel}
          </button>
          <button onclick={exitApp}
            class="flex-1 bg-red-600 text-white font-bold py-3 rounded-xl focus:outline-none focus:ring-4 focus:ring-white hover:bg-red-500 transition-colors">
            {i18n.t.exitConfirm}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- ============================================================
       PHASE: LOGIN — server selection + profile selection.
       Lazy-loaded: the auto-login path never touches the chunk.
       Flow state/logic live entirely in components/Login.svelte;
       App keeps session/selectedServer/users/savedServers/savedTokens.
  ============================================================ -->
  {#if appPhase === 'servers' || appPhase === 'users'}
    {#await lazyLogin()}
      <div class="h-full flex items-center justify-center"><div class="w-14 h-14 border-4 border-white/25 border-t-white rounded-full animate-spin"></div></div>
    {:then Login}
      <Login
        bind:this={loginRef}
        bind:phase={appPhase}
        server={selectedServer}
        {users}
        {savedServers}
        clientAuthHeader={CLIENT_AUTH_HEADER}
        {authHeaderFor}
        getStoredToken={(sid, uid) => savedTokens[sid]?.[uid]}
        onValidateToken={(t) => validateToken(t)}
        onServerConnected={(s) => { selectedServer = s; }}
        onFetchUsers={fetchUsers}
        onSaveServer={(s) => { savedServers = [...savedServers, s]; persistSavedServers(); }}
        onRemoveServer={removeServer}
        onRenameServer={(id, name) => {
          savedServers = savedServers.map(x => x.id === id ? { ...x, name } : x);
          if (selectedServer?.id === id) selectedServer = { ...selectedServer, name };
          persistSavedServers();
        }}
        onTokenRefreshed={(sid, uid, token) => {
          // Only refresh if the user has enabled saving (entry exists)
          if (savedTokens[sid]?.[uid]) { savedTokens[sid][uid] = token; persistSavedTokens(); }
        }}
        onSwitchServer={handleLogout}
        onDone={finishLogin}
      />
    {/await}

  <!-- ============================================================
       PHASE: MAIN APP
  ============================================================ -->
  {:else if appPhase === 'app'}
    <div class="flex h-full w-full">

      <Sidebar
        {selectedUser}
        {viewState}
        showLogo={displaySettings.showLogo}
        libraries={navLibraries}
        navOrder={displaySettings.navOrder}
        navHidden={displaySettings.navHidden}
        navIcons={displaySettings.navIcons}
        activeLibraryId={currentLibrary?.Id}
        onNavigate={(target) => {
          if (target === 'syncplay') { openSyncPlay(); return; }
          pendingCardFocusId = null;
          // Search from the menu is always a FRESH search — mount it on first use, then clear it.
          if (target === 'search') { searchMounted = true; viewState = target; tick().then(() => searchRef?.reset()); return; }
          viewState = target;
          if (target !== 'favorites') focusMain();
        }}
        onNavigateLibrary={(lib) => navigateToLibrary(lib, true)}
        onSwitchUser={handleSwitchUser}
        onLogOutServer={handleLogout}
      />

      <div data-focus-group="main" data-enter-first-fresh class="flex-1 h-full overflow-y-auto hide-scrollbar bg-gray-900 relative [scroll-padding-top:5rem]">

        {#if viewState === 'dashboard'}
          {#key dashboardReloadKey}
          <Dashboard
            {selectedUser} {apiCache} {reduceAnimations}
            {resumeStale}
            onResumeRefreshed={() => resumeStale = false}
            showHero={displaySettings.hero}
            dashboardBackdrop={displaySettings.dashboardBackdrop}
            showLibraries={displaySettings.libraries}
            showHistory={displaySettings.history}
            showNextUp={displaySettings.nextUp}
            showWatchlist={displaySettings.watchlist}
            showRecommendations={displaySettings.recommendations}
            recommendationRows={displaySettings.recommendationRows}
            showLatest={displaySettings.latest}
            showCollections={displaySettings.collections}
            {sharedSuggestions}
            showSharedSuggestions={sharedReady && displaySettings.sharedSuggestions}
            onOpenLibrary={(lib) => navigateToLibrary(lib, false)}
            onLibrariesLoaded={(libs) => navLibraries = libs}
            onOpenDetails={(item) => showItemDetails(item)}
            onOpenCollection={(col) => openCollection(col)}
            onOpenContext={(item) => openContextMenu(item)}
          />
          {/key}

        {:else if viewState === 'settings'}
          {#await lazySettings()}
            <div class="h-full flex items-center justify-center"><div class="w-14 h-14 border-4 border-white/25 border-t-white rounded-full animate-spin"></div></div>
          {:then Settings}
          <Settings
            {selectedUser} {selectedServer} {savedTokens}
            {screensaverSettings} {reduceAnimations} {displaySettings} {playbackPrefs}
            {serverVersion} {serverVobSub}
            libraries={navLibraries}
            publicUsers={users} {sharedProfile} {sharedTokens}
            clientAuthHeader={CLIENT_AUTH_HEADER}
            onSharedToggle={toggleSharedEnabled}
            onSharedSetMember={setSharedMember}
            onSharedRemoveMember={removeSharedMember}
            onToggleSave={toggleCurrentUserSave}
            onSwitchUser={handleSwitchUser}
            onLogout={handleLogout}
            onScreensaverChange={onScreensaverSettingsChange}
            onReduceAnimationsChange={onReduceAnimationsChange}
            onDisplayChange={onDisplayChange}
            onReorderingChange={(v) => navReordering = v}
            onProfileImageChanged={refreshSelectedUser}
            onPlaybackPrefsChange={onPlaybackPrefsChange}
            onClearCache={clearCache}
          />
          {/await}
        {:else if viewState === 'details' && currentDetailItem}
          <Details bind:this={detailsRef}
            focusItemId={pendingCardFocusId} focusScrollTop={pendingCardScrollTop}
            item={currentDetailItem}
            {selectedUser} {playbackPrefs} {use24h} {serverVobSub}
            spoilerProtection={displaySettings.spoilerProtection}
            detailsBackdrop={displaySettings.detailsBackdrop}
            detailsLogo={displaySettings.detailsLogo}
            onClose={returnFromDetails}
            onOpenPerson={(person) => openPerson(person)}
            onLibChanged={refreshLibraries}
            onPlayVideo={startPlayback}
          />

        {:else if viewState === 'person'}
          <Person person={currentPerson} {selectedUser}
            focusItemId={pendingCardFocusId} focusScrollTop={pendingCardScrollTop}
            onBack={returnFromPerson}
            onOpenDetails={showItemDetails} onContextMenu={openContextMenu} />
        {:else if viewState === 'favorites'}
          <Favorites {selectedUser} reloadKey={favReloadKey} focusItemId={pendingCardFocusId}
            focusScrollTop={pendingCardScrollTop}
            onOpenDetails={showItemDetails} onContextMenu={openContextMenu}
            onOpenPerson={openPerson} onFocusFallback={focusMain} />
        {:else if viewState === 'collection'}
          <Collection bind:this={collectionRef} collection={currentCollection} {selectedUser}
            focusItemId={pendingCardFocusId} focusScrollTop={pendingCardScrollTop}
            onBack={returnFromCollection}
            onOpenDetails={showItemDetails} onContextMenu={openContextMenu}
            onChildCountChanged={onCollectionChildCount}
            onPlayVideo={(p) => { detailsOrigin = 'collection'; startPlayback(p); }}
            onPlayQueue={(qItems) => { playQueue = { items: qItems, index: 0 }; detailsOrigin = 'collection'; startPlayback({ item: qItems[0], audioIndex: -1, subtitleIndex: -1 }); }}
            onPlaylistRenamed={onCollectionRenamed}
            onPlaylistDeleted={onCollectionDeleted} />
        {/if}

        <!-- SEARCH stays mounted for the same reason as LIBRARY below: a trip into Details or a
             person page would otherwise discard the query, up to 24 results, the 10 people AND the
             per-person count cache the component keeps — so coming back meant retyping and paying
             two requests plus a count probe per person again. Opened FRESH from the menu it is
             reset instead, because a search screen showing a two-day-old query reads as stale. -->
        {#if searchMounted}
          <div class="h-full w-full" class:hidden={viewState !== 'search'}>
            <Search bind:this={searchRef} {selectedUser}
              onOpenDetails={(item) => showItemDetails(item)}
              onOpenPerson={(person) => openPerson(person)} />
          </div>
        {/if}

        <!-- LIBRARY stays permanently mounted (hidden when inactive) so scroll/items/the
             loaded window are preserved when opening Details — as before, when the state lived in App. -->
        {#if libraryMounted}
          <div class="h-full w-full" class:hidden={viewState !== 'library'}>
            <Library bind:this={libraryRef}
              {selectedUser} library={currentLibrary} reloadKey={libraryReloadKey}
              focusFirstOnLoad={libraryFocusFirst}
              sharedReady={sharedReady} partnerPlayedIds={partnersPlayedIds}
              {librarySorts} {displaySettings}
              onOpenDetails={(item) => showItemDetails(item)}
              onContextMenu={(item) => openContextMenu(item)}
              onSortPersist={(libId, sort) => { librarySorts[libId] = sort; saveUserPrefs(); }}
              onSharedWatchToggle={(on) => librarySharedOn = on} />
          </div>
        {/if}

      </div>
    </div>
  {/if}

  <!-- ============================================================
       PLAYER — absolute overlay (always on top of everything)
  ============================================================ -->
  {#if appPhase === 'app' && viewState === 'player' && currentDetailItem}
    <!-- Fade OUT only: leaving the player reveals the details underneath (softens the hard cut at
         the end of a video / on back). Entering stays instant so playback isn't delayed.
         uiFade honours "reduce animations" (duration 0). -->
    <div out:uiFade={{ duration: 150 }} class="absolute inset-0 z-[100] bg-black w-full h-full">
      {#key currentDetailItem.Id}
        {#await lazyPlayer() then Player}
        <Player
          item={currentDetailItem}
          {selectedUser} {playbackPrefs} {use24h} {serverVobSub}
          showClock={displaySettings.clock}
          showChapters={displaySettings.showChapters}
          seekStep={displaySettings.seekStep}
          selectedAudioIndex={activeAudioIndex}
          selectedSubtitleIndex={activeSubtitleIndex}
          mediaSourceId={activeMediaSourceId}
          {autoPlayStreak}
          syncPlayOpen={showSyncPlay}
          inSyncGroup={!!syncMyGroup}
          {syncCommand}
          {remoteCommand}
          {syncQueue}
          queueActive={!!playQueue}
          {queueNext}
          {queuePrev}
          onExit={() => { viewState = 'details'; resumeStale = true; }}
          onPlayState={(p) => playerPlaying = p}
          onLibChanged={refreshLibraries}
          onNext={(payload) => handleNextEpisode(payload)}
          onPrev={(episode) => handlePrevEpisode(episode)}
          onSyncplay={openSyncPlay}
        />
        {/await}
      {/key}
    </div>
  {/if}

  <!-- SYNCPLAY — group modal (on top of everything except the screensaver) -->
  {#if showSyncPlay}
    {#await lazySyncPlay() then SyncPlayModal}
    <SyncPlayModal
      group={syncMyGroup}
      groups={syncGroups}
      loading={syncLoading}
      onCreate={syncCreate}
      onJoin={(groupId) => syncJoin(groupId)}
      onLeave={syncLeave}
      onRefresh={() => syncRefresh()}
      onClose={closeSyncPlay}
    />
    {/await}
  {/if}

  <!-- CONTEXT MENU — on top of everything except the screensaver -->
  {#if contextItem}
    <ContextMenu
      item={contextItem}
      userId={activeUserId}
      onClose={() => contextItem = null}
      onChanged={onContextChanged}
      onOpenDetails={contextOpenDetails}
      onAddToList={contextAddToList}
      onAddToCollection={contextAddToCollection}
      onPlayAll={contextPlayPlaylist}
      {selectedUser}
    />
  {/if}

  <!-- AddToPicker for the context menu (focus returns to the card after closing) -->
  <AddToPicker mode={contextPickerMode} item={contextPickerItem} {selectedUser} {getAuthHeaders}
    onCreated={refreshLibraries} onClose={() => contextPickerMode = null} />

  <!-- CLOCK — top right in the app views. In the Player NOT this overlay: the Player brings
       its OWN clock in the HUD (only when the controls are shown, saves OLED), so it's excluded
       here via viewState !== 'player'. -->
  {#if appPhase === 'app' && viewState !== 'player' && displaySettings.clock}
    <Clock {viewState} {use24h} />
  {/if}

  <!-- ADMIN MESSAGE — sent from the Jellyfin dashboard (DisplayMessage). Fades itself out. -->
  {#if remoteMessage}
    <div role="status" class="fixed top-8 left-1/2 -translate-x-1/2 z-[200] w-[90%] max-w-xl pointer-events-none">
      <div class="bg-gray-900/95 border border-gray-600 rounded-2xl shadow-2xl px-6 py-5 flex items-start gap-4">
        <svg class="w-7 h-7 text-blue-400 shrink-0 mt-0.5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M8 10h.01M12 10h.01M16 10h.01M21 12c0 4.418-4.03 8-9 8a9.86 9.86 0 01-4-.8L3 20l1.3-3.9A7.96 7.96 0 013 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"/>
        </svg>
        <div class="min-w-0">
          {#if remoteMessage.header}
            <p class="text-lg font-bold text-white mb-1 break-words">{remoteMessage.header}</p>
          {/if}
          <p class="text-base text-gray-200 break-words whitespace-pre-wrap">{remoteMessage.text}</p>
        </div>
      </div>
    </div>
  {/if}

  <!-- ============================================================
       SCREENSAVER — topmost layer
  ============================================================ -->
  {#if showScreensaver}
    <Screensaver {use24h} userId={activeUserId}
      mode={screensaverSettings.mode} artSource={screensaverSettings.artSource} brightness={screensaverSettings.brightness}
      onDismiss={resetActivity} />
  {/if}

</main>

