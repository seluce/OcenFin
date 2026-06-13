<script>
  import { onMount, tick } from 'svelte';
  import { fade } from 'svelte/transition';
  import { isBackKey, focusOnMount, itemProgress, connectionLost, longPress, personImageUrl, serverSupportsVobSub, authHeaders, dlog, setDebug, blurUp, itemBlurHash } from './utils.js';
  import { createFocusManager } from './spatialnav.js';
  import { currentLang, t, detectUiLang } from './i18n.js';
  import Clock       from './components/Clock.svelte';
  import Screensaver from './components/Screensaver.svelte';
  import Dashboard   from './components/Dashboard.svelte';
  import Sidebar     from './components/Sidebar.svelte';
  import Details     from './components/Details.svelte';
  import Player      from './components/Player.svelte';
  import ContextMenu from './components/ContextMenu.svelte';
  import Search      from './components/Search.svelte';
  import Settings    from './components/Settings.svelte';
  import SyncPlayModal from './components/SyncPlay.svelte';
  import { registerSession, listSyncGroups, createSyncGroup, joinSyncGroup, leaveSyncGroup, syncSocketUrl, setSyncIgnoreWait } from './syncplay.js';

  // ============================================================
  // APP PHASE
  // 'servers' → 'users' → 'app'
  // ============================================================
  let appPhase = 'servers';   // aktueller Schritt im Onboarding-Flow
  let initializing = true;    // Splashscreen, bis Auto-Login/Start abgeschlossen ist
  let dashboardReloadKey = 0; // erhöhen erzwingt frisches Neuladen des Dashboards

  // Cache leeren (Einstellungen): In-Memory-Cache verwerfen und Dashboard frisch laden.
  function clearCache() {
    apiCache.dashboard = null;
    apiCache.views = {};
    dashboardReloadKey++;
    viewState = 'dashboard';
  }

  // ============================================================
  // SERVER-VERWALTUNG
  // ============================================================
  let savedServers      = [];   // [{ id, url, name }]
  let selectedServer    = null; // aktuell verbundener Server
  let serverConnectError = '';
  let isConnecting      = false;
  let showAddServer     = false; // Panel "Neuen Server hinzufügen"

  // Discovery
  let isDiscovering      = false;
  let discoveredServers  = [];

  // Manuelle Eingabe im Add-Panel
  let newServerUrl       = '';

  // ============================================================
  // AUTH / BENUTZER
  // ============================================================
  let users            = [];
  let selectedUser     = null;
  let isLoggedIn       = false;
  let activeToken      = '';
  let serverVobSub     = false;   // liefert der Server VobSub/DVD extern als .mks? (Jellyfin 12.0+)
  let serverVersion    = '';      // Jellyfin-Serverversion (für die Status-Seite)
  let savedTokens      = {};  // { serverId: { userId: token } } — Schnellwechsel (nur über Profil-Schalter)
  let sharedTokens     = {};  // { serverId: { userId: token } } — gemeinsames Schauen, GETRENNT vom Schnellwechsel

  // Login-Unteransichten
  let showPasswordForm  = false;  // Passwort für ausgewähltes Profil
  let showManualLogin   = false;  // Manuelle Anmeldung (beliebiger Benutzer)
  let manualUsername    = '';
  let manualPassword    = '';
  let loginError        = '';
  let password          = '';     // Passwort für Profil-Login

  // Quick Connect (Login-Flow — TV zeigt Code, Handy scannt)
  let qcCode    = null;
  let qcSecret  = null;
  let qcPolling = null;

  const BASE_DEVICE_ID = 'oceonfin-tv-001';
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
    return `MediaBrowser Client="OcenFin-TV", Device="LG Smart TV", DeviceId="${deviceIdFor(name)}", Version="1.0.0"`;
  }
  // Basis-Header ohne Nutzerbezug — nur für Quick Connect, weil der Nutzer beim Initiate noch unbekannt ist.
  const CLIENT_AUTH_HEADER =
    `MediaBrowser Client="OcenFin-TV", Device="LG Smart TV", DeviceId="${BASE_DEVICE_ID}", Version="1.0.0"`;

  // Hilfreich: auf welchen User der aktuelle Server-Token zeigt
  $: serverUrl = selectedServer?.url ?? '';
  $: isCurrentUserSaved = !!(
    selectedUser && selectedServer &&
    savedTokens[selectedServer.id]?.[selectedUser.Id]
  );

  // ============================================================
  // ANIMATIONEN
  // ============================================================
  let reduceAnimations = false;

  // Anzeige-Elemente (Uhr, Hero-Banner, Episodenanzahl, Mediatheken) — einzeln abschaltbar
  let displaySettings = { clock: true, hero: true, episodeCount: true, libraries: true, history: true, nextUp: true, recommendations: true, latest: true, collections: true, sharedSuggestions: true, backdropPreview: true, spoilerProtection: true, showChapters: true, clockFormat: 'auto', uiSize: 'medium', theme: 'blue', showLogo: true, recommendationRows: 1, seekStep: 30, navOrder: [], navHidden: [], navIcons: {} };

  // Standard-Audio-/Untertitelsprache
  let playbackPrefs = { audioLanguage: 'default', subtitleLanguage: 'default', autoSkipIntro: false, autoSkipCredits: false, subtitleSize: 'normal', autoPlayNext: true, burnSubtitles: false, pgsRendering: true, assRendering: true, forcedGraphicSubs: true, stillWatching: true, stillWatchingEpisodes: 3 };

  // ── Profil-bezogene Einstellungen ───────────────────────────
  // Sprache + Anzeige + Wiedergabe + Animationen werden PRO BENUTZER gespeichert.
  // Vor dem Login (Server-/Benutzerauswahl) gibt es noch kein Profil — dort gilt
  // die zuletzt gewählte Gerätesprache ('app_language'). Der Bildschirmschoner
  // bleibt geräteweit (schützt das physische OLED-Panel, benutzerunabhängig).
  let activeUserId = null;
  let langValue    = 'de';
  let prefsReady   = false;   // verhindert Speichern während des initialen Ladens
  let applyingPrefs = false;  // verhindert Speichern WÄHREND applyUserPrefs (sonst halb-fertiger Zustand)

  // Sprachänderungen (auch aus den Einstellungen) zentral persistieren
  currentLang.subscribe(v => {
    langValue = v;
    if (!prefsReady || applyingPrefs) return;
    localStorage.setItem('app_language', v);   // Gerätesprache für Vor-Login-Screens
    saveUserPrefs();                            // + im aktiven Profil sichern
  });

  // 12h/24h-Format für beide Uhren (oben rechts + Screensaver).
  // "auto" folgt der Sprache: Deutsch → 24h, Englisch → 12h. Überschreibbar.
  $: use24h = displaySettings.clockFormat === '24h' ? true
            : displaySettings.clockFormat === '12h' ? false
            : langValue !== 'en';

  // Sicherheitsnetz: Greifen-Sperre nie über die Einstellungen hinaus aktiv lassen.
  $: if (viewState !== 'settings' && navReordering) navReordering = false;

  function userPrefsKey(userId) { return `user_prefs_${userId}`; }

  function loadUserPrefs(userId) {
    try { return JSON.parse(localStorage.getItem(userPrefsKey(userId)) || '{}'); } catch { return {}; }
  }

  function saveUserPrefs() {
    if (!activeUserId || applyingPrefs) return;
    localStorage.setItem(userPrefsKey(activeUserId), JSON.stringify({
      language: langValue,
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
      currentLang.set(p.language);
      localStorage.setItem('app_language', p.language);   // "zuletzt genutzt" aktualisieren
    }
    displaySettings  = { clock: true, hero: true, episodeCount: true, libraries: true, history: true, nextUp: true, recommendations: true, latest: true, collections: true, sharedSuggestions: true, backdropPreview: true, spoilerProtection: true, showChapters: true, clockFormat: 'auto', uiSize: 'medium', theme: 'blue', showLogo: true, recommendationRows: 1, seekStep: 30, navOrder: [], navHidden: [], navIcons: {}, ...(p.displaySettings || {}) };
    playbackPrefs    = { audioLanguage: 'default', subtitleLanguage: 'default', autoSkipIntro: false, autoSkipCredits: false, subtitleSize: 'normal', autoPlayNext: true, burnSubtitles: false, pgsRendering: true, assRendering: true, forcedGraphicSubs: true, stillWatching: true, stillWatchingEpisodes: 3, ...(p.playbackPrefs || {}) };
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
    sharedWatchMode  = false;   // Filter startet pro Sitzung aus
    partnersPlayedIds = null;
    applyingPrefs = false;
  }

  $: {
    if (typeof document !== 'undefined') {
      document.body.dataset.reduceMotion = reduceAnimations ? '1' : '0';
    }
  }

  // Darstellung anwenden — leichtgewichtig über CSS: die Root-Schriftgröße skaliert die
  // gesamte Oberfläche (Tailwind rechnet in rem), data-theme schaltet die Akzentfarbe.
  // Läuft reaktiv bei jeder Änderung von displaySettings (Login, Umschalten, Start).
  $: if (typeof document !== 'undefined') {
    const sizes = { small: '16px', medium: '20px', large: '24px' };
    document.documentElement.style.fontSize = sizes[displaySettings.uiSize] || '20px';
    document.documentElement.setAttribute('data-theme', displaySettings.theme || 'blue');
  }

  function onReduceAnimationsChange(e) {
    reduceAnimations = e.detail;
    saveUserPrefs();
  }

  function onDisplayChange(e) {
    displaySettings = e.detail;
    saveUserPrefs();
  }

  function onPlaybackPrefsChange(e) {
    playbackPrefs = e.detail;
    saveUserPrefs();
  }

  let screensaverSettings = { enabled: true, timeout: 90, mode: 'clock', artSource: 'watched', brightness: 0.45 };
  let showScreensaver     = false;
  let screensaverTimer    = null;

  // Screensaver nur im App-Betrieb und nicht während der Wiedergabe
  $: {
    if (appPhase !== 'app' || viewState === 'player') {
      if (screensaverTimer) { clearTimeout(screensaverTimer); screensaverTimer = null; }
      showScreensaver = false;
    }
  }

  function scheduleScreensaver() {
    if (screensaverTimer) clearTimeout(screensaverTimer);
    if (!screensaverSettings.enabled || appPhase !== 'app' || viewState === 'player') return;
    screensaverTimer = setTimeout(() => { showScreensaver = true; }, screensaverSettings.timeout * 1000);
  }

  function resetActivity() {
    if (showScreensaver) showScreensaver = false;
    scheduleScreensaver();
  }

  function onScreensaverSettingsChange(e) {
    screensaverSettings = e.detail;
    localStorage.setItem('screensaver_settings', JSON.stringify(screensaverSettings));
    scheduleScreensaver();
  }

  // ============================================================
  // NAVIGATION (App-intern)
  // ============================================================
  let viewState          = 'dashboard';
  let currentItems       = [];
  let currentDetailItem  = null;
  let currentLibraryName         = '';
  let currentLibraryId           = null;
  let navLibraries               = [];    // echte Mediatheken fürs Menü (vom Dashboard gemeldet)
  let navReordering              = false;  // true während ein Sidebar-Eintrag „angehoben" ist
  let totalLibraryItems          = 0;
  let isFetchingMore     = false;
  let isLoading          = false;
  const libraryItemLimit = 50;

  let activeAudioIndex    = -1;
  let activeSubtitleIndex = -1;
  let activeMediaSourceId = null;   // gewählte Version (FullHD/4K), aus Details
  let autoPlayStreak = 0;           // "Schaust du noch?": automatisch abgespielte Folgen in Folge ohne Interaktion

  // A-Z
  let activeLetter    = '#';
  let currentLetter   = '';
  const alphabet = ['#','A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z'];
  let libraryScrollContainer;
  let libraryGrid;

  // A-Z Sprung-Vorschau (großes Buchstaben-Overlay, iOS-Kontakte-Stil)
  let jumpLetterOverlay = '';
  let jumpOverlayTimer;
  function showJumpLetter(letter) {
    jumpLetterOverlay = letter;
    clearTimeout(jumpOverlayTimer);
    jumpOverlayTimer = setTimeout(() => { jumpLetterOverlay = ''; }, 800);
  }

  // Backdrop-Vorschau: blendet nach 700ms Fokus auf einer Karte das Backdrop ein.
  // 700ms ist der Sweet Spot — löst beim schnellen Durchscrollen nicht aus,
  // bleibt aber reaktiv. Eine einzige geteilte <img>-Ebene, moderate Auflösung.
  let previewBackdrop = '';
  let previewTimer;
  function previewItem(item) {
    if (!displaySettings.backdropPreview) return;   // eigene Einstellung (nicht an "Animationen reduzieren" gekoppelt)
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      const tag = item.BackdropImageTags?.[0];
      const pTag = item.ParentBackdropImageTags?.[0];
      if (tag)       previewBackdrop = `${serverUrl}/Items/${item.Id}/Images/Backdrop?tag=${tag}&maxWidth=1280&quality=70&format=webp`;
      else if (pTag) previewBackdrop = `${serverUrl}/Items/${item.ParentBackdropItemId}/Images/Backdrop?tag=${pTag}&maxWidth=1280&quality=70&format=webp`;
    }, 700);
  }
  function cancelPreview() {
    clearTimeout(previewTimer);
  }

  // Position merken: woher wurde Details geöffnet + Scroll/Fokus in der Bibliothek
  let detailsOrigin      = 'dashboard';   // 'dashboard' | 'library' | 'search'
  let savedLibraryScroll = 0;
  let lastFocusedItemId  = null;

  // Filter
  let showFilterMenu  = false;
  let activeFilters   = { isFavorite: false, isPlayed: false, isNotPlayed: false };
  let availableGenres = [];
  let selectedGenres  = [];
  let selectedFsk     = [];
  const fskOptions    = ['0','6','12','16','18'];
  $: hasFilters = activeFilters.isFavorite || activeFilters.isPlayed || activeFilters.isNotPlayed
                  || selectedGenres.length > 0 || selectedFsk.length > 0;

  // ── Gemeinsames Schauen ────────────────────────────────────────────────────
  // Das eingeloggte (Gemeinsam-)Profil referenziert zwei andere Profile. Deren Tokens
  // liegen in savedTokens (gekoppelt an "Token speichern"); hier nur ID + Name gemerkt.
  let sharedProfile     = { enabled: false, members: [] };  // members: [{ id, name }]
  let sharedWatchMode   = false;   // Bibliotheks-Filter "Gemeinsam schauen" aktiv
  let partnersPlayedIds = null;    // Set: von BEIDEN komplett gesehene Item-IDs (aktuelle Bibliothek)
  $: sharedReady = sharedProfile.enabled
                   && sharedProfile.members.filter(m => m && m.id).length >= 1;
  // Aufräumen: Option an, aber kein Profil hinterlegt → beim Verlassen der Einstellungen wieder aus.
  $: if (viewState !== 'settings' && sharedProfile.enabled
         && sharedProfile.members.filter(m => m && m.id).length === 0) {
    sharedProfile = { ...sharedProfile, enabled: false };
    saveUserPrefs();
  }
  // Token eines Mitglieds: eigener Shared-Speicher zuerst, sonst (falls der Nutzer den
  // Schnellwechsel selbst aktiviert hat) der Schnellwechsel-Speicher.
  function memberToken(m) {
    const sid = selectedServer?.id;
    return m && (sharedTokens[sid]?.[m.id] || savedTokens[sid]?.[m.id]);
  }
  // Bibliotheks-Grid: im "Gemeinsam schauen"-Modus alles ausblenden, was beide gesehen haben
  $: visibleLibraryItems = (sharedWatchMode && partnersPlayedIds)
                           ? currentItems.filter(i => !partnersPlayedIds.has(i.Id))
                           : currentItems;
  // Profil-Liste für die Einrichtung bereitstellen, falls noch nicht geladen
  $: if (viewState === 'settings' && users.length === 0 && serverUrl) fetchUsers();

  // ── Gemeinsame Vorschläge (Dashboard-Reihe „Für euch beide") ───────────────
  let sharedSuggestions = [];
  let _loadedSugKey     = null;
  $: sharedSugKey = (sharedReady && displaySettings.sharedSuggestions)
                    ? sharedProfile.members.filter(m => m?.id).map(m => m.id).join('|') : '';
  $: if (!sharedSugKey && sharedSuggestions.length) sharedSuggestions = [];
  $: if (viewState === 'dashboard' && sharedSugKey && sharedSugKey !== _loadedSugKey) loadSharedSuggestions();

  // ── SyncPlay (Gruppen-Wiedergabe) — Phase 1: Gruppen verwalten ─────────────
  let showSyncPlay = false;
  let syncMyGroup  = null;    // { GroupId, GroupName, Participants } oder null
  let syncGroups   = [];      // verfügbare Gruppen (ohne meine eigene)
  let syncLoading  = false;
  let syncPollTimer = null;
  let syncJoined   = false;   // ist DIESE Sitzung in einer Gruppe? (maßgeblich, nicht der Profilname)
  let syncMyGroupId = null;   // GroupId der eigenen Gruppe (vom Socket-GroupJoined bzw. beim Beitreten gesetzt)
  // Phase 2: empfangene Wiedergabe-Kommandos + aktueller Gruppen-Queue-Stand (an den Player weitergereicht)
  let syncCommand = null;   // letztes SyncPlayCommand { ...Data, _seq }
  let syncCmdSeq  = 0;
  let syncQueue   = null;   // { itemId, playlistItemId, positionTicks, isPlaying }

  // Admin-Fernsteuerung (Jellyfin-Dashboard): Playstate/GeneralCommand über dieselbe WebSocket.
  let remoteCommand = null;   // { command, seekTicks?, args?, _seq } → an den Player
  let remoteCmdSeq  = 0;
  let remoteMessage = null;   // { header, text } – Admin-Nachricht als Overlay
  let remoteMessageTimer = null;
  function showRemoteMessage(header, text, timeoutMs) {
    // Jellyfins Standard-Header ("Message from Server") oder leerer Header → lokalisieren.
    // Einen eigenen Header des Admins unverändert übernehmen.
    const h = (header || '').trim();
    const localized = (!h || h.toLowerCase() === 'message from server') ? $t.messageFromServer : h;
    remoteMessage = { header: localized, text: text || '' };
    if (remoteMessageTimer) clearTimeout(remoteMessageTimer);
    const ms = timeoutMs && timeoutMs > 0 ? Math.min(timeoutMs, 30000) : 7000;
    remoteMessageTimer = setTimeout(() => { remoteMessage = null; }, ms);
  }
  function dismissRemoteMessage() { if (remoteMessageTimer) clearTimeout(remoteMessageTimer); remoteMessage = null; }
  let _lastSyncQueueItem = null;   // zuletzt automatisch geöffnetes Gruppen-Item (kein erneutes Öffnen nach Verlassen)
  let _syncOpeningId = null;       // gerade im Öffnen befindlich (verhindert Doppel-Öffnen)
  async function syncRefresh() {
    if (!serverUrl || !activeToken) return;
    syncLoading = true;
    const all = await listSyncGroups(serverUrl, activeToken);
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
  async function syncCreate() { await createSyncGroup(serverUrl, activeToken, selectedUser?.Name || 'OcenFin'); syncJoined = true; await setSyncIgnoreWait(serverUrl, activeToken, false); await syncRefresh(); }
  async function syncJoin(groupId) { await joinSyncGroup(serverUrl, activeToken, groupId); syncJoined = true; syncMyGroupId = groupId; await setSyncIgnoreWait(serverUrl, activeToken, false); await syncRefresh(); }
  async function syncLeave() { await leaveSyncGroup(serverUrl, activeToken); syncJoined = false; syncMyGroupId = null; syncQueue = null; _lastSyncQueueItem = null; await syncRefresh(); }

  // Auto-Laden: Item, das die Gruppe spielt, programmatisch im Player öffnen (springt per Ready→Unpause an die Gruppenposition).
  async function openItemInPlayer(itemId) {
    if (!itemId) return;
    const norm = (s) => (s || '').replace(/-/g, '');
    if (viewState === 'player' && norm(currentDetailItem?.Id) === norm(itemId)) return;  // läuft bereits
    if (_syncOpeningId === norm(itemId)) return;                                          // gerade am Öffnen
    _syncOpeningId = norm(itemId);
    try {
      const res = await fetch(`${serverUrl}/Users/${selectedUser.Id}/Items/${itemId}`, { headers: getAuthHeaders() });
      if (res.ok) {
        currentDetailItem   = await res.json();
        activeAudioIndex    = -1;
        activeSubtitleIndex = -1;
        activeMediaSourceId = null;
        viewState = 'player';
        dlog('[SyncPlay] Auto-Laden →', currentDetailItem?.Name);
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
    if (!serverUrl || !activeToken) return;
    if (syncSocket && (syncSocket.readyState === WebSocket.OPEN || syncSocket.readyState === WebSocket.CONNECTING)) return;
    let ws;
    try { ws = new WebSocket(syncSocketUrl(serverUrl, activeToken, deviceIdFor(selectedUser?.Name))); }
    catch (e) { console.warn('[SyncPlay] Socket konnte nicht geöffnet werden', e); return; }
    syncSocket = ws;
    ws.onopen = () => {
      dlog('[SyncPlay] Socket verbunden');
      if (syncKeepAlive) clearInterval(syncKeepAlive);
      syncKeepAlive = setInterval(() => { try { ws.send(JSON.stringify({ MessageType: 'KeepAlive' })); } catch {} }, 30000);
    };
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      handleSyncMessage(msg);
    };
    ws.onclose = () => {
      if (syncKeepAlive) { clearInterval(syncKeepAlive); syncKeepAlive = null; }
      dlog('[SyncPlay] Socket getrennt');
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
      dlog('[SyncPlay] Kommando empfangen', syncCommand.Command, syncCommand.PositionTicks);
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
  $: if (isLoggedIn && activeToken && serverUrl && !syncSocketWanted) {
    registerSession(serverUrl, activeToken);   // Sitzung als steuerbar registrieren (für SyncPlay)
    connectSyncSocket();                        // SyncPlay-Echtzeitkanal öffnen
  }

  // Sortierung
  let showSortMenu = false;
  let showExitConfirm = false;   // Bestätigungsdialog "App verlassen?" (Zurück am Dashboard)
  let currentSort  = { by: 'SortName', order: 'Ascending' };
  let librarySorts = {};   // pro Bibliothek gemerkte Sortierung (im Profil gespeichert)
  const sortOptions = [
    { by: 'SortName',        order: 'Ascending',  key: 'sortName' },
    { by: 'DateCreated',     order: 'Descending', key: 'sortDateAdded' },
    { by: 'PremiereDate',    order: 'Descending', key: 'sortReleaseYear' },
    { by: 'CommunityRating', order: 'Descending', key: 'sortRating' },
    { by: 'Random',          order: 'Ascending',  key: 'sortRandom' },
  ];
  // Cache nur für die Standardansicht (Name aufsteigend) — andere Sortierungen
  // bypassen den Cache wie Filter. A-Z-Leiste ergibt nur bei Namenssortierung Sinn.
  $: isDefaultSort = currentSort.by === 'SortName' && currentSort.order === 'Ascending';

  // Synchrone Variante für loadLibraryItems: die reaktive `hasFilters` wird erst
  // im nächsten Tick aktualisiert — beim sofortigen Aufruf nach toggleFilter wäre
  // sie noch veraltet und der Cache (ungefiltert) würde fälschlich zurückgegeben.
  function currentlyHasFilters() {
    return activeFilters.isFavorite || activeFilters.isPlayed || activeFilters.isNotPlayed
           || selectedGenres.length > 0 || selectedFsk.length > 0;
  }

  // Synchron (gleicher Tick-Grund wie currentlyHasFilters)
  function currentlyDefaultSort() {
    return currentSort.by === 'SortName' && currentSort.order === 'Ascending';
  }

  // Nur Standardansicht (Name aufsteigend, keine Filter, kein Buchstabe) wird gecacht
  function isCacheableView() {
    return !currentLetter && !currentlyHasFilters() && currentlyDefaultSort();
  }

  function setSort(option) {
    if (currentSort.by === option.by && option.by !== 'Random') {
      // Gleiche Sortierung erneut → Richtung umkehren (auf-/absteigend)
      currentSort = { by: option.by, order: currentSort.order === 'Ascending' ? 'Descending' : 'Ascending' };
    } else {
      currentSort = { by: option.by, order: option.order };
    }
    showSortMenu = false;
    // Bei Sortierwechsel A-Z zurücksetzen (Leiste ergibt nur bei Namenssortierung Sinn)
    if (currentSort.by !== 'SortName') { currentLetter = ''; activeLetter = '#'; }
    // Sortierung für diese Bibliothek im Profil merken
    if (currentLibraryId) { librarySorts[currentLibraryId] = { ...currentSort }; saveUserPrefs(); }
    loadLibraryItems({ Id: currentLibraryId, Name: currentLibraryName }, null);
  }

  // Bibliotheks-Cache mit Größenbegrenzung (LRU): höchstens 5 Bibliotheken halten,
  // damit der Speicher bei vielen besuchten Bibliotheken nicht unbegrenzt wächst.
  const MAX_CACHED_VIEWS = 5;
  function cacheLibraryView(libraryId, data) {
    // Bereits vorhandenen Eintrag entfernen, dann neu ans Ende setzen (= zuletzt genutzt)
    delete apiCache.views[libraryId];
    const keys = Object.keys(apiCache.views);
    if (keys.length >= MAX_CACHED_VIEWS) delete apiCache.views[keys[0]];  // ältesten verwerfen
    apiCache.views[libraryId] = data;
  }

  let apiCache = { dashboard: null, views: {} };

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
    if (selectedServer && selectedUser && activeToken) {
      localStorage.setItem('current_session', JSON.stringify({
        serverId: selectedServer.id,
        userId:   selectedUser.Id,
        token:    activeToken
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
    currentLang.set(detectUiLang());
    prefsReady = true;   // ab jetzt werden Änderungen persistiert

    // Globale Back-Taste (WebOS Fernbedienung)
    window.addEventListener('keydown', handleGlobalBack);
    // D-Pad-Navigation (Gruppen-Fokus-Modell) — überall aktiv. Der Player ist eine
    // eigene Fokus-Gruppe; sein Schieberegler verarbeitet Links/Rechts selbst.
    createFocusManager(() => !navReordering);
    // Netzwerkstatus überwachen (Banner bei Verbindungsverlust)
    window.addEventListener('offline', () => connectionLost.set(true));
    window.addEventListener('online',  () => connectionLost.set(false));

    try {
      // Auto-Login via gespeicherter Session
      const sessionStr = localStorage.getItem('current_session');
      dlog('[restore] current_session vorhanden:', !!sessionStr);
      if (sessionStr) {
        try {
          const session = JSON.parse(sessionStr);
          const server  = savedServers.find(s => s.id === session.serverId);
          dlog('[restore] Server gefunden:', !!server, '| Token:', !!session.token, '| userId:', !!session.userId);
          if (server && session.token && session.userId) {
            selectedServer = server;
            activeToken    = session.token;

            if (await validateToken(session.token, server.url)) {
              const res = await fetch(`${server.url}/Users/${session.userId}`, {
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
                dlog('[restore] Auto-Login erfolgreich:', selectedUser.Name);
                return;
              }
            }
            // Token abgelaufen → User-Screen für diesen Server
            dlog('[restore] Token ungültig → zurück zum Benutzer-Screen');
            clearCurrentSession();
            await connectToServer(server);
            return;
          }
        } catch (e) { dlog('[restore] Fehler beim Wiederherstellen:', e?.message || e); clearCurrentSession(); }
      }

      // Kein Auto-Login → Server-Auswahl anzeigen
      dlog('[restore] kein Auto-Login → Server-Auswahl');
      appPhase = 'servers';
    } finally {
      initializing = false;   // Splashscreen ausblenden (egal welcher Pfad)
    }
  });

  // ============================================================
  // SERVER DISCOVERY
  // ============================================================

  async function getLocalIpViaWebRTC() {
    return new Promise((resolve) => {
      try {
        const pc = new RTCPeerConnection({ iceServers: [] });
        pc.createDataChannel('');
        pc.createOffer().then(o => pc.setLocalDescription(o));
        pc.onicecandidate = (e) => {
          if (!e?.candidate) { pc.close(); resolve(null); return; }
          const m = /([0-9]{1,3}(\.[0-9]{1,3}){3})/.exec(e.candidate.candidate);
          if (m && !m[1].startsWith('127.')) { pc.close(); resolve(m[1]); }
        };
      } catch { resolve(null); }
      setTimeout(() => resolve(null), 3000);
    });
  }

  async function tryJellyfinServer(url) {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    try {
      const res = await fetch(`${url}/System/Info/Public`, { signal: ctrl.signal });
      if (res.ok) {
        const data = await res.json();
        return { url, name: data.ServerName || 'Jellyfin Server' };
      }
    } catch { } finally { clearTimeout(timer); }
    return null;
  }

  async function discoverJellyfinServers() {
    isDiscovering     = true;
    discoveredServers = [];

    const candidates = new Set([
      'http://jellyfin.local:8096',
      'https://jellyfin.local:8920',
      'http://localhost:8096',
    ]);

    const localIp = await getLocalIpViaWebRTC();
    if (localIp) {
      const subnet = localIp.split('.').slice(0, 3).join('.');
      for (const h of [1, 2, 3, 10, 50, 100, 101, 150, 200, 201, 250]) {
        if (!localIp.endsWith(`.${h}`)) candidates.add(`http://${subnet}.${h}:8096`);
      }
    } else {
      for (const s of ['192.168.0','192.168.1','192.168.2','10.0.0','10.0.1']) {
        for (const h of [1, 2, 100, 101]) candidates.add(`http://${s}.${h}:8096`);
      }
    }

    const results = await Promise.allSettled([...candidates].map(tryJellyfinServer));
    discoveredServers = results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value)
      .filter(d => !savedServers.find(s => s.url === d.url)); // bereits gespeicherte rausfiltern

    isDiscovering = false;
  }

  // ============================================================
  // SERVER VERBINDEN / HINZUFÜGEN
  // ============================================================

  async function connectToServer(server) {
    selectedServer     = server;
    serverConnectError = '';
    isConnecting       = true;
    users              = [];
    loginError         = '';
    showPasswordForm   = false;
    showManualLogin    = false;

    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const res   = await fetch(`${server.url}/System/Info/Public`, { signal: ctrl.signal });
      clearTimeout(timer);

      if (res.ok) {
        const data = await res.json();
        // Servernamen aktualisieren wenn geändert
        if (data.ServerName && data.ServerName !== server.name) {
          server.name    = data.ServerName;
          savedServers   = savedServers.map(s => s.id === server.id ? { ...s, name: data.ServerName } : s);
          persistSavedServers();
        }
        await fetchUsers();
        appPhase     = 'users';
        showAddServer = false;
      } else {
        serverConnectError = $t.errInvalid;
      }
    } catch {
      serverConnectError = $t.errOffline;
    } finally {
      isConnecting = false;
    }
  }

  async function addAndConnectServer(url) {
    if (!url.trim()) return;
    const cleanUrl = url.trim().replace(/\/$/, '');

    // Schon vorhanden?
    const existing = savedServers.find(s => s.url === cleanUrl);
    if (existing) { await connectToServer(existing); return; }

    // Neuer Server: testen, dann speichern
    serverConnectError = '';
    isConnecting       = true;
    try {
      const ctrl  = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 6000);
      const res   = await fetch(`${cleanUrl}/System/Info/Public`, { signal: ctrl.signal });
      clearTimeout(timer);

      if (res.ok) {
        const data   = await res.json();
        const server = { id: 'srv_' + Date.now(), url: cleanUrl, name: data.ServerName || 'Jellyfin Server' };
        savedServers = [...savedServers, server];
        persistSavedServers();
        await connectToServer(server);
        newServerUrl = '';
      } else {
        serverConnectError = $t.errInvalid;
      }
    } catch {
      serverConnectError = $t.errOffline;
    } finally {
      isConnecting = false;
    }
  }

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

  const getAuthHeaders = () => authHeaders(activeToken);

  async function fetchUsers() {
    try {
      const res = await fetch(`${serverUrl}/Users/Public`);
      if (res.ok) users = await res.json();
    } catch { }
  }

  // ── Gemeinsames Schauen: Mitglieder & Datenbasis ───────────────────────────
  function toggleSharedEnabled() {
    sharedProfile = { ...sharedProfile, enabled: !sharedProfile.enabled };
    if (!sharedProfile.enabled) { sharedWatchMode = false; partnersPlayedIds = null; }
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
        const res = await fetch(`${serverUrl}/Users/AuthenticateByName`, {
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
    if (sharedWatchMode) loadPartnersPlayedIds(currentLibraryId);
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
    if (sharedWatchMode) loadPartnersPlayedIds(currentLibraryId);
  }

  // Vereinigung der von den Mitgliedern komplett gesehenen Top-Level-Titel der Bibliothek.
  // Jedes Profil mit eigenem Token (kein Admin). Wir holen alle Titel mit UserData und prüfen
  // selbst auf Played=true — zuverlässiger als Filters=IsPlayed, das bei Serien nicht immer greift.
  async function loadPartnersPlayedIds(libraryId) {
    partnersPlayedIds = null;
    if (!sharedWatchMode || !sharedReady || !libraryId) return;
    const ids = new Set();
    for (const m of sharedProfile.members) {
      if (!m || !m.id) continue;
      const token = memberToken(m);
      if (!token) { console.warn('[Gemeinsam] Kein gültiger Token für', m.name, '– Profil neu hinterlegen.'); continue; }
      try {
        const res = await fetch(
          `${serverUrl}/Users/${m.id}/Items?ParentId=${libraryId}&Recursive=true` +
          `&IncludeItemTypes=Movie,Series&Fields=UserData&EnableImages=false` +
          `&Limit=100000&EnableTotalRecordCount=false`,
          { headers: { 'Authorization': `MediaBrowser Token="${token}"`, 'Content-Type': 'application/json' } }
        );
        if (!res.ok) { console.warn('[Gemeinsam] Abfrage fehlgeschlagen für', m.name, '· HTTP', res.status); continue; }
        let n = 0;
        (await res.json()).Items?.forEach(i => { if (i.UserData?.Played) { ids.add(i.Id); n++; } });
        dlog('[Gemeinsam]', m.name, '→', n, 'komplett gesehene Titel');
      } catch (e) { console.warn('[Gemeinsam] Fehler für', m.name, e); }
    }
    partnersPlayedIds = ids;
  }

  function toggleSharedWatch() {
    sharedWatchMode = !sharedWatchMode;
    if (sharedWatchMode) loadPartnersPlayedIds(currentLibraryId);
    else partnersPlayedIds = null;
  }

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
          `${serverUrl}/Users/${m.id}/Items?Recursive=true&IncludeItemTypes=Movie,Series` +
          `&Fields=Genres,CommunityRating,UserData&EnableImageTypes=Primary&Limit=100000&EnableTotalRecordCount=false`,
          { headers: { 'Authorization': `MediaBrowser Token="${token}"`, 'Content-Type': 'application/json' } }
        );
        if (!res.ok) continue;
        const items = (await res.json()).Items || [];
        const genreCount = {}; const watched = new Set();
        for (const it of items) {
          if (it.UserData?.Played) {
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
      .slice(0, 20)
      .map(x => ({ ...x.it, UserData: {} }));   // UserData leeren → kein Fortschrittsbalken eines Mitglieds
    dlog('[Gemeinsam] Vorschläge:', sharedSuggestions.length);
  }

  // baseUrl explizit übergebbar: beim Auto-Login ist der reaktive serverUrl ($:) noch nicht
  // aktualisiert (Svelte flusht Reaktivität erst nach dem synchronen Block), daher würde
  // `${serverUrl}` dort auf '' zeigen → relativer Fetch auf die App-Origin statt auf den Server.
  async function validateToken(token, baseUrl = serverUrl) {
    try {
      const res = await fetch(`${baseUrl}/Users/Me`, {
        headers: { "Authorization": `MediaBrowser Token="${token}"` }
      });
      if (!res.ok) dlog('[auth] Token-Validierung fehlgeschlagen — HTTP', res.status);
      return res.ok;
    } catch (e) { dlog('[auth] Token-Validierung — Netzwerkfehler:', e?.message || e); return false; }
  }

  /** Profil angeklickt — ggf. Schnellanmeldung per gespeichertem Token */
  async function handleUserClick(user) {
    loginError       = '';
    password         = '';
    selectedUser     = user;
    showManualLogin  = false;

    if (!user.HasPassword) {
      await authenticateUser(user.Name, '');
      return;
    }

    const storedToken = savedTokens[selectedServer.id]?.[user.Id];
    if (storedToken) {
      if (await validateToken(storedToken)) {
        activeToken = storedToken;
        finishLogin(user, storedToken);
        return;
      } else {
        // Token abgelehnt: Eintrag NICHT löschen — er steht für den Speicher-Wunsch des Nutzers.
        // authenticateUser überschreibt ihn nach erfolgreicher Passwort-Anmeldung mit dem frischen
        // Token. (Früher wurde hier gelöscht, wodurch sich der Schnellwechsel nach einem einzigen
        // Token-Ablauf still selbst abschaltete.)
        dlog('[auth] gespeicherter Token abgelehnt für', user.Name, '— Speicher-Wunsch bleibt, wird nach Passwort-Login erneuert');
      }
    }

    // Passwort-Eingabe anzeigen
    showPasswordForm = true;
  }

  async function authenticateUser(username, pw) {
    loginError = '';
    try {
      const res = await fetch(`${serverUrl}/Users/AuthenticateByName`, {
        method:  "POST",
        headers: { "Content-Type": "application/json", "Authorization": authHeaderFor(username) },
        body:    JSON.stringify({ Username: username, Pw: pw })
      });
      if (res.ok) {
        const data = await res.json();
        // Gespeicherten Token aktualisieren wenn Speichern aktiv
        if (savedTokens[selectedServer.id]?.[data.User.Id]) {
          savedTokens[selectedServer.id][data.User.Id] = data.AccessToken;
          persistSavedTokens();
        }
        finishLogin(data.User, data.AccessToken);
      } else {
        loginError = $t.errLogin;
      }
    } catch { loginError = $t.errOffline; }
  }

  function finishLogin(user, token) {
    selectedUser = user;
    activeToken  = token;
    isLoggedIn   = true;
    appPhase     = 'app';
    applyUserPrefs(user.Id);   // Profil-Einstellungen laden
    showPasswordForm = false;
    showManualLogin  = false;
    manualUsername   = '';
    manualPassword   = '';
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
      const res = await fetch(`${serverUrl}/System/Info/Public`);
      if (res.ok) {
        const info = await res.json();
        serverVersion = info?.Version || '';
        serverVobSub = serverSupportsVobSub(info?.Version);
      }
    } catch {}
    dlog('[OcenFin] Server-Capabilities:', { version: serverVersion || '(unbekannt)', vobSub: serverVobSub });
  }

  // Quick Connect — Login-Flow (Code auf TV, Handy scannt)
  async function startQuickConnect() {
    loginError = '';
    showPasswordForm = false;
    showManualLogin  = false;
    try {
      const res = await fetch(`${serverUrl}/QuickConnect/Initiate`, {
        headers: { "Authorization": CLIENT_AUTH_HEADER }
      });
      if (res.ok) {
        const data = await res.json();
        qcCode   = data.Code;
        qcSecret = data.Secret;
        qcPolling = setInterval(async () => {
          try {
            const poll = await fetch(`${serverUrl}/QuickConnect/Connect?Secret=${qcSecret}`, {
              headers: { "Authorization": CLIENT_AUTH_HEADER }
            });
            const pd   = await poll.json();
            if (pd.Authenticated) {
              clearInterval(qcPolling);
              const authRes = await fetch(`${serverUrl}/Users/AuthenticateWithQuickConnect`, {
                method:  "POST",
                headers: { "Content-Type": "application/json", "Authorization": CLIENT_AUTH_HEADER },
                body:    JSON.stringify({ Secret: qcSecret })
              });
              if (authRes.ok) {
                const authData = await authRes.json();
                qcCode = null;
                finishLogin(authData.User, authData.AccessToken);
              }
            }
          } catch { }
        }, 3000);
      } else {
        loginError = $t.qcError;
      }
    } catch { loginError = $t.networkError; }
  }

  function cancelQuickConnect() {
    clearInterval(qcPolling);
    qcCode = qcSecret = null;
  }

  function toggleCurrentUserSave() {
    if (!selectedUser || !selectedServer) return;
    const sid = selectedServer.id;
    if (!savedTokens[sid]) savedTokens[sid] = {};
    if (savedTokens[sid][selectedUser.Id]) {
      delete savedTokens[sid][selectedUser.Id];
    } else {
      savedTokens[sid][selectedUser.Id] = activeToken;
    }
    savedTokens = { ...savedTokens };
    persistSavedTokens();
  }

  /** Zurück zum Benutzer-Screen (behält Server-Verbindung) */
  function handleSwitchUser() {
    isLoggedIn       = false;
    selectedUser     = null;
    activeToken      = '';
    password         = '';
    loginError       = '';
    showPasswordForm = false;
    showManualLogin  = false;
    qcCode           = null;
    clearInterval(qcPolling);
    disconnectSyncSocket();              // SyncPlay-Socket schließen
    closeSyncPlay(); syncMyGroup = null; syncGroups = []; syncQueue = null; syncCommand = null; _lastSyncQueueItem = null; syncJoined = false; syncMyGroupId = null;   // Gruppenstatus zurücksetzen
    remoteCommand = null; dismissRemoteMessage();   // Admin-Fernsteuerung/Nachricht verwerfen
    viewState = 'dashboard';
    apiCache  = { dashboard: null, views: {} };
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
    serverConnectError = '';
    appPhase          = 'servers';
  }

  // ============================================================
  // GLOBALE BACK-TASTE (WebOS Fernbedienung)
  // ============================================================

  function handleGlobalBack(e) {
    if (!isBackKey(e)) return;   // Escape / Backspace (außer in Eingaben) / Fernbedienung 461
    if (appPhase === 'users') {
      if (showPasswordForm || showManualLogin || qcCode) {
        showPasswordForm = false;
        showManualLogin  = false;
        if (qcCode) cancelQuickConnect();
        e.preventDefault();
        return;
      }
      e.preventDefault();
      handleLogout(); // zurück zur Server-Auswahl
      return;
    }
    if (appPhase !== 'app') return;
    // Bestätigungsdialog offen → Zurück bricht ab (statt zu schließen)
    if (showExitConfirm) { showExitConfirm = false; e.preventDefault(); return; }
    // Offene Overlays zuerst schließen (gilt auch für Fernbedienungs-Zurück)
    if (showSyncPlay)   { closeSyncPlay();         e.preventDefault(); return; }
    if (contextItem)    { contextItem = null;     e.preventDefault(); return; }
    if (showSortMenu)   { showSortMenu = false;   e.preventDefault(); return; }
    if (showFilterMenu) { showFilterMenu = false; e.preventDefault(); return; }
    // Innerhalb der App navigieren; preventDefault verhindert, dass webOS die App schließt.
    // Am Dashboard (oberste Ebene) Bestätigung zeigen statt die App direkt zu schließen.
    if      (viewState === 'player')   { viewState = 'details';        e.preventDefault(); }
    else if (viewState === 'details')  { returnFromDetails();          e.preventDefault(); }
    else if (viewState === 'person')   { viewState = personReturnView; e.preventDefault(); }
    else if (viewState === 'collection') { if (renamingPlaylist) renamingPlaylist = false; else if (confirmDeletePlaylist) confirmDeletePlaylist = false; else if (playlistEditMode) playlistEditMode = false; else viewState = collectionReturnView; e.preventDefault(); }
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
    // viewState bleibt 'player' — {#key currentDetailItem.Id} in der Template sorgt für Remount
  }

  function handlePrevEpisode(episodeItem) {
    if (!episodeItem) return;
    autoPlayStreak = 0;   // Zurückspringen ist eine bewusste Aktion → Zähler zurücksetzen
    activeMediaSourceId = null;
    currentDetailItem = episodeItem;
  }

  // ============================================================
  // BIBLIOTHEK / LIBRARY
  // ============================================================

  async function loadGenres(libraryId) {
    try {
      const res = await fetch(`${serverUrl}/Genres?ParentId=${libraryId}&UserId=${selectedUser.Id}`, { headers: getAuthHeaders() });
      if (res.ok) { const d = await res.json(); availableGenres = d.Items || []; }
    } catch { }
  }

  function getFilterQuery() {
    let q = '';
    const f = [];
    if (activeFilters.isFavorite)  f.push('IsFavorite');
    if (activeFilters.isPlayed)    f.push('IsPlayed');
    if (activeFilters.isNotPlayed) f.push('IsNotPlayed');
    if (f.length) q += `&Filters=${f.join(',')}`;

    // Genres: separate Parameter für OR-Logik in Jellyfin
    for (const g of selectedGenres) {
      q += `&Genres=${encodeURIComponent(g)}`;
    }

    // FSK: ein einziger Parameter mit pipe-separierten Werten = OR in Jellyfin.
    // Früher wurden zwei separate &OfficialRatings-Parameter übergeben
    // (FSK X und X) was in manchen Jellyfin-Versionen AND-Logik erzeugt → leeres Ergebnis.
    if (selectedFsk.length) {
      const ratings = selectedFsk.map(f => `FSK ${f}`).join('|');
      q += `&OfficialRatings=${encodeURIComponent(ratings)}`;
    }

    return q;
  }

  function toggleFilter(key) {
    activeFilters[key] = !activeFilters[key];
    if (key === 'isPlayed'    && activeFilters.isPlayed)    activeFilters.isNotPlayed = false;
    if (key === 'isNotPlayed' && activeFilters.isNotPlayed) activeFilters.isPlayed    = false;
    activeFilters = { ...activeFilters };
    loadLibraryItems({ Id: currentLibraryId, Name: currentLibraryName }, currentLetter || null);
  }

  function toggleGenre(name) {
    selectedGenres = selectedGenres.includes(name)
      ? selectedGenres.filter(g => g !== name)
      : [...selectedGenres, name];
    loadLibraryItems({ Id: currentLibraryId, Name: currentLibraryName }, currentLetter || null);
  }

  function toggleFsk(age) {
    selectedFsk = selectedFsk.includes(age)
      ? selectedFsk.filter(f => f !== age)
      : [...selectedFsk, age];
    loadLibraryItems({ Id: currentLibraryId, Name: currentLibraryName }, currentLetter || null);
  }

  async function loadLibraryItems(library, letter = null) {
    if (currentLibraryId !== library.Id) {
      activeFilters  = { isFavorite: false, isPlayed: false, isNotPlayed: false };
      selectedGenres = [];
      selectedFsk    = [];
      // Gemerkte Sortierung dieser Bibliothek wiederherstellen (sonst Standard)
      currentSort    = librarySorts[library.Id] ? { ...librarySorts[library.Id] } : { by: 'SortName', order: 'Ascending' };
      previewBackdrop = '';                                       // Backdrop-Vorschau zurücksetzen
      clearTimeout(previewTimer);
      loadGenres(library.Id);
    }
    currentLibraryName           = library.Name;
    currentLibraryId             = library.Id;
    viewState                    = 'library';
    if (sharedWatchMode) loadPartnersPlayedIds(library.Id);   // gesehene Titel beider Profile für diese Bibliothek

    if (letter !== null) {
      currentLetter = letter === '#' ? '' : letter;
      activeLetter  = letter;
      if (libraryScrollContainer) libraryScrollContainer.scrollTop = 0;
    } else {
      currentLetter = '';
      activeLetter  = '#';
    }

    if (isCacheableView() && apiCache.views[library.Id] && letter === null) {
      currentItems      = apiCache.views[library.Id].items;
      totalLibraryItems = apiCache.views[library.Id].total;
      return;
    }

    isLoading    = true;
    currentItems = [];

    let url = `${serverUrl}/Users/${selectedUser.Id}/Items?ParentId=${library.Id}&Fields=Overview,PrimaryImageAspectRatio,EndDate,Status,ChildCount,RecursiveItemCount,BackdropImageTags&SortBy=${currentSort.by}&SortOrder=${currentSort.order}&Limit=${libraryItemLimit}&StartIndex=0`;
    if (currentLetter) url += `&NameStartsWithOrGreater=${currentLetter}`;
    url += getFilterQuery();

    try {
      const res = await fetch(url, { headers: getAuthHeaders() });
      if (res.ok) {
        const data    = await res.json();
        currentItems      = data.Items || [];
        totalLibraryItems = data.TotalRecordCount || 0;
        if (isCacheableView()) cacheLibraryView(library.Id, { items: currentItems, total: totalLibraryItems });
      }
      connectionLost.set(false);
    } catch { connectionLost.set(true); } finally { isLoading = false; }
  }

  // Zufälliges Item aus der aktuellen Bibliothek holen und dessen Details öffnen.
  // Best Practice "irgendwas schauen": ein Klick → Detailseite mit Play/Fortsetzen.
  async function playRandomItem() {
    if (!currentLibraryId) return;
    try {
      const res = await fetch(
        `${serverUrl}/Users/${selectedUser.Id}/Items?ParentId=${currentLibraryId}` +
        `&SortBy=Random&Limit=1&Recursive=true&IncludeItemTypes=Movie,Series&Fields=Overview`,
        { headers: getAuthHeaders() }
      );
      if (res.ok) {
        const data = await res.json();
        if (data.Items?.length) showItemDetails(data.Items[0]);
      }
    } catch { /* ignorieren */ }
  }

  // ── Personen-Ansicht (Filmografie) ──────────────────────────
  let currentPersonName  = '';
  let currentPerson      = null;
  let currentPersonFav   = false;
  let currentPersonItems = [];
  let personReturnView   = 'search';   // wohin "Zurück" führt
  let isLoadingPerson    = false;

  // Sammlungen (BoxSets) — eigene Grid-Ansicht, gespiegelt von der Personen-Ansicht
  let collectionItems      = [];
  let currentCollectionName = '';
  let currentCollection     = null;
  let collectionReturnView = 'dashboard';
  let isLoadingCollection  = false;
  let playlistEditMode     = false;   // Bearbeiten-Modus der Wiedergabelisten-Ansicht (Entfernen/Umsortieren)

  async function openCollection(boxSet) {
    collectionReturnView  = viewState;
    currentCollectionName = boxSet.Name;
    currentCollection     = boxSet;
    collectionItems       = [];
    isLoadingCollection   = true;
    playlistEditMode      = false;
    viewState             = 'collection';
    // Wiedergabelisten über ihren eigenen Endpunkt laden (zuverlässig + in Listen-Reihenfolge),
    // Sammlungen/BoxSets über ParentId.
    const url = boxSet.Type === 'Playlist'
      ? `${serverUrl}/Playlists/${boxSet.Id}/Items?UserId=${selectedUser.Id}&Fields=PrimaryImageAspectRatio&Limit=300`
      : `${serverUrl}/Users/${selectedUser.Id}/Items?ParentId=${boxSet.Id}&SortBy=SortName&Fields=PrimaryImageAspectRatio&Limit=100`;
    try {
      const res = await fetch(url, { headers: getAuthHeaders() });
      if (res.ok) collectionItems = (await res.json()).Items || [];
    } catch { /* ignorieren */ }
    finally { isLoadingCollection = false; }
  }

  // Beschriftung für eine Folge in der Sammlungs-/Wiedergabelisten-Ansicht: "S1 · E5 · Titel"
  function episodeLabel(item) {
    const s = item.ParentIndexNumber, e = item.IndexNumber;
    const code = (s != null && e != null) ? `S${s} · E${e}` : (e != null ? `E${e}` : '');
    return [code, item.Name].filter(Boolean).join(' · ');
  }

  // Nach dem Anlegen einer Wiedergabeliste/Sammlung erscheint serverseitig ggf. eine neue
  // Mediatheks-Ansicht (z. B. "Playlists") – Sidebar/Menü sofort aktualisieren statt erst beim Neustart.
  async function refreshLibraries() {
    try {
      const res = await fetch(`${serverUrl}/Users/${selectedUser.Id}/Views`, { headers: getAuthHeaders() });
      if (res.ok) navLibraries = (await res.json()).Items || [];
    } catch { }
  }

  // --- Wiedergabelisten-Verwaltung (nur in der Wiedergabelisten-Inhaltsansicht) -----------------
  // Umsortieren: optimistisch lokal, dann serverseitig bestätigen.
  async function movePlaylistItem(fromIndex, toIndex) {
    if (!currentCollection || toIndex < 0 || toIndex >= collectionItems.length) return;
    const item = collectionItems[fromIndex];
    if (!item?.PlaylistItemId) return;
    const arr = [...collectionItems];
    const [moved] = arr.splice(fromIndex, 1);
    arr.splice(toIndex, 0, moved);
    collectionItems = arr;
    try {
      const res = await fetch(`${serverUrl}/Playlists/${currentCollection.Id}/Items/${item.PlaylistItemId}/Move/${toIndex}`,
        { method: 'POST', headers: getAuthHeaders() });
      if (!res.ok) console.warn('[OcenFin] Verschieben fehlgeschlagen', res.status);
    } catch (e) { console.warn('[OcenFin] Verschieben-Fehler', e); }
  }
  async function removePlaylistItem(item) {
    if (!currentCollection || !item?.PlaylistItemId) return;
    collectionItems = collectionItems.filter(i => i.PlaylistItemId !== item.PlaylistItemId);
    // Kinderzahl der Übersichts-Kachel mitziehen (für Platzhalter bei leerer Liste, ohne Reload)
    const gi = currentItems.find(x => x.Id === currentCollection.Id);
    if (gi) { gi.ChildCount = collectionItems.length; currentItems = [...currentItems]; }
    try {
      const res = await fetch(`${serverUrl}/Playlists/${currentCollection.Id}/Items?EntryIds=${item.PlaylistItemId}`,
        { method: 'DELETE', headers: getAuthHeaders() });
      if (!res.ok) console.warn('[OcenFin] Entfernen fehlgeschlagen', res.status);
    } catch (e) { console.warn('[OcenFin] Entfernen-Fehler', e); }
  }
  // Ganze Wiedergabeliste löschen (Inline-Sicherheitsabfrage im Bearbeiten-Modus).
  let confirmDeletePlaylist = false;
  async function deletePlaylist() {
    if (!currentCollection || currentCollection.Type !== 'Playlist') return;
    const id = currentCollection.Id;
    try {
      const res = await fetch(`${serverUrl}/Items/${id}`, { method: 'DELETE', headers: getAuthHeaders() });
      if (!res.ok) { console.warn('[OcenFin] Playlist löschen fehlgeschlagen', res.status); return; }
    } catch (e) { console.warn('[OcenFin] Playlist-Löschen-Fehler', e); return; }
    currentItems          = currentItems.filter(i => i.Id !== id);   // sofort aus dem Grid
    confirmDeletePlaylist = false;
    playlistEditMode      = false;

    await refreshLibraries();   // Sidebar/Menü neu laden (Playlist verschwindet)

    // War es die letzte Playlist, entfernt Jellyfin die ganze "Playlists"-Bibliothek.
    // Dann existiert die Rück-Ansicht nicht mehr → zurück aufs Dashboard.
    const playlistsLibGone = !navLibraries.some(l => l.CollectionType === 'playlists');
    if (collectionReturnView === 'library' && playlistsLibGone) {
      currentLibraryId = null;
      viewState        = 'dashboard';
    } else {
      viewState = collectionReturnView;
    }
  }

  // Playlist umbenennen (Inline-Eingabe im Bearbeiten-Modus).
  let renamingPlaylist = false;
  let renameValue      = '';
  let renameError      = false;
  function startRename() {
    renameValue           = currentCollectionName;
    confirmDeletePlaylist = false;
    renameError           = false;
    renamingPlaylist      = true;
  }
  async function savePlaylistName() {
    const name = renameValue.trim();
    if (!currentCollection || !name) { renameError = true; return; }
    if (name === currentCollectionName) { renamingPlaylist = false; return; }
    const id = currentCollection.Id;
    renameError = false;
    try {
      // Playlist-eigener Update-Endpunkt: nutzt die Besitzrechte des Nutzers (kein Admin-Recht nötig).
      // POST /Items/{id} wäre Metadaten-Bearbeitung und verlangt Adminrechte — daher hier bewusst nicht.
      const res = await fetch(`${serverUrl}/Playlists/${id}`, {
        method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ Name: name })
      });
      if (!res.ok) { console.warn('[OcenFin] Umbenennen fehlgeschlagen', res.status); renameError = true; return; }
    } catch (e) { console.warn('[OcenFin] Umbenennen-Fehler', e); renameError = true; return; }
    // Lokal sofort spiegeln (Titel, Übersichts-Kachel, Sidebar)
    currentCollectionName = name;
    currentCollection     = { ...currentCollection, Name: name };
    const gi = currentItems.find(x => x.Id === id);
    if (gi) { gi.Name = name; currentItems = [...currentItems]; }
    renamingPlaylist = false;
    refreshLibraries();
  }

  // Favoriten — eigene Ansicht (Filme, Serien, Sammlungen), aus dem Menü erreichbar.
  // Wird bei jedem Aufruf frisch geladen, da sich Favoriten jederzeit ändern können.
  let favoriteItems      = [];
  let isLoadingFavorites = false;
  let favoritesGrid;

  // Gruppierung wie in der Suche: Filme / Serien / Sammlungen (leere Gruppen entfallen im Template)
  $: favGroups = [
    { key: 'movies',      label: $t.movies,      items: favoriteItems.filter(i => i.Type === 'Movie') },
    { key: 'series',      label: $t.series,      items: favoriteItems.filter(i => i.Type === 'Series') },
    { key: 'collections', label: $t.collections, items: favoriteItems.filter(i => i.Type === 'BoxSet') },
  ];
  // Personen separat (runde Karten, eigene Sektion)
  $: favPersons = favoriteItems.filter(i => i.Type === 'Person');

  async function loadFavorites() {
    isLoadingFavorites = true;
    favoriteItems = [];
    try {
      // Personen sind KEINE Bibliothekselemente → die /Items-Abfrage (Recursive) liefert sie nie.
      // Stattdessen der dedizierte /Persons-Endpunkt mit IsFavorite-Filter (UserId für den Kontext).
      const [contentRes, personRes] = await Promise.all([
        fetch(
          `${serverUrl}/Users/${selectedUser.Id}/Items?Filters=IsFavorite&Recursive=true` +
          `&IncludeItemTypes=Movie,Series,BoxSet&SortBy=SortName&SortOrder=Ascending` +
          `&Fields=PrimaryImageAspectRatio,ProductionYear,UserData&EnableImageTypes=Primary,Backdrop,Thumb`,
          { headers: getAuthHeaders() }
        ),
        fetch(
          `${serverUrl}/Persons?UserId=${selectedUser.Id}&IsFavorite=true&SortBy=SortName&SortOrder=Ascending&Fields=PrimaryImageAspectRatio`,
          { headers: getAuthHeaders() }
        ),
      ]);
      const content = contentRes.ok ? ((await contentRes.json()).Items || []) : [];
      const persons = personRes.ok  ? ((await personRes.json()).Items  || []).map(p => ({ ...p, Type: 'Person' })) : [];
      dlog('[OcenFin] Favoriten:', content.length, 'Titel,', persons.length, 'Personen');
      favoriteItems = [...content, ...persons];
    } catch (e) { dlog('[OcenFin] Favoriten-Fehler:', e?.message); }
    finally { isLoadingFavorites = false; }
    await tick();
    const card = favoritesGrid?.querySelector('button');
    if (card) card.focus(); else focusMain();
  }

  // Öffnet die Filmografie einer Person (aus Suche oder Besetzung in den Details)
  async function openPerson(person) {
    personReturnView   = viewState;
    currentPersonName  = person.Name;
    currentPerson      = person;
    currentPersonFav   = !!person.UserData?.IsFavorite;
    currentPersonItems = [];
    isLoadingPerson    = true;
    viewState          = 'person';
    // Person-Item separat holen → korrekter Favoritenstatus (aus Suche/Besetzung fehlt UserData oft)
    fetch(`${serverUrl}/Users/${selectedUser.Id}/Items/${person.Id}`, { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(p => { if (p) { currentPerson = p; currentPersonFav = !!p.UserData?.IsFavorite; } })
      .catch(() => {});
    try {
      const res = await fetch(
        `${serverUrl}/Users/${selectedUser.Id}/Items?PersonIds=${person.Id}` +
        `&Recursive=true&IncludeItemTypes=Movie,Series&SortBy=PremiereDate&SortOrder=Descending` +
        `&Limit=100&Fields=PrimaryImageAspectRatio,SeriesName`,
        { headers: getAuthHeaders() }
      );
      if (res.ok) currentPersonItems = (await res.json()).Items || [];
    } catch { /* ignorieren */ }
    finally { isLoadingPerson = false; }
  }

  // Person als Favorit setzen/entfernen (optimistisch; bei Fehler zurückrollen)
  async function togglePersonFavorite() {
    if (!currentPerson) return;
    const next = !currentPersonFav;
    currentPersonFav = next;
    try {
      await fetch(`${serverUrl}/Users/${selectedUser.Id}/FavoriteItems/${currentPerson.Id}`,
        { method: next ? 'POST' : 'DELETE', headers: getAuthHeaders() });
    } catch { currentPersonFav = !next; }
  }

  // Filmografie nach Typ gruppieren (nur Filme / Serien). Folgen werden bewusst weggelassen –
  // wer in Serie X mitspielt, taucht sonst in dutzenden Folgen auf und überlagert alles.
  $: personGroups = [
    { label: $t.movies,   items: currentPersonItems.filter(i => i.Type === 'Movie') },
    { label: $t.series,   items: currentPersonItems.filter(i => i.Type === 'Series') },
  ].filter(g => g.items.length > 0);

  async function loadMoreLibraryItems() {
    if (isFetchingMore || currentItems.length >= totalLibraryItems || !currentLibraryId) return;
    isFetchingMore = true;
    let url = `${serverUrl}/Users/${selectedUser.Id}/Items?ParentId=${currentLibraryId}&Fields=Overview,PrimaryImageAspectRatio,EndDate,Status,ChildCount,RecursiveItemCount,BackdropImageTags&SortBy=${currentSort.by}&SortOrder=${currentSort.order}&Limit=${libraryItemLimit}&StartIndex=${currentItems.length}`;
    if (currentLetter) url += `&NameStartsWithOrGreater=${currentLetter}`;
    url += getFilterQuery();
    try {
      const res = await fetch(url, { headers: getAuthHeaders() });
      if (res.ok) {
        const data   = await res.json();
        currentItems = [...currentItems, ...(data.Items || [])];
        if (isCacheableView()) cacheLibraryView(currentLibraryId, { items: currentItems, total: totalLibraryItems });
      }
    } catch { } finally { isFetchingMore = false; }
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
      const res = await fetch(`${serverUrl}/Users/${selectedUser.Id}`, { headers: getAuthHeaders() });
      if (res.ok) selectedUser = await res.json();
    } catch { /* ignorieren */ }
  }

  async function navigateToLibrary(lib, focusFirstCard = false) {
    if (!lib) return;
    await loadLibraryItems(lib);
    // Beim Öffnen aus dem Menü den Fokus auf die erste Karte legen (nicht auf "Zufällig").
    // Das Verschieben des Fokus klappt zugleich die Sidebar wieder ein.
    if (focusFirstCard) {
      await tick();
      const card = libraryGrid?.querySelector('button');
      if (card) card.focus(); else focusMain();
    }
  }

  function showItemDetails(item) {
    // Container (Sammlung/Wiedergabeliste) zeigen ihren Inhalt statt einer Detailseite
    if (item?.Type === 'BoxSet' || item?.Type === 'Playlist') { openCollection(item); return; }
    // Herkunft merken, damit "Zurück" wieder dorthin führt (nicht immer Dashboard)
    detailsOrigin = viewState;
    if (viewState === 'library') {
      savedLibraryScroll = libraryScrollContainer?.scrollTop ?? 0;
      lastFocusedItemId  = item.Id;
    }
    currentDetailItem = item;
    viewState = 'details';
  }

  // ============================================================
  // KONTEXTMENÜ (langes Drücken auf eine Karte)
  // ============================================================
  let contextItem = null;
  function openContextMenu(item) { contextItem = item; }

  // Nach einer Aktion (gesehen/Favorit/zurückgesetzt) die aktuelle Ansicht auffrischen,
  // damit Badges/Fortschritt/"Weiterschauen" den neuen Stand zeigen.
  function onContextChanged() {
    if (viewState === 'dashboard') {
      apiCache.dashboard = null;
      dashboardReloadKey++;
    } else if (viewState === 'library' && currentLibraryId) {
      loadLibraryItems({ Id: currentLibraryId, Name: currentLibraryName }, currentLetter || null);
    } else if (viewState === 'collection' && currentCollection) {
      openCollection(currentCollection);
    }
  }
  function contextOpenDetails(e) {
    contextItem = null;
    showItemDetails(e.detail);
  }

  // Zurück aus Details/Player → an die Herkunft, Bibliotheksposition wiederherstellen
  async function returnFromDetails() {
    viewState = detailsOrigin;
    if (detailsOrigin === 'library') {
      await tick();
      if (libraryScrollContainer) libraryScrollContainer.scrollTop = savedLibraryScroll;
      // Fokus auf das zuletzt geöffnete Item zurücksetzen (WebOS D-Pad)
      if (lastFocusedItemId && libraryGrid) {
        const btn = libraryGrid.querySelector(`[data-item-id="${lastFocusedItemId}"]`);
        if (btn) btn.focus();
      }
    }
  }

  async function loadItemById(itemId) {
    try {
      const res = await fetch(`${serverUrl}/Users/${selectedUser.Id}/Items/${itemId}`, { headers: getAuthHeaders() });
      if (res.ok) { currentDetailItem = await res.json(); viewState = 'details'; }
    } catch { }
  }

  function getItemImageUrl(item) {
    if (item.ImageTags?.Primary)
      return `${serverUrl}/Items/${item.Id}/Images/Primary?tag=${item.ImageTags.Primary}&fillHeight=400&fillWidth=266&quality=80&format=webp`;
    return null;
  }

  function getGridItemSubtitle(item) {
    if (item.Type === 'Series') {
      const start = item.ProductionYear || '';
      const end   = item.Status === 'Continuing'
        ? $t.today
        : (item.EndDate ? new Date(item.EndDate).getFullYear() : '');
      if (start && end && start != end) return `${start} – ${end}`;
      if (start && item.Status === 'Continuing') return `${start} – ${$t.today}`;
      return start.toString();
    }
    return item.ProductionYear?.toString() || '';
  }

  function infiniteScroll(node) {
    const obs = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) loadMoreLibraryItems(); },
      { rootMargin: '400px' }
    );
    obs.observe(node);
    return { destroy() { obs.disconnect(); } };
  }

  let scrollTimer;
  function handleLibraryScroll() {
    if (scrollTimer) clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      if (!libraryGrid || !currentItems.length) return;
      for (const child of libraryGrid.children) {
        const rect = child.getBoundingClientRect();
        if (rect.bottom > 150) {
          const idx  = [...libraryGrid.children].indexOf(child);
          const item = currentItems[idx];
          if (item) {
            const char = (item.SortName || item.Name)[0].toUpperCase();
            activeLetter = /[A-Z]/.test(char) ? char : '#';
          }
          break;
        }
      }
    }, 150);
  }
</script>

<svelte:window
  on:keydown={resetActivity}
  on:mousemove={resetActivity}
  on:pointermove={resetActivity}
  on:click={resetActivity}
/>

<style>
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

  .hide-scrollbar::-webkit-scrollbar { display: none; }
  .hide-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }

  /* content-visibility: Browser überspringt Rendering/Layout für Items außerhalb
     des sichtbaren Bereichs. Nativer, sehr effizienter "Virtual Scrolling"-Ersatz
     ab Chromium 85+ (B4 unterstützt es). contain-intrinsic-size reserviert Platz,
     damit die Scrollleiste korrekt bleibt (Poster-Verhältnis 2:3). */
  .cv-auto {
    content-visibility: auto;
    contain-intrinsic-size: auto 320px;
  }

  /* A-Z Sprung-Vorschau: kurz einblenden, dann ausblenden */
  .jump-overlay { animation: jumpPop 0.8s ease forwards; }
  @keyframes jumpPop {
    0%   { opacity: 0; transform: scale(0.8); }
    20%  { opacity: 1; transform: scale(1); }
    70%  { opacity: 1; transform: scale(1); }
    100% { opacity: 0; transform: scale(0.95); }
  }

  /* Backdrop-Vorschau: sanftes Einblenden */
  .preview-fade { animation: previewFadeIn 0.6s ease forwards; }
  @keyframes previewFadeIn { from { opacity: 0; } to { opacity: 1; } }

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

  {#if $connectionLost && !initializing}
    <div class="fixed top-0 left-0 right-0 z-[500] bg-red-600/95 text-white px-6 py-3 flex items-center justify-center gap-4 shadow-lg" transition:fade={{ duration: 200 }}>
      <svg class="w-6 h-6 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M18.364 5.636a9 9 0 010 12.728m-3.536-3.536a4 4 0 010-5.656M12 12h.01M5.636 5.636a9 9 0 000 12.728"/></svg>
      <span class="font-bold">{$t.connectionLostMsg}</span>
      <button on:click={() => location.reload()}
        class="bg-white text-red-700 font-bold px-4 py-1.5 rounded-lg focus:outline-none focus:ring-4 focus:ring-white/60 hover:bg-gray-100">
        {$t.retry}
      </button>
    </div>
  {/if}

  <!-- App-verlassen-Bestätigung (Zurück am Dashboard) -->
  {#if showExitConfirm}
    <div class="fixed inset-0 z-[600] flex items-center justify-center bg-black/70 backdrop-blur-sm" data-focus-trap transition:fade={{ duration: 150 }}>
      <div class="bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl p-8 w-full max-w-md mx-6 flex flex-col gap-6">
        <div>
          <h2 class="text-2xl font-bold text-white">{$t.exitTitle}</h2>
          <p class="text-gray-400 mt-2">{$t.exitMessage}</p>
        </div>
        <div class="flex gap-3">
          <button on:click={() => showExitConfirm = false} use:focusOnMount
            class="flex-1 bg-gray-700 text-white font-bold py-3 rounded-xl focus:outline-none focus:ring-4 focus:ring-white hover:bg-gray-600 transition-colors">
            {$t.cancel}
          </button>
          <button on:click={exitApp}
            class="flex-1 bg-red-600 text-white font-bold py-3 rounded-xl focus:outline-none focus:ring-4 focus:ring-white hover:bg-red-500 transition-colors">
            {$t.exitConfirm}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- ============================================================
       PHASE: SERVER-AUSWAHL
  ============================================================ -->
  {#if appPhase === 'servers'}
    <div class="h-full flex items-center justify-center p-8">
      <div data-focus-group="servers" class="w-full max-w-2xl flex flex-col gap-6">

        <div class="text-center mb-2">
          <h1 class="text-4xl font-bold text-blue-500 mb-1">{$t.title}</h1>
          <p class="text-gray-400">{$t.serverSelectPrompt}</p>
        </div>

        <!-- Gespeicherte Server -->
        {#if savedServers.length > 0}
          <div class="flex flex-col gap-3">
            <p class="text-sm text-gray-400 uppercase tracking-wider font-bold ml-1">{$t.savedServers}</p>
            {#each savedServers as server, i}
              <div class="flex items-center gap-3">
                <button
                  on:click={() => connectToServer(server)}
                  use:focusOnMount={i === 0}
                  class="flex-1 flex items-center justify-between p-5 bg-gray-800 hover:bg-gray-700 focus:bg-gray-700
                         border border-gray-600 hover:border-blue-500 focus:border-blue-500
                         rounded-xl text-left focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all"
                >
                  <div class="overflow-hidden">
                    <span class="text-xl font-bold text-white block truncate">{server.name}</span>
                    <span class="text-sm text-gray-400 block mt-0.5 truncate">{server.url}</span>
                  </div>
                  {#if isConnecting && selectedServer?.id === server.id}
                    <div class="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin shrink-0 ml-4"></div>
                  {:else}
                    <svg class="w-6 h-6 text-blue-400 shrink-0 ml-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/>
                    </svg>
                  {/if}
                </button>
                <!-- Server entfernen -->
                <button
                  on:click={() => removeServer(server.id)}
                  class="p-3 text-gray-600 hover:text-red-400 focus:text-red-400 focus:outline-none focus:ring-2 focus:ring-red-500 rounded-lg transition-colors"
                  title={$t.backToServers}
                >
                  <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
                  </svg>
                </button>
              </div>
            {/each}
          </div>
        {/if}

        <!-- Fehlermeldung + Retry -->
        {#if serverConnectError}
          <div class="bg-red-900/40 border border-red-700 rounded-xl p-5 flex flex-col gap-4">
            <div class="flex items-center gap-3">
              <svg class="w-6 h-6 text-red-400 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
              </svg>
              <p class="text-red-300 font-semibold text-lg">{serverConnectError}</p>
            </div>
            <div class="flex gap-3">
              <button
                on:click={() => selectedServer && connectToServer(selectedServer)}
                use:focusOnMount
                class="flex-1 bg-gray-700 hover:bg-gray-600 focus:bg-gray-600 text-white font-bold py-3 rounded-lg
                       focus:outline-none focus:ring-2 focus:ring-white transition-colors"
              >
                {$t.serverRetry}
              </button>
              <button
                on:click={() => { serverConnectError = ''; selectedServer = null; }}
                class="flex-1 bg-transparent border border-gray-600 hover:bg-gray-800 focus:bg-gray-800 text-gray-300 font-bold py-3 rounded-lg
                       focus:outline-none focus:ring-2 focus:ring-white transition-colors"
              >
                {$t.backToServers}
              </button>
            </div>
          </div>
        {/if}

        <!-- Neuen Server hinzufügen (Toggle-Panel) -->
        <button
          on:click={() => { showAddServer = !showAddServer; if (showAddServer) discoverJellyfinServers(); }}
          class="w-full flex items-center justify-center gap-3 py-4 rounded-xl border-2 transition-all
                 focus:outline-none focus:ring-4 focus:ring-blue-300 font-bold text-lg
                 {showAddServer ? 'bg-gray-800 border-blue-600 text-blue-400' : 'bg-transparent border-gray-700 text-gray-400 hover:border-blue-500 hover:text-blue-400'}"
        >
          <svg class="w-6 h-6 transition-transform {showAddServer ? 'rotate-45' : ''}" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
          </svg>
          {showAddServer ? $t.qcCancel : $t.addServer}
        </button>

        {#if showAddServer}
          <div class="bg-gray-800 border border-gray-700 rounded-xl p-6 flex flex-col gap-5">

            <!-- Discovery -->
            <button
              on:click={discoverJellyfinServers}
              disabled={isDiscovering}
              class="w-full flex items-center justify-center gap-3 bg-blue-600 hover:bg-blue-500 disabled:bg-blue-900
                     text-white font-bold text-lg py-4 rounded-xl focus:outline-none focus:ring-4 focus:ring-blue-300 transition-colors"
            >
              {#if isDiscovering}
                <div class="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                {$t.discovering}
              {:else}
                <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0"/>
                </svg>
                {$t.discoverServers}
              {/if}
            </button>

            <!-- Gefundene (neue) Server -->
            {#if discoveredServers.length > 0}
              <div class="flex flex-col gap-2">
                <p class="text-xs text-gray-400 uppercase tracking-wider font-bold">{$t.serverFound}</p>
                {#each discoveredServers as d}
                  <button
                    on:click={() => addAndConnectServer(d.url)}
                    class="flex items-center justify-between p-4 bg-gray-900 hover:bg-gray-700 focus:bg-gray-700
                           border border-gray-600 hover:border-blue-500 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 transition-all text-left"
                  >
                    <div>
                      <span class="text-lg font-bold text-white block">{d.name}</span>
                      <span class="text-sm text-gray-400">{d.url}</span>
                    </div>
                    <svg class="w-5 h-5 text-blue-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
                    </svg>
                  </button>
                {/each}
              </div>
            {/if}

            <!-- Trennlinie -->
            <div class="flex items-center gap-3">
              <div class="flex-1 h-px bg-gray-700"></div>
              <span class="text-gray-500 text-sm">{$t.serverManualEntry}</span>
              <div class="flex-1 h-px bg-gray-700"></div>
            </div>

            <!-- Manuelle URL -->
            <div class="flex gap-3">
              <input
                type="text"
                bind:value={newServerUrl}
                on:keydown={(e) => e.key === 'Enter' && addAndConnectServer(newServerUrl)}
                placeholder="z.B. http://192.168.1.100:8096"
                class="flex-1 bg-gray-900 text-white text-lg p-4 rounded-xl border border-gray-600
                       focus:outline-none focus:ring-4 focus:ring-blue-500"
              />
              <button
                on:click={() => addAndConnectServer(newServerUrl)}
                disabled={!newServerUrl.trim() || isConnecting}
                class="bg-gray-700 hover:bg-gray-600 disabled:opacity-40 text-white font-bold px-6 rounded-xl
                       focus:outline-none focus:ring-4 focus:ring-white transition-colors"
              >
                {isConnecting ? '…' : 'OK'}
              </button>
            </div>

          </div>
        {/if}

      </div>
    </div>

  <!-- ============================================================
       PHASE: BENUTZER-AUSWAHL
  ============================================================ -->
  {:else if appPhase === 'users'}
    <div class="h-full flex items-center justify-center p-8">
      <div data-focus-group="users" class="w-full max-w-6xl flex flex-col items-center gap-10">

        <!-- Server-Name als Kontext -->
        {#if selectedServer}
          <p class="text-gray-500 text-lg font-medium tracking-wide">
            {selectedServer.name} · <span class="text-gray-600">{selectedServer.url}</span>
          </p>
        {/if}

        <!-- QC-Login: Code anzeigen -->
        {#if qcCode}
          <div class="bg-gray-800 p-10 rounded-2xl shadow-xl max-w-xl w-full text-center border border-gray-700">
            <h2 class="text-3xl font-bold text-white mb-4">{$t.quickConnect}</h2>
            <p class="text-gray-400 mb-6 text-xl">{$t.qcInstruction}</p>
            <div class="bg-gray-900 border-2 border-blue-500 rounded-lg py-6 mb-6">
              <span class="text-6xl font-mono font-bold text-white tracking-widest">{qcCode}</span>
            </div>
            <button on:click={cancelQuickConnect}
              class="w-full bg-gray-700 hover:bg-gray-600 text-gray-300 font-bold py-4 rounded-xl
                     focus:outline-none focus:ring-4 focus:ring-white transition-colors">
              {$t.qcCancel}
            </button>
          </div>

        <!-- Passwort-Eingabe für ausgewähltes Profil -->
        {:else if showPasswordForm && selectedUser}
          <div class="bg-gray-800 p-10 rounded-2xl shadow-xl max-w-xl w-full text-center border border-gray-700">
            <h2 class="text-3xl font-bold text-white mb-6">{$t.passwordPrompt} {selectedUser.Name}</h2>
            <input
              type="password"
              bind:value={password}
              class="w-full bg-gray-900 text-white text-2xl p-5 rounded-xl mb-6 border border-gray-600 text-center
                     focus:outline-none focus:ring-4 focus:ring-blue-500"
              on:keydown={(e) => e.key === 'Enter' && authenticateUser(selectedUser.Name, password)}
              use:focusOnMount
            />
            <button on:click={() => authenticateUser(selectedUser.Name, password)}
              class="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold text-xl py-4 rounded-xl mb-4
                     focus:outline-none focus:ring-4 focus:ring-white">
              {$t.loginText}
            </button>
            <!-- Alternative: Quick Connect (falls Kennwort nicht gespeichert/getippt werden soll) -->
            <button on:click={startQuickConnect}
              class="w-full flex items-center justify-center gap-2 bg-gray-700 hover:bg-gray-600 text-gray-200 font-bold text-lg py-3.5 rounded-xl mb-4
                     focus:outline-none focus:ring-4 focus:ring-white transition-colors">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
              {$t.quickConnect}
            </button>
            <button on:click={() => { showPasswordForm = false; selectedUser = null; }}
              class="w-full bg-gray-700/50 hover:bg-gray-600 text-gray-300 hover:text-white font-bold text-lg py-3.5 rounded-xl
                     focus:outline-none focus:ring-4 focus:ring-white transition-colors">
              {$t.back}
            </button>
            {#if loginError}<p class="text-red-400 mt-4 font-semibold">{loginError}</p>{/if}
          </div>

        <!-- Manuelle Anmeldung -->
        {:else if showManualLogin}
          <div class="bg-gray-800 p-10 rounded-2xl shadow-xl max-w-xl w-full text-center border border-gray-700">
            <h2 class="text-3xl font-bold text-white mb-6">{$t.manualLogin}</h2>
            <input
              type="text"
              bind:value={manualUsername}
              placeholder={$t.username}
              on:keydown={(e) => e.key === 'Enter' && authenticateUser(manualUsername, manualPassword)}
              class="w-full bg-gray-900 text-white text-xl p-5 rounded-xl mb-4 border border-gray-600
                     focus:outline-none focus:ring-4 focus:ring-blue-500"
              use:focusOnMount
            />
            <input
              type="password"
              bind:value={manualPassword}
              placeholder="Passwort"
              on:keydown={(e) => e.key === 'Enter' && authenticateUser(manualUsername, manualPassword)}
              class="w-full bg-gray-900 text-white text-xl p-5 rounded-xl mb-6 border border-gray-600
                     focus:outline-none focus:ring-4 focus:ring-blue-500"
            />
            <button on:click={() => authenticateUser(manualUsername, manualPassword)}
              class="w-full bg-blue-600 hover:bg-blue-500 text-white font-bold text-xl py-4 rounded-xl mb-4
                     focus:outline-none focus:ring-4 focus:ring-white">
              {$t.loginText}
            </button>
            <button on:click={() => showManualLogin = false}
              class="w-full bg-gray-700/50 hover:bg-gray-600 text-gray-300 hover:text-white font-bold text-lg py-3.5 rounded-xl
                     focus:outline-none focus:ring-4 focus:ring-white transition-colors">
              {$t.back}
            </button>
            {#if loginError}<p class="text-red-400 mt-4 font-semibold">{loginError}</p>{/if}
          </div>

        <!-- Profilauswahl -->
        {:else}
          <h1 class="text-5xl font-bold text-white">{$t.selectUser}</h1>

          <!-- Profile -->
          {#if users.length > 0}
            <div class="flex flex-wrap justify-center gap-10">
              {#each users as user}
                <button on:click={() => handleUserClick(user)} class="flex flex-col items-center group focus:outline-none">
                  <div class="w-44 h-44 rounded-2xl overflow-hidden border-4 border-transparent group-focus:border-white shadow-xl transition-all">
                    {#if user.PrimaryImageTag}
                      <img src="{serverUrl}/Users/{user.Id}/Images/Primary?tag={user.PrimaryImageTag}" alt={user.Name} class="w-full h-full object-cover"/>
                    {:else}
                      <div class="w-full h-full bg-gray-700 flex items-center justify-center">
                        <span class="text-6xl font-bold">{user.Name.charAt(0)}</span>
                      </div>
                    {/if}
                  </div>
                  <span class="mt-4 text-2xl text-gray-400 group-focus:text-white transition-colors">{user.Name}</span>
                </button>
              {/each}
            </div>
          {/if}

          <!-- Trennlinie -->
          <div class="flex items-center gap-4 w-full max-w-xl mt-4">
            <div class="flex-1 h-px bg-gray-800"></div>
            <span class="text-gray-600 text-sm">oder</span>
            <div class="flex-1 h-px bg-gray-800"></div>
          </div>

          <!-- Manuelle Anmeldung + Quick Connect Buttons (wie original Jellyfin) -->
          <div class="flex gap-4">
            <button
              on:click={() => { showManualLogin = true; loginError = ''; }}
              class="flex items-center gap-3 bg-gray-800 hover:bg-gray-700 focus:bg-gray-700
                     border border-gray-700 hover:border-gray-500 text-gray-300 hover:text-white
                     font-bold text-lg px-8 py-4 rounded-xl focus:outline-none focus:ring-4 focus:ring-white transition-all"
            >
              <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"/>
              </svg>
              {$t.manualLogin}
            </button>

            <button
              on:click={startQuickConnect}
              class="flex items-center gap-3 bg-gray-800 hover:bg-gray-700 focus:bg-gray-700
                     border border-gray-700 hover:border-blue-500 text-gray-300 hover:text-blue-300
                     font-bold text-lg px-8 py-4 rounded-xl focus:outline-none focus:ring-4 focus:ring-blue-500 transition-all"
            >
              <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/>
              </svg>
              {$t.quickConnect}
            </button>
          </div>

          <!-- Anderen Server wählen -->
          <button
            on:click={handleLogout}
            class="text-gray-600 hover:text-gray-400 focus:text-gray-400 focus:outline-none text-sm font-medium mt-2"
          >
            ← {$t.switchServer}
          </button>

          {#if loginError}<p class="text-red-400 font-semibold">{loginError}</p>{/if}
        {/if}

      </div>
    </div>

  <!-- ============================================================
       PHASE: HAUPT-APP
  ============================================================ -->
  {:else if appPhase === 'app'}
    <div class="flex h-full w-full">

      <Sidebar
        {selectedUser}
        {serverUrl}
        {viewState}
        showLogo={displaySettings.showLogo}
        libraries={navLibraries}
        navOrder={displaySettings.navOrder}
        navHidden={displaySettings.navHidden}
        navIcons={displaySettings.navIcons}
        activeLibraryId={currentLibraryId}
        on:navigate={(e) => { if (e.detail === 'syncplay') { openSyncPlay(); } else { viewState = e.detail; if (e.detail === 'favorites') loadFavorites(); else focusMain(); } }}
        on:navigateLibrary={(e) => navigateToLibrary(e.detail, true)}
        on:switchUser={handleSwitchUser}
        on:logOutServer={handleLogout}
      />

      <div data-focus-group="main" class="flex-1 h-full overflow-y-auto hide-scrollbar bg-gray-900 relative">

        {#if viewState === 'dashboard'}
          {#key dashboardReloadKey}
          <Dashboard
            {serverUrl} {selectedUser} {activeToken} {apiCache} {reduceAnimations}
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
            on:openLibrary={(e) => loadLibraryItems(e.detail)}
            on:librariesLoaded={(e) => navLibraries = e.detail}
            on:openDetails={(e) => showItemDetails(e.detail)}
            on:openCollection={(e) => openCollection(e.detail)}
            on:openContext={(e) => openContextMenu(e.detail)}
          />
          {/key}

        {:else if viewState === 'library'}
          <div class="flex h-full w-full relative">

            <!-- Backdrop-Vorschau (blendet beim Fokussieren einer Karte sanft ein) -->
            {#if previewBackdrop}
              <div class="absolute inset-0 z-0 pointer-events-none">
                {#key previewBackdrop}
                  <img src={previewBackdrop} alt="" class="w-full h-full object-cover preview-fade" />
                {/key}
                <div class="absolute inset-0 bg-gradient-to-r from-gray-900 via-gray-900/85 to-gray-900/40"></div>
                <div class="absolute inset-0 bg-gradient-to-t from-gray-900 via-transparent to-gray-900/60"></div>
              </div>
            {/if}

            <!-- A-Z Sprung-Vorschau (großes Buchstaben-Overlay) -->
            {#if jumpLetterOverlay}
              <div class="absolute inset-0 z-30 flex items-center justify-center pointer-events-none">
                <div class="bg-black/70 backdrop-blur-md rounded-3xl w-40 h-40 flex items-center justify-center jump-overlay">
                  <span class="text-8xl font-bold text-white">{jumpLetterOverlay}</span>
                </div>
              </div>
            {/if}

            <div bind:this={libraryScrollContainer} on:scroll={handleLibraryScroll}
              class="flex-1 p-10 pt-16 overflow-y-auto hide-scrollbar relative z-10">

              <div class="flex justify-between items-center mb-10 pr-6">
                <h1 class="text-4xl font-bold text-white">
                  {currentLibraryName}
                  <span class="text-xl text-gray-500 font-normal">({totalLibraryItems})</span>
                </h1>
                <div class="flex items-center gap-3">
                  <!-- Zufällig abspielen -->
                  <button on:click={playRandomItem}
                    class="flex items-center gap-3 bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 px-6 py-3 rounded-xl text-white font-bold
                           focus:outline-none focus:ring-4 focus:ring-white transition-all shadow-lg border border-gray-700 focus:scale-105"
                    title={$t.shuffle}>
                    <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M4 4h4l12 16h4M4 20h4l3-4m4-9l2-3h3M20 4v4m0 12v-4"/>
                    </svg>
                    {$t.shuffle}
                  </button>
                  <!-- Sortierung -->
                  <button on:click={() => showSortMenu = true}
                    class="flex items-center gap-3 bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 px-6 py-3 rounded-xl text-white font-bold
                           focus:outline-none focus:ring-4 focus:ring-white transition-all shadow-lg border border-gray-700 focus:scale-105"
                    title={$t.sortBy}>
                    <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M3 4h13M3 8h9M3 12h5m4 4l4 4m0 0l4-4m-4 4V8"/>
                    </svg>
                    {$t.sortBy}
                  </button>
                  <!-- Filter -->
                  <button on:click={() => showFilterMenu = true}
                    class="flex items-center gap-3 bg-gray-800 hover:bg-gray-700 px-6 py-3 rounded-xl text-white font-bold
                           focus:outline-none focus:ring-4 focus:ring-white transition-all shadow-lg border border-gray-700 focus:scale-105">
                    <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"/>
                    </svg>
                    {$t.filter}
                    {#if hasFilters}<span class="bg-blue-600 text-white text-xs px-2 py-1 rounded-full ml-1 font-bold">{$t.filterActive}</span>{/if}
                  </button>
                  <!-- Gemeinsam schauen: blendet aus, was beide Profile schon gesehen haben -->
                  {#if sharedReady}
                    <button on:click={toggleSharedWatch}
                      class="flex items-center gap-3 px-6 py-3 rounded-xl font-bold focus:outline-none focus:ring-4 focus:ring-white transition-all shadow-lg border focus:scale-105
                             {sharedWatchMode ? 'bg-blue-600 border-blue-400 text-white' : 'bg-gray-800 hover:bg-gray-700 border-gray-700 text-white'}"
                      title={$t.watchTogether}>
                      <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4zm6 0a3 3 0 10-2.5-1.34M5 11a3 3 0 102.5-1.34"/>
                      </svg>
                      {$t.watchTogether}
                    </button>
                  {/if}
                </div>
              </div>

              <!-- SCHNELLFILTER-CHIPS: Favoriten + Sortierung (Genre/FSK über den Filter-Button) -->
              <div class="flex gap-3 mb-6 px-2 py-3 overflow-x-auto hide-scrollbar">
                <!-- Favoriten-Chip (immer zuerst) -->
                <button on:click={() => toggleFilter('isFavorite')}
                  class="shrink-0 flex items-center gap-2 px-5 py-2.5 rounded-full font-bold text-sm whitespace-nowrap
                         focus:outline-none focus:ring-4 focus:ring-white transition-all focus:scale-105
                         {activeFilters.isFavorite ? 'bg-red-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}">
                  <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
                  {$t.filterFavorites}
                </button>
                <!-- Sortier-Chips -->
                {#each sortOptions as opt}
                  <button on:click={() => setSort(opt)}
                    class="shrink-0 flex items-center gap-1.5 px-5 py-2.5 rounded-full font-bold text-sm whitespace-nowrap
                           focus:outline-none focus:ring-4 focus:ring-white transition-all focus:scale-105
                           {currentSort.by === opt.by ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}">
                    {$t[opt.key]}
                    {#if currentSort.by === opt.by && opt.by !== 'Random'}
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24">
                        {#if currentSort.order === 'Ascending'}
                          <path stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7"/>
                        {:else}
                          <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/>
                        {/if}
                      </svg>
                    {/if}
                  </button>
                {/each}
              </div>

              <div bind:this={libraryGrid}
                class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6 pr-4">
                {#if isLoading}
                  {#each Array(14).fill(0) as _}
                    <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg animate-pulse"></div>
                  {/each}
                {:else}
                  {#each visibleLibraryItems as item}
                    <button on:click={() => showItemDetails(item)} data-item-id={item.Id}
                      on:focus={() => previewItem(item)} on:blur={cancelPreview}
                      use:longPress on:longpress={() => openContextMenu(item)}
                      class="group focus:outline-none text-left cv-auto">
                      <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg overflow-hidden border-4 border-transparent group-focus:border-white shadow-xl relative">
                        {#if item.Type === 'Playlist' && item.ChildCount === 0}
                          <!-- Leere Wiedergabeliste: neutraler Platzhalter statt veraltetem Jellyfin-Collage-Bild -->
                          <div class="w-full h-full flex items-center justify-center text-gray-600">
                            <svg class="w-16 h-16" fill="currentColor" viewBox="0 0 24 24"><path d="M4 6h16v2H4zm2-4h12v2H6zm-4 8h20v10a2 2 0 01-2 2H4a2 2 0 01-2-2V10z"/></svg>
                          </div>
                        {:else if getItemImageUrl(item)}
                          <img src={getItemImageUrl(item)} use:blurUp={itemBlurHash(item)} alt={item.Name} class="w-full h-full object-cover" loading="lazy" decoding="async"/>
                        {/if}
                        <!-- Episodenanzahl bei Serien (abschaltbar in Einstellungen) -->
                        {#if displaySettings.episodeCount && item.Type === 'Series' && item.RecursiveItemCount}
                          <div class="absolute top-2 right-2 bg-black/80 text-white text-xs font-bold px-2 py-1 rounded-md">
                            {item.RecursiveItemCount} {$t.episodes}
                          </div>
                        {/if}
                        {#if itemProgress(item) > 0}
                          <div class="absolute bottom-0 left-0 w-full h-1.5 bg-gray-900/80">
                            <div class="h-full bg-blue-500" style="width:{itemProgress(item)}%"></div>
                          </div>
                        {/if}
                      </div>
                      <div class="mt-3 flex flex-col items-start w-full overflow-hidden">
                        <span class="text-sm font-bold text-gray-300 group-focus:text-white truncate block w-full">{item.Name}</span>
                        <span class="text-xs text-gray-500 group-focus:text-gray-400 block truncate w-full mt-0.5">{getGridItemSubtitle(item)}</span>
                      </div>
                    </button>
                  {/each}
                {/if}
              </div>

              {#if sharedWatchMode && !isLoading && currentItems.length > 0 && visibleLibraryItems.length === 0}
                <div class="text-center text-gray-400 py-24 text-lg">{$t.watchTogetherEmpty}</div>
              {/if}

              {#if isFetchingMore}
                <div class="w-full flex justify-center py-12 mt-8">
                  <div class="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
                </div>
              {:else if currentItems.length > 0 && currentItems.length < totalLibraryItems}
                <div use:infiniteScroll class="h-24 w-full"></div>
              {/if}
            </div>

            <!-- A-Z (nur bei Namenssortierung sinnvoll) -->
            {#if isDefaultSort}
            <div class="w-16 shrink-0 bg-gradient-to-l from-gray-950/85 via-gray-950/55 to-transparent backdrop-blur-sm flex flex-col items-center justify-between py-6 overflow-y-auto hide-scrollbar z-10">
              {#each alphabet as letter}
                <button
                  on:click={() => { showJumpLetter(letter); loadLibraryItems({ Id: currentLibraryId, Name: currentLibraryName }, letter); }}
                  on:focus={() => showJumpLetter(letter)}
                  class="w-10 h-10 flex items-center justify-center rounded-full text-sm font-bold drop-shadow
                         focus:outline-none focus:ring-4 focus:ring-white transition-all transform focus:scale-125
                         {activeLetter === letter ? 'text-white bg-blue-600 shadow-lg scale-110' : 'text-gray-300/80 hover:text-white hover:bg-white/10'}"
                >{letter}</button>
              {/each}
            </div>
            {/if}
          </div>

        {:else if viewState === 'search'}
          <Search {serverUrl} {activeToken} {selectedUser}
            on:openDetails={(e) => showItemDetails(e.detail)}
            on:openPerson={(e) => openPerson(e.detail)} />

        {:else if viewState === 'settings'}
          <Settings
            {serverUrl} {activeToken} {selectedUser} {selectedServer} {savedTokens}
            {screensaverSettings} {reduceAnimations} {displaySettings} {playbackPrefs}
            {serverVersion} {serverVobSub}
            libraries={navLibraries}
            publicUsers={users} {sharedProfile} {sharedTokens}
            onSharedToggle={toggleSharedEnabled}
            onSharedSetMember={setSharedMember}
            onSharedRemoveMember={removeSharedMember}
            on:toggleSave={toggleCurrentUserSave}
            on:switchUser={handleSwitchUser}
            on:logout={handleLogout}
            on:screensaverChange={onScreensaverSettingsChange}
            on:reduceAnimationsChange={onReduceAnimationsChange}
            on:displayChange={onDisplayChange}
            on:reorderingChange={(e) => navReordering = e.detail}
            on:profileImageChanged={refreshSelectedUser}
            on:playbackPrefsChange={onPlaybackPrefsChange}
            on:clearCache={clearCache}
          />

        {:else if viewState === 'details' && currentDetailItem}
          <Details
            item={currentDetailItem}
            {serverUrl} {activeToken} {selectedUser} {reduceAnimations} {playbackPrefs} {use24h} {serverVobSub}
            spoilerProtection={displaySettings.spoilerProtection}
            on:close={returnFromDetails}
            on:openItemById={(e) => loadItemById(e.detail)}
            on:openPerson={(e) => openPerson(e.detail)}
            on:libchanged={refreshLibraries}
            on:playVideo={(e) => {
              if (e.detail.item) currentDetailItem = e.detail.item;
              activeAudioIndex    = e.detail.audioIndex    ?? -1;
              activeSubtitleIndex = e.detail.subtitleIndex ?? -1;
              activeMediaSourceId = e.detail.mediaSourceId ?? null;
              viewState = 'player';
            }}
          />

        {:else if viewState === 'person'}
          <div class="p-10 pt-16 h-full overflow-y-auto hide-scrollbar">
            <div class="flex items-center gap-6 mb-8">
              <button on:click={() => viewState = personReturnView} use:focusOnMount
                class="bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 px-6 py-2 rounded-lg text-white font-bold focus:outline-none focus:ring-4 focus:ring-white">
                {$t.back}
              </button>
              <button on:click={togglePersonFavorite} aria-label={$t.favorites}
                class="w-12 h-12 rounded-lg focus:outline-none focus:ring-4 focus:ring-white transition-colors flex items-center justify-center
                       {currentPersonFav ? 'bg-red-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700 focus:bg-gray-700'}">
                <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M11.645 20.91l-.007-.003-.022-.012a15.247 15.247 0 01-.383-.218 25.18 25.18 0 01-4.244-3.17C4.688 15.36 2.25 12.174 2.25 8.25 2.25 5.322 4.714 3 7.688 3A5.5 5.5 0 0112 5.052 5.5 5.5 0 0116.313 3c2.973 0 5.437 2.322 5.437 5.25 0 3.925-2.438 7.111-4.739 9.256a25.175 25.175 0 01-4.244 3.17 15.247 15.247 0 01-.383.219l-.022.012-.007.004-.003.001a.752.752 0 01-.704 0z"/></svg>
              </button>
            </div>
            <div class="flex items-center gap-4 mb-10">
              <svg class="w-10 h-10 text-blue-400" fill="currentColor" viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
              <div>
                <h1 class="text-4xl font-bold text-white">{currentPersonName}</h1>
                <p class="text-gray-400 mt-1">{$t.appearsIn}</p>
              </div>
            </div>

            {#if isLoadingPerson}
              <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6 pr-4">
                {#each Array(12).fill(0) as _}
                  <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg animate-pulse"></div>
                {/each}
              </div>
            {:else if personGroups.length > 0}
              {#each personGroups as group}
                <h2 class="text-2xl font-bold text-white mb-4 mt-2">{group.label}</h2>
                <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6 pr-4 mb-10">
                  {#each group.items as item}
                    <button on:click={() => showItemDetails(item)}
                      use:longPress on:longpress={() => openContextMenu(item)}
                      class="group focus:outline-none text-left cv-auto">
                      <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg overflow-hidden border-4 border-transparent group-focus:border-white shadow-xl relative">
                        {#if getItemImageUrl(item)}
                          <img src={getItemImageUrl(item)} use:blurUp={itemBlurHash(item)} alt={item.Name} class="w-full h-full object-cover" loading="lazy" decoding="async"/>
                        {/if}
                        {#if itemProgress(item) > 0}
                          <div class="absolute bottom-0 left-0 w-full h-1.5 bg-gray-900/80">
                            <div class="h-full bg-blue-500" style="width:{itemProgress(item)}%"></div>
                          </div>
                        {/if}
                      </div>
                      <span class="text-sm font-bold text-gray-300 group-focus:text-white block truncate w-full mt-2">
                        {item.Type === 'Episode' && item.SeriesName ? item.SeriesName : item.Name}
                      </span>
                      {#if item.Type === 'Episode'}
                        <span class="text-xs text-gray-500 block truncate w-full">{item.Name}</span>
                      {:else if item.ProductionYear}
                        <span class="text-xs text-gray-500 block truncate w-full">{item.ProductionYear}</span>
                      {/if}
                    </button>
                  {/each}
                </div>
              {/each}
            {:else}
              <div class="flex items-center justify-center h-64">
                <p class="text-2xl text-gray-500 font-bold">{$t.noItems}</p>
              </div>
            {/if}
          </div>

        {:else if viewState === 'favorites'}
          <div class="p-10 pt-16 h-full overflow-y-auto hide-scrollbar">
            <div class="flex items-center gap-4 mb-10">
              <svg class="w-10 h-10 text-blue-400" fill="currentColor" viewBox="0 0 24 24"><path d="M11.645 20.91l-.007-.003-.022-.012a15.247 15.247 0 01-.383-.218 25.18 25.18 0 01-4.244-3.17C4.688 15.36 2.25 12.174 2.25 8.25 2.25 5.322 4.714 3 7.688 3A5.5 5.5 0 0112 5.052 5.5 5.5 0 0116.313 3c2.973 0 5.437 2.322 5.437 5.25 0 3.925-2.438 7.111-4.739 9.256a25.175 25.175 0 01-4.244 3.17 15.247 15.247 0 01-.383.219l-.022.012-.007.004-.003.001a.752.752 0 01-.704 0z"/></svg>
              <h1 class="text-4xl font-bold text-white">{$t.favorites}</h1>
            </div>

            {#if isLoadingFavorites}
              <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6 pr-4">
                {#each Array(12).fill(0) as _}
                  <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg animate-pulse"></div>
                {/each}
              </div>
            {:else if favoriteItems.length > 0}
              <div bind:this={favoritesGrid}>
                {#each favGroups as group (group.key)}
                  {#if group.items.length > 0}
                    <h2 class="text-3xl font-bold text-white mb-6 px-2">{group.label}</h2>
                    <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6 pr-4 mb-12">
                      {#each group.items as item (item.Id)}
                        <button on:click={() => showItemDetails(item)}
                          use:longPress on:longpress={() => openContextMenu(item)}
                          class="group focus:outline-none text-left cv-auto">
                          <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg overflow-hidden border-4 border-transparent group-focus:border-white shadow-xl relative">
                            {#if getItemImageUrl(item)}
                              <img src={getItemImageUrl(item)} use:blurUp={itemBlurHash(item)} alt={item.Name} class="w-full h-full object-cover" loading="lazy" decoding="async"/>
                            {/if}
                            {#if itemProgress(item) > 0}
                              <div class="absolute bottom-0 left-0 w-full h-1.5 bg-gray-900/80">
                                <div class="h-full bg-blue-500" style="width:{itemProgress(item)}%"></div>
                              </div>
                            {/if}
                          </div>
                          <span class="text-sm font-bold text-gray-300 group-focus:text-white block truncate w-full mt-2">{item.Name}</span>
                          {#if item.ProductionYear}<span class="text-xs text-gray-500 block truncate w-full">{item.ProductionYear}</span>{/if}
                        </button>
                      {/each}
                    </div>
                  {/if}
                {/each}

                {#if favPersons.length > 0}
                  <h2 class="text-3xl font-bold text-white mb-6 px-2">{$t.people}</h2>
                  <div class="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-6 pr-4 mb-12">
                    {#each favPersons as p (p.Id)}
                      <button on:click={() => openPerson(p)} class="group focus:outline-none text-center cv-auto">
                        <div class="aspect-square w-full bg-gray-800 rounded-full overflow-hidden border-4 border-transparent group-focus:border-white shadow-xl">
                          {#if personImageUrl(serverUrl, p)}
                            <img src={personImageUrl(serverUrl, p)} use:blurUp={itemBlurHash(p)} alt={p.Name} class="w-full h-full object-cover" loading="lazy" decoding="async"/>
                          {:else}
                            <div class="w-full h-full flex items-center justify-center text-gray-600">
                              <svg class="w-16 h-16" fill="currentColor" viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
                            </div>
                          {/if}
                        </div>
                        <span class="mt-3 text-sm font-bold text-gray-300 group-focus:text-white truncate w-full block">{p.Name}</span>
                      </button>
                    {/each}
                  </div>
                {/if}
              </div>
            {:else}
              <div class="flex items-center justify-center h-64">
                <p class="text-2xl text-gray-500 font-bold">{$t.noItems}</p>
              </div>
            {/if}
          </div>
        {:else if viewState === 'collection'}
          <div class="p-10 pt-16 h-full overflow-y-auto hide-scrollbar">
            <div class="flex items-center gap-6 mb-8">
              <button on:click={() => viewState = collectionReturnView} use:focusOnMount
                class="bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 px-6 py-2 rounded-lg text-white font-bold focus:outline-none focus:ring-4 focus:ring-white">
                {$t.back}
              </button>
              {#if currentCollection?.Type === 'Playlist'}
                <button on:click={() => { playlistEditMode = !playlistEditMode; confirmDeletePlaylist = false; renamingPlaylist = false; }}
                  class="ml-auto px-6 py-2 rounded-lg font-bold focus:outline-none focus:ring-4 focus:ring-white transition-colors
                         {playlistEditMode ? 'bg-blue-600 text-white' : 'bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 text-white'}">
                  {playlistEditMode ? $t.done : $t.edit}
                </button>
              {/if}
            </div>
            <div class="flex items-center gap-4 mb-10">
              <svg class="w-10 h-10 text-blue-400" fill="currentColor" viewBox="0 0 24 24"><path d="M4 6h16v2H4zm2-4h12v2H6zm-4 8h20v10a2 2 0 01-2 2H4a2 2 0 01-2-2V10z"/></svg>
              <h1 class="text-4xl font-bold text-white">{currentCollectionName}</h1>
            </div>

            {#if isLoadingCollection}
              <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6 pr-4">
                {#each Array(12).fill(0) as _}
                  <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg animate-pulse"></div>
                {/each}
              </div>
            {:else if playlistEditMode}
              <div class="flex flex-col gap-2 pr-4 max-w-4xl">
                {#if collectionItems.length > 0}
                  {#each collectionItems as item, i (item.PlaylistItemId)}
                    <div class="flex items-center gap-4 bg-gray-800/60 rounded-xl p-3">
                      <div class="w-14 h-20 shrink-0 bg-gray-900 rounded-lg overflow-hidden">
                        {#if getItemImageUrl(item)}<img src={getItemImageUrl(item)} use:blurUp={itemBlurHash(item)} alt={item.Name} class="w-full h-full object-cover"/>{/if}
                      </div>
                      <div class="flex-1 min-w-0">
                        {#if item.Type === 'Episode'}
                          <div class="text-lg font-bold text-white truncate">{item.SeriesName || item.Name}</div>
                          <div class="text-sm text-gray-400 truncate">{episodeLabel(item)}</div>
                        {:else}
                          <div class="text-lg font-bold text-white truncate">{item.Name}</div>
                          {#if item.ProductionYear}<div class="text-sm text-gray-400">{item.ProductionYear}</div>{/if}
                        {/if}
                      </div>
                      <button on:click={() => movePlaylistItem(i, i - 1)} disabled={i === 0} title={$t.moveUp} aria-label={$t.moveUp}
                        class="p-3 rounded-lg text-gray-300 hover:bg-gray-700 focus:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-white disabled:opacity-30 disabled:cursor-not-allowed">
                        <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7"/></svg>
                      </button>
                      <button on:click={() => movePlaylistItem(i, i + 1)} disabled={i === collectionItems.length - 1} title={$t.moveDown} aria-label={$t.moveDown}
                        class="p-3 rounded-lg text-gray-300 hover:bg-gray-700 focus:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-white disabled:opacity-30 disabled:cursor-not-allowed">
                        <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
                      </button>
                      <button on:click={() => removePlaylistItem(item)} title={$t.remove} aria-label={$t.remove}
                        class="p-3 rounded-lg text-red-400 hover:bg-red-900/40 focus:bg-red-900/40 focus:outline-none focus:ring-2 focus:ring-red-500">
                        <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 7h12M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-7 0v12a1 1 0 001 1h6a1 1 0 001-1V7"/></svg>
                      </button>
                    </div>
                  {/each}
                {:else}
                  <p class="text-gray-500 font-bold py-6 text-center">{$t.noItems}</p>
                {/if}

                <!-- Playlist verwalten: Umbenennen / Löschen (auch bei leerer Liste erreichbar) -->
                <div class="mt-4 border-t border-gray-700/70 pt-4">
                  {#if renamingPlaylist}
                    <div class="flex flex-col gap-2">
                      <div class="flex items-center gap-3 flex-wrap">
                        <input
                          bind:value={renameValue}
                          use:focusOnMount
                          maxlength="100"
                          on:input={() => renameError = false}
                          on:keydown={(e) => { if (e.key === 'Enter') savePlaylistName(); }}
                          class="flex-1 min-w-[220px] bg-gray-900 text-white text-lg px-4 py-3 rounded-lg border border-gray-600
                                 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                        />
                        <button on:click={savePlaylistName}
                          class="px-6 py-3 rounded-lg font-bold bg-blue-600 hover:bg-blue-500 focus:bg-blue-500 text-white focus:outline-none focus:ring-4 focus:ring-white transition-colors">
                          {$t.save}
                        </button>
                        <button on:click={() => renamingPlaylist = false}
                          class="px-6 py-3 rounded-lg font-bold bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 text-white focus:outline-none focus:ring-4 focus:ring-white transition-colors">
                          {$t.cancel}
                        </button>
                      </div>
                      {#if renameError}
                        <p class="text-red-400 text-sm font-semibold">{$t.actionFailed}</p>
                      {/if}
                    </div>
                  {:else if confirmDeletePlaylist}
                    <div class="flex items-center gap-4 flex-wrap">
                      <span class="text-gray-200 font-semibold">{$t.deletePlaylistConfirm}</span>
                      <button on:click={deletePlaylist}
                        class="px-6 py-3 rounded-lg font-bold bg-red-600 hover:bg-red-500 focus:bg-red-500 text-white focus:outline-none focus:ring-4 focus:ring-white transition-colors">
                        {$t.deletePlaylist}
                      </button>
                      <button on:click={() => confirmDeletePlaylist = false} use:focusOnMount
                        class="px-6 py-3 rounded-lg font-bold bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 text-white focus:outline-none focus:ring-4 focus:ring-white transition-colors">
                        {$t.cancel}
                      </button>
                    </div>
                  {:else}
                    <div class="flex items-center gap-3 flex-wrap">
                      <button on:click={startRename}
                        class="flex items-center gap-3 px-6 py-3 rounded-lg font-bold bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 text-white focus:outline-none focus:ring-4 focus:ring-white transition-colors">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                        {$t.renamePlaylist}
                      </button>
                      <button on:click={() => confirmDeletePlaylist = true}
                        class="flex items-center gap-3 px-6 py-3 rounded-lg font-bold bg-red-900/40 hover:bg-red-900/60 focus:bg-red-900/60 text-red-300 hover:text-white focus:text-white focus:outline-none focus:ring-4 focus:ring-red-500 transition-colors">
                        <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 7h12M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-7 0v12a1 1 0 001 1h6a1 1 0 001-1V7"/></svg>
                        {$t.deletePlaylist}
                      </button>
                    </div>
                  {/if}
                </div>
              </div>
            {:else if collectionItems.length > 0}
              {@const groups = [
                { label: $t.movies,   items: collectionItems.filter(i => i.Type === 'Movie') },
                { label: $t.series,   items: collectionItems.filter(i => i.Type === 'Series') },
                { label: $t.episodes, items: collectionItems.filter(i => i.Type === 'Episode') },
                { label: '',          items: collectionItems.filter(i => !['Movie', 'Series', 'Episode'].includes(i.Type)) }
              ].filter(g => g.items.length)}
              <div class="flex flex-col gap-10 pr-4">
                {#each groups as group}
                  <div>
                    {#if groups.length > 1 && group.label}
                      <h2 class="text-2xl font-bold text-gray-400 mb-4">{group.label}</h2>
                    {/if}
                    <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
                      {#each group.items as item}
                        <button on:click={() => showItemDetails(item)}
                          use:longPress on:longpress={() => openContextMenu(item)}
                          class="group focus:outline-none text-left cv-auto">
                          <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg overflow-hidden border-4 border-transparent group-focus:border-white shadow-xl relative">
                            {#if getItemImageUrl(item)}
                              <img src={getItemImageUrl(item)} use:blurUp={itemBlurHash(item)} alt={item.Name} class="w-full h-full object-cover" loading="lazy" decoding="async"/>
                            {/if}
                            {#if itemProgress(item) > 0}
                              <div class="absolute bottom-0 left-0 w-full h-1.5 bg-gray-900/80">
                                <div class="h-full bg-blue-500" style="width:{itemProgress(item)}%"></div>
                              </div>
                            {/if}
                          </div>
                          {#if item.Type === 'Episode'}
                            <span class="text-sm font-bold text-gray-300 group-focus:text-white block truncate w-full mt-2">{item.SeriesName || item.Name}</span>
                            <span class="text-xs text-gray-500 block truncate w-full">{episodeLabel(item)}</span>
                          {:else}
                            <span class="text-sm font-bold text-gray-300 group-focus:text-white block truncate w-full mt-2">{item.Name}</span>
                            {#if item.ProductionYear}<span class="text-xs text-gray-500 block truncate w-full">{item.ProductionYear}</span>{/if}
                          {/if}
                        </button>
                      {/each}
                    </div>
                  </div>
                {/each}
              </div>
            {:else}
              <div class="flex items-center justify-center h-64">
                <p class="text-2xl text-gray-500 font-bold">{$t.noItems}</p>
              </div>
            {/if}
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
        <Player
          item={currentDetailItem}
          {serverUrl} {activeToken} {selectedUser} {playbackPrefs} {use24h} {serverVobSub}
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
          on:exit={() => viewState = 'details'}
          on:libchanged={refreshLibraries}
          on:next={(e) => handleNextEpisode(e.detail)}
          on:prev={(e) => handlePrevEpisode(e.detail)}
          on:syncplay={openSyncPlay}
        />
      {/key}
    </div>
  {/if}

  <!-- SYNCPLAY — Gruppen-Modal (über allem außer Screensaver) -->
  {#if showSyncPlay}
    <SyncPlayModal
      group={syncMyGroup}
      groups={syncGroups}
      loading={syncLoading}
      on:create={syncCreate}
      on:join={(e) => syncJoin(e.detail)}
      on:leave={syncLeave}
      on:refresh={syncRefresh}
      on:close={closeSyncPlay}
    />
  {/if}

  <!-- KONTEXTMENÜ — über allem außer Screensaver -->
  {#if contextItem}
    <ContextMenu
      item={contextItem}
      {serverUrl} {activeToken}
      userId={activeUserId}
      on:close={() => contextItem = null}
      on:changed={onContextChanged}
      on:openDetails={contextOpenDetails}
    />
  {/if}

  <!-- UHRZEIT — oben rechts, sichtbar im App-Betrieb außer im Player -->
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
    <Screensaver {use24h} {serverUrl} token={activeToken} userId={activeUserId}
      mode={screensaverSettings.mode} artSource={screensaverSettings.artSource} brightness={screensaverSettings.brightness}
      on:dismiss={resetActivity} />
  {/if}

</main>

<!-- ============================================================
     FILTER-MENÜ
============================================================ -->
{#if showSortMenu}
  <div data-focus-trap class="fixed inset-0 bg-black/90 z-[100] flex items-center justify-center p-8 animate-fade-in"
    on:keydown={(e) => { if (isBackKey(e)) { e.stopPropagation(); showSortMenu = false; } }}>
    <div class="bg-gray-800 border border-gray-700 p-10 rounded-2xl w-full max-w-xl flex flex-col gap-4 shadow-2xl">
      <div class="flex justify-between items-center mb-2">
        <h2 class="text-4xl text-white font-bold">{$t.sortBy}</h2>
        <button on:click={() => showSortMenu = false}
          class="text-gray-400 hover:text-white focus:text-white focus:outline-none focus:ring-4 focus:ring-white rounded-full p-2">
          <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>
      {#each sortOptions as opt}
        <button on:click={() => setSort(opt)}
          class="w-full text-left p-5 text-xl font-bold rounded-xl transition-colors flex items-center justify-between
                 focus:outline-none focus:ring-4 focus:ring-white
                 {currentSort.by === opt.by ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-200 hover:bg-blue-600 focus:bg-blue-600'}">
          <span>{$t[opt.key]}</span>
          {#if currentSort.by === opt.by}
            {#if opt.by === 'Random'}
              <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
            {:else}
              <!-- Pfeil zeigt aktuelle Richtung; erneutes Tippen kehrt um -->
              <span class="flex items-center gap-1 text-sm">
                {currentSort.order === 'Ascending' ? $t.sortAsc : $t.sortDesc}
                <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24">
                  {#if currentSort.order === 'Ascending'}
                    <path stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7"/>
                  {:else}
                    <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/>
                  {/if}
                </svg>
              </span>
            {/if}
          {/if}
        </button>
      {/each}
    </div>
  </div>
{/if}

{#if showFilterMenu}
  <div data-focus-trap class="fixed inset-0 bg-black/90 z-[100] flex items-center justify-center p-8 animate-fade-in">
    <div class="bg-gray-800 border border-gray-700 rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl">

      <!-- Kopf (fix) -->
      <div class="flex justify-between items-center p-8 pb-4 shrink-0">
        <h2 class="text-4xl text-white font-bold">{$t.filter}</h2>
        <button on:click={() => showFilterMenu = false}
          class="text-gray-400 hover:text-white focus:text-white focus:outline-none focus:ring-4 focus:ring-white rounded-full p-2">
          <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <!-- Inhalt: scrollt als ein Bereich (kein verschachteltes Chip-Scrollen) -->
      <div class="flex-1 overflow-y-auto hide-scrollbar px-8 flex flex-col gap-6">

        <!-- Status als kompakte Chips -->
        <div class="flex flex-col gap-3">
          <h3 class="text-lg font-bold text-gray-400 uppercase tracking-wider">{$t.status}</h3>
          <div class="flex flex-wrap gap-3">
            {#each [['isFavorite', $t.filterFavorites],['isNotPlayed', $t.filterUnplayed],['isPlayed', $t.filterPlayed]] as [key, label]}
              <button on:click={() => toggleFilter(key)}
                class="px-5 py-2 rounded-full font-bold text-lg border-2 transition-all focus:outline-none focus:ring-4 focus:ring-white
                       {activeFilters[key] ? 'bg-blue-600 border-blue-400 text-white' : 'bg-gray-900 border-gray-700 text-gray-400 hover:bg-gray-700 hover:text-white'}">
                {label}
              </button>
            {/each}
          </div>
        </div>

        <!-- Altersfreigabe -->
        <div class="flex flex-col gap-3">
          <h3 class="text-lg font-bold text-gray-400 uppercase tracking-wider">{$t.ageRating}</h3>
          <div class="flex flex-wrap gap-3">
            {#each fskOptions as age}
              <button on:click={() => toggleFsk(age)}
                class="px-5 py-2 rounded-full font-bold text-lg border-2 transition-all focus:outline-none focus:ring-4 focus:ring-white
                       {selectedFsk.includes(age) ? 'bg-red-700 border-red-500 text-white' : 'bg-gray-900 border-gray-700 text-gray-400 hover:bg-gray-700 hover:text-white'}">
                FSK {age}
              </button>
            {/each}
          </div>
        </div>

        <!-- Genres: fließen im scrollbaren Inhalt, kein eigenes Mini-Scrollfeld -->
        {#if availableGenres.length > 0}
          <div class="flex flex-col gap-3 pb-2">
            <h3 class="text-lg font-bold text-gray-400 uppercase tracking-wider">{$t.genres}</h3>
            <div class="flex flex-wrap gap-3">
              {#each availableGenres as genre}
                <button on:click={() => toggleGenre(genre.Name)}
                  class="px-5 py-2 rounded-full font-bold text-lg border-2 transition-all focus:outline-none focus:ring-4 focus:ring-white
                         {selectedGenres.includes(genre.Name) ? 'bg-blue-600 border-blue-400 text-white' : 'bg-gray-900 border-gray-700 text-gray-400 hover:bg-gray-700 hover:text-white'}">
                  {genre.Name}
                </button>
              {/each}
            </div>
          </div>
        {/if}

      </div>

      <!-- Fußzeile (fix) -->
      <div class="p-8 pt-4 shrink-0">
        <button on:click={() => showFilterMenu = false}
          class="w-full bg-gray-700 hover:bg-gray-600 text-white font-bold text-xl py-5 rounded-xl
                 focus:outline-none focus:ring-4 focus:ring-white transition-colors">
          {$t.filterClose}
        </button>
      </div>

    </div>
  </div>
{/if}
