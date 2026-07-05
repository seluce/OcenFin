<script>
  import { onMount, tick } from 'svelte';
  import { fade } from 'svelte/transition';
  import { isBackKey, focusOnMount, itemProgress, longPress, personImageUrl, serverSupportsVobSub, authHeaders, dlog, setDebug, blurUp, itemBlurHash, uiFade, dropTrapOnOutro, getItemSubtitle, getItemImageUrl } from './utils.js';
  import { session } from './session.svelte.js';
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
  import { registerSession, listSyncGroups, createSyncGroup, joinSyncGroup, leaveSyncGroup, syncSocketUrl, setSyncIgnoreWait } from './syncplay.js';

  // Lazy-geladene Ansichten (Vite-Code-Splitting): erst beim ersten Öffnen geladen, danach gecacht.
  // Hält das Kaltstart-Bundle klein — v.a. Player zieht die schweren Deps (hls.js, assjs) erst beim
  // ersten Abspielen nach, statt sie bei jedem App-Start mitzuladen.
  let _settingsP, _playerP, _syncP;
  const lazySettings = () => (_settingsP ??= import('./components/Settings.svelte').then(m => m.default));
  const lazyPlayer   = () => (_playerP   ??= import('./components/Player.svelte').then(m => m.default));
  const lazySyncPlay = () => (_syncP     ??= import('./components/SyncPlay.svelte').then(m => m.default));
  let _loginP;
  const lazyLogin    = () => (_loginP    ??= import('./components/Login.svelte').then(m => m.default));
  let loginRef = $state();   // bind:this → handleBackKey (Zurück in Anmelde-Unterdialogen)

  // ============================================================
  // APP PHASE
  // 'servers' → 'users' → 'app'
  // ============================================================
  let appPhase = $state('servers');   // aktueller Schritt im Onboarding-Flow
  let initializing = $state(true);    // Splashscreen, bis Auto-Login/Start abgeschlossen ist
  let dashboardReloadKey = $state(0); // erhöhen erzwingt frisches Neuladen des Dashboards
  let resumeStale = $state(false);    // nach einer Wiedergabe: Dashboard holt Resume/NextUp frisch (Cache bleibt sonst)
  let currentLibrary     = $state(null);  // { Id, Name } — aktive Bibliothek (an Library.svelte)
  let libraryReloadKey   = $state(0);     // erhöhen → Library verwirft View-Cache + lädt neu
  let libraryFocusFirst  = $state(false); // beim Öffnen aus dem Menü erste Karte fokussieren
  let librarySharedOn    = $state(false); // "Gemeinsam schauen" aktiv (von Library gemeldet)
  let libraryMounted     = $state(false); // ab erstem Bibliotheksbesuch dauerhaft gemountet (State bleibt)
  let libraryRef = $state();              // bind:this → restoreView / Grid-Mutationen

  // Cache leeren (Einstellungen): In-Memory-Cache verwerfen und Dashboard frisch laden.
  function clearCache() {
    apiCache.dashboard = null;
    partnersPlayedCache = {};
    libraryReloadKey++;        // Library verwirft ihren eigenen View-Cache + lädt neu
    dashboardReloadKey++;
    viewState = 'dashboard';
  }

  // ============================================================
  // SERVER-VERWALTUNG
  // ============================================================
  let savedServers      = $state([]);   // [{ id, url, name }]
  let selectedServer    = $state(null); // aktuell verbundener Server

  // Discovery

  // Manuelle Eingabe im Add-Panel

  // ============================================================
  // AUTH / BENUTZER
  // ============================================================
  let users            = $state([]);
  let selectedUser     = $state(null);
  let isLoggedIn       = $state(false);
  let serverVobSub     = $state(false);   // liefert der Server VobSub/DVD extern als .mks? (Jellyfin 12.0+)
  let serverVersion    = $state('');      // Jellyfin-Serverversion (für die Status-Seite)
  let savedTokens      = $state({});  // { serverId: { userId: token } } — Schnellwechsel (nur über Profil-Schalter)
  let sharedTokens     = $state({});  // { serverId: { userId: token } } — gemeinsames Schauen, GETRENNT vom Schnellwechsel

  // Login-Unteransichten

  // Quick Connect (Login-Flow — TV zeigt Code, Handy scannt)

  // Geräte-Basis-ID: einmalig pro Installation zufällig erzeugt und in localStorage gehalten, damit
  // dasselbe Profil auf zwei TVs NICHT dieselbe DeviceId bekommt (Jellyfin erlaubt nur einen Token je
  // DeviceId → der zweite TV würde sonst den ersten ausloggen). Bestehende Installationen, die schon
  // Tokens haben, behalten die alte feste Basis, damit ihre Tokens nach dem Update gültig bleiben.
  function randomDeviceBase() {
    try {
      const a = new Uint8Array(16); crypto.getRandomValues(a);   // braucht KEINEN secure context
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
  // Eindeutige DeviceId pro Nutzer: Jellyfin erlaubt nur EINEN Token je DeviceId. Ohne diese Trennung
  // macht das Anmelden eines zweiten Profils (z.B. fürs gemeinsame Schauen) den Token des ersten
  // ungültig. Der gehashte Benutzername ist der nutzerspezifische Teil — er sanitisiert zugleich
  // Sonderzeichen, die das Header-Format (Werte in Anführungszeichen) brechen könnten.
  function deviceIdHash(name) {
    let h = 5381; const s = String(name || '');
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
  function deviceIdFor(name) { return `${BASE_DEVICE_ID}-${deviceIdHash(name)}`; }
  function authHeaderFor(name) {
    return `MediaBrowser Client="OcenFin-TV", Device="LG Smart TV", DeviceId="${deviceIdFor(name)}", Version="${APP_VERSION}"`;
  }
  // Basis-Header ohne Nutzerbezug — nur für Quick Connect, weil der Nutzer beim Initiate noch unbekannt ist.
  const CLIENT_AUTH_HEADER =
    `MediaBrowser Client="OcenFin-TV", Device="LG Smart TV", DeviceId="${BASE_DEVICE_ID}", Version="${APP_VERSION}"`;

  // Hilfreich: auf welchen User der aktuelle Server-Token zeigt
  // App-weite Stores speisen (parallel zu den bestehenden Props; Komponenten werden schrittweise umgestellt).
  // session.serverUrl aus dem gewählten Server ableiten — in der Pre-Phase, damit Kinder
  // (Dashboard etc.) beim Remount bereits die aktuelle URL lesen. Der Token wird imperativ bei
  // Login/Wechsel/Logout direkt in session.token geschrieben (kein Feed, kein Timing-Lag).
  $effect.pre(() => { session.serverUrl = selectedServer?.url ?? ''; });
  let isCurrentUserSaved = $derived(!!(
    selectedUser && selectedServer &&
    savedTokens[selectedServer.id]?.[selectedUser.Id]
  ));

  // ============================================================
  // ANIMATIONEN
  // ============================================================
  let reduceAnimations = $state(false);

  // Anzeige-Elemente (Uhr, Hero-Banner, Episodenanzahl, Mediatheken) — einzeln abschaltbar
  let displaySettings = $state({ clock: true, hero: true, episodeCount: true, libraries: true, history: true, nextUp: true, recommendations: true, latest: true, collections: true, sharedSuggestions: true, backdropPreview: true, spoilerProtection: true, detailsBackdrop: true, detailsLogo: false, showChapters: true, clockFormat: 'auto', uiSize: 'medium', theme: 'blue', uiFont: 'system', showLogo: true, recommendationRows: 1, seekStep: 30, navOrder: [], navHidden: [], navIcons: {} });

  // Standard-Audio-/Untertitelsprache
  let playbackPrefs = $state({ audioLanguage: 'default', subtitleLanguage: 'default', autoSkipIntro: false, autoSkipCredits: false, subtitleSize: 'normal', subtitleColor: 'white', subtitleEdge: 'shadow', subtitleBackground: 'none', subtitleFont: 'system', autoPlayNext: true, burnSubtitles: false, pgsRendering: true, assRendering: true, forcedGraphicSubs: true, stillWatching: true, stillWatchingEpisodes: 3, showPlaybackInfo: false, sleepButton: false, trickplay: true });

  // ── Profil-bezogene Einstellungen ───────────────────────────
  // Sprache + Anzeige + Wiedergabe + Animationen werden PRO BENUTZER gespeichert.
  // Vor dem Login (Server-/Benutzerauswahl) gibt es noch kein Profil — dort gilt
  // die zuletzt gewählte Gerätesprache ('app_language'). Der Bildschirmschoner
  // bleibt geräteweit (schützt das physische OLED-Panel, benutzerunabhängig).
  let activeUserId = $state(null);
  let prefsReady   = false;   // verhindert Speichern während des initialen Ladens
  let applyingPrefs = false;  // verhindert Speichern WÄHREND applyUserPrefs (sonst halb-fertiger Zustand)

  // Sprachänderungen (auch aus den Einstellungen) zentral persistieren. Verfolgt i18n.lang reaktiv
  // und ersetzt das frühere currentLang.subscribe.
  $effect(() => {
    const v = i18n.lang;
    if (!prefsReady || applyingPrefs) return;
    localStorage.setItem('app_language', v);   // Gerätesprache für Vor-Login-Screens
    saveUserPrefs();                            // + im aktiven Profil sichern
  });

  // 12h/24h-Format für beide Uhren (oben rechts + Screensaver).
  // "auto" folgt der Sprache: Deutsch → 24h, Englisch → 12h. Überschreibbar.
  let use24h = $derived(displaySettings.clockFormat === '24h' ? true
            : displaySettings.clockFormat === '12h' ? false
            : i18n.lang !== 'en');

  // Sicherheitsnetz: Greifen-Sperre nie über die Einstellungen hinaus aktiv lassen.
  $effect(() => { if (viewState !== 'settings' && navReordering) navReordering = false; });

  function userPrefsKey(userId) { return `user_prefs_${userId}`; }

  function loadUserPrefs(userId) {
    try { return JSON.parse(localStorage.getItem(userPrefsKey(userId)) || '{}'); } catch { return {}; }
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

  // Beim Login die Einstellungen des Profils anwenden (oder Gerätestandards behalten)
  function applyUserPrefs(userId) {
    applyingPrefs = true;
    activeUserId = userId;
    const p = loadUserPrefs(userId);
    if (p.language) {
      setLang(p.language);
      localStorage.setItem('app_language', p.language);   // "zuletzt genutzt" aktualisieren
    }
    displaySettings  = { clock: true, hero: true, episodeCount: true, libraries: true, history: true, nextUp: true, recommendations: true, latest: true, collections: true, sharedSuggestions: true, backdropPreview: true, spoilerProtection: true, detailsBackdrop: true, detailsLogo: false, showChapters: true, clockFormat: 'auto', uiSize: 'medium', theme: 'blue', uiFont: 'system', showLogo: true, recommendationRows: 1, seekStep: 30, navOrder: [], navHidden: [], navIcons: {}, ...(p.displaySettings || {}) };
    playbackPrefs    = { audioLanguage: 'default', subtitleLanguage: 'default', autoSkipIntro: false, autoSkipCredits: false, subtitleSize: 'normal', subtitleColor: 'white', subtitleEdge: 'shadow', subtitleBackground: 'none', subtitleFont: 'system', autoPlayNext: true, burnSubtitles: false, pgsRendering: true, assRendering: true, forcedGraphicSubs: true, stillWatching: true, stillWatchingEpisodes: 3, showPlaybackInfo: false, sleepButton: false, trickplay: true, ...(p.playbackPrefs || {}) };
    reduceAnimations = p.reduceAnimations ?? false;
    librarySorts     = p.librarySorts || {};   // gemerkte Sortierung pro Bibliothek
    sharedProfile    = p.sharedProfile && Array.isArray(p.sharedProfile.members)
                       ? { enabled: !!p.sharedProfile.enabled,
                           members: [p.sharedProfile.members[0] || null, p.sharedProfile.members[1] || null] }
                       : { enabled: false, members: [] };
    // Migration: Member-Tokens, die (alt) nur im Schnellwechsel-Speicher liegen, in den eigenen
    // Shared-Speicher kopieren → gemeinsames Schauen läuft unabhängig, Schnellwechsel kann frei aus.
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
    librarySharedOn  = false;   // Filter startet pro Sitzung aus
    partnersPlayedIds = null;
    partnersPlayedCache = {};   // Partner-Cache gehört zur alten Sitzung
    applyingPrefs = false;
  }

  $effect.pre(() => {
    if (typeof document !== 'undefined') {
      document.body.dataset.reduceMotion = reduceAnimations ? '1' : '0';
    }
  });

  // Darstellung anwenden — leichtgewichtig über CSS: die Root-Schriftgröße skaliert die
  // gesamte Oberfläche (Tailwind rechnet in rem), data-theme schaltet die Akzentfarbe.
  // Läuft reaktiv bei jeder Änderung von displaySettings (Login, Umschalten, Start).
  $effect.pre(() => { if (typeof document !== 'undefined') {
    const sizes = { small: '16px', medium: '20px', large: '24px' };
    document.documentElement.style.fontSize = sizes[displaySettings.uiSize] || '20px';
    document.documentElement.setAttribute('data-theme', displaySettings.theme || 'blue');
    // UI-Schriftart: am Root gesetzt, alles erbt (font-mono-Stellen bleiben bewusst mono).
    // 'system' → Inline-Style entfernen → Chromium/webOS-Standard wie bisher. Gilt NICHT für
    // ASS-Untertitel (eigene Schriften aus dem Skript), wohl aber für die VTT-Anzeige.
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
  let screensaverTimer    = null;
  let playerPlaying       = $state(false);   // vom Player gemeldet; true NUR bei aktiver Wiedergabe

  // Plant den Screensaver: nach `timeout` s Inaktivität einblenden. Geblockt nur, wenn aus, nicht im
  // App-Betrieb, oder das Video GERADE LÄUFT. Pausierter Player, Details, Dashboard usw. → erlaubt
  // (gerade auf OLED wichtig: Standbilder dürfen nicht einbrennen).
  function scheduleScreensaver() {
    if (screensaverTimer) { clearTimeout(screensaverTimer); screensaverTimer = null; }
    if (!screensaverSettings.enabled || appPhase !== 'app' || playerPlaying) { showScreensaver = false; return; }
    screensaverTimer = setTimeout(() => { showScreensaver = true; }, screensaverSettings.timeout * 1000);
  }

  // Reaktiv neu planen, sobald sich Ein/Aus, App-Phase oder der Wiedergabe-Status ändern — so greift der
  // Screensaver auch OHNE Tastendruck (z. B. wenn der Player pausiert oder per SyncPlay angehalten wird).
  $effect(() => { scheduleScreensaver(); });

  // Jede Eingabe = Aktivität: Screensaver weg, Timer neu.
  function resetActivity() {
    if (showScreensaver) showScreensaver = false;
    scheduleScreensaver();
  }

  // Solange der Screensaver läuft, den ersten Tastendruck NUR zum Aufwecken nutzen und schlucken
  // (Capture-Phase + stopImmediatePropagation), damit er nicht zugleich z. B. die pausierte Wiedergabe
  // umschaltet oder unter dem Schoner etwas auslöst.
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
  // NAVIGATION (App-intern)
  // ============================================================
  let viewState          = $state('dashboard');
  let currentDetailItem  = $state(null);
  let navLibraries               = $state([]);    // echte Mediatheken fürs Menü (vom Dashboard gemeldet)
  let navReordering              = $state(false);  // true während ein Sidebar-Eintrag „angehoben" ist

  let activeAudioIndex    = $state(-1);
  let activeSubtitleIndex = $state(-1);
  let activeMediaSourceId = $state(null);   // gewählte Version (FullHD/4K), aus Details
  let autoPlayStreak = $state(0);           // "Schaust du noch?": automatisch abgespielte Folgen in Folge ohne Interaktion

  // Position merken: woher wurde Details geöffnet (Scroll/Fokus liegen jetzt in Library.svelte)
  let detailsOrigin      = $state('dashboard');   // 'dashboard' | 'library' | 'search'

  // ── Gemeinsames Schauen ────────────────────────────────────────────────────
  // Das eingeloggte (Gemeinsam-)Profil referenziert zwei andere Profile. Deren Tokens
  // liegen in savedTokens (gekoppelt an "Token speichern"); hier nur ID + Name gemerkt.
  let sharedProfile     = $state({ enabled: false, members: [] });  // members: [{ id, name }]
  let partnersPlayedIds = $state(null);    // Set: von BEIDEN komplett gesehene Item-IDs (aktuelle Bibliothek)
  let sharedReady = $derived(sharedProfile.enabled
                   && sharedProfile.members.filter(m => m && m.id).length >= 1);
  // Aufräumen: Option an, aber kein Profil hinterlegt → beim Verlassen der Einstellungen wieder aus.
  $effect(() => { if (viewState !== 'settings' && sharedProfile.enabled
         && sharedProfile.members.filter(m => m && m.id).length === 0) {
    sharedProfile = { ...sharedProfile, enabled: false };
    saveUserPrefs();
  } });
  // Token eines Mitglieds: eigener Shared-Speicher zuerst, sonst (falls der Nutzer den
  // Schnellwechsel selbst aktiviert hat) der Schnellwechsel-Speicher.
  function memberToken(m) {
    const sid = selectedServer?.id;
    return m && (sharedTokens[sid]?.[m.id] || savedTokens[sid]?.[m.id]);
  }
  // Profil-Liste für die Einrichtung bereitstellen, falls noch nicht geladen
  $effect(() => { if (viewState === 'settings' && users.length === 0 && session.serverUrl) fetchUsers(); });

  // ── Gemeinsame Vorschläge (Dashboard-Reihe „Für euch beide") ───────────────
  let sharedSuggestions = $state([]);
  let _loadedSugKey     = null;
  let sharedSugKey = $derived((sharedReady && displaySettings.sharedSuggestions)
                    ? sharedProfile.members.filter(m => m?.id).map(m => m.id).join('|') : '');
  $effect(() => { if (!sharedSugKey && sharedSuggestions.length) sharedSuggestions = []; });
  $effect(() => { if (viewState === 'dashboard' && sharedSugKey && sharedSugKey !== _loadedSugKey) loadSharedSuggestions(); });

  // ── SyncPlay (Gruppen-Wiedergabe) — Phase 1: Gruppen verwalten ─────────────
  let showSyncPlay = $state(false);
  let syncMyGroup  = $state(null);    // { GroupId, GroupName, Participants } oder null
  let syncGroups   = $state([]);      // verfügbare Gruppen (ohne meine eigene)
  let syncLoading  = $state(false);
  let syncPollTimer = null;
  let syncJoined   = $state(false);   // ist DIESE Sitzung in einer Gruppe? (maßgeblich, nicht der Profilname)
  let syncMyGroupId = $state(null);   // GroupId der eigenen Gruppe (vom Socket-GroupJoined bzw. beim Beitreten gesetzt)
  // Phase 2: empfangene Wiedergabe-Kommandos + aktueller Gruppen-Queue-Stand (an den Player weitergereicht)
  let syncCommand = $state(null);   // letztes SyncPlayCommand { ...Data, _seq }
  let syncCmdSeq  = $state(0);
  let syncQueue   = $state(null);   // { itemId, playlistItemId, positionTicks, isPlaying }

  // Admin-Fernsteuerung (Jellyfin-Dashboard): Playstate/GeneralCommand über dieselbe WebSocket.
  let remoteCommand = $state(null);   // { command, seekTicks?, args?, _seq } → an den Player
  let remoteCmdSeq  = $state(0);
  let remoteMessage = $state(null);   // { header, text } – Admin-Nachricht als Overlay
  let remoteMessageTimer = null;
  function showRemoteMessage(header, text, timeoutMs) {
    // Jellyfins Standard-Header ("Message from Server") oder leerer Header → lokalisieren.
    // Einen eigenen Header des Admins unverändert übernehmen.
    const h = (header || '').trim();
    const localized = (!h || h.toLowerCase() === 'message from server') ? i18n.t.messageFromServer : h;
    remoteMessage = { header: localized, text: text || '' };
    if (remoteMessageTimer) clearTimeout(remoteMessageTimer);
    const ms = timeoutMs && timeoutMs > 0 ? Math.min(timeoutMs, 30000) : 7000;
    remoteMessageTimer = setTimeout(() => { remoteMessage = null; }, ms);
  }
  function dismissRemoteMessage() { if (remoteMessageTimer) clearTimeout(remoteMessageTimer); remoteMessage = null; }
  let _lastSyncQueueItem = null;   // zuletzt automatisch geöffnetes Gruppen-Item (kein erneutes Öffnen nach Verlassen)
  let _syncOpeningId = null;       // gerade im Öffnen befindlich (verhindert Doppel-Öffnen)
  async function syncRefresh() {
    if (!session.serverUrl || !session.token) return;
    syncLoading = true;
    const all = await listSyncGroups(session.serverUrl, session.token);
    syncLoading = false;
    // Meine Gruppe = die, der DIESE Sitzung beigetreten ist (per GroupId) — NICHT per Profilname,
    // da derselbe User über mehrere Geräte gleichzeitig Mitglied sein kann.
    const mine = (syncJoined && syncMyGroupId) ? all.find(g => g.GroupId === syncMyGroupId) || null : null;
    syncMyGroup = mine;
    syncGroups  = all.filter(g => g.GroupId !== syncMyGroupId);
  }
  function openSyncPlay() {
    showSyncPlay = true;
    syncRefresh();
    if (syncPollTimer) clearInterval(syncPollTimer);
    syncPollTimer = setInterval(syncRefresh, 4000);   // Mitglieder live aktualisieren, solange offen
  }
  function closeSyncPlay() {
    showSyncPlay = false;
    if (syncPollTimer) { clearInterval(syncPollTimer); syncPollTimer = null; }
  }

  // ── Auto-Reconnect: solange der Server nicht erreichbar ist, regelmäßig leicht anpingen.
  // /System/Info/Public ist unauthentifiziert → unabhängig vom Token-Zustand. Kommt der Server
  // zurück, schließt sich der Banner von selbst (soft-clear, kein Reload → Platz bleibt erhalten).
  let reconnectTimer = null;
  function manageReconnect(lost) {
    if (lost && session.serverUrl) {
      if (reconnectTimer) return;
      reconnectTimer = setInterval(async () => {
        try {
          const r = await fetch(`${session.serverUrl}/System/Info/Public`, { cache: 'no-store' });
          if (r.ok) session.connectionLost = false;
        } catch { /* weiter versuchen */ }
      }, 5000);
    } else if (reconnectTimer) {
      clearInterval(reconnectTimer); reconnectTimer = null;
    }
  }
  $effect(() => { manageReconnect(session.connectionLost); });

  // Banner-Buttons. "Erneut versuchen" prüft SOFORT, ohne Reload → dein Platz bleibt erhalten:
  // ist der Server zurück, schließt der Banner; sonst bleibt er (Auto-Reconnect läuft weiter).
  let retryBtnEl = $state();
  async function retryNow() {
    try {
      const r = await fetch(`${session.serverUrl}/System/Info/Public`, { cache: 'no-store' });
      if (r.ok) session.connectionLost = false;
    } catch { /* weiterhin weg → Banner bleibt */ }
  }
  // Fokus zuverlässig auf den Button legen, wenn der Banner erscheint (er mountet durch ein
  // Hintergrund-Ereignis; focusOnMount griff dort nicht — tick() nach dem Flush gewinnt).
  $effect(() => { if (session.connectionLost) tick().then(() => retryBtnEl?.focus()); });
  async function syncCreate() { await createSyncGroup(session.serverUrl, session.token, selectedUser?.Name || 'OcenFin'); syncJoined = true; await setSyncIgnoreWait(session.serverUrl, session.token, false); await syncRefresh(); }
  async function syncJoin(groupId) { await joinSyncGroup(session.serverUrl, session.token, groupId); syncJoined = true; syncMyGroupId = groupId; await setSyncIgnoreWait(session.serverUrl, session.token, false); await syncRefresh(); }
  async function syncLeave() { await leaveSyncGroup(session.serverUrl, session.token); syncJoined = false; syncMyGroupId = null; syncQueue = null; _lastSyncQueueItem = null; await syncRefresh(); }

  // Auto-Laden: Item, das die Gruppe spielt, programmatisch im Player öffnen (springt per Ready→Unpause an die Gruppenposition).
  async function openItemInPlayer(itemId) {
    if (!itemId) return;
    const norm = (s) => (s || '').replace(/-/g, '');
    if (viewState === 'player' && norm(currentDetailItem?.Id) === norm(itemId)) return;  // läuft bereits
    if (_syncOpeningId === norm(itemId)) return;                                          // gerade am Öffnen
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
  // Echtzeit-Kanal: Gruppen-Updates (Beitritt/Austritt) und – ab Schritt 2 –
  // Wiedergabe-Kommandos (Play/Pause/Seek). Verbindet nach Login, hält sich per
  // KeepAlive offen und verbindet bei Abbruch automatisch neu.
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
      if (syncKeepAlive) { clearInterval(syncKeepAlive); syncKeepAlive = null; }
      dlog('[SyncPlay] socket disconnected');
      if (syncSocketWanted) { clearTimeout(syncReconnect); syncReconnect = setTimeout(connectSyncSocket, 5000); }
    };
    ws.onerror = () => { /* onclose folgt automatisch → Reconnect dort */ };
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
      // Eigene Mitgliedschaft maßgeblich am Socket festmachen (GroupId), nicht am Namen.
      if (type === 'GroupJoined') { syncJoined = true; syncMyGroupId = msg.Data?.GroupId || syncMyGroupId; syncRefresh(); }
      else if (['GroupLeft', 'NotInGroup', 'GroupDoesNotExist'].includes(type)) { syncJoined = false; syncMyGroupId = null; syncQueue = null; syncRefresh(); }
      else if (['UserJoined', 'UserLeft'].includes(type)) syncRefresh();
      else if (type === 'PlayQueue') {
        // Aktueller Gruppen-Queue-Stand (welches Item, welche Position) → an den Player weitergereicht.
        const q = msg.Data?.Data;
        const entry = q?.Playlist?.[q?.PlayingItemIndex ?? 0];
        syncQueue = entry
          ? { itemId: entry.ItemId, playlistItemId: entry.PlaylistItemId, positionTicks: q.StartPositionTicks || 0, isPlaying: !!q.IsPlaying }
          : null;
        dlog('[SyncPlay] PlayQueue', syncQueue);
        // Neues Gruppen-Item → automatisch öffnen (nur einmal pro Item; nicht erneut nach manuellem Verlassen).
        const qid = syncQueue?.itemId || null;
        if (syncMyGroup && qid && qid !== _lastSyncQueueItem) {
          _lastSyncQueueItem = qid;
          openItemInPlayer(qid);
        }
      }
    } else if (msg.MessageType === 'SyncPlayCommand') {
      // Wiedergabe-Kommando (Play/Pause/Seek) → an den Player; _seq dient dem Player als Dedupe-Marke.
      syncCommand = { ...msg.Data, _seq: ++syncCmdSeq };
      dlog('[SyncPlay] command received', syncCommand.Command, syncCommand.PositionTicks);
    } else if (msg.MessageType === 'Playstate') {
      // Admin-Fernsteuerung (Dashboard): Pause/Unpause/Stop/Seek/PlayPause/NextTrack → an den Player.
      const cmd = msg.Data?.Command;
      if (cmd) { remoteCommand = { command: cmd, seekTicks: msg.Data?.SeekPositionTicks ?? null, _seq: ++remoteCmdSeq }; }
    } else if (msg.MessageType === 'GeneralCommand') {
      const name = msg.Data?.Name;
      if (name === 'DisplayMessage') {
        const a = msg.Data?.Arguments || {};
        showRemoteMessage(a.Header, a.Text, parseInt(a.TimeoutMs, 10) || 0);
      } else if (name) {
        // Lautstärke/Mute u. ä. → an den Player weiterreichen.
        remoteCommand = { command: name, args: msg.Data?.Arguments || {}, _seq: ++remoteCmdSeq };
      }
    } else if (msg.MessageType === 'Play') {
      // Admin "Auf diesem Gerät abspielen" → erstes Item öffnen.
      const itemId = msg.Data?.ItemIds?.[0];
      if (itemId) openItemInPlayer(itemId);
    }
  }
  // Socket öffnen, sobald angemeldet — deckt regulären Login UND Auto-Wiederherstellung beim Reload ab.
  $effect(() => { if (isLoggedIn && session.token && session.serverUrl && !syncSocketWanted) {
    registerSession(session.serverUrl, session.token);   // Sitzung als steuerbar registrieren (für SyncPlay)
    connectSyncSocket();                        // SyncPlay-Echtzeitkanal öffnen
  } });

  let showExitConfirm = $state(false);   // Bestätigungsdialog "App verlassen?" (Zurück am Dashboard)
  let librarySorts = $state({});   // pro Bibliothek gemerkte Sortierung (im Profil gespeichert)
  let apiCache = { dashboard: null };   // nur noch Dashboard; Bibliotheks-Cache liegt in Library.svelte

  // ============================================================
  // STORAGE HELPERS
  // ============================================================

  function loadSavedServers() {
    try { return JSON.parse(localStorage.getItem('jellyfin_servers') || '[]'); } catch { return []; }
  }
  function persistSavedServers() {
    localStorage.setItem('jellyfin_servers', JSON.stringify(savedServers));
  }
  function loadSavedTokens() {
    try { return JSON.parse(localStorage.getItem('jellyfin_tokens_v2') || '{}'); } catch { return {}; }
  }
  function persistSavedTokens() {
    localStorage.setItem('jellyfin_tokens_v2', JSON.stringify(savedTokens));
  }
  // Eigener Speicher fürs gemeinsame Schauen — bewusst getrennt vom Schnellwechsel (savedTokens),
  // damit das Einrichten NIE den Schnellwechsel-Schalter eines Profils beeinflusst.
  function loadSharedTokens() {
    try { return JSON.parse(localStorage.getItem('jellyfin_shared_tokens_v1') || '{}'); } catch { return {}; }
  }
  function persistSharedTokens() {
    localStorage.setItem('jellyfin_shared_tokens_v1', JSON.stringify(sharedTokens));
  }
  function loadScreensaverSettings() {
    try { return JSON.parse(localStorage.getItem('screensaver_settings') || '{}'); } catch { return {}; }
  }

  /**
   * Einmalige Migration vom alten Format (einzelner Server, flache Token-Map).
   * Läuft einmalig und entfernt dann die alten Keys.
   */
  function migrateOldData() {
    const oldUrl = localStorage.getItem('jellyfin_url');
    if (!oldUrl) return;

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
    setDebug(localStorage.getItem('ocenfin_debug') === '1');   // geräteweites Diagnose-Logging (opt-in)

    // Gerätesprache für Vor-Login-Screens (Server-/Benutzerauswahl): zuletzt gewählte Sprache →
    // sonst Gerätesprache → sonst Englisch. Validiert gegen vorhandene Übersetzungen.
    // Profil-spezifische Einstellungen werden erst beim Login via applyUserPrefs geladen.
    setLang(detectUiLang());
    prefsReady = true;   // ab jetzt werden Änderungen persistiert

    // Globale Back-Taste (WebOS Fernbedienung)
    window.addEventListener('keydown', handleGlobalBack);
    // D-Pad-Navigation (Gruppen-Fokus-Modell) — überall aktiv. Der Player ist eine
    // eigene Fokus-Gruppe; sein Schieberegler verarbeitet Links/Rechts selbst.
    createFocusManager(() => !navReordering);
    // Netzwerkstatus überwachen (Banner bei Verbindungsverlust)
    window.addEventListener('offline', () => session.connectionLost = true);
    window.addEventListener('online',  () => session.connectionLost = false);

    // webOS-Lifecycle: Kehrt man über Home zur (suspendierten) App zurück, feuert webOSRelaunch.
    // Auf manchen Builds/appinfo-Konfigurationen (handlesRelaunch:true) bleibt die App dann im
    // Hintergrund hängen und startet scheinbar nicht — wir holen sie deshalb explizit in den
    // Vordergrund. Harmlos, falls webOS das ohnehin selbst übernimmt.
    const toForeground = () => {
      dlog('[Lifecycle] webOSRelaunch → activate');
      try { window.PalmSystem?.activate?.(); } catch (e) { console.warn('[Lifecycle] activate failed:', e); }
      try { window.webOSSystem?.activate?.(); } catch { /* nicht vorhanden */ }
    };
    document.addEventListener('webOSRelaunch', toForeground, true);

    // webOS-System-Screensaver aktiv ablehnen, solange OcenFins eigener Screensaver aktiv ist —
    // sonst lägen zwei Screensaver übereinander und man müsste zweimal drücken. webOS fragt über
    // die Luna-API vor dem Anzeigen nach; wir antworten mit ack:false (= bitte nicht zeigen, wir
    // schützen das OLED selbst). Ist OcenFins Screensaver aus, lassen wir webOS zu (ack:true).
    if (window.webOS?.service?.request) {
      window.webOS.service.request('luna://com.webos.service.tvpower', {
        method: 'power/registerScreenSaverRequest',
        parameters: { subscribe: true, clientName: 'ocenfin' },
        subscribe: true,
        onSuccess: (res) => {
          // Erste Antwort bestätigt nur die Registrierung (ohne state); danach kommt state je Anfrage.
          if (res?.state !== 'Active') { dlog('[Screensaver] Luna registered, returnValue=', res?.returnValue); return; }
          const decline = screensaverSettings.enabled;   // OcenFin-Screensaver an → webOS ablehnen
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
      // Auto-Login via gespeicherter Session
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
                applyUserPrefs(selectedUser.Id);   // Profil-Einstellungen laden
                fetchUsers(); // Im Hintergrund für Benutzerwechsel
                scheduleScreensaver();
                dlog('[restore] auto-login successful:', selectedUser.Name);
                return;
              }
            }
            // Token abgelaufen → User-Screen für diesen Server
            dlog('[restore] token invalid → back to user screen');
            clearCurrentSession();
            // selectedServer ist gesetzt (oben) — die Login-Komponente zeigt die Profilwahl
            // und lädt die Profile selbst nach (users-Effect in Login.svelte).
            appPhase = 'users';
            return;
          }
        } catch (e) { dlog('[restore] restore failed:', e?.message || e); clearCurrentSession(); }
      }

      // Kein Auto-Login → Server-Auswahl anzeigen
      dlog('[restore] no auto-login → server selection');
      appPhase = 'servers';
    } finally {
      initializing = false;   // Splashscreen ausblenden (egal welcher Pfad)
    }
  });

  // ============================================================
  // SERVER ENTFERNEN — Verbinden-/Discovery-/Anmelde-Flow lebt in
  // components/Login.svelte (lazy geladen)
  // ============================================================

  function removeServer(id) {
    savedServers = savedServers.filter(s => s.id !== id);
    persistSavedServers();
    // Tokens für diesen Server entfernen
    if (savedTokens[id]) {
      delete savedTokens[id];
      savedTokens = { ...savedTokens };
      persistSavedTokens();
    }
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

  // ── Gemeinsames Schauen: Mitglieder & Datenbasis ───────────────────────────
  function toggleSharedEnabled() {
    sharedProfile = { ...sharedProfile, enabled: !sharedProfile.enabled };
    if (!sharedProfile.enabled) { librarySharedOn = false; partnersPlayedIds = null; partnersPlayedCache = {}; }
    saveUserPrefs();
  }

  // Ein Profil als Mitglied setzen. Nutzt einen gültigen gespeicherten Token; sonst wird
  // mit pw einmal authentifiziert. KEIN Sitzungswechsel — das Gemeinsam-Profil bleibt aktiv.
  // Rückgabe: 'ok' | 'needPassword' | 'error'
  async function setSharedMember(slot, user, pw = '') {
    if (!user || !selectedServer) return 'error';
    const sid = selectedServer.id;
    // Vorhandenen Token wiederverwenden (eigener Speicher oder selbst aktivierter Schnellwechsel).
    let token = sharedTokens[sid]?.[user.Id] || savedTokens[sid]?.[user.Id];
    if (token && !(await validateToken(token))) token = null;   // abgelaufen → neu anmelden
    if (!token) {
      if (user.HasPassword && !pw) return 'needPassword';
      try {
        const res = await fetch(`${session.serverUrl}/Users/AuthenticateByName`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': authHeaderFor(user.Name) },
          body:    JSON.stringify({ Username: user.Name, Pw: pw || '' })
        });
        if (!res.ok) return 'error';
        token = (await res.json()).AccessToken;
      } catch { return 'error'; }
    }
    // Token NUR im eigenen Shared-Speicher ablegen — NIE in savedTokens. Der Schnellwechsel
    // bleibt damit allein über den Profil-Schalter steuerbar (pro Benutzer selbst entschieden).
    if (!sharedTokens[sid]) sharedTokens[sid] = {};
    sharedTokens[sid][user.Id] = token;
    sharedTokens = { ...sharedTokens };
    persistSharedTokens();
    const members = [sharedProfile.members[0] || null, sharedProfile.members[1] || null];
    members[slot] = { id: user.Id, name: user.Name };
    sharedProfile = { ...sharedProfile, members };
    _loadedSugKey = null;   // Vorschläge neu berechnen
    saveUserPrefs();
    partnersPlayedCache = {};   // Mitglieder geändert → alle gecachten Vereinigungen ungültig
    if (librarySharedOn) loadPartnersPlayedIds(currentLibrary?.Id);
    return 'ok';
  }

  function removeSharedMember(slot) {
    const members = [sharedProfile.members[0] || null, sharedProfile.members[1] || null];
    const removed = members[slot];
    members[slot] = null;
    sharedProfile = { ...sharedProfile, members };
    // Nur den eigenen Shared-Token entfernen — der Schnellwechsel-Token (savedTokens) bleibt unberührt.
    const sid = selectedServer?.id;
    if (removed?.id && sid && sharedTokens[sid]?.[removed.id]) {
      delete sharedTokens[sid][removed.id];
      sharedTokens = { ...sharedTokens };
      persistSharedTokens();
    }
    _loadedSugKey = null;   // Vorschläge neu berechnen
    saveUserPrefs();
    partnersPlayedCache = {};   // Mitglieder geändert → alle gecachten Vereinigungen ungültig
    if (librarySharedOn) loadPartnersPlayedIds(currentLibrary?.Id);
  }

  // Vereinigung der von den Mitgliedern komplett gesehenen Top-Level-Titel der Bibliothek.
  // Jedes Profil mit eigenem Token (kein Admin). Wir holen alle Titel mit UserData und prüfen
  // selbst auf Played=true — zuverlässiger als Filters=IsPlayed, das bei Serien nicht immer greift.
  // Cache pro Bibliothek (TTL 10 min): der Fetch ist die schwerste Abfrage der App (voller Katalog
  // pro Mitglied) — beim Hin- und Herwechseln zwischen Bibliotheken nicht jedes Mal neu laden.
  // Invalidiert bei Mitglieder-Änderung, Profil-Aus, Sitzungswechsel und "Cache leeren".
  let partnersPlayedCache = {};   // libraryId → { ids: Set, at: Timestamp }
  const PARTNERS_CACHE_TTL = 10 * 60 * 1000;
  async function loadPartnersPlayedIds(libraryId) {
    partnersPlayedIds = null;
    if (!librarySharedOn || !sharedReady || !libraryId) return;
    const hit = partnersPlayedCache[libraryId];
    if (hit && Date.now() - hit.at < PARTNERS_CACHE_TTL) { partnersPlayedIds = hit.ids; return; }
    const ids = new Set();
    for (const m of sharedProfile.members) {
      if (!m || !m.id) continue;
      const token = memberToken(m);
      if (!token) { console.warn('[Shared] no valid token for', m.name, '– please re-add profile.'); continue; }
      try {
        const res = await fetch(
          `${session.serverUrl}/Users/${m.id}/Items?ParentId=${libraryId}&Recursive=true` +
          `&IncludeItemTypes=Movie,Series&Fields=UserData&EnableImages=false` +
          `&Limit=100000&EnableTotalRecordCount=false`,
          { headers: authHeaders(token) }
        );
        if (!res.ok) { console.warn('[Shared] query failed for', m.name, '· HTTP', res.status); continue; }
        let n = 0;
        // Clientseitig auf UserData.Played prüfen — zuverlässiger als Filters=IsPlayed (greift bei Serien nicht immer).
        (await res.json()).Items?.forEach(i => { if (i.UserData?.Played) { ids.add(i.Id); n++; } });
        dlog('[Shared]', m.name, '→', n, 'fully-watched titles');
      } catch (e) { console.warn('[Shared] error for', m.name, e); }
    }
    partnersPlayedIds = ids;
    partnersPlayedCache[libraryId] = { ids, at: Date.now() };
  }

  // Partner-IDs für "Gemeinsam schauen" laden/verwerfen, sobald sich Bibliothek oder Schalter ändern.
  $effect(() => {
    const lib = currentLibrary;
    if (lib && librarySharedOn) loadPartnersPlayedIds(lib.Id);
    else partnersPlayedIds = null;
  });

  // Vorschläge, die zur GEMEINSAMEN Vorliebe passen und die noch keiner gesehen hat.
  // Pro Mitglied einmal Katalog (mit Genres) holen → Genre-Gewichte (nur Genres, die ALLE mögen)
  // und Vereinigung der gesehenen IDs. Dann ungesehene Titel nach Genre-Score ranken.
  async function loadSharedSuggestions() {
    if (!sharedSugKey) { sharedSuggestions = []; return; }
    _loadedSugKey = sharedSugKey;   // Schlüssel vorab beanspruchen → kein Doppel-Fetch
    const memberData = [];
    for (const m of sharedProfile.members) {
      if (!m?.id) continue;
      const token = memberToken(m);
      if (!token) continue;
      try {
        const res = await fetch(
          `${session.serverUrl}/Users/${m.id}/Items?Recursive=true&IncludeItemTypes=Movie,Series` +
          `&Fields=Genres,CommunityRating,UserData&EnableImageTypes=Primary&Limit=100000&EnableTotalRecordCount=false`,
          { headers: authHeaders(token) }
        );
        if (!res.ok) continue;
        const items = (await res.json()).Items || [];
        const genreCount = {}; const watched = new Set();
        for (const it of items) {
          if (it.UserData?.Played) {
            // Nur vollständig Gesehenes ausschließen + Genre-Vorlieben daraus ableiten.
            // Angefangene Serien/Filme bleiben bewusst als Vorschlag erhalten (kein Extra-Traffic).
            watched.add(it.Id);
            for (const g of it.Genres || []) genreCount[g] = (genreCount[g] || 0) + 1;
          }
        }
        memberData.push({ items, genreCount, watched });
      } catch { }
    }
    if (!memberData.length) { sharedSuggestions = []; return; }

    // Genre-Gewichte: Genres, die ALLE Mitglieder gesehen haben (Produkt der Häufigkeiten → „beide mögen es").
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
    // Fallback: keine echte Schnittmenge → Summe über alle, damit überhaupt Vorschläge kommen.
    if (!Object.keys(weights).length)
      for (const g of allGenres) weights[g] = memberData.reduce((s, d) => s + (d.genreCount[g] || 0), 0);

    const exclude = new Set();
    memberData.forEach(d => d.watched.forEach(id => exclude.add(id)));

    sharedSuggestions = memberData[0].items
      .filter(it => !exclude.has(it.Id))
      .map(it => ({ it, score: (it.Genres || []).reduce((s, g) => s + (weights[g] || 0), 0) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score || (b.it.CommunityRating || 0) - (a.it.CommunityRating || 0))
      .slice(0, 12)   // einheitliche Dashboard-Reihenlänge (ROW_LIMIT in Dashboard.svelte)
      .map(x => ({ ...x.it, UserData: {} }));   // UserData leeren → kein Fortschrittsbalken eines Mitglieds
    dlog('[Shared] suggestions:', sharedSuggestions.length);
  }

  // baseUrl explizit übergebbar: beim Auto-Login ist der reaktive session.serverUrl ($:) noch nicht
  // aktualisiert (Svelte flusht Reaktivität erst nach dem synchronen Block), daher würde
  // `${session.serverUrl}` dort auf '' zeigen → relativer Fetch auf die App-Origin statt auf den Server.
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
    applyUserPrefs(user.Id);   // Profil-Einstellungen laden
    saveCurrentSession();
    scheduleScreensaver();
    detectServerCapabilities();
    refreshSharedMemberToken(user.Id, token);
  }

  // Jellyfin bindet Sessions an die DeviceId — meldet sich ein Profil auf demselben Gerät neu an,
  // verfällt sein vorheriger Token. Ist dieses Profil Mitglied im Gemeinsam-Profil, frischen wir
  // dessen gespeicherte Token-Momentaufnahme auf den neuen Token auf, sonst läuft das gemeinsame
  // Schauen später ins 401. Nur Profile auffrischen, die bereits als Mitglied erfasst sind.
  function refreshSharedMemberToken(userId, token) {
    const sid = selectedServer?.id;
    if (!sid || !token) return;
    if (sharedTokens[sid]?.[userId] && sharedTokens[sid][userId] !== token) {
      sharedTokens[sid][userId] = token;
      sharedTokens = { ...sharedTokens };
      persistSharedTokens();
    }
  }

  // Einmalig die Serverversion prüfen → entscheidet, ob DVD/VobSub clientseitig (libbitsub via
  // .mks) renderbar ist oder noch gebrannt werden muss. Fehlerhaft/alt → false (sicheres Brennen).
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

  /** Zurück zum Benutzer-Screen (behält Server-Verbindung) */
  function handleSwitchUser() {
    isLoggedIn       = false;
    selectedUser     = null;
    session.token      = '';
    disconnectSyncSocket();              // SyncPlay-Socket schließen
    closeSyncPlay(); syncMyGroup = null; syncGroups = []; syncQueue = null; syncCommand = null; _lastSyncQueueItem = null; syncJoined = false; syncMyGroupId = null;   // Gruppenstatus zurücksetzen
    remoteCommand = null; dismissRemoteMessage();   // Admin-Fernsteuerung/Nachricht verwerfen
    viewState = 'dashboard';
    apiCache.dashboard = null;   // Cache leeren (Property-Mutation statt Neuzuweisung → geteilte Referenz bleibt)
    navLibraries = [];
    clearCurrentSession();
    // Zurück zum User-Screen, Server bleibt verbunden
    appPhase = 'users';
  }

  /** Vollständig abmelden + Server-Verbindung trennen */
  function handleLogout() {
    handleSwitchUser();
    selectedServer    = null;
    users             = [];
    appPhase          = 'servers';
  }

  // ============================================================
  // GLOBALE BACK-TASTE (WebOS Fernbedienung)
  // ============================================================

  function handleGlobalBack(e) {
    if (!isBackKey(e)) return;   // Escape / Backspace (außer in Eingaben) / Fernbedienung 461
    if (appPhase === 'users') {
      e.preventDefault();
      // Unterdialoge (Passwort/Manuell/QC) schließt die Login-Komponente selbst;
      // sonst zurück zur Server-Auswahl. (Muster wie collectionRef.handleBackKey)
      if (!loginRef?.handleBackKey()) handleLogout();
      return;
    }
    if (appPhase !== 'app') return;
    // Bestätigungsdialog offen → Zurück bricht ab (statt zu schließen)
    if (showExitConfirm) { showExitConfirm = false; e.preventDefault(); return; }
    // Offene Overlays zuerst schließen (gilt auch für Fernbedienungs-Zurück)
    if (showSyncPlay)   { closeSyncPlay();         e.preventDefault(); return; }
    if (contextItem)    { contextItem = null;     e.preventDefault(); return; }
    // Innerhalb der App navigieren; preventDefault verhindert, dass webOS die App schließt.
    // Am Dashboard (oberste Ebene) Bestätigung zeigen statt die App direkt zu schließen.
    if      (viewState === 'player')   { viewState = 'details';        e.preventDefault(); }
    else if (viewState === 'details')  { returnFromDetails();          e.preventDefault(); }
    else if (viewState === 'person')   { viewState = personReturnView; e.preventDefault(); }
    else if (viewState === 'collection') { if (!collectionRef?.handleBackKey()) viewState = collectionReturnView; e.preventDefault(); }
    else if (viewState === 'library')  { viewState = 'dashboard';      e.preventDefault(); }
    else if (viewState === 'settings') { viewState = 'dashboard';      e.preventDefault(); }
    else if (viewState === 'search')   { viewState = 'dashboard';      e.preventDefault(); }
    else if (viewState === 'favorites') { viewState = 'dashboard';      e.preventDefault(); }
    else if (viewState === 'dashboard') { showExitConfirm = true;      e.preventDefault(); }
  }

  // Schließt die App auf webOS (platformBack an der Wurzel); window.close als Rückfall.
  function exitApp() {
    try { window.webOSSystem?.platformBack?.(); } catch {}
    try { window.close(); } catch {}
  }

  // ============================================================
  // EPISODE NAVIGATION
  // ============================================================

  // Player sendet jetzt das vollständige Episode-Objekt via dispatch('next/prev', episodeItem).
  // Kein eigener API-Call mehr nötig — einfach currentDetailItem setzen.
  // Player sendet { episode, resetStreak }. resetStreak=true → Nutzer war wach (manuell/Interaktion),
  // Zähler auf 0; sonst hochzählen (für den "Schaust du noch?"-Einschlaf-Schutz).
  function handleNextEpisode(detail) {
    const episodeItem = detail?.episode ?? detail;   // Robustheit: akzeptiert auch ein nacktes Episoden-Objekt
    if (!episodeItem) return;
    autoPlayStreak = detail?.resetStreak ? 0 : autoPlayStreak + 1;
    activeMediaSourceId = null;   // neue Folge → eigene Standard-Version, nicht die der vorigen
    currentDetailItem = episodeItem;
    syncQueueIndex(episodeItem);
    // viewState bleibt 'player' — {#key currentDetailItem.Id} in der Template sorgt für Remount
  }

  function handlePrevEpisode(episodeItem) {
    if (!episodeItem) return;
    autoPlayStreak = 0;   // Zurückspringen ist eine bewusste Aktion → Zähler zurücksetzen
    activeMediaSourceId = null;
    currentDetailItem = episodeItem;
    syncQueueIndex(episodeItem);
  }

  // ── Personen-Ansicht (Filmografie) ──────────────────────────
  let currentPerson      = $state(null);       // Seed-Person für die Personen-Ansicht (Person.svelte lädt selbst)
  let personReturnView   = $state('search');   // wohin "Zurück" führt

  // Sammlungen (BoxSets) — eigene Grid-Ansicht, gespiegelt von der Personen-Ansicht
  // Sammlungen/Wiedergabelisten — eigene Ansicht (Collection.svelte lädt selbst).
  let currentCollection    = $state(null);          // Seed-BoxSet/Playlist
  let collectionReturnView = $state('dashboard');   // wohin "Zurück" führt
  let collectionRef = $state();                     // bind:this → für Zurück-Taste (handleBackKey)

  function openCollection(boxSet) {
    collectionReturnView = viewState;
    currentCollection    = boxSet;
    viewState            = 'collection';
  }

  // Cross-Effekte aus der Collection-Ansicht auf Bibliotheks-Grid / Sidebar:
  function onCollectionChildCount(id, count) { libraryRef?.updateChildCount(id, count); }
  function onCollectionRenamed(id, name) { libraryRef?.renamePlaylist(id, name); refreshLibraries(); }
  async function onCollectionDeleted(id) {
    libraryRef?.removeItem(id);   // sofort aus dem Grid
    await refreshLibraries();   // Sidebar/Menü neu laden (Playlist verschwindet)
    // War es die letzte Playlist, entfernt Jellyfin die ganze "Playlists"-Bibliothek.
    const playlistsLibGone = !navLibraries.some(l => l.CollectionType === 'playlists');
    if (playlistsLibGone) {
      // Das Dashboard hält seine Bibliotheksliste gecacht — sonst bliebe der "Playlists"-Ordner
      // im "Meine Medien"-Bereich stehen, bis man das Dashboard neu öffnet. Cache verwerfen + Remount.
      apiCache.dashboard = null;
      dashboardReloadKey++;
    }
    if (collectionReturnView === 'library' && playlistsLibGone) { currentLibrary = null; viewState = 'dashboard'; }
    else viewState = collectionReturnView;
  }

  // Nach dem Anlegen einer Wiedergabeliste/Sammlung erscheint serverseitig ggf. eine neue
  // Mediatheks-Ansicht (z. B. "Playlists") – Sidebar/Menü sofort aktualisieren statt erst beim Neustart.
  async function refreshLibraries() {
    try {
      const res = await fetch(`${session.serverUrl}/Users/${selectedUser.Id}/Views`, { headers: getAuthHeaders() });
      if (res.ok) navLibraries = (await res.json()).Items || [];
    } catch { }
  }

  // Favoriten — eigene Ansicht (Komponente Favorites.svelte). Lädt selbst beim Mounten; dieser
  // Schlüssel wird hochgezählt, um nach einer Änderung (z.B. Favorit in Details entfernt) neu zu laden.
  let favReloadKey = $state(0);

  // Öffnet die Filmografie einer Person (aus Suche, Besetzung in den Details oder Favoriten).
  // Setzt nur Rückkehr-Ansicht + Seed-Person; Person.svelte lädt Person-Details + Filmografie selbst.
  function openPerson(person) {
    personReturnView = viewState;
    currentPerson    = person;
    viewState        = 'person';
  }

  // Nach einer Auswahl in der Sidebar den Fokus in den Inhalt verschieben. Das
  // Verlassen der Sidebar klappt sie automatisch wieder ein (ihr focusout-Handler).
  // So liegt der Fokus direkt dort, wo es weitergeht, statt in der offenen Leiste.
  async function focusMain() {
    await tick();
    const main = document.querySelector('[data-focus-group="main"]');
    if (!main) return;
    const first = main.querySelector(
      'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (first) first.focus();
  }

  // Lädt das Benutzerobjekt neu (z. B. nach Profilbild-Upload) → Avatar aktualisiert sich überall.
  async function refreshSelectedUser() {
    try {
      const res = await fetch(`${session.serverUrl}/Users/${selectedUser.Id}`, { headers: getAuthHeaders() });
      if (res.ok) selectedUser = await res.json();
    } catch { /* ignorieren */ }
  }

  function navigateToLibrary(lib, focusFirstCard = false) {
    if (!lib) return;
    libraryMounted = true;                  // ab jetzt bleibt Library gemountet (Scroll/Items überleben Details)
    libraryFocusFirst = focusFirstCard;     // Library fokussiert nach dem Laden selbst die erste Karte
    currentLibrary = { Id: lib.Id, Name: lib.Name };
    viewState = 'library';
  }

  function showItemDetails(item) {
    // Container (Sammlung/Wiedergabeliste) zeigen ihren Inhalt statt einer Detailseite
    if (item?.Type === 'BoxSet' || item?.Type === 'Playlist') { openCollection(item); return; }
    // Herkunft merken, damit "Zurück" wieder dorthin führt (nicht immer Dashboard)
    detailsOrigin = viewState;
    currentDetailItem = item;
    viewState = 'details';
    lazyPlayer();   // Player-Chunk im Hintergrund vorladen — von hier wird sehr wahrscheinlich abgespielt
  }

  // ============================================================
  // KONTEXTMENÜ (langes Drücken auf eine Karte)
  // ============================================================
  let contextItem = $state(null);
  let contextReturnId = $state(null);     // Item-Id der auslösenden Card (Fokus-Rückgabe, überlebt Reload)
  let contextReturnEl = $state(null);     // Fallback: Element-Referenz, falls keine data-item-id vorhanden
  let contextPickerMode = $state(null);   // null | 'playlist' — AddToPicker aus dem Kontextmenü
  let contextPickerItem = $state(null);
  function openContextMenu(item) {
    contextReturnId = item?.Id ?? null;
    contextReturnEl = document.activeElement;
    contextItem = item;
  }
  // Nach dem Schließen von Kontextmenü UND Picker den Fokus zurück auf die Card legen.
  // Dashboard lädt nach Kontextaktionen NICHT mehr neu → die Card-Referenz lebt noch und wird
  // direkt fokussiert (instant). Bibliothek/Sammlung laden noch async neu → die Card kommt per
  // data-item-id zurück (kurz pollen), sonst der erste sichtbare Eintrag (statt Fokusverlust).
  function restoreContextFocus() {
    const id = contextReturnId, el = contextReturnEl;
    contextReturnId = null; contextReturnEl = null;
    let tries = 0;
    const attempt = () => {
      if (el && document.contains(el) && typeof el.focus === 'function') { el.focus(); return; }
      const target = id ? document.querySelector(`[data-item-id="${id}"]`) : null;
      if (target) { target.focus(); return; }
      if (++tries < 12) { setTimeout(attempt, 50); return; }   // bis ~600 ms auf den neu geladenen Eintrag warten
      document.querySelector('[data-item-id]')?.focus();
    };
    tick().then(attempt);
  }
  $effect(() => { if (!contextItem && !contextPickerMode && (contextReturnId || contextReturnEl)) restoreContextFocus(); });

  function onContextChanged() {
    // ContextMenu hat item.UserData bereits in-place mutiert → Deep Reactivity aktualisiert
    // Badges/Fortschritt sofort, ohne Full-Reload (kein Reshuffle, kein Fokusverlust).
    // Bibliothek: passt das geänderte Item nicht mehr zum aktiven Status-Filter, fliegt es gezielt
    // aus der Liste (die servergeladene Liste bleibt sonst unberührt → kein Mismatch-Risiko).
    // Dashboard/Sammlung brauchen keine Aktion (kein membership-relevanter Status-Filter).
    if (viewState === 'library' && contextItem && libraryRef && !libraryRef.matchesStatusFilters(contextItem)) {
      libraryRef.removeItem(contextItem.Id);
    }
  }
  function contextOpenDetails(item) {
    contextReturnId = null; contextReturnEl = null;   // Details übernimmt den Fokus
    contextItem = null;
    showItemDetails(item);
  }
  // "Zur Wiedergabeliste hinzufügen" aus dem Kontextmenü → AddToPicker öffnen (Fokus-Rückgabe-Id bleibt
  // erhalten und greift erst, wenn auch der Picker geschlossen ist).
  function contextAddToList(item) { contextPickerItem = item; contextPickerMode = 'playlist'; }

  // Zurück aus Details/Player → an die Herkunft, Bibliotheksposition wiederherstellen
  // Startet die Wiedergabe eines Items — genutzt von Details (Play/Von-Anfang/Zufallsfolge)
  // und Collection (Zufällige Wiedergabe). Eine Quelle statt zwei Inline-Kopien.
  // "Alle abspielen" (Sammlung/Playlist): geordnete Abspiel-Queue. Lebt nur, solange der
  // Player offen ist — beim Verlassen wird sie geräumt, damit spätere normale Wiedergaben
  // nicht versehentlich weiterschalten.
  let playQueue = $state(null);   // { items: [...], index }
  let queueNext = $derived(playQueue && playQueue.index < playQueue.items.length - 1 ? playQueue.items[playQueue.index + 1] : null);
  let queuePrev = $derived(playQueue && playQueue.index > 0 ? playQueue.items[playQueue.index - 1] : null);
  $effect(() => { if (viewState !== 'player' && playQueue) playQueue = null; });

  // Beim Titelwechsel im Player den Queue-Zeiger mitführen (deckt Vor UND Zurück ab)
  function syncQueueIndex(playedItem) {
    if (!playQueue || !playedItem) return;
    const qi = playQueue.items.findIndex(x => x.Id === playedItem.Id);
    if (qi >= 0) playQueue = { ...playQueue, index: qi };
  }
  function startPlayback(p) {
    if (p.item) currentDetailItem = p.item;
    activeAudioIndex    = p.audioIndex    ?? -1;
    activeSubtitleIndex = p.subtitleIndex ?? -1;
    activeMediaSourceId = p.mediaSourceId ?? null;
    viewState = 'player';
  }

  async function returnFromDetails() {
    viewState = detailsOrigin;
    if (detailsOrigin === 'library') {
      libraryRef?.restoreView();
      // Gleiche Mechanik wie onContextChanged: Details hat item.UserData in-place mitgezogen
      // (Favorit/Gesehen-Toggles). Passt das Item nicht mehr zum aktiven Status-Filter
      // (z. B. Favoriten-Filter an + Favorit in den Details entfernt), fliegt es gezielt aus
      // der geladenen Liste — statt Full-Reload, damit Scrollposition und Fokus erhalten bleiben.
      if (currentDetailItem && libraryRef && !libraryRef.matchesStatusFilters(currentDetailItem)) {
        libraryRef.removeItem(currentDetailItem.Id);
      }
    } else if (detailsOrigin === 'favorites') {
      // Favoriten neu laden — z.B. wenn in den Details ein Favorit entfernt wurde, war er sonst
      // noch in der Übersicht gelistet, bis man die Ansicht wechselte. Schlüssel hochzählen → Favorites lädt neu.
      favReloadKey++;
    }
  }

  async function loadItemById(itemId) {
    try {
      const res = await fetch(`${session.serverUrl}/Users/${selectedUser.Id}/Items/${itemId}`, { headers: getAuthHeaders() });
      if (res.ok) { currentDetailItem = await res.json(); viewState = 'details'; }
    } catch { }
  }

</script>

<svelte:window
  onkeydown={resetActivity}
  onmousemove={resetActivity}
  onpointermove={resetActivity}
  onclick={resetActivity}
/>

<style>
  /* ── ASS-Untertitel-Schriften ────────────────────────────────────────────────
     assjs nutzt die Browser-Schriften. ASS-Skripte geben fast immer die Windows-Namen
     an (Arial / Times New Roman / Courier New), die auf dem TV nicht installiert sind →
     System-Fallback. Wir hinterlegen metrisch kompatible offene Ersatzschriften UNTER
     genau diesen Namen: Arimo→Arial, Tinos→Times New Roman, Cousine→Courier New. Damit
     greift assjs sie automatisch, ohne dass am ASS-Skript etwas geändert werden muss.
     Die Dateien (Latin-woff2, je 4 Schnitte) liegen in src/fonts/ und werden von Vite
     gebündelt (basis-/pfadkorrekt, gehasht). Die UI selbst nutzt keinen dieser Namen,
     also keine Nebenwirkung. font-display: swap → erste Zeile evtl. kurz im Fallback,
     danach gecacht. @font-face wird von Svelte ohnehin global ausgegeben (nicht gescoped). */
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

  /* ── Weitere häufige Fansub-Schriften (Tahoma / Verdana / Trebuchet MS) ───────
     Für diese gibt es KEINE metrisch kompatiblen Klone wie oben. Stattdessen ein
     gemeinsamer "Topf": EINE neutrale, moderne Sans (Noto Sans, latin + latin-ext,
     je 4 Schnitte) wird unter allen drei Windows-Namen registriert. Nur visuell
     ähnlich, NICHT metrik-genau — für Dialog/Schilder in der Praxis ausreichend.
     Noto ist enger als Tahoma/Verdana, dafür einheitlich mit der übrigen Font-
     Pipeline (gwfh, latin+latin-ext). Dieselben 4 Dateien für alle drei Namen →
     kein zusätzlicher Speicher pro Name. */
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

  /* ── UI-/VTT-Schriftarten (Einstellungen → Darstellung bzw. → Untertitel) ─────
     Dieselben Dateien wie oben, nur unter ihren ECHTEN Namen registriert, damit
     UI und VTT-Untertitel sie sauber referenzieren können ('Arimo' statt Umweg
     über den 'Arial'-Alias). Tinos (Serife) nur für VTT wählbar. Kein zusätz-
     licher Speicher — WOFF2 wird pro Datei nur einmal geladen. */
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

  /* TV-Skalierung (10-Fuß-UI): hebt die rem-basierte Basisgröße an, damit Texte und
     Abstände aus Sofa-Entfernung größer wirken. Standard-Browser sind 16px; 20px = +25%.
     Bei Bedarf weiter anpassen, falls auf dem TV noch zu klein/zu groß. */
  :global(html) { font-size: 20px; }

  /* Akzentfarben-Themes: In Tailwind v4 nutzen alle blue-Utilities CSS-Variablen.
     Wir überschreiben nur diese → die ganze Akzentfarbe wechselt, ohne 100+ Klassen
     anzufassen. Rot (Favorit) und Grün (gesehen) bleiben unberührt. Die Töne sind
     OLED-freundlich gewählt (kräftig, leicht entsättigt, gut auf tiefem Schwarz). */
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

  /* Splashscreen: Logo pulsiert sanft, Overlay blendet aus */
  .splash-logo { animation: splashPulse 1.6s ease-in-out infinite; }
  @keyframes splashPulse {
    0%, 100% { transform: scale(1);    opacity: 0.9; }
    50%      { transform: scale(1.07); opacity: 1; }
  }

  /* Animationen reduzieren — wird per data-reduce-motion auf body gesteuert */
  :global([data-reduce-motion="1"] *) {
    transition-duration: 0ms !important;
    animation-duration:  0ms !important;
  }
  /* backdrop-blur ist der teuerste GPU-Effekt — bei "Animationen reduzieren"
     deaktivieren, damit ältere/schwächere TVs flüssig bleiben. */
  :global([data-reduce-motion="1"] .backdrop-blur-sm),
  :global([data-reduce-motion="1"] .backdrop-blur-md),
  :global([data-reduce-motion="1"] .backdrop-blur-lg) {
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }
</style>

<main class="h-screen w-full bg-gray-900 text-white overflow-hidden relative">

  <!-- ============================================================
       SPLASHSCREEN — bis Auto-Login/Start abgeschlossen ist
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

  <!-- App-verlassen-Bestätigung (Zurück am Dashboard) -->
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
       PHASE: LOGIN — Server-Auswahl + Profilwahl.
       Lazy geladen: der Auto-Login-Pfad fasst den Chunk nie an.
       Flow-Zustand/-Logik leben komplett in components/Login.svelte;
       App behält session/selectedServer/users/savedServers/savedTokens.
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
          // Nur auffrischen, wenn der Nutzer das Speichern aktiviert hat (Eintrag existiert)
          if (savedTokens[sid]?.[uid]) { savedTokens[sid][uid] = token; persistSavedTokens(); }
        }}
        onSwitchServer={handleLogout}
        onDone={finishLogin}
      />
    {/await}

  <!-- ============================================================
       PHASE: HAUPT-APP
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
        onNavigate={(target) => { if (target === 'syncplay') { openSyncPlay(); } else { viewState = target; if (target !== 'favorites') focusMain(); } }}
        onNavigateLibrary={(lib) => navigateToLibrary(lib, true)}
        onSwitchUser={handleSwitchUser}
        onLogOutServer={handleLogout}
      />

      <div data-focus-group="main" class="flex-1 h-full overflow-y-auto hide-scrollbar bg-gray-900 relative">

        {#if viewState === 'dashboard'}
          {#key dashboardReloadKey}
          <Dashboard
            {selectedUser} {apiCache} {reduceAnimations}
            {resumeStale}
            onResumeRefreshed={() => resumeStale = false}
            showHero={displaySettings.hero}
            showLibraries={displaySettings.libraries}
            showHistory={displaySettings.history}
            showNextUp={displaySettings.nextUp}
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

        {:else if viewState === 'search'}
          <Search {selectedUser}
            onOpenDetails={(item) => showItemDetails(item)}
            onOpenPerson={(person) => openPerson(person)} />

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
          <Details
            item={currentDetailItem}
            {selectedUser} {playbackPrefs} {use24h} {serverVobSub}
            spoilerProtection={displaySettings.spoilerProtection}
            detailsBackdrop={displaySettings.detailsBackdrop}
            detailsLogo={displaySettings.detailsLogo}
            onClose={returnFromDetails}
            onOpenItemById={(id) => loadItemById(id)}
            onOpenPerson={(person) => openPerson(person)}
            onLibChanged={refreshLibraries}
            onPlayVideo={startPlayback}
          />

        {:else if viewState === 'person'}
          <Person person={currentPerson} {selectedUser}
            onBack={() => viewState = personReturnView}
            onOpenDetails={showItemDetails} onContextMenu={openContextMenu} />
        {:else if viewState === 'favorites'}
          <Favorites {selectedUser} reloadKey={favReloadKey}
            onOpenDetails={showItemDetails} onContextMenu={openContextMenu}
            onOpenPerson={openPerson} onFocusFallback={focusMain} />
        {:else if viewState === 'collection'}
          <Collection bind:this={collectionRef} collection={currentCollection} {selectedUser}
            onBack={() => viewState = collectionReturnView}
            onOpenDetails={showItemDetails} onContextMenu={openContextMenu}
            onChildCountChanged={onCollectionChildCount}
            onPlayVideo={(p) => { detailsOrigin = 'collection'; startPlayback(p); }}
            onPlayQueue={(qItems) => { playQueue = { items: qItems, index: 0 }; detailsOrigin = 'collection'; startPlayback({ item: qItems[0], audioIndex: -1, subtitleIndex: -1 }); }}
            onPlaylistRenamed={onCollectionRenamed}
            onPlaylistDeleted={onCollectionDeleted} />
        {/if}

        <!-- MEDIATHEK bleibt dauerhaft gemountet (versteckt, wenn inaktiv), damit Scroll/Items/das
             geladene Fenster beim Öffnen der Details erhalten bleiben — wie früher, als der State in App lag. -->
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
       PLAYER — absolutes Overlay (immer über allem)
  ============================================================ -->
  {#if appPhase === 'app' && viewState === 'player' && currentDetailItem}
    <div class="absolute inset-0 z-[100] bg-black w-full h-full">
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

  <!-- SYNCPLAY — Gruppen-Modal (über allem außer Screensaver) -->
  {#if showSyncPlay}
    {#await lazySyncPlay() then SyncPlayModal}
    <SyncPlayModal
      group={syncMyGroup}
      groups={syncGroups}
      loading={syncLoading}
      onCreate={syncCreate}
      onJoin={(groupId) => syncJoin(groupId)}
      onLeave={syncLeave}
      onRefresh={syncRefresh}
      onClose={closeSyncPlay}
    />
    {/await}
  {/if}

  <!-- KONTEXTMENÜ — über allem außer Screensaver -->
  {#if contextItem}
    <ContextMenu
      item={contextItem}
      userId={activeUserId}
      onClose={() => contextItem = null}
      onChanged={onContextChanged}
      onOpenDetails={contextOpenDetails}
      onAddToList={contextAddToList}
    />
  {/if}

  <!-- AddToPicker fürs Kontextmenü (Fokus kehrt nach dem Schließen zur Card zurück) -->
  <AddToPicker mode={contextPickerMode} item={contextPickerItem} {selectedUser} {getAuthHeaders}
    onCreated={refreshLibraries} onClose={() => contextPickerMode = null} />

  <!-- UHRZEIT — oben rechts in den App-Ansichten. Im Player NICHT dieses Overlay: der Player bringt
       seine EIGENE Uhr im HUD mit (nur bei eingeblendeter Steuerung, schont OLED), daher hier per
       viewState !== 'player' ausgenommen. -->
  {#if appPhase === 'app' && viewState !== 'player' && displaySettings.clock}
    <Clock {viewState} {use24h} />
  {/if}

  <!-- ADMIN-NACHRICHT — vom Jellyfin-Dashboard gesendet (DisplayMessage). Blendet sich selbst aus. -->
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
       SCREENSAVER — oberste Ebene
  ============================================================ -->
  {#if showScreensaver}
    <Screensaver {use24h} userId={activeUserId}
      mode={screensaverSettings.mode} artSource={screensaverSettings.artSource} brightness={screensaverSettings.brightness}
      onDismiss={resetActivity} />
  {/if}

</main>

