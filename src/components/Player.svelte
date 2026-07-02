<script>
  import { i18n } from '../i18n.svelte.js';
  import { isBackKey, focusOnMount, authHeaders, dlog, uiFade, dropTrapOnOutro } from '../utils.js';
  import { session } from '../session.svelte.js';
  import { getPlaybackInfoFast, prefetchPlaybackInfo, resolveStream, externalSubtitleUrl, graphicSubtitleUrl, assSubtitleUrl } from '../playback.js';
  import { sendSyncCommand, setSyncQueue, sendSyncBuffering, sendSyncReady } from '../syncplay.js';
  import { PgsRenderer, VobSubRenderer, initWasm } from 'libbitsub';
  // ASS/SSA mit Original-Layout via assjs — schlanker DOM/CSS-Renderer (kein WASM/Worker). Synchronisiert
  // sich ans <video> (nur Zeit + Maße, KEINE Pixel → kein cross-origin-Taint, kein crossorigin am <video>).
  // Font-Fallback macht der Browser. Deckt fast alle ASS-Tags ab (Rest: VTT-Fallback über den Schalter).
  import ASS from 'assjs';
  import { onMount, onDestroy, tick } from 'svelte';
  import AddToPicker from './AddToPicker.svelte';

  let {
    item,
    selectedAudioIndex = $bindable(),
    selectedSubtitleIndex = $bindable(),
    mediaSourceId = null,   // gewählte Version (FullHD/4K); null = Server-Standard
    selectedUser,
    playbackPrefs = { autoSkipIntro: false, autoSkipCredits: false },
    use24h = true,   // Uhrzeit-Format (aus Einstellung) für die Uhr im Player
    showClock = true, // Uhr im Player anzeigen (folgt der Anzeige-Einstellung)
    showChapters = false, // Kapitelmarken auf der Leiste (Opt-in)
    seekStep = 30,        // Sprungweite der Vor-/Zurück-Buttons in Sekunden (pro Profil)
    autoPlayStreak = 0,   // "Schaust du noch?": Folgen ohne Interaktion auto-gestartet (von App)
    syncPlayOpen = false, // SyncPlay-Modal offen (von App) → Wiedergabe solange pausieren …
    inSyncGroup  = false, // … außer in aktiver Gruppe: dann NICHT lokal pausieren
    syncCommand = null,   // letztes empfangenes SyncPlayCommand (von App)
    syncQueue   = null,   // aktueller Gruppen-Queue-Stand (von App)
    remoteCommand = null, // Admin-Fernsteuerung (Dashboard) (von App)
    serverVobSub = false, // Server liefert VobSub/DVD extern (.mks, Jellyfin 12.0+)?
    onExit, onPrev, onNext, onSyncplay, onLibChanged,   // Callback-Props (statt Events)
    onPlayState,          // meldet App den Wiedergabe-Status (für den Screensaver: pausiert → erlaubt)
  } = $props();

  let videoElement;
  let playerContainer;
  let settingsPanel = $state();       // bind für Auto-Fokus auf WebOS
  let playPauseBtn;        // bind: damit ▼ von der Leiste direkt hierher springt
  let seekBarEl;           // bind: damit Links/Rechts bei verborgenem HUD direkt hierher springt
  let isPlaying  = $state(false);
  // Wiedergabe-Status nach außen melden (App unterdrückt den Screensaver nur bei AKTIVER Wiedergabe);
  // beim Unmount/Verlassen des Players sicher false melden, egal über welchen Weg ausgestiegen wird.
  $effect(() => {
    onPlayState?.(isPlaying);
    return () => onPlayState?.(false);
  });
  let currentTime = $state(0);
  let duration    = $state(0);

  // Scrubbing
  let isSeeking  = $state(false);
  let seekTime   = $state(0);
  let seekCommitTimer = null;   // gebündeltes Spulen: erst nach kurzer Pause EINMAL springen
  let displayTime = $derived(isSeeking ? seekTime : currentTime);
  let seekPct = $derived(duration > 0 ? (displayTime / duration) * 100 : 0);

  // Rechte Zeit-Anzeige: tippbar, wechselt Gesamtdauer → Restzeit → Endzeit (dezent, kein neues Element)
  let timeMode = $state('total');
  function cycleTimeMode() {
    timeMode = timeMode === 'total' ? 'remaining' : timeMode === 'remaining' ? 'end' : 'total';
    resetControlsTimeout();
  }
  let rightTimeLabel = $derived.by(() => {
    if (!duration) return formatTime(0);
    if (timeMode === 'remaining') return '-' + formatTime(Math.max(0, duration - displayTime));
    if (timeMode === 'end') {
      const end = new Date(Date.now() + Math.max(0, duration - currentTime) * 1000);
      return end.toLocaleTimeString(i18n.lang === 'de' ? 'de-DE' : 'en-US', { hour: '2-digit', minute: '2-digit', hour12: !use24h });
    }
    return formatTime(duration);
  });

  // Uhrzeit (oben rechts, nur sichtbar wenn Steuerung eingeblendet — schont OLED)
  let clockNow = $state('');
  let clockTimer;
  function updateClock() {
    clockNow = new Date().toLocaleTimeString(i18n.lang === 'de' ? 'de-DE' : 'en-US',
      { hour: '2-digit', minute: '2-digit', hour12: !use24h });
  }
  $effect(() => { i18n.lang; use24h; updateClock(); });

  // Ladeanimation + Fehlerzustand
  let isBuffering = $state(true);
  let playbackError = $state(false);     // zeigt Fehlermeldung statt endlosem Spinner
  let bufferWatchdog = null;

  // Wenn die Wiedergabe WIRKLICH hängt (Stall ohne 'error'-Event), Fehler anzeigen.
  // Wichtig: nur wenn die Zeit seit dem Start des Watchdogs NICHT vorangekommen ist —
  // sonst würde ein kurzer Puffer-Moment mitten in laufender Wiedergabe fälschlich
  // nach 30 s einen Fehler auslösen.
  let watchdogAnchor = 0;
  function armBufferWatchdog() {
    clearTimeout(bufferWatchdog);
    watchdogAnchor = videoElement?.currentTime ?? 0;
    bufferWatchdog = setTimeout(() => {
      const progressed = (videoElement?.currentTime ?? 0) > watchdogAnchor + 0.5;
      if (videoElement?.paused) {
        isBuffering = false;          // pausiert ist KEIN Fehler (z.B. Nutzer-Pause am Anfang / Gruppen-Pause)
      } else if (progressed) {
        isBuffering = false;          // läuft doch → kein Fehler
      } else if (isBuffering) {
        playbackError = true; isBuffering = false;
      }
      bufferWatchdog = null;
    }, 30000);
  }
  function clearBufferWatchdog() { clearTimeout(bufferWatchdog); bufferWatchdog = null; }

  // Mini-Aussetzer (< ~300 ms) sollen den Spinner nicht aufblitzen lassen → verzögert einblenden.
  let spinnerTimer = null;
  function clearSpinner() { if (spinnerTimer) { clearTimeout(spinnerTimer); spinnerTimer = null; } }

  function onPlayable() {            // canplay / playing
    clearSpinner();
    isBuffering = false;
    playbackError = false;
    clearBufferWatchdog();
  }
  function onWaiting() {             // waiting / stalled
    if (videoElement?.paused) return;   // pausiert ist KEIN Puffern → kein Spinner
    armBufferWatchdog();
    if (isBuffering || spinnerTimer) return;
    spinnerTimer = setTimeout(() => {
      spinnerTimer = null;
      if (!videoElement?.paused) isBuffering = true;
    }, 300);
  }
  // Diagnose-Logger für <video>-Lebenszyklus-Events
  function vlog(ev, extra) {
    dlog(`[OcenFin] video:${ev}`, { method: playMethod, t: Math.round(videoElement?.currentTime || 0), ...(extra || {}) });
  }
  // Läuft die Zeit, läuft die Wiedergabe → Pufferzustand sicher aufheben.
  function onProgressTick() {
    clearSpinner();
    if (isBuffering) { isBuffering = false; clearBufferWatchdog(); }
  }
  function onVideoError() {
    // MediaError-Code hilft bei der Diagnose: 3 = DECODE (Codec/Decoder),
    // 4 = SRC_NOT_SUPPORTED (Format/Container), 2 = NETWORK.
    const err = videoElement?.error;
    console.error('[OcenFin] <video> error:', { code: err?.code, message: err?.message, playMethod });
    // Direct Play am Gerät gescheitert (z.B. MKV-Demux/Audio nicht abspielbar) →
    // EINMALIG auf Transcode zurückfallen, statt sofort die Fehlerseite zu zeigen.
    // Genau dieses "erst Direct Play versuchen, dann transkodieren" machen LiteFin/Breezefin.
    if (playMethod !== 'Transcode' && !triedTranscodeFallback) {
      triedTranscodeFallback = true;
      console.warn('[OcenFin] Direct Play failed → forcing transcode fallback');
      clearBufferWatchdog();
      isBuffering = true; playbackError = false;
      setupPlayback(selectedAudioIndex, selectedSubtitleIndex, true);
      return;
    }
    clearBufferWatchdog();
    isBuffering = false;
    playbackError = true;
    flushProgress();          // Position auch bei Wiedergabefehler sichern
  }
  function retryPlayback() {
    playbackError = false;
    isBuffering = true;
    resumeApplied = false;          // beim Neuversuch ggf. wieder an die Position springen
    if (videoElement) { videoElement.load(); videoElement.play(); }
    armBufferWatchdog();
  }

  // UI
  let showControls  = $state(true);
  let showSettings  = $state(false);
  let controlOpener = null;        // Button, der Panel/Picker geöffnet hat → Fokus kehrt dorthin zurück
  let pickerMode    = $state(null);        // null | 'collection' | 'playlist' – steuert <AddToPicker>
  let wasPlayingBeforePicker = false;
  // Beim Öffnen des "Hinzufügen"-Dialogs pausieren (läuft sonst im Hintergrund weiter).
  function openPicker(mode) {
    const el = document.activeElement;
    if (el instanceof HTMLElement) controlOpener = el;   // Fokus später dorthin zurück
    wasPlayingBeforePicker = isPlaying;
    videoElement?.pause();
    pickerMode = mode;
  }
  // SyncPlay-Modal offen → wie beim Picker pausieren — aber NICHT im aktiven Gruppen-Sync
  // (dort würde ein lokales Pausieren den Gleichlauf stören). Resümee beim Schließen.
  let wasPlayingBeforeSync = false;
  let _prevSyncOpen = false;
  $effect(() => { if (syncPlayOpen !== _prevSyncOpen) { onSyncPlayToggle(syncPlayOpen); _prevSyncOpen = syncPlayOpen; } });
  function onSyncPlayToggle(open) {
    if (open) {
      if (inSyncGroup) return;
      wasPlayingBeforeSync = isPlaying;
      videoElement?.pause();
    } else {
      if (wasPlayingBeforeSync) {
        videoElement?.play().catch(() => {});
        wasPlayingBeforeSync = false;
      }
      // Fokus zurück in den Player + HUD zeigen. Ohne das bleibt der Fokus am
      // geschlossenen SyncPlay-Dialog hängen und der Player nimmt keine Eingaben mehr an.
      resetControlsTimeout();
      tick().then(() => playerContainer?.focus());
    }
  }

  // ── SyncPlay-Engine (Phase 2a): lokale Aktionen senden + empfangene Kommandos anwenden ──
  let syncReady        = false;   // erst nach echtem Wiedergabe-Start senden (verhindert Senden beim Resume-Seek/Autostart)
  let syncQueueSet     = false;   // SetNewQueue für dieses Item bereits gesendet/bestätigt?
  let syncSuppressUntil = 0;      // Ausgehende Sendungen kurz unterdrücken, während ein empfangenes Kommando wirkt
  let _appliedSyncSeq  = 0;       // zuletzt angewendetes Kommando (Dedupe)
  let _expectSeekEcho  = false;   // nächstes 'seeked' stammt von einem empfangenen Kommando → nicht zurücksenden (robust auch bei langsamem Seek)
  let _groupWantsPaused = false;  // Gruppe hat zuletzt Pause befohlen → ungewolltes Auto-Play (Transcode-Neustart) zurücknehmen
  let _userPlayIntent  = 0;       // Zeitstempel einer echten Nutzer-Play-Aktion (Backstop)
  function posTicks() { return Math.round((videoElement?.currentTime || 0) * 10000000); }

  // Lokales Steuer-Ereignis an die Gruppe senden (außer es stammt gerade von einem empfangenen Kommando).
  function syncEmit(action) {
    if (!inSyncGroup || !syncReady) return;
    if (Date.now() < syncSuppressUntil) return;
    dlog('[SyncPlay] →', action, posTicks());
    sendSyncCommand(session.serverUrl, session.token, action, posTicks());
  }
  // Erster Start in einer Gruppe legt die Queue fest (Server spielt für alle los); spätere Plays = Unpause.
  async function onLocalPlay() {
    if (!inSyncGroup) return;
    // Transcode-Streams starten nach (Neu-)Laden ungewollt automatisch. Wenn die Gruppe pausiert ist
    // und kein echter Nutzer-Play vorliegt → wieder anhalten, nicht an die Gruppe melden.
    if (_groupWantsPaused && (Date.now() - _userPlayIntent) > 1500) {
      dlog('[SyncPlay] auto-play suppressed (group paused)');
      syncSuppressUntil = Date.now() + 600;
      videoElement?.pause();
      return;
    }
    _groupWantsPaused = false;
    if (syncQueueSet) { syncEmit('Unpause'); return; }
    syncQueueSet = true;
    if (syncQueue && syncQueue.itemId === item.Id) { syncReady = true; return; }  // Gruppe spielt dieses Item bereits
    dlog('[SyncPlay] → SetNewQueue', item.Id, posTicks());
    await setSyncQueue(session.serverUrl, session.token, item.Id, posTicks());
    syncReady = true;
  }
  function onLocalPause() { syncEmit('Pause'); }
  function onLocalSeeked() {
    if (_expectSeekEcho) { _expectSeekEcho = false; return; }   // Echo eines empfangenen Seeks → nicht zurücksenden
    syncEmit('Seek');
  }

  // Puffer-Handshake: dem Server melden, ob wir bereit sind. Buffering → Gruppe wartet; Ready → Freigabe.
  let _syncBuffering = false;
  let _syncReadySent = false;
  function syncReportBuffering() {
    if (!inSyncGroup || !syncQueue?.playlistItemId || _syncBuffering) return;
    _syncBuffering = true;
    dlog('[SyncPlay] → Buffering', posTicks());
    sendSyncBuffering(session.serverUrl, session.token, posTicks(), true, syncQueue.playlistItemId);
  }
  function syncReportReady() {
    if (!inSyncGroup || !syncQueue?.playlistItemId) return;
    if (!_syncBuffering && _syncReadySent) return;   // nichts Neues seit dem letzten Ready
    _syncBuffering = false; _syncReadySent = true;
    dlog('[SyncPlay] → Ready', posTicks());
    sendSyncReady(session.serverUrl, session.token, posTicks(), true, syncQueue.playlistItemId);
  }

  // Empfangenes Gruppen-Kommando anwenden (mit grobem Zeitbezug über "When"; Feinabgleich = Phase 2b).
  function applySyncCommand(cmd) {
    if (!cmd || cmd._seq === _appliedSyncSeq || !videoElement) return;
    _appliedSyncSeq = cmd._seq;
    const command = cmd.Command;
    const pos   = (cmd.PositionTicks || 0) / 10000000;
    const when  = cmd.When ? new Date(cmd.When).getTime() : Date.now();
    const delay = Math.max(0, when - Date.now());
    syncSuppressUntil = Date.now() + delay + 600;   // Backstop für Play/Pause-Folge-Events
    dlog('[SyncPlay] ← apply', command, 'pos', Math.round(pos), 'in', delay, 'ms');
    if (command === 'Seek') {
      _expectSeekEcho = true; videoElement.currentTime = pos; currentTime = pos;
    } else if (command === 'Pause') {
      _groupWantsPaused = true;
      if (Math.abs(videoElement.currentTime - pos) > 1) { _expectSeekEcho = true; videoElement.currentTime = pos; currentTime = pos; }
      videoElement.pause();
    } else if (command === 'Unpause') {
      _groupWantsPaused = false;
      if (Math.abs(videoElement.currentTime - pos) > 1) { _expectSeekEcho = true; videoElement.currentTime = pos; }
      setTimeout(() => videoElement?.play().catch(() => {}), delay);
    } else if (command === 'Stop') {
      _groupWantsPaused = true;
      videoElement.pause();
    }
  }
  $effect(() => { if (syncCommand && syncCommand._seq !== _appliedSyncSeq) applySyncCommand(syncCommand); });

  // ---- Admin-Fernsteuerung (Jellyfin-Dashboard) -------------------------------------------
  // Initial auf den aktuellen Stand setzen → vor dem Öffnen gesendete Befehle nicht nachträglich anwenden.
  let _appliedRemoteSeq = remoteCommand?._seq ?? 0;
  $effect(() => { if (remoteCommand && remoteCommand._seq !== _appliedRemoteSeq) applyRemoteCommand(remoteCommand); });
  function applyRemoteCommand(c) {
    if (!c || c._seq === _appliedRemoteSeq) return;
    _appliedRemoteSeq = c._seq;
    const cmd = (c.command || '').toString().toLowerCase();
    dlog('[OcenFin] admin remote:', cmd);
    if (cmd === 'pause') videoElement?.pause();
    else if (cmd === 'unpause') videoElement?.play().catch(() => {});
    else if (cmd === 'playpause') togglePlay();
    else if (cmd === 'stop') { videoElement?.pause(); onExit?.(); }
    else if (cmd === 'seek' && videoElement) {
      const t = Math.max(0, (c.seekTicks || 0) / 10000000);
      videoElement.currentTime = t; currentTime = t;
    }
    else if (cmd === 'nexttrack') { if (nextEpisode) goToNextEpisode(true); }
    else if (cmd === 'previoustrack') { if (prevEpisode) onPrev?.(prevEpisode); }
    // Lautstärke/Stummschaltung (GeneralCommand)
    else if (cmd === 'setvolume' && videoElement) { const v = parseInt(c.args?.Volume, 10); if (!isNaN(v)) videoElement.volume = Math.max(0, Math.min(1, v / 100)); }
    else if (cmd === 'volumeup'   && videoElement) videoElement.volume = Math.min(1, videoElement.volume + 0.1);
    else if (cmd === 'volumedown' && videoElement) videoElement.volume = Math.max(0, videoElement.volume - 0.1);
    else if ((cmd === 'mute' || cmd === 'unmute' || cmd === 'togglemute') && videoElement)
      videoElement.muted = cmd === 'mute' ? true : cmd === 'unmute' ? false : !videoElement.muted;
  }
  let settingsTab   = $state('audio');     // 'audio' | 'subtitle' — welcher Bereich im Panel gezeigt wird
  let controlsTimeout;
  let isFavorite = $state(item.UserData?.IsFavorite || false);

  // Playback
  let progressTimer;
  let startTicks    = item.UserData?.PlaybackPositionTicks || 0;
  let resumeApplied = false;   // Fortsetzen-Sprung nur einmal ausführen
  let playSessionId = crypto.randomUUID();  // wird durch PlaybackInfo ersetzt
  let playMethod    = $state('DirectPlay');         // DirectPlay | DirectStream | Transcode
  let triedTranscodeFallback = false;       // einmaliger Auto-Fallback wenn Direct Play am Gerät scheitert
  let hls           = null;                 // hls.js-Instanz (nur bei Transcode/HLS)
  let maxBitrate    = 120000000;            // 120 Mbit/s (lokales Netz) — Grenze für Direct Play
  // Beim Transkodieren (z. B. erzwungene ASS-Untertitel ins Bild brennen) ist die Quell-Bitrate
  // oft zu hoch (HEVC-Remuxe ~100+ Mbit/s) → Echtzeit-Transcode stockt (fragLoadTimeOut/bufferStalled).
  // Daher das Transcode-Ziel deckeln; Direct Play bleibt unbegrenzt (B4 dekodiert nativ).
  const TRANSCODE_MAX_BITRATE = 20000000;   // 20 Mbit/s — hohe 1080p-Qualität, gut transkodierbar

  // Nach 'loadedmetadata' an die Fortsetzen-Position springen (Datei ist dann seekbar).
  function seekToResume() {
    duration = videoElement?.duration ?? 0;
    if (!resumeApplied && startTicks > 0 && videoElement) {
      resumeApplied = true;
      videoElement.currentTime = startTicks / 10000000;
    }
  }

  // Streams
  let mediaStreams   = $state([]);
  let currentMediaSource = null;   // aktuell laufende Quelle – für den Instant-Switch von Textuntertiteln
  let audioStreams = $derived(mediaStreams.filter(s => s.Type === 'Audio'));
  let subtitleStreams = $derived(mediaStreams.filter(s => s.Type === 'Subtitle'));

  // --- Wiedergabeinfo-Overlay (opt-in via playbackPrefs.showPlaybackInfo) ---------------------
  let showInfoOverlay = $state(false);
  let infoInterval    = null;
  let liveStats       = $state({ bufferAhead: 0, dropped: 0, total: 0, width: 0, height: 0 });
  let infoVideoStream = $derived(mediaStreams.find(s => s.Type === 'Video'));
  let infoAudioStream = $derived((selectedAudioIndex >= 0)
        ? mediaStreams.find(s => s.Index === selectedAudioIndex)
        : (mediaStreams.find(s => s.Type === 'Audio' && s.IsDefault) || mediaStreams.find(s => s.Type === 'Audio')));
  let playMethodLabel = $derived(playMethod === 'Transcode' ? 'Transcode' : (playMethod === 'DirectStream' ? 'Direct Stream' : 'Direct Play'));
  let playMethodColor = $derived(playMethod === 'Transcode' ? 'text-amber-400' : (playMethod === 'DirectStream' ? 'text-sky-400' : 'text-green-400'));
  const fmtBitrate = (bps) => bps ? (bps >= 1e6 ? (bps/1e6).toFixed(1) + ' Mbit/s' : Math.round(bps/1e3) + ' kbit/s') : null;
  function updateLiveStats() {
    if (!videoElement) return;
    let ahead = 0;
    try {
      const b = videoElement.buffered, t = videoElement.currentTime;
      for (let i = 0; i < b.length; i++) { if (t >= b.start(i) && t <= b.end(i)) { ahead = b.end(i) - t; break; } }
    } catch {}
    let dropped = 0, total = 0;
    try { const q = videoElement.getVideoPlaybackQuality?.(); if (q) { dropped = q.droppedVideoFrames; total = q.totalVideoFrames; } } catch {}
    liveStats = { bufferAhead: Math.round(ahead), dropped, total, width: videoElement.videoWidth || 0, height: videoElement.videoHeight || 0 };
  }
  function toggleInfoOverlay() {
    showInfoOverlay = !showInfoOverlay;
    if (showInfoOverlay) { updateLiveStats(); infoInterval = setInterval(updateLiveStats, 1000); }
    else if (infoInterval) { clearInterval(infoInterval); infoInterval = null; }
  }

  // --- Trickplay: Vorschaubilder beim Spulen (Jellyfin 10.9+) -------------------------------
  // Jellyfin liefert Kachel-Sheets (z. B. 10×10 Thumbnails/Bild). Wir berechnen pro Zeit das
  // richtige Sheet + die Position darin und schneiden es per background-position aus. Sheets
  // bleiben im Browser-Cache → flüssiges Scrubben, nur an Sheet-Grenzen wird neu geladen.
  let trickplayInfo = $state(null);   // { width, Width, Height, TileWidth, TileHeight, ThumbnailCount, Interval }
  let trickplayMsId = null;
  function parseTrickplay(data) {
    trickplayInfo = null; trickplayMsId = null;
    const tp = data?.Trickplay;
    if (!tp) return;
    // mediaSourceId-Schlüssel: bevorzugt die laufende Quelle, sonst der erste Eintrag.
    const srcId = data.MediaSources?.[0]?.Id;
    const msId  = (srcId && tp[srcId]) ? srcId : Object.keys(tp)[0];
    const byWidth = msId && tp[msId];
    if (!byWidth) return;
    const w = Object.keys(byWidth).map(Number).filter(n => !isNaN(n)).sort((a, b) => b - a)[0]; // größte Breite
    if (!w || !byWidth[String(w)]) return;
    trickplayInfo = { width: w, ...byWidth[String(w)] };
    trickplayMsId = msId;
  }
  let trickplayTile = $derived((isSeeking && playbackPrefs.trickplay !== false && trickplayInfo && duration > 0) ? computeTrickplayTile(seekTime) : null);
  function computeTrickplayTile(t) {
    const { Interval, TileWidth, TileHeight, Width, Height, width, ThumbnailCount } = trickplayInfo;
    if (!Interval || !TileWidth || !TileHeight || !Width || !Height) return null;
    const idx     = Math.min(Math.max(0, Math.floor((t * 1000) / Interval)), (ThumbnailCount || 1) - 1);
    const perTile = TileWidth * TileHeight;
    const sheet   = Math.floor(idx / perTile);
    const local   = idx % perTile;
    return {
      url: `${session.serverUrl}/Videos/${item.Id}/Trickplay/${width}/${sheet}.jpg?ApiKey=${session.token}&MediaSourceId=${trickplayMsId}`,
      x: (local % TileWidth) * Width,
      y: Math.floor(local / TileWidth) * Height,
      w: Width, h: Height,
    };
  }

  // ============================================================
  // WIEDERGABE-AUFBAU — PlaybackInfo entscheidet Direct Play vs. Transcode
  // ============================================================

  // Holt die Server-Entscheidung und hängt die passende Quelle ans <video>.
  // Bei Fehlern: Fallback auf die alte Direct-Play-Logik (Verhalten wie zuvor).
  async function setupPlayback(audioIndex, subtitleIndex, forceTranscode = false) {
    if (hls) { try { hls.destroy(); } catch {} hls = null; }
    if (!forceTranscode) triedTranscodeFallback = false;   // frischer Versuch → Fallback wieder erlauben
    try {
      // Für die Direct-Play-Entscheidung brauchen wir die Tonspuren des Titels. Beim Sprung über
      // "nächste Folge" trägt das Episodenobjekt (aus der leichten Folgenliste) KEINE MediaStreams →
      // einmalig nachladen, sonst schlägt die Standard-Audio-Erkennung fehl und es wird fälschlich
      // transkodiert (während Direktstart aus den Details direkt läuft).
      let titleStreams = (item?.MediaStreams?.length ? item.MediaStreams : mediaStreams) || [];
      if (!titleStreams.length && item?.Id) {
        try {
          const r = await fetch(`${session.serverUrl}/Users/${selectedUser.Id}/Items/${item.Id}?Fields=MediaStreams`, { headers: getAuthHeaders() });
          if (r.ok) { const full = await r.json(); if (full?.MediaStreams?.length) titleStreams = full.MediaStreams; }
        } catch {}
      }
      // Audio gilt nur dann als "explizit" (→ Transcode, damit der Server die GEWÄHLTE Spur ausgibt),
      // wenn die Standardspur BEKANNT ist UND die gewählte davon abweicht. Ist die Standardspur
      // unbekannt (keine Streams), wird NICHT transkodiert — Direct Play hat Vorrang.
      const allStreams = titleStreams;
      const audioTracks = allStreams.filter(s => s.Type === 'Audio');
      const defaultAudioIndex = (audioTracks.find(s => s.IsDefault) || audioTracks[0])?.Index ?? -1;
      const explicitAudio = audioIndex !== -1 && defaultAudioIndex !== -1 && audioIndex !== defaultAudioIndex;
      // Ein Untertitel erzwingt nur dann einen Transcode, wenn er GEBRANNT wird:
      // Textuntertitel nur bei aktiviertem Einbrennen, Grafikuntertitel (PGS/VobSub) immer.
      // Externe Textuntertitel (VTT-Overlay) brauchen KEINEN Transcode → Direct Play bleibt möglich,
      // und der Untertitelwechsel kann weich (ohne Neuladen) erfolgen.
      const subStreams = allStreams;
      const subStream  = subtitleIndex !== -1 ? subStreams.find(s => s.Index === subtitleIndex && s.Type === 'Subtitle') : null;
      const subCodec    = (subStream?.Codec || '').toLowerCase();
      const isPgsSub    = ['pgssub', 'pgs'].includes(subCodec);
      const isVobSub    = ['dvdsub', 'vobsub', 'sub'].includes(subCodec);          // DVD/VobSub → .mks ab 12.0
      const isGraphicSub = isPgsSub || isVobSub || ['dvbsub'].includes(subCodec);
      // libbitsub rendert clientseitig (wenn aktiviert): PGS immer, VobSub erst wenn der Server
      // .mks liefert (Jellyfin 12.0+). Sonst muss der Grafik-Untertitel gebrannt werden.
      const graphicClientRender = clientGraphicRender && (isPgsSub || (isVobSub && serverVobSub));
      const subWillBurn = subtitleIndex !== -1 && (playbackPrefs.burnSubtitles || (isGraphicSub && !graphicClientRender));

      const enableDirectPlay = !explicitAudio && !subWillBurn && !forceTranscode;
      // Bei explizitem Audiowechsel/gebranntem Untertitel: DirectStream AUS + Audio NEU kodieren → der
      // Server gibt garantiert die GEWÄHLTE Spur aus, statt die Standardspur (deutsch) zu kopieren.
      const enableDirectStream = !explicitAudio && !subWillBurn && !forceTranscode;
      const allowAudioStreamCopy = !explicitAudio;
      dlog('[OcenFin] setupPlayback →', { item: item?.Name, audioIndex, subtitleIndex, enableDirectPlay, enableDirectStream, allowAudioStreamCopy, forceTranscode });
      // Direct Play: volle Bitrate; Transcode: deckeln, damit der Server in Echtzeit mitkommt.
      const requestBitrate = enableDirectPlay ? maxBitrate : Math.min(maxBitrate, TRANSCODE_MAX_BITRATE);
      const info = await getPlaybackInfoFast({
        serverUrl: session.serverUrl, userId: selectedUser.Id, token: session.token, itemId: item.Id,
        audioStreamIndex: audioIndex, subtitleStreamIndex: subtitleIndex,
        maxBitrate: requestBitrate, startTicks: 0,   // Resume passiert client-seitig (seekToResume)
        enableDirectPlay, enableDirectStream, allowAudioStreamCopy,
        burnSubtitles: playbackPrefs.burnSubtitles,
        clientGraphicSubs: clientGraphicRender, serverVobSub,
        mediaSourceId,
      });
      if (info.playSessionId) playSessionId = info.playSessionId;
      const ms = info.mediaSource;
      currentMediaSource = ms;   // für den fliegenden Untertitel-Wechsel merken
      const resolved = resolveStream({ serverUrl: session.serverUrl, token: session.token, itemId: item.Id, mediaSource: ms, audioStreamIndex: audioIndex, subtitleStreamIndex: subtitleIndex });
      playMethod = resolved.method;
      dlog('[OcenFin] resolveStream →', { method: resolved.method, isHls: resolved.isHls, url: resolved.url });
      // Warum transkodiert der Server? TranscodeReasons nennt es direkt (VideoCodecNotSupported,
      // AudioCodecNotSupported, ContainerBitrateExceedsLimit, SubtitleCodecNotSupported …).
      // Als warn → landet immer im Log-Puffer, auch ohne Debug-Modus.
      if (resolved.method === 'Transcode') {
        const reasons = ms?.TranscodeReasons;
        console.warn('[OcenFin] Transcode —', (Array.isArray(reasons) && reasons.length) ? reasons.join(', ') : 'reason not reported');
      }
      await attachSource(resolved.url, resolved.isHls);
      applySubtitleOverlay(subtitleIndex, ms);
    } catch (e) {
      console.error('PlaybackInfo failed, falling back to Direct Play:', e);
      playMethod = 'DirectPlay';
      const url = `${session.serverUrl}/Videos/${item.Id}/stream?static=true&ApiKey=${session.token}` +
                  (audioIndex !== -1 ? `&AudioStreamIndex=${audioIndex}` : '');
      await attachSource(url, false);
    }
  }

  // Hängt eine Quelle ans Video. HLS via hls.js, sofern der Browser HLS nicht nativ kann.
  async function attachSource(url, isHls) {
    if (!videoElement) return;
    isBuffering = true;
    playbackError = false;

    const nativeHls = videoElement.canPlayType('application/vnd.apple.mpegurl');
    if (isHls && !nativeHls) {
      try {
        const Hls = (await import('hls.js')).default;
        if (Hls.isSupported()) {
          // Mehr Vorauspuffer (60 s, bis 120 s bei freiem Netz) → robuster gegen Aussetzer auf
          // langsamem Netz/Server. backBufferLength klein halten (Speicher am TV schonen).
          hls = new Hls({ maxBufferLength: 60, maxMaxBufferLength: 120, enableWorker: true, backBufferLength: 30 });
          hls.loadSource(url);
          hls.attachMedia(videoElement);
          hls.on(Hls.Events.ERROR, (_e, data) => {
            // Ausführliche Diagnose: Typ, Detail, Codec-Hinweis, HTTP-Status
            console.error('[OcenFin] hls.js error:', {
              type: data?.type, details: data?.details, fatal: data?.fatal,
              reason: data?.reason || data?.err?.message,
              httpStatus: data?.response?.code, url: data?.url,
            });
            if (data?.fatal) onVideoError();
          });
        } else {
          videoElement.src = url;   // letzter Versuch nativ
        }
      } catch (err) {
        console.error('hls.js could not be loaded:', err);
        videoElement.src = url;
      }
    } else {
      videoElement.removeAttribute('src');
      videoElement.src = url;       // Direct Play oder nativer HLS-Player
      videoElement.load();
    }
    armBufferWatchdog();
    videoElement.play().catch(() => {});
  }

  // Externe Textuntertitel selbst rendern: VTT per fetch holen (Jellyfin erlaubt CORS) und
  // parsen, statt einen <track> zu setzen. Ein cross-origin <track> wird vom Browser blockiert,
  // und webOS rendert native Cues ohnehin unzuverlässig. So haben wir volle Kontrolle.
  let subtitleCues = $state([]);           // [{ start, end, text }] in Sekunden
  // Untertitel-Versatz (nur Text-Overlay = VTT/SRT/ASS-zu-VTT). + = Untertitel später (verzögert),
  // − = früher. Pro Spur/Titel zurückgesetzt; bewusst NICHT gespeichert (ist inhaltsspezifisch).
  let subtitleOffset = $state(0);
  function adjustSubtitleOffset(delta) {
    subtitleOffset = Math.round(Math.max(-10, Math.min(10, subtitleOffset + delta)) * 10) / 10;
  }
  function formatOffset(s) {
    return (s > 0 ? '+' : '') + s.toFixed(1).replace('.', ',') + ' s';
  }
  let subtitleFetchToken = 0;      // ignoriert Antworten eines überholten Wechsels
  let graphicRenderer = $state(null);      // libbitsub-Instanz für das aktuell sichtbare Bild-Untertitel-Overlay
  // Bild-Untertitel clientseitig rendern? Nur wenn aktiviert UND nicht ohnehin alles eingebrannt wird.
  let clientGraphicRender = $derived(playbackPrefs.pgsRendering && !playbackPrefs.burnSubtitles);
  // ASS/SSA mit Original-Layout rendern (assjs)? Aus → schlichtes Text-Overlay, beides Direct Play.
  let assRenderer = null;
  let assContainer = $state(null);  // Host-<div>; assjs injiziert hier sein DOM-Overlay (über dem Video)
  let clientAssRender = $derived(playbackPrefs.assRendering && !playbackPrefs.burnSubtitles);

  // Textuntertitel-Styling (NUR fürs .subtitle-box-Overlay = WebVTT/SRT). PGS/VobSub sind Bitmaps
  // (nur skalierbar), ASS bringt sein eigenes Styling mit. Defaults = bisheriges Verhalten.
  let subColor = $derived(({ white:'#ffffff', yellow:'#ffe14d', green:'#6dff6d', cyan:'#66e0ff' })[playbackPrefs.subtitleColor || 'white'] || '#ffffff');
  let subEdgeCss = $derived((playbackPrefs.subtitleEdge === 'outline')
        ? '-webkit-text-stroke:0.35vh #000;paint-order:stroke fill;text-shadow:0 0 3px rgba(0,0,0,.55);'
        : (playbackPrefs.subtitleEdge === 'none')
        ? 'text-shadow:none;'
        : 'text-shadow:0 1px 2px #000,0 2px 8px rgba(0,0,0,.95),0 0 4px rgba(0,0,0,.9);');
  let subBgCss = $derived((playbackPrefs.subtitleBackground === 'solid')
        ? 'background:#000;padding:0.05em 0.5em;border-radius:0.5vh;'
        : (playbackPrefs.subtitleBackground === 'semi')
        ? 'background:rgba(0,0,0,.6);padding:0.05em 0.5em;border-radius:0.5vh;'
        : 'background:transparent;');
  // VTT-Schriftart — bewusst IMMER explizit gesetzt (auch bei 'system' → Browser-Standard-Stack),
  // damit die UI-Schriftwahl (html-Ebene) nicht in die Untertitel durcherbt. ASS ist unberührt.
  let subFontCss = $derived(({ arimo: "font-family:'Arimo',sans-serif;",
                               noto:  "font-family:'Noto Sans',sans-serif;",
                               tinos: "font-family:'Tinos',serif;" })[playbackPrefs.subtitleFont]
        ?? 'font-family:ui-sans-serif,system-ui,sans-serif;');
  // -webkit-text-fill-color zusätzlich zu color: bei gesetztem -webkit-text-stroke bestimmt auf webOS die
  // FILL-Farbe das Rendering und fällt dort fälschlich auf Schwarz zurück, statt color zu erben → Untertitel
  // sonst schwarz trotz Farbwahl. Explizit setzen erzwingt die gewählte Farbe (am Desktop ohnehin no-op).
  let subStyle = $derived(`color:${subColor};-webkit-text-fill-color:${subColor};${subFontCss}${subEdgeCss}${subBgCss}`);

  // Untertitelgröße → libbitsub-Skalierung (Variante B: gilt für PGS UND VobSub, nicht nur VTT).
  function graphicSubScale() {
    const s = playbackPrefs.subtitleSize || 'normal';
    return s === 'small' ? 0.85 : s === 'large' ? 1.25 : 1.0;
  }
  // Dateiname-Hinweis, damit libbitsub das Format erkennt (PGS=.sup, VobSub=.mks via DeliveryUrl).
  function graphicSubFileName(url, stream) {
    const m = (url.split('?')[0] || '').match(/\.(\w+)$/);
    if (m) return `track.${m[1].toLowerCase()}`;
    const codec = (stream?.Codec || '').toLowerCase();
    return ['dvdsub', 'vobsub', 'sub'].includes(codec) ? 'track.mks' : 'track.sup';
  }

  // Untertitel anwenden – routet je nach Codec: PGS/VobSub → libbitsub-Overlay, Text → VTT-Overlay.
  function applySubtitleOverlay(index, ms) {
    subtitleFetchToken++;   // laufende VTT-Fetches invalidieren (sonst Text-Overlay neben Grafik/ASS)
    subtitleOffset = 0;     // neuer Spurwechsel → Versatz zurücksetzen (inhaltsspezifisch)
    if (index === -1 || !ms) { disposeGraphic(); clearAss(); subtitleCues = []; return; }
    const stream = (ms.MediaStreams || []).find(s => s.Index === index && s.Type === 'Subtitle');
    const codec  = (stream?.Codec || '').toLowerCase();
    const isPgs = ['pgssub', 'pgs'].includes(codec);
    const isVob = ['dvdsub', 'vobsub', 'sub'].includes(codec);
    const isAss = ['ass', 'ssa'].includes(codec);
    if (stream && clientGraphicRender && (isPgs || (isVob && serverVobSub))) {
      clearAss();
      subtitleCues = [];                    // kein VTT-Overlay daneben
      applyGraphicSubtitle(stream, ms);     // weicher Wechsel ohne Lücke (siehe unten)
    } else if (stream && isAss && clientAssRender && (stream.DeliveryMethod || '').toLowerCase() !== 'encode') {
      disposeGraphic();
      subtitleCues = [];                    // assjs rendert selbst → kein VTT-Overlay daneben
      applyAssSubtitle(stream, ms);         // Original-Layout (Positionen, Fonts, Typesetting)
    } else {
      disposeGraphic();                     // verlässt Grafik/ASS → Overlay sofort entfernen
      clearAss();
      applyExternalSubtitleIfNeeded(index, ms);   // Text → VTT (gebrannte Grafik → nichts zu tun)
    }
  }
  // ASS/SSA clientseitig mit vollem Styling rendern via assjs (DOM/CSS, kein WASM/Worker). assjs hängt sein
  // Overlay in assContainer und synchronisiert Zeit + Größe selbst ans <video> (liest KEINE Pixel → kein
  // cross-origin-Taint, kein crossorigin am <video>). Font-Fallback macht der Browser. resampling regelt das
  // Verhalten bei Script-Auflösung (PlayResX/Y) ≠ Videoauflösung (Letterbox); Default 'video_height' passt meist.
  // assjs kennt kein setTrack → Spurwechsel/Re-Apply per Neuaufbau (DOM-Overlay wird ent-/neu angehängt).
  async function applyAssSubtitle(stream, ms) {
    if (!videoElement || !assContainer) return;
    const url = assSubtitleUrl({ serverUrl: session.serverUrl, itemId: item.Id, mediaSourceId: ms.Id, stream, token: session.token });
    try {
      const res = await fetch(url);            // ApiKey steckt in der URL → einfacher GET, kein Preflight
      if (!res.ok) { console.warn('[OcenFin] ASS fetch failed:', res.status); return; }
      const content = await res.text();
      ensureVideoFrameCallback();               // webOS: rVFC-Polyfill aktiv, BEVOR assjs sie liest
      disposeAss();                            // kein setTrack → altes Overlay entfernen, frisch aufbauen
      assRenderer = new ASS(content, videoElement, { container: assContainer });
      // assjs treibt seine Render-Schleife per requestAnimationFrame, gestartet übers 'play'/'playing'-
      // Event des Videos. Bei einem Spurwechsel MITTEN in der Wiedergabe läuft das Video schon → es feuert
      // kein erneutes Event → die Schleife liefe nie an und der Untertitel bliebe auf dem Stand vom Umschalten
      // stehen. Darum einmalig anstoßen, wenn bereits abgespielt wird. ('playing' statt 'play': onplaying ist
      // nebenwirkungsfrei, onplay würde an SyncPlay melden.)
      if (!videoElement.paused) videoElement.dispatchEvent(new Event('playing'));
      // Das Overlay wird ASYNCHRON aufgebaut — also NACH changeTrack, das den Fokus schon gesetzt hatte.
      // Das Einhängen des assjs-DOM kann den Fokus verlieren; daher hier erneut sichern. Auf denselben
      // Auslöser-Button wie changeTrack (sichtbar + konsistent), nicht auf den unsichtbaren Container.
      if (!showSettings) restoreControlFocus();
      dlog('[OcenFin] ASS subtitle via assjs:', stream.Index, stream.Codec);
    } catch (e) { console.warn('[OcenFin] assjs error:', e?.message); }
  }
  // ASS ausblenden (Wechsel zu PGS/Text/aus): Overlay entfernen.
  function clearAss() { disposeAss(); }
  function disposeAss() {
    if (assRenderer) {
      try { assRenderer.destroy(); } catch {}
      assRenderer = null;
    }
  }
  // webOS meldet requestVideoFrameCallback als vorhanden (Feature-Detection wahr), ruft den Callback aber
  // NIE auf. Der Bug sitzt in LGs Media-Anbindung, nicht im Chromium → versionsunabhängig (am Desktop tritt
  // er nicht auf). assjs treibt damit seine Render-Schleife → ASS-Untertitel laufen am Desktop, frieren auf
  // dem TV aber auf dem Bild beim Aufbau ein. Darum auf webOS rVFC am <video> durch ein rAF-Polyfill
  // ersetzen, das wirklich zurückruft (60 fps reichen fürs Untertitel-Timing locker). Nur webOS — Desktop
  // behält seine native, bildgenaue rVFC. Idempotent.
  let rvfcPatched = false;
  function ensureVideoFrameCallback() {
    if (rvfcPatched || !videoElement) return;
    if (!window.webOSSystem && !window.webOS) { rvfcPatched = true; return; }  // kein webOS → native rVFC behalten
    videoElement.requestVideoFrameCallback = function (cb) {
      return requestAnimationFrame((now) => cb(now, {
        presentationTime: now, expectedDisplayTime: now,
        width: videoElement?.videoWidth || 0, height: videoElement?.videoHeight || 0,
        mediaTime: videoElement?.currentTime || 0, presentedFrames: 0, processingDuration: 0,
      }));
    };
    videoElement.cancelVideoFrameCallback = function (id) { cancelAnimationFrame(id); };
    rvfcPatched = true;
    dlog('[OcenFin] requestVideoFrameCallback per rAF-Polyfill ersetzt (webOS)');
  }
  function applyGraphicSubtitle(stream, ms) {
    if (!videoElement) return;
    const url = graphicSubtitleUrl({ serverUrl: session.serverUrl, itemId: item.Id, mediaSourceId: ms.Id, stream, token: session.token });
    if (!url) { disposeGraphic(); dlog('[OcenFin] image subtitle not available (server does not provide it externally):', stream.Index); return; }
    // TV-freundlich: STRENG SEQUENZIELL. Erst den alten Renderer restlos zerstören (Worker/WASM freigeben),
    // dann den neuen erzeugen. Auf WebOS sind zwei gleichzeitige WASM-Worker riskant (Limit → libbitsub
    // flüchtet in den Main-Thread → 2–3 s Freeze). Eine kurze Lücke beim manuellen Wechsel ist akzeptabel.
    disposeGraphic();
    const codec = (stream?.Codec || '').toLowerCase();
    const opts = {
      video: videoElement, subUrl: url,
      displaySettings: { scale: graphicSubScale(), aspectMode: 'contain' },
      onWarning: (w) => dlog('[OcenFin] libbitsub notice:', w?.code || w?.message || w),
      onError: (e) => { dlog('[OcenFin] libbitsub error:', e?.code || '', e?.message || e); disposeGraphic(); },
      onEvent: (ev) => {
        // backend 'worker' = off-main-thread (gut); alles andere = Main-Thread-Fallback (Freeze-Ursache auf TV).
        // Beides immer ins Protokoll (console.warn), damit der B4-Backend-Zustand auch ohne Debug sichtbar ist.
        if (ev?.type === 'renderer-change') console.warn('[OcenFin] libbitsub backend:', ev.renderer);
        else if (ev?.type === 'worker-state') console.warn('[OcenFin] libbitsub worker-state:', ev.state ?? ev);
        else if (ev?.type === 'loaded') dlog('[OcenFin] libbitsub loaded:', ev.format, 'cues=' + (ev.metadata?.cueCount ?? '?'));
      },
    };
    try {
      // Codec ist bekannt → expliziten Renderer wählen (keine Format-Auto-Erkennung nötig).
      graphicRenderer = ['pgssub', 'pgs'].includes(codec)
        ? new PgsRenderer(opts)
        : new VobSubRenderer({ ...opts, fileName: graphicSubFileName(url, stream) });   // VobSub/DVD: .mks-Container
      dlog('[OcenFin] image subtitle via libbitsub:', stream.Index, stream.Codec);
    } catch (e) { dlog('[OcenFin] libbitsub renderer error:', e?.message); disposeGraphic(); }
  }
  function disposeGraphic() {
    if (graphicRenderer) { try { graphicRenderer.dispose(); } catch {} graphicRenderer = null; }
  }
  // Größenänderung zur Laufzeit live auf den laufenden Renderer anwenden.
  $effect(() => { if (graphicRenderer && (playbackPrefs.subtitleSize || 'normal')) {
    const sc = graphicSubScale();
    try { graphicRenderer.setDisplaySettings({ scale: sc }); } catch {}
  } });

  // VTT-Zeitstempel "HH:MM:SS.mmm" oder "MM:SS.mmm" → Sekunden
  function parseVttTime(t) {
    const p = t.split(':');
    if (p.length === 3) return (+p[0]) * 3600 + (+p[1]) * 60 + parseFloat(p[2]);
    if (p.length === 2) return (+p[0]) * 60 + parseFloat(p[1]);
    return parseFloat(t);
  }
  function parseVtt(text) {
    const cues = [];
    const blocks = text.replace(/\r/g, '').split('\n\n');
    for (const block of blocks) {
      const lines = block.split('\n').filter(l => l.length);
      const tlIdx = lines.findIndex(l => l.includes('-->'));
      if (tlIdx === -1) continue;
      const times = lines[tlIdx].split('-->');
      const start = parseVttTime(times[0].trim().split(/\s+/)[0]);
      const end   = parseVttTime(times[1].trim().split(/\s+/)[0]);
      const txt = lines.slice(tlIdx + 1).join('\n').replace(/<[^>]+>/g, '').trim();
      if (txt && !isNaN(start) && !isNaN(end)) cues.push({ start, end, text: txt });
    }
    return cues;
  }

  // Aktiven Cue aus der aktuellen Zeit ableiten (reaktiv, folgt currentTime)
  let currentSubtitleText = $derived(subtitleCues.length
    ? (subtitleCues.find(c => (currentTime - subtitleOffset) >= c.start && (currentTime - subtitleOffset) <= c.end)?.text ?? '')
    : '');

  async function applyExternalSubtitleIfNeeded(index, ms) {
    subtitleCues = [];
    const myToken = ++subtitleFetchToken;
    if (!videoElement) return;
    if (index === -1 || !ms) return;
    const stream = (ms.MediaStreams || []).find(s => s.Index === index && s.Type === 'Subtitle');
    if (!stream) return;
    const method = (stream.DeliveryMethod || '').toLowerCase();
    const graphic = ['pgssub', 'dvdsub', 'pgs', 'dvbsub', 'vobsub', 'sub'].includes((stream.Codec || '').toLowerCase());
    if (method === 'encode' || graphic) return;   // gebrannt oder Grafik-Untertitel → kein VTT-Overlay

    const url = externalSubtitleUrl({ serverUrl: session.serverUrl, itemId: item.Id, mediaSourceId: ms.Id, stream, token: session.token });
    try {
      const res = await fetch(url);
      if (!res.ok || myToken !== subtitleFetchToken) return;   // überholt oder Fehler
      const text = await res.text();
      if (myToken !== subtitleFetchToken) return;
      subtitleCues = parseVtt(text);
      dlog('[OcenFin] subtitles loaded:', subtitleCues.length, 'cues');
    } catch (e) { dlog('[OcenFin] subtitle fetch error:', e?.message); }
  }

  // Intro Skipper / Media Segments
  let introData = $state(null);
  let segmentsChecked = $state(false);     // Plugin-APIs abgefragt → Kapitel-Fallback darf greifen
  let chapterFallbackDone = false;
  let showSkipIntro = $derived(introData?.Introduction?.Valid
    && currentTime >= (introData.Introduction.ShowSkipPromptAt ?? 0)
    && currentTime <= (introData.Introduction.HideSkipPromptAt ?? 0));

  // Outro/Abspann (Media-Segments-/Plugin-Daten) — Auslöser für Auto-Skip & Auto-Play-Countdown
  let showSkipCredits = $derived(introData?.Credits?.Valid
    && currentTime >= (introData.Credits.ShowSkipPromptAt ?? Infinity));

  // Auto-Play der nächsten Folge mit Countdown-Overlay (Netflix-Prinzip).
  // Startet nahe dem Ende; "Abspann automatisch überspringen" hat Vorrang (sofortiger Sprung).
  let chapters          = $state([]);
  let nextCountdown     = $state(null);   // verbleibende Sekunden (ganzzahlig, für den Text), null = inaktiv
  let countdownProgress = $state(0);      // 1 → 0, treibt den Balken
  let countdownTimer    = null;
  let countdownEnd      = 0;
  let countdownDismissed = false; // pro Folge: nach Abbruch nicht erneut starten
  let outroDismissed = $state(false); // manueller Outro-Prompt für DIESE Folge weggeklickt → dranbleiben
  const COUNTDOWN_FROM  = 20;
  const OUTRO_FALLBACK  = 45;     // ohne Kapitel/Segment-Daten: "Nächste Folge"-Karte in den letzten X s zeigen

  // Kapitel-Fallback für Intro/Abspann: greift reaktiv, sobald die Plugin-APIs nichts lieferten
  // UND die Kapitel geladen sind (nur eindeutig benannte Kapitel, sonst kein Prompt).
  $effect(() => { if (segmentsChecked && !chapterFallbackDone && introData === null && chapters.length) {
    chapterFallbackDone = true;
    introData = chaptersToIntroData(chapters);
  } });

  let nearEnd = $derived(duration > 0 && currentTime > 0 && (
    showSkipCredits || (duration - currentTime) <= COUNTDOWN_FROM
  ));
  // "Nächste Folge"-Karte (manuell) zeigen: bei echten Abspann-Daten ab Abspannbeginn, sonst
  // als zuverlässiger Fallback in den letzten OUTRO_FALLBACK Sekunden (auch ohne Kapitel/Segmente).
  // Der Auto-Play-Countdown (nearEnd, 20 s) bleibt davon unberührt, damit nie Inhalt abgeschnitten wird.
  let outroPromptActive = $derived(duration > 0 && currentTime > 0 && (
    showSkipCredits || (duration - currentTime) <= OUTRO_FALLBACK
  ));
  // Ein interaktives Overlay ist offen → OK soll dessen fokussierten Button auslösen, nicht pausieren.
  let overlayActive = $derived(showSkipIntro || showStillWatching || (outroPromptActive && !!nextEpisode));
  // Genau dann ist EIN Outro-Entscheidungsprompt sichtbar (Timer ODER manuell) → Fokus dort einsperren.
  let outroPromptShowing = $derived(!!nextEpisode && (nextCountdown !== null || (outroPromptActive && !outroDismissed)));
  $effect(() => { if (playbackPrefs.autoPlayNext && nextEpisode && !playbackPrefs.autoSkipCredits
         && nearEnd && nextCountdown === null && !countdownDismissed) {
    startCountdown();
  } });

  // Nächste Folge leicht vorladen (nur PlaybackInfo/Stream-URL, kein Video-Pre-Buffering),
  // damit der Wechsel den Roundtrip spart. Greift nur, wenn die Parameter beim Wechsel passen.
  // Gemeinsamer Helfer für BEIDE Wechselpfade: Countdown UND Auto-Skip-Abspann.
  function prefetchNextEpisode() {
    if (!nextEpisode?.Id) return;
    prefetchPlaybackInfo({
      serverUrl: session.serverUrl, userId: selectedUser.Id, token: session.token, itemId: nextEpisode.Id,
      audioStreamIndex: selectedAudioIndex, subtitleStreamIndex: selectedSubtitleIndex,
      maxBitrate, burnSubtitles: playbackPrefs.burnSubtitles, mediaSourceId: null,
      clientGraphicSubs: clientGraphicRender, serverVobSub,
    });
  }

  function startCountdown() {
    prefetchNextEpisode();
    nextCountdown = COUNTDOWN_FROM;   // sofort sichtbar → Karte erscheint
    countdownProgress = 1;
    countdownEnd = Date.now() + COUNTDOWN_FROM * 1000;
    // setInterval (im Projekt zuverlässig) alle 100 ms → Text sekündlich, Balken flüssig.
    countdownTimer = setInterval(() => {
      const remainingMs = countdownEnd - Date.now();
      if (remainingMs <= 0) { stopCountdown(); goToNextEpisode(); return; }
      countdownProgress = remainingMs / (COUNTDOWN_FROM * 1000);
      nextCountdown = Math.ceil(remainingMs / 1000);
    }, 100);
  }
  function stopCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;
    nextCountdown = null;
  }
  function cancelCountdown() {
    stopCountdown();
    countdownDismissed = true;   // für diese Folge nicht erneut zeigen
    resetControlsTimeout();
  }
  function onVideoEnded() {
    // Am Ende automatisch weiter, sofern aktiviert und nicht abgebrochen
    if (playbackPrefs.autoPlayNext && nextEpisode && !countdownDismissed) {
      stopCountdown();
      goToNextEpisode();
    }
  }

  // Aktueller Kapitelname (für Anzeige beim Spulen). Nichtssagende Auto-Namen (Zeitstempel,
  // "Chapter N", reine Nummern) werden durch ein sauberes "Kapitel N" ersetzt.
  let currentChapterName = $derived.by(() => {
    if (!chapters?.length) return null;
    let idx = -1;
    for (let i = 0; i < chapters.length; i++) {
      if ((chapters[i].StartPositionTicks / 10000000) <= displayTime) idx = i; else break;
    }
    if (idx < 0) return null;
    const raw = (chapters[idx].Name || '').trim();
    const junk = !raw
      || /^\(?\d+\)?[\s:.]*\d{1,2}[:.]\d{2}([:.]\d{2})?([:.]\d{1,3})?$/.test(raw)   // (01)00:00:00:000 u. ä.
      || /^(chapter|kapitel|chapitre|capitolo|cap[ií]tulo)\b/i.test(raw)
      || /^\d{1,3}$/.test(raw);
    return junk ? `${i18n.t.chapter} ${idx + 1}` : raw;
  });

  // Auto-Skip (abhängig von Einstellung + installiertem Intro-Skipper-Plugin).
  // Flags verhindern wiederholtes Springen; werden beim Episodenwechsel via {#key}-Remount zurückgesetzt.
  let introAutoSkipped   = false;
  let creditsAutoSkipped = false;
  $effect(() => { if (playbackPrefs.autoSkipIntro && showSkipIntro && !introAutoSkipped && videoElement) {
    introAutoSkipped = true;
    skipIntro();
  } });
  $effect(() => { if (playbackPrefs.autoSkipCredits && showSkipCredits && !creditsAutoSkipped && nextEpisode) {
    creditsAutoSkipped = true;
    prefetchNextEpisode();   // dieser Pfad umgeht den Countdown → Fetch läuft parallel zum Player-Remount
    goToNextEpisode();
  } });

  // Serien-Episoden (alle Staffeln) für zuverlässige Vor/Zurück-Navigation über Staffelgrenzen hinweg
  let seriesEpisodes = $state([]);
  let episodeIndex   = $state(-1);
  let prevEpisode = $derived(episodeIndex > 0 ? seriesEpisodes[episodeIndex - 1] : null);
  let nextByIndex = $derived(episodeIndex >= 0 && episodeIndex < seriesEpisodes.length - 1
                   ? seriesEpisodes[episodeIndex + 1] : null);
  let nextEpisode = $derived(nextByIndex);   // Auto-Play/Outro nutzen dieselbe sequentielle nächste Folge (auch zur nächsten Staffel)
  // Position in der Staffel für die Anzeige oben links: "Folge X von Y"
  let seasonTotal = $derived((item?.Type === 'Episode' && item.ParentIndexNumber != null)
                   ? seriesEpisodes.filter(e => e.ParentIndexNumber === item.ParentIndexNumber).length : 0);
  let episodePosition = $derived((item?.Type === 'Episode' && item.IndexNumber != null && seasonTotal > 0)
                   ? `${i18n.t.episode} ${item.IndexNumber} ${i18n.t.of} ${seasonTotal}` : '');

  // Infozeile zur nächsten Folge: "S2 · E1 · 52 Min · endet um 11:59"
  let nextEpisodeMeta = $derived.by(() => {
    if (!nextEpisode) return '';
    const parts = [];
    if (nextEpisode.ParentIndexNumber != null && nextEpisode.IndexNumber != null)
      parts.push(`S${nextEpisode.ParentIndexNumber} · E${nextEpisode.IndexNumber}`);
    const mins = nextEpisode.RunTimeTicks ? Math.round(nextEpisode.RunTimeTicks / 600000000) : 0;
    if (mins) {
      parts.push(`${mins} ${i18n.t.minShort}`);
      const end = new Date(Date.now() + mins * 60000);
      parts.push(`${i18n.t.endsAt} ${end.toLocaleTimeString(i18n.lang === 'de' ? 'de-DE' : 'en-US', { hour: '2-digit', minute: '2-digit', hour12: !use24h })}`);
    }
    return parts.join(' · ');
  });

  // ============================================================
  // LIFECYCLE
  // ============================================================

  // "Schaust du noch?" – Best Practice (Netflix-Stil): NICHT zeitbasiert, sondern nach
  // mehreren automatisch abgespielten Folgen in Folge ohne Interaktion. Greift damit nur bei
  // Serien-Auto-Play (Einschlaf-Schutz) und unterbricht nie einen Film oder eine aktiv geschaute Folge.
  // Der Zähler (autoPlayStreak) lebt in App.svelte, weil der Player pro Folge neu aufsetzt.
  let showStillWatching = $state(false);
  let interacted = false;   // hat der Nutzer in DIESER Folge etwas getan? (Tastendruck/Remote/Klick)
  function markInteraction() { interacted = true; }
  function resumeFromStillWatching() {
    showStillWatching = false;
    // Nutzer ist wach → weiter zur nächsten Folge; Zähler in App zurücksetzen.
    if (nextEpisode) onNext?.({ episode: nextEpisode, resetStreak: true });
  }

  onMount(async () => {
    resetControlsTimeout();
    if (playerContainer) playerContainer.focus();

    // libbitsub-WASM früh kompilieren (dedupliziert, non-blocking) → der erste PGS/VobSub-Sub muss nicht
    // erst auf den WASM-Compile warten. Schlägt es fehl, fällt libbitsub später ohnehin sauber zurück.
    initWasm().then(() => dlog('[OcenFin] libbitsub WASM ready')).catch((e) => dlog('[OcenFin] libbitsub WASM init failed:', e?.message));

    fetchMediaSources();
    fetchIntroTimestamps();
    fetchSeriesEpisodes();   // Vor/Zurück + Auto-Play + Positionsanzeige (über alle Staffeln)

    // Interaktions-Tracking für "Schaust du noch?": jede bewusste Eingabe markiert den Nutzer als wach.
    window.addEventListener('keydown', markInteraction);
    window.addEventListener('pointermove', markInteraction);
    window.addEventListener('click', markInteraction);
    // Position auch bei App-Suspend (webOS Home) / Schließen / Neuladen sichern.
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);

    // PlaybackInfo entscheidet Direct Play vs. Transcode; setzt Quelle + ggf. HLS.
    // Resume (startTicks) passiert client-seitig nach 'loadedmetadata' (seekToResume).
    await setupPlayback(selectedAudioIndex, selectedSubtitleIndex);

    await reportPlaybackStart();
    progressTimer = setInterval(reportPlaybackProgress, 10000);
    updateClock();
    clockTimer = setInterval(updateClock, 15000);
  });

  onDestroy(() => {
    window.removeEventListener('keydown', markInteraction);
    window.removeEventListener('pointermove', markInteraction);
    window.removeEventListener('click', markInteraction);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('pagehide', onPageHide);
    if (controlsTimeout) clearTimeout(controlsTimeout);
    if (progressTimer)   clearInterval(progressTimer);
    if (countdownTimer)  clearInterval(countdownTimer);
    if (seekCommitTimer) clearTimeout(seekCommitTimer);
    if (clockTimer)      clearInterval(clockTimer);
    if (infoInterval)    clearInterval(infoInterval);
    clearSpinner();
    clearBufferWatchdog();
    if (hls) { try { hls.destroy(); } catch {} hls = null; }
    disposeGraphic();
    disposeAss();
    reportPlaybackStopped(true);
  });

  // ============================================================
  // API
  // ============================================================

  const getAuthHeaders = () => authHeaders(session.token);

  async function fetchMediaSources() {
    try {
      const res = await fetch(
        `${session.serverUrl}/Users/${selectedUser.Id}/Items/${item.Id}?Fields=MediaSources,Chapters,Trickplay`,
        { headers: getAuthHeaders() }
      );
      if (res.ok) {
        const data = await res.json();
        chapters = data.Chapters || [];
        // Spurenliste nur für die Auswahl-UI (Audio/Untertitel). Die tatsächliche
        // Lieferung (Spur vs. eingebrannt) entscheidet PlaybackInfo in setupPlayback.
        if (data.MediaSources?.[0]?.MediaStreams) mediaStreams = data.MediaSources[0].MediaStreams;
        parseTrickplay(data);
      }
    } catch (e) { console.error('fetchMediaSources:', e); }
  }

  async function fetchIntroTimestamps() {
    if (item.Type !== 'Episode') return;
    // 1) Moderne Media-Segments-API (Intro Skipper ab Jellyfin 10.9 liefert hierüber).
    //    Ohne Typ-Filter abfragen und selbst filtern — robuster gegen Server-/Versionsunterschiede.
    try {
      const res = await fetch(`${session.serverUrl}/MediaSegments/${item.Id}`, { headers: getAuthHeaders() });
      if (res.ok) {
        const segs = (await res.json()).Items || [];
        dlog('[OcenFin] media segments:', segs.map(s => s.Type));
        const d = segs.length ? segmentsToIntroData(segs) : null;
        if (d) {
          dlog('[OcenFin] media segments → intro', d.Introduction.Valid, '| outro', d.Credits.Valid);
          introData = d; return;
        }
      } else {
        dlog('[OcenFin] media segments HTTP', res.status);   // z. B. 404 = Endpunkt fehlt, 401 = Auth
      }
    } catch (e) { dlog('[OcenFin] media segments error:', e?.message); }
    // 2) Ältere ConfusedPolarBear-Plugin-API. Manche Versionen liefern das Intro flach
    //    ({ Valid, IntroStart, … }), andere als { Introduction, Credits } → beide Formen abfangen.
    try {
      const res = await fetch(`${session.serverUrl}/Episode/${item.Id}/IntroTimestamps/v1`, { headers: getAuthHeaders() });
      if (res.ok) {
        const data = await res.json();
        dlog('[OcenFin] IntroTimestamps/v1:', JSON.stringify(data));
        introData = (data.Introduction || data.Credits) ? data : { Introduction: data, Credits: { Valid: false } };
        return;
      } else {
        dlog('[OcenFin] IntroTimestamps/v1 HTTP', res.status);
      }
    } catch (e) { dlog('[OcenFin] IntroTimestamps/v1 error:', e?.message); }
    // 3) Kein Plugin-Treffer → Kapitel-Fallback (greift reaktiv, sobald Kapitel geladen sind)
    dlog('[OcenFin] no media segments / plugin data → chapter fallback');
    segmentsChecked = true;
  }

  // Wandelt Media-Segments (Ticks) in die introData-Struktur (Sekunden). Null, wenn weder Intro noch Outro.
  function segmentsToIntroData(segs) {
    const T = 10000000;
    const intro = segs.find(s => s.Type === 'Intro');
    const outro = segs.find(s => s.Type === 'Outro');
    if (!intro && !outro) return null;
    const mk = (s) => s ? {
      Valid: true,
      IntroStart: s.StartTicks / T, IntroEnd: s.EndTicks / T,
      ShowSkipPromptAt: s.StartTicks / T, HideSkipPromptAt: s.EndTicks / T,
    } : { Valid: false };
    return { Introduction: mk(intro), Credits: mk(outro) };
  }

  // Fallback aus benannten Kapiteln — nur eindeutige Treffer, sonst null (kein falscher Prompt).
  function chaptersToIntroData(chs) {
    const T = 10000000;
    const list = chs.map(c => ({ name: (c.Name || '').toLowerCase(), start: c.StartPositionTicks / T }));
    const introIdx   = list.findIndex(c => /intro|opening|vorspann|main title|titelsequenz/.test(c.name));
    const creditsIdx = list.findIndex((c, i) => i > 0 && /credit|abspann|ending|outro/.test(c.name));
    const intro = introIdx >= 0 ? {
      Valid: true, IntroStart: list[introIdx].start,
      IntroEnd: list[introIdx + 1]?.start ?? list[introIdx].start + 90,
      ShowSkipPromptAt: list[introIdx].start,
      HideSkipPromptAt: list[introIdx + 1]?.start ?? list[introIdx].start + 90,
    } : { Valid: false };
    const credits = creditsIdx >= 0 ? {
      Valid: true, IntroStart: list[creditsIdx].start, IntroEnd: list[creditsIdx].start + 60,
      ShowSkipPromptAt: list[creditsIdx].start, HideSkipPromptAt: Infinity,
    } : { Valid: false };
    return (intro.Valid || credits.Valid) ? { Introduction: intro, Credits: credits } : null;
  }

  // Alle Episoden der Serie (staffelübergreifend, in Reihenfolge) – für Vor/Zurück, Auto-Play und Positionsanzeige
  async function fetchSeriesEpisodes() {
    if (item.Type !== 'Episode' || !item.SeriesId) return;
    try {
      const res = await fetch(
        `${session.serverUrl}/Shows/${item.SeriesId}/Episodes?UserId=${selectedUser.Id}`,
        { headers: getAuthHeaders() }
      );
      if (res.ok) {
        const data     = await res.json();
        seriesEpisodes = data.Items || [];
        episodeIndex   = seriesEpisodes.findIndex(ep => ep.Id === item.Id);
      }
    } catch { }
  }

  async function reportPlaybackStart() {
    try {
      await fetch(`${session.serverUrl}/Sessions/Playing`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          ItemId: item.Id, PositionTicks: startTicks,
          IsPaused: false, PlayMethod: playMethod,
          PlaySessionId: playSessionId
        })
      });
    } catch { }
  }

  async function reportPlaybackProgress() {
    if (!isPlaying || !videoElement) return;
    try {
      await fetch(`${session.serverUrl}/Sessions/Playing/Progress`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          ItemId: item.Id,
          PositionTicks: Math.round(videoElement.currentTime * 10000000),
          IsPaused: false, PlayMethod: playMethod,
          PlaySessionId: playSessionId
        })
      });
    } catch { }
  }

  async function reportPlaybackStopped(keepalive = false) {
    if (!videoElement) return;
    try {
      await fetch(`${session.serverUrl}/Sessions/Playing/Stopped`, {
        method: "POST",
        headers: getAuthHeaders(),
        keepalive,
        body: JSON.stringify({
          ItemId: item.Id,
          PositionTicks: Math.round(videoElement.currentTime * 10000000),
          PlaySessionId: playSessionId
        })
      });
    } catch { }
  }

  // Aktuelle Position sofort sichern (auch pausiert) — `keepalive` lässt den Request den App-Suspend/
  // Teardown überleben und behält den Auth-Header. Für visibilitychange→hidden und Wiedergabefehler,
  // damit die Position nie verloren geht (ohne die Session zu beenden — daher Progress, nicht Stopped).
  function flushProgress() {
    if (!videoElement || !playSessionId) return;
    try {
      fetch(`${session.serverUrl}/Sessions/Playing/Progress`, {
        method: "POST",
        headers: getAuthHeaders(),
        keepalive: true,
        body: JSON.stringify({
          ItemId: item.Id,
          PositionTicks: Math.round(videoElement.currentTime * 10000000),
          IsPaused: !isPlaying, PlayMethod: playMethod,
          PlaySessionId: playSessionId
        })
      }).catch(() => {});
    } catch { }
  }

  // App wird in den Hintergrund geschickt/suspendiert (webOS Home, Tab-Wechsel): Position flushen.
  // pagehide = endgültiges Schließen/Neuladen → sauberes Stopped (keepalive überlebt den Teardown).
  function onVisibilityChange() { if (document.hidden) flushProgress(); }
  function onPageHide() { reportPlaybackStopped(true); }

  // ============================================================
  // TRACK WECHSEL
  // ============================================================

  async function changeTrack(type, index) {
    // Panel-Trap SOFORT lösen, bevor Zustand mutiert und der Fokus zurückkehrt. Sonst zieht onFocusIn der
    // Spatial-Nav den Fokus zurück in das noch ausblendende Panel (transition:uiFade → erst nach dem Outro
    // weg), das gleich darauf unmountet → Fokus landet im Nichts. Beim Schließen tritt das nicht auf, weil
    // dort kein panel-interner Zustand mehr mutiert und dropTrapOnOutro den Trap rechtzeitig entfernt.
    settingsPanel?.removeAttribute('data-focus-trap');
    showSettings = false;
    resetControlsTimeout();

    if (type === 'subtitle') {
      const oldStream = mediaStreams.find(s => s.Index === selectedSubtitleIndex && s.Type === 'Subtitle');
      const newStream = mediaStreams.find(s => s.Index === index && s.Type === 'Subtitle');
      // Weicher Wechsel möglich, wenn der Untertitel NICHT gebrannt werden muss: "Aus", oder
      // ein Textuntertitel (egal ob extern geliefert oder eingebettet → wir holen ihn als VTT).
      const graphicCodecs = ['pgssub', 'dvdsub', 'pgs', 'dvbsub', 'vobsub', 'sub'];
      const isSoftSub = (s, idx) => {
        if (idx === -1) return true;
        if (!s) return false;
        if ((s.DeliveryMethod || '').toLowerCase() === 'encode') return false;      // gebrannt → Neuladen
        const codec = (s.Codec || '').toLowerCase();
        if (['pgssub', 'pgs'].includes(codec)) return clientGraphicRender;          // PGS: clientseitig → weich, sonst gebrannt
        if (['dvdsub', 'vobsub', 'sub'].includes(codec)) return clientGraphicRender && serverVobSub;  // VobSub: weich ab Jellyfin 12.0
        if (graphicCodecs.includes(codec)) return false;                            // andere Grafik → nicht als VTT
        return true;
      };
      const oldIsExternal = isSoftSub(oldStream, selectedSubtitleIndex);
      const newIsExternal = isSoftSub(newStream, index);

      selectedSubtitleIndex = index;

      // Instant-Switch: müssen weder alter noch neuer Untertitel ins Bild gebrannt werden
      // (Text, PGS-clientseitig oder "Aus"), tauschen wir nur das Overlay aus – ohne Neuladen.
      if (oldIsExternal && newIsExternal && currentMediaSource) {
        applySubtitleOverlay(index, currentMediaSource);
        // Fokus ERST NACH allen reaktiven Änderungen (selectedSubtitleIndex, subtitleCues, Panel-Outro)
        // zurückgeben — sonst wirft der nachgelagerte Re-Render ihn wieder weg. Exakt wie der Schließen-Pfad,
        // der nach restoreControlFocus() nichts mehr mutiert. (ASS sichert den Fokus zusätzlich nach dem
        // assjs-Einhängen in applyAssSubtitle erneut.)
        await tick();
        restoreControlFocus();
        return;
      }
    } else {
      selectedAudioIndex = index;
    }

    // Hard-Reload (Fallback): Audiowechsel oder gebrannte Untertitel erfordern einen neuen
    // Server-Stream. Position sichern → seekToResume stellt sie nach dem Neuaufbau wieder her.
    const savedPosition = videoElement?.currentTime ?? 0;
    startTicks    = Math.round(savedPosition * 10000000);
    resumeApplied = false;
    await setupPlayback(selectedAudioIndex, selectedSubtitleIndex);
    await tick();
    restoreControlFocus();   // auch nach Hard-Reload (Audiowechsel / gebrannter Untertitel) auf den Auslöser
  }

  // ============================================================
  // AKTIONEN
  // ============================================================

  function skipIntro() {
    if (!videoElement || !introData?.Introduction?.IntroEnd) return;
    videoElement.currentTime = introData.Introduction.IntroEnd;
    // Beim Überspringen NICHT die Steuerung einblenden — man will direkt weiterschauen. Fokus auf den
    // Player legen, da der Skip-Button gleich verschwindet → Tastendrücke greifen weiterhin.
    playerContainer?.focus();
  }

  // manual=true → vom Nutzer ausgelöst (Button/Prompt); manual=false → Auto-Play (Countdown/Ende/Credits).
  function goToNextEpisode(manual = false) {
    stopCountdown();
    if (!nextEpisode) return;
    const awake = manual || interacted;
    // Einschlaf-Schutz: nur bei Serien-Auto-Play, wenn der Nutzer länger nichts getan hat.
    if (!awake && playbackPrefs.stillWatching && item.Type === 'Episode'
        && autoPlayStreak >= (playbackPrefs.stillWatchingEpisodes || 3)) {
      videoElement?.pause();
      showStillWatching = true;
      return;
    }
    // resetStreak: wach → Zähler in App auf 0; sonst hochzählen.
    onNext?.({ episode: nextEpisode, resetStreak: awake });
  }

  async function toggleFavorite() {
    isFavorite = !isFavorite;
    resetControlsTimeout();
    try {
      await fetch(`${session.serverUrl}/Users/${selectedUser.Id}/FavoriteItems/${item.Id}`, {
        method: isFavorite ? "POST" : "DELETE",
        headers: getAuthHeaders()
      });
    } catch { }
  }

  // ============================================================
  // SCRUBBING
  // ============================================================

  function onSeekStart() {
    isSeeking = true;
    seekTime  = currentTime;
    if (controlsTimeout) clearTimeout(controlsTimeout); // Controls bleiben sichtbar
  }

  function onSeekInput(e) {
    seekTime = +e.target.value;
  }

  function onSeekEnd(e) {
    if (seekCommitTimer) { clearTimeout(seekCommitTimer); seekCommitTimer = null; }
    const t = +e.target.value;
    if (videoElement) videoElement.currentTime = t;
    seekTime  = t;
    isSeeking = false;
    resetControlsTimeout();
  }

  // ============================================================
  // CONTROLS / UI
  // ============================================================

  function resetControlsTimeout() {
    showControls = true;
    if (controlsTimeout) clearTimeout(controlsTimeout);
    controlsTimeout = setTimeout(() => {
      if (isPlaying && !showSettings) showControls = false;
    }, 3500);
  }

  function togglePlay() {
    if (isPlaying) { _groupWantsPaused = inSyncGroup; videoElement.pause(); }
    else           { _groupWantsPaused = false; _userPlayIntent = Date.now(); videoElement.play(); }
    resetControlsTimeout();
  }

  // Spulen wie bei Netflix/Jellyfin: mehrfaches schnelles Drücken verschiebt nur die VORSCHAU
  // und springt erst nach einer kurzen Pause EINMAL an die Stelle — nicht bei jedem Druck neu laden.
  function skip(seconds) {
    if (!videoElement || !duration) return;
    if (!isSeeking) { isSeeking = true; seekTime = currentTime; }
    seekTime = Math.max(0, Math.min(duration, seekTime + seconds));
    resetControlsTimeout();
    if (seekCommitTimer) clearTimeout(seekCommitTimer);
    seekCommitTimer = setTimeout(commitSeek, 700);
  }
  function commitSeek() {
    if (seekCommitTimer) { clearTimeout(seekCommitTimer); seekCommitTimer = null; }
    if (!isSeeking) return;
    if (videoElement) videoElement.currentTime = seekTime;
    currentTime = seekTime;   // sofort übernehmen, kein kurzes Zurückspringen bis zum timeupdate
    isSeeking = false;
  }

  // Kapitel-Sprünge — nur sinnvoll/sichtbar wenn das Video echte Kapitelmarken hat
  let hasChapterNav = $derived(showChapters && chapters.length > 1);
  function chapterStartsSorted() {
    return chapters.map(c => c.StartPositionTicks / 10000000).sort((a, b) => a - b);
  }
  function chapterPrev() {
    if (!videoElement) return;
    const t = videoElement.currentTime;
    // 3 s Toleranz: kurz nach einem Kapitelstart springt man zum vorigen Kapitel
    const target = [...chapterStartsSorted()].reverse().find(s => s < t - 3);
    videoElement.currentTime = target ?? 0;
    resetControlsTimeout();
  }
  function chapterNext() {
    if (!videoElement) return;
    const t = videoElement.currentTime;
    const target = chapterStartsSorted().find(s => s > t + 0.5);
    if (target != null) videoElement.currentTime = target;
    resetControlsTimeout();
  }

  // Fokus nach Panel-Schließen/Spurwechsel zurück auf den auslösenden Button (Untertitel/Audio/Zahnrad),
  // damit ein SICHTBARES Steuerelement fokussiert ist — nicht der unsichtbare Container. Fällt auf den
  // Player-Container zurück, falls der Button nicht (mehr) existiert (Erststart, Hard-Reload).
  function restoreControlFocus() {
    if (controlOpener && document.contains(controlOpener)) controlOpener.focus();
    else playerContainer?.focus();
  }

  // FIX: Settings Panel auto-fokussieren für WebOS D-Pad
  async function toggleSettings() {
    if (!showSettings) {
      // Öffnenden Button merken (sofern er außerhalb des Panels liegt)
      const el = document.activeElement;
      if (el instanceof HTMLElement && !settingsPanel?.contains(el)) controlOpener = el;
    }
    showSettings = !showSettings;
    if (showSettings) {
      if (controlsTimeout) clearTimeout(controlsTimeout);
      await tick();
      // Ersten Button im Settings-Panel fokussieren
      const firstBtn = settingsPanel?.querySelector('button');
      if (firstBtn) firstBtn.focus();
    } else {
      resetControlsTimeout();
      await tick();
      // Fokus zurück auf den auslösenden Button (Audio/Untertitel/Zahnrad), sonst auf den Player
      restoreControlFocus();
      controlOpener = null;
    }
  }

  // Öffnet das Panel direkt auf Audio- oder Untertitel-Bereich (eigene Buttons statt Zahnrad).
  // Gleiche Taste bei offenem, gleichem Tab → schließen.
  async function openSettings(tab) {
    if (showSettings && settingsTab === tab) { toggleSettings(); return; }
    // Auch beim Tab-Wechsel den aktiven Button merken (z. B. von Audio auf Untertitel)
    const el = document.activeElement;
    if (el instanceof HTMLElement && !settingsPanel?.contains(el)) controlOpener = el;
    settingsTab = tab;
    if (!showSettings) { await toggleSettings(); }
    else { await tick(); settingsPanel?.querySelector('button')?.focus(); }
  }

  // Schieberegler: Links/Rechts spulen (±10 s), Hoch/Runter verlässt die Leiste
  // (das native Wertändern bei Hoch/Runter wird unterdrückt; die Gruppen-Navigation
  // übernimmt den Sprung zu den Steuer-Buttons).
  function onSeekKey(e) {
    if (e.key === 'ArrowLeft')      { e.preventDefault(); e.stopPropagation(); skip(-10); resetControlsTimeout(); }
    else if (e.key === 'ArrowRight'){ e.preventDefault(); e.stopPropagation(); skip(10);  resetControlsTimeout(); }
    // OK auf der Leiste: ausstehenden Sprung sofort übernehmen, dann Wiedergabe/Pause umschalten.
    else if (e.key === 'Enter' || e.keyCode === 13) {
      e.preventDefault(); e.stopPropagation();
      if (isSeeking) commitSeek();
      togglePlay();
    }
    // ▼ springt direkt auf Wiedergabe/Pause (häufigster Fall) statt auf den linken Zurückspul-Button.
    else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); if (isSeeking) commitSeek(); playPauseBtn?.focus(); resetControlsTimeout(); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); /* nach oben per FocusManager */ }
  }

  function handleKeyDown(e) {
    // Fehler-Overlay offen: Pfeile/OK steuern nur die zwei Buttons (Spatial-Nav + Button-Klick), Zurück verlässt.
    if (playbackError) {
      if (isBackKey(e)) { e.preventDefault(); e.stopPropagation(); onExit?.(); }
      return;
    }
    if (showSettings) {
      if (isBackKey(e)) { e.preventDefault(); e.stopPropagation(); toggleSettings(); }
      return;
    }
    // Läuft der Auto-Play-Countdown, bricht Zurück erst diesen ab (statt den Player zu verlassen)
    if (nextCountdown !== null && isBackKey(e)) {
      e.preventDefault(); e.stopPropagation();
      cancelCountdown();
      return;
    }
    if (isBackKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      onExit?.();
      return;
    }
    // Outro-Entscheidungsprompt offen: Pfeile bewegen NUR zwischen dessen Buttons (Spatial-Nav im
    // data-focus-trap des Prompts) — nicht zur Wiedergabeleiste, und ohne das HUD einzublenden.
    if (outroPromptShowing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'
                            || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      return;
    }
    // HUD verborgen (man schaut gerade) → OK pausiert/spielt direkt und fokussiert Play/Pause,
    // damit ein erneutes OK sofort fortsetzt. Bei offenem Overlay NICHT eingreifen — dort soll
    // OK den fokussierten Button (Intro/Outro überspringen, Weiterschauen) auslösen.
    if ((e.key === 'Enter' || e.keyCode === 13) && !showControls && !overlayActive) {
      e.preventDefault();
      togglePlay();
      resetControlsTimeout();
      playPauseBtn?.focus();
      return;
    }
    // HUD verborgen + Links/Rechts → Wiedergabeleiste fokussieren und spulen (wie bei Jellyfin).
    if (!showControls && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault(); e.stopPropagation();
      resetControlsTimeout();
      seekBarEl?.focus();
      skip(e.key === 'ArrowLeft' ? -10 : 10);
      return;
    }
    // Pfeiltasten/Enter werden sonst von der Gruppen-Navigation bzw. den fokussierten
    // Buttons verarbeitet — hier nur die Steuerung wieder einblenden.
    resetControlsTimeout();
  }

  function formatTime(seconds) {
    if (isNaN(seconds) || seconds < 0) return "00:00";
    const h    = Math.floor(seconds / 3600);
    const m    = Math.floor((seconds % 3600) / 60);
    const s    = Math.floor(seconds % 60);
    return h > 0
      ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
      : `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }
</script>

<div
  bind:this={playerContainer}
  data-focus-trap
  tabindex="0"
  class="w-full h-screen bg-black relative overflow-hidden flex items-center justify-center cursor-none focus:outline-none subs-{playbackPrefs.subtitleSize || 'normal'}"
  onmousemove={resetControlsTimeout}
  onpointermove={resetControlsTimeout}
  onkeydown={handleKeyDown}
>

  <video
    bind:this={videoElement}
    preload="auto"
    class="w-full h-full object-contain"
    onplay={() => { vlog('play'); isPlaying = true; onPlayable(); onLocalPlay(); flushProgress(); }}
    onplaying={() => { vlog('playing'); onPlayable(); syncReportReady(); }}
    onpause={() => { isPlaying = false; clearSpinner(); isBuffering = false; clearBufferWatchdog(); onLocalPause(); flushProgress(); }}
    onseeked={onLocalSeeked}
    onseeking={syncReportBuffering}
    onwaiting={() => { vlog('waiting'); onWaiting(); syncReportBuffering(); }}
    onstalled={() => { vlog('stalled'); onWaiting(); syncReportBuffering(); }}
    oncanplay={onPlayable}
    onloadstart={() => vlog('loadstart')}
    onsuspend={() => vlog('suspend')}
    onerror={onVideoError}
    ontimeupdate={() => { if (!isSeeking) currentTime = videoElement?.currentTime ?? 0; onProgressTick(); }}
    onloadedmetadata={() => {
      vlog('loadedmetadata', { dur: Math.round(videoElement?.duration || 0), w: videoElement?.videoWidth, h: videoElement?.videoHeight });
      seekToResume();
    }}
    onended={onVideoEnded}
    onclick={togglePlay}
  ></video>

  <!-- ASS/SSA-Untertitel: assjs injiziert hier sein DOM-Overlay, synchron zum <video> (liest KEINE Pixel
       → kein Taint). Container überlappt das Video (absolute inset-0); z unter Spinner/Controls. -->
  <div bind:this={assContainer} class="absolute inset-0 pointer-events-none z-[20]"></div>

  <!-- LADEANIMATION — sichtbar solange Video puffert oder NAS aufwacht -->
  {#if isBuffering && !playbackError}
    <div class="absolute inset-0 flex items-center justify-center z-[30] pointer-events-none">
      <div class="flex flex-col items-center gap-5">
        <div class="w-20 h-20 border-4 border-white/20 border-t-white rounded-full animate-spin"></div>
        <p class="text-white/50 text-lg font-medium tracking-wider">{i18n.t.loading}</p>
      </div>
    </div>
  {/if}

  <!-- FEHLER — statt endlosem Spinner: klare Meldung + Aktionen -->
  {#if playbackError}
    <div data-focus-trap class="absolute inset-0 flex items-center justify-center z-[80] bg-black/80">
      <div class="flex flex-col items-center gap-5 max-w-md text-center px-8">
        <svg class="w-16 h-16 text-red-500" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m0 3.75h.008M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
        <p class="text-white text-2xl font-bold">{i18n.t.playbackError}</p>
        <p class="text-gray-400">{i18n.t.playbackErrorHint}</p>
        <div class="flex gap-4 mt-2">
          <button onclick={retryPlayback} {@attach focusOnMount()}
            class="bg-white text-black font-bold px-6 py-3 rounded-xl focus:outline-none focus:ring-4 focus:ring-white hover:bg-gray-200 transition-colors">
            {i18n.t.retry}
          </button>
          <button onclick={() => onExit?.()}
            class="bg-gray-700 text-white font-bold px-6 py-3 rounded-xl focus:outline-none focus:ring-4 focus:ring-white hover:bg-gray-600 transition-colors">
            {i18n.t.back}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- WIEDERGABEINFO-OVERLAY (opt-in, vom Info-Button getoggelt) -->
  {#if showInfoOverlay}
    <div transition:uiFade class="absolute top-8 left-8 z-[55] bg-black/75 backdrop-blur-md border border-gray-700 rounded-xl px-6 py-5 text-lg shadow-2xl pointer-events-none max-w-md">
      <div class="text-gray-400 uppercase tracking-wider text-sm font-bold mb-3">{i18n.t.playbackInfo}</div>
      <div class="flex flex-col gap-2">
        <div class="flex justify-between gap-8">
          <span class="text-gray-500">{i18n.t.infoMethod}</span>
          <span class="font-bold {playMethodColor}">{playMethodLabel}</span>
        </div>
        {#if infoVideoStream}
          <div class="flex justify-between gap-8">
            <span class="text-gray-500">{i18n.t.infoVideo}</span>
            <span class="text-white font-mono text-right">{[
              infoVideoStream.Codec ? infoVideoStream.Codec.toUpperCase() : null,
              (liveStats.width && liveStats.height) ? `${liveStats.width}×${liveStats.height}` : (infoVideoStream.Width ? `${infoVideoStream.Width}×${infoVideoStream.Height}` : null),
              infoVideoStream.AverageFrameRate ? `${infoVideoStream.AverageFrameRate.toFixed(0)} fps` : null,
              fmtBitrate(infoVideoStream.BitRate)
            ].filter(Boolean).join(' · ')}</span>
          </div>
        {/if}
        {#if infoAudioStream}
          <div class="flex justify-between gap-8">
            <span class="text-gray-500">{i18n.t.audio}</span>
            <span class="text-white font-mono text-right">{[
              infoAudioStream.Codec ? infoAudioStream.Codec.toUpperCase() : null,
              infoAudioStream.ChannelLayout,
              infoAudioStream.Language
            ].filter(Boolean).join(' · ')}</span>
          </div>
        {/if}
        <div class="flex justify-between gap-8">
          <span class="text-gray-500">{i18n.t.infoBuffer}</span>
          <span class="text-white font-mono">{liveStats.bufferAhead}s</span>
        </div>
        {#if liveStats.total > 0}
          <div class="flex justify-between gap-8">
            <span class="text-gray-500">{i18n.t.infoDropped}</span>
            <span class="text-white font-mono">{liveStats.dropped} / {liveStats.total}</span>
          </div>
        {/if}
      </div>
    </div>
  {/if}

  <!-- HAUPT-OVERLAY — Klick auf die leere Bildfläche (|self, nicht auf Buttons) pausiert/spielt -->
  <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/50 flex flex-col justify-between p-10 transition-opacity duration-500 z-50
              {showControls ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}"
       onclick={(e) => { if (e.target === e.currentTarget) togglePlay(); }}>

    <!-- OBEN: Titel + Uhrzeit -->
    <div class="flex items-start justify-between gap-6">
      <div>
        <h1 class="text-3xl font-bold drop-shadow-lg">{item.Name}</h1>
        {#if item.SeriesName}
          <p class="text-gray-400 text-lg mt-1">{item.SeriesName} · {item.SeasonName}</p>
        {/if}
        {#if episodePosition}
          <p class="text-gray-500 text-base mt-0.5 font-semibold tracking-wide">{episodePosition}</p>
        {/if}
      </div>
      <div class="flex items-center gap-4 shrink-0">
        <button onclick={(e) => { e.stopPropagation(); onSyncplay?.(); }}
          aria-label={i18n.t.syncPlay} title={i18n.t.syncPlay}
          class="text-white/90 hover:text-blue-300 focus:text-white focus:bg-blue-600 rounded-lg p-2
                 focus:outline-none focus:ring-2 focus:ring-white transition-colors">
          <svg class="w-7 h-7" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z"/>
          </svg>
        </button>
        {#if showClock}
          <span class="text-2xl font-semibold text-white/90 drop-shadow-lg tabular-nums">{clockNow}</span>
        {/if}
      </div>
    </div>

    <!-- UNTEN: Progress + Buttons -->
    <div class="w-full flex flex-col gap-6">

      <!-- PROGRESS BAR — sauberes Scrubbing, Kapitelmarken nur wenn aktiviert -->
      <div class="flex items-center gap-4 w-full">
        <span class="text-xl font-mono w-24 tabular-nums">{formatTime(displayTime)}</span>
        <div class="relative flex-1 flex items-center">
          <input
            type="range"
            min="0"
            max={duration || 0}
            value={isSeeking ? seekTime : currentTime}
            bind:this={seekBarEl}
            onpointerdown={onSeekStart}
            oninput={onSeekInput}
            onpointerup={onSeekEnd}
            onkeydown={onSeekKey}
            style="background: linear-gradient(to right, var(--color-blue-500, #3b82f6) {seekPct}%, rgba(255,255,255,0.22) {seekPct}%);"
            class="seekbar w-full h-1.5 rounded-full appearance-none cursor-pointer focus:outline-none"
          />
          {#if isSeeking}
            <!-- Vorschau folgt dem Scrubber; Kapitelname (falls vorhanden) darüber gestapelt → keine Überlappung -->
            <div class="absolute bottom-full mb-4 -translate-x-1/2 pointer-events-none whitespace-nowrap flex flex-col items-center gap-0.5"
                 style="left: {Math.min(96, Math.max(4, seekPct))}%;">
              {#if trickplayTile}
                <!-- Trickplay-Vorschaubild: aus dem Kachel-Sheet ausgeschnitten -->
                <div class="rounded-lg overflow-hidden shadow-2xl ring-1 ring-white/25 mb-1.5"
                     style="width:{trickplayTile.w}px; height:{trickplayTile.h}px;
                            background-image:url('{trickplayTile.url}');
                            background-position:-{trickplayTile.x}px -{trickplayTile.y}px;
                            background-repeat:no-repeat;"></div>
              {/if}
              {#if showChapters && currentChapterName}
                <span class="text-sm font-semibold text-white/80 drop-shadow-[0_2px_8px_rgba(0,0,0,0.95)]">{currentChapterName}</span>
              {/if}
              <span class="text-4xl font-bold text-white tabular-nums drop-shadow-[0_2px_10px_rgba(0,0,0,0.95)]">{formatTime(seekTime)}</span>
            </div>
          {/if}
          {#if showChapters && duration > 0 && chapters.length > 1}
            {#each chapters as ch}
              <div class="absolute top-1/2 -translate-y-1/2 w-0.5 h-3 bg-white/60 rounded-full pointer-events-none"
                   style="left: {(ch.StartPositionTicks / 10000000 / duration) * 100}%"></div>
            {/each}
          {/if}
        </div>
        <div class="relative shrink-0">
          {#if timeMode === 'end'}
            <span class="absolute bottom-full right-2 mb-1 text-sm font-medium text-gray-400 whitespace-nowrap pointer-events-none">{i18n.t.endsAt}</span>
          {/if}
          <button onclick={(e) => { e.stopPropagation(); cycleTimeMode(); }}
            class="text-xl font-mono text-right tabular-nums cursor-pointer rounded-md px-2 py-1
                   transition-colors hover:text-blue-300
                   focus:text-white focus:bg-blue-600 focus:ring-2 focus:ring-white focus:outline-none">
            {rightTimeLabel}
          </button>
        </div>
      </div>

      <!-- TRANSPORT CONTROLS -->
      <div class="flex justify-between items-center w-full px-4">
        <div class="flex items-center gap-6">

          <!-- Vorige Folge: |◄ — Transport-Navigation (sequentiell) -->
          <button onclick={() => prevEpisode && onPrev?.(prevEpisode)}
            disabled={!prevEpisode}
            class="p-3 text-gray-400 hover:text-white focus:text-white focus:outline-none disabled:opacity-30"
            title={i18n.t.prevEpisode}>
            <!-- |◄ : bar links + Dreieck zeigt LINKS -->
            <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/>
            </svg>
          </button>

          <!-- Kapitel zurück — nur wenn aktiviert UND Kapitelmarken vorhanden.
               Icon bewusst ANDERS als Folgen-Skip: Chevron auf einen Punkt (= Kapitelmarke). -->
          {#if hasChapterNav}
            <button onclick={chapterPrev} class="p-2.5 text-gray-500 hover:text-white focus:text-white focus:outline-none" title={i18n.t.chapterPrev}>
              <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M15 7l-5 5 5 5"/>
                <circle cx="8" cy="12" r="1.6" fill="currentColor" stroke="none"/>
              </svg>
            </button>
          {/if}

          <button onclick={() => skip(-seekStep)} class="p-3 text-gray-400 hover:text-white focus:text-white focus:outline-none" title="-{seekStep}s">
            <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12.066 11.2a1 1 0 000 1.6l5.334 4A1 1 0 0019 16V8a1 1 0 00-1.6-.8l-5.334 4zM4.066 11.2a1 1 0 000 1.6l5.334 4A1 1 0 0011 16V8a1 1 0 00-1.6-.8l-5.334 4z"/>
            </svg>
          </button>

          <button onclick={togglePlay} {@attach focusOnMount()} bind:this={playPauseBtn}
            class="p-4 bg-white text-black rounded-full hover:scale-110 focus:scale-110 transition-transform focus:outline-none shadow-xl">
            {#if isPlaying}
              <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
            {:else}
              <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
            {/if}
          </button>

          <button onclick={() => skip(seekStep)} class="p-3 text-gray-400 hover:text-white focus:text-white focus:outline-none" title="+{seekStep}s">
            <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M11.934 12.8a1 1 0 000-1.6l-5.334-4A1 1 0 005 8v8a1 1 0 001.6.8l5.334-4zM19.934 12.8a1 1 0 000-1.6l-5.334-4A1 1 0 0013 8v8a1 1 0 001.6.8l5.334-4z"/>
            </svg>
          </button>

          <!-- Kapitel vor — nur wenn aktiviert UND Kapitelmarken vorhanden.
               Icon bewusst ANDERS als Folgen-Skip: Chevron auf einen Punkt (= Kapitelmarke). -->
          {#if hasChapterNav}
            <button onclick={chapterNext} class="p-2.5 text-gray-500 hover:text-white focus:text-white focus:outline-none" title={i18n.t.chapterNext}>
              <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 7l5 5-5 5"/>
                <circle cx="16" cy="12" r="1.6" fill="currentColor" stroke="none"/>
              </svg>
            </button>
          {/if}

          <!-- Nächste Folge: ►| — Transport-Navigation (sequentiell), zählt als bewusste Aktion -->
          <button onclick={() => goToNextEpisode(true)}
            disabled={!nextByIndex}
            class="p-3 text-gray-400 hover:text-white focus:text-white focus:outline-none disabled:opacity-30"
            title={i18n.t.nextEpisode}>
            <!-- ►| : Dreieck zeigt RECHTS + bar rechts -->
            <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
              <path d="M16 6h2v12h-2zm-10 0l9 6-9 6V6z"/>
            </svg>
          </button>
        </div>

        <div class="flex items-center gap-4">

          <!-- Favorit -->
          <button onclick={toggleFavorite}
            class="p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-white transition-colors {isFavorite ? 'text-red-500' : 'text-gray-400 hover:text-white focus:text-white'}">
            <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
            </svg>
          </button>

          <!-- Zur Wiedergabeliste hinzufügen -->
          <button onclick={(e) => { e.stopPropagation(); openPicker('playlist'); }} title={i18n.t.addToPlaylist} aria-label={i18n.t.addToPlaylist}
            class="p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-white transition-colors text-gray-400 hover:text-white focus:text-white">
            <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 6h13M3 12h9m-9 6h9m4-3v6m3-3h-6"/></svg>
          </button>

          <!-- Zur Sammlung hinzufügen -->
          <button onclick={(e) => { e.stopPropagation(); openPicker('collection'); }} title={i18n.t.addToCollection} aria-label={i18n.t.addToCollection}
            class="p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-white transition-colors text-gray-400 hover:text-white focus:text-white">
            <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/></svg>
          </button>

          <!-- AUDIO — nur Icon (ersetzt das Zahnrad) -->
          <button onclick={(e) => { e.stopPropagation(); openSettings('audio'); }} title={i18n.t.audio} aria-label={i18n.t.audio}
            class="p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-white transition-colors
                   {showSettings && settingsTab === 'audio' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white focus:text-white'}">
            <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"/>
            </svg>
          </button>

          <!-- UNTERTITEL — nur Icon -->
          <button onclick={(e) => { e.stopPropagation(); openSettings('subtitle'); }} title={i18n.t.subtitles} aria-label={i18n.t.subtitles}
            class="p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-white transition-colors
                   {showSettings && settingsTab === 'subtitle' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white focus:text-white'}">
            <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/>
              <text x="12" y="15.6" text-anchor="middle" font-size="8.5" font-weight="700" fill="currentColor" stroke="none" font-family="ui-sans-serif, system-ui, sans-serif">CC</text>
            </svg>
          </button>

          <!-- WIEDERGABEINFOS — nur wenn in den Einstellungen freigeschaltet -->
          {#if playbackPrefs.showPlaybackInfo}
            <button onclick={(e) => { e.stopPropagation(); toggleInfoOverlay(); }} title={i18n.t.playbackInfo} aria-label={i18n.t.playbackInfo}
              class="p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-white transition-colors
                     {showInfoOverlay ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white focus:text-white'}">
              <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="9"/>
                <path stroke-linecap="round" stroke-linejoin="round" d="M12 11v5"/>
                <circle cx="12" cy="8" r="0.6" fill="currentColor" stroke="none"/>
              </svg>
            </button>
          {/if}
        </div>
      </div>
    </div>

    <!-- EINSTELLUNGS-PANEL — bind:this für WebOS D-Pad Fokus -->
    {#if showSettings}
      <div bind:this={settingsPanel} data-focus-trap transition:uiFade onoutrostart={dropTrapOnOutro}
        class="absolute bottom-32 right-12 bg-gray-900/95 backdrop-blur-md border border-gray-700 rounded-2xl shadow-2xl z-[60] p-6 flex flex-col gap-6 w-96 max-h-[60vh]">

        <div class="flex justify-between items-center">
          <h2 class="text-2xl font-bold text-white">{settingsTab === 'audio' ? i18n.t.audio : i18n.t.subtitles}</h2>
          <button onclick={toggleSettings} class="text-gray-400 hover:text-white focus:text-white focus:outline-none focus:ring-2 focus:ring-white rounded-lg p-1">
            <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div class="overflow-y-auto hide-scrollbar flex flex-col gap-2">

          {#if settingsTab === 'audio'}
            {#each audioStreams as stream}
              <button onclick={() => changeTrack('audio', stream.Index)}
                class="text-left p-3 rounded-lg font-medium text-sm focus:outline-none focus:ring-2 focus:ring-inset focus:ring-white transition-colors
                       {selectedAudioIndex === stream.Index ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700 focus:bg-gray-700'}">
                {stream.DisplayTitle || `${stream.Language || 'Unbekannt'} – ${stream.Codec}`}
              </button>
            {:else}
              <p class="text-gray-500 text-sm p-3">—</p>
            {/each}
          {:else}
            <button onclick={() => changeTrack('subtitle', -1)}
              class="text-left p-3 rounded-lg font-medium text-sm focus:outline-none focus:ring-2 focus:ring-inset focus:ring-white transition-colors
                     {selectedSubtitleIndex === -1 ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700 focus:bg-gray-700'}">
              {i18n.t.subtitleOff}
            </button>
            {#each subtitleStreams as stream}
              <button onclick={() => changeTrack('subtitle', stream.Index)}
                class="text-left p-3 rounded-lg font-medium text-sm focus:outline-none focus:ring-2 focus:ring-inset focus:ring-white transition-colors
                       {selectedSubtitleIndex === stream.Index ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700 focus:bg-gray-700'}">
                {stream.DisplayTitle || stream.Language || 'Unbekannt'}
              </button>
            {/each}
          {/if}

          {#if subtitleCues.length > 0}
            <div class="mt-3 pt-3 border-t border-gray-700/60 flex items-center justify-between gap-3 px-1">
              <span class="text-sm text-gray-300 font-medium">{i18n.t.subtitleOffset}</span>
              <div class="flex items-center gap-2">
                <button onclick={() => adjustSubtitleOffset(-0.5)} aria-label="-0,5 s"
                  class="w-9 h-9 rounded-lg bg-gray-800 text-white text-xl font-bold leading-none focus:outline-none focus:ring-2 focus:ring-inset focus:ring-white hover:bg-gray-700 focus:bg-gray-700 transition-colors">−</button>
                <span class="text-sm font-mono text-white w-16 text-center tabular-nums">{formatOffset(subtitleOffset)}</span>
                <button onclick={() => adjustSubtitleOffset(0.5)} aria-label="+0,5 s"
                  class="w-9 h-9 rounded-lg bg-gray-800 text-white text-xl font-bold leading-none focus:outline-none focus:ring-2 focus:ring-inset focus:ring-white hover:bg-gray-700 focus:bg-gray-700 transition-colors">+</button>
              </div>
            </div>
          {/if}

        </div>
      </div>
    {/if}

  </div>
  <!-- ENDE HAUPT-OVERLAY -->


  <!-- UNTERTITEL-OVERLAY — eigener VTT-Renderer (native Track-Anzeige ist auf webOS unzuverlässig).
       Rückt nach oben, wenn die Steuerleiste sichtbar ist, damit nichts überdeckt wird. -->
  {#if currentSubtitleText}
    <div class="absolute inset-x-0 z-[65] flex justify-center px-[8%] pointer-events-none transition-all duration-200
                {showControls ? 'bottom-44' : 'bottom-[7%]'}">
      <span class="subtitle-box sub-{playbackPrefs.subtitleSize || 'normal'}" style={subStyle}>{currentSubtitleText}</span>
    </div>
  {/if}


  <!-- INTRO ÜBERSPRINGEN — unten links -->
  {#if showSkipIntro}
    <div transition:uiFade class="absolute bottom-36 left-12 z-[70]">
      <button onclick={skipIntro} {@attach focusOnMount()}
        class="bg-white/10 backdrop-blur-md border-2 border-white text-white font-bold text-xl
               px-8 py-4 rounded-xl flex items-center gap-3 shadow-2xl
               hover:bg-white hover:text-black focus:bg-white focus:text-black
               focus:outline-none transition-all duration-200">
        <!-- Doppelpfeil rechts für "überspringen" -->
        <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
          <path d="M5.59 7.41L10.18 12l-4.59 4.59L7 18l6-6-6-6zM16 6h2v12h-2z"/>
        </svg>
        {i18n.t.skipIntro}
      </button>
    </div>
  {/if}


  <!-- NÄCHSTE FOLGE — unten rechts -->
  <!-- AUTO-PLAY COUNTDOWN — Netflix-Stil, mit "Jetzt abspielen" / "Abbrechen" -->
  {#if nextCountdown !== null && nextEpisode}
    <div transition:uiFade data-focus-trap class="absolute bottom-36 right-12 z-[70]">
      <div class="bg-gray-900/95 border border-gray-700 rounded-2xl shadow-2xl p-5 w-80 flex flex-col gap-3">
        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">{i18n.t.nextEpisodeIn} {nextCountdown} {nextCountdown === 1 ? i18n.t.secondOne : i18n.t.secondsMany}</span>
        <span class="text-lg font-bold text-white truncate">{nextEpisode.Name}</span>
        {#if nextEpisodeMeta}<span class="text-sm text-gray-400 truncate">{nextEpisodeMeta}</span>{/if}
        <div class="h-1 bg-gray-700 rounded-full overflow-hidden">
          <div class="h-full bg-blue-500" style="width: {countdownProgress * 100}%; transition: width 0.12s linear;"></div>
        </div>
        <div class="flex gap-3">
          <button onclick={() => goToNextEpisode(true)} {@attach focusOnMount()}
            class="flex-1 bg-white text-black font-bold py-2.5 rounded-lg flex items-center justify-center gap-2
                   focus:outline-none focus:ring-4 focus:ring-white hover:bg-gray-200 transition-colors">
            <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
            {i18n.t.playNow}
          </button>
          <button onclick={cancelCountdown}
            class="px-4 bg-gray-700 text-white font-bold py-2.5 rounded-lg
                   focus:outline-none focus:ring-4 focus:ring-white hover:bg-gray-600 transition-colors">
            {i18n.t.cancel}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Manueller "Nächste Folge"-Prompt (kein Countdown): erscheint bei deaktiviertem Auto-Play ODER nach
       Abbruch des Timers. Der Nutzer entscheidet selbst — "Abbrechen" bleibt bei der aktuellen Folge (Outro). -->
  {#if outroPromptActive && nextEpisode && nextCountdown === null && !outroDismissed}
    <div transition:uiFade data-focus-trap class="absolute bottom-36 right-12 z-[70]">
      <div class="bg-gray-900/95 border border-gray-700 rounded-2xl shadow-2xl p-5 w-80 flex flex-col gap-3">
        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">{i18n.t.nextEpisode}</span>
        <span class="text-lg font-bold text-white truncate">{nextEpisode.Name}</span>
        {#if nextEpisodeMeta}<span class="text-sm text-gray-400 truncate">{nextEpisodeMeta}</span>{/if}
        <div class="flex gap-3">
          <button onclick={() => goToNextEpisode(true)} {@attach focusOnMount()}
            class="flex-1 bg-white text-black font-bold py-2.5 rounded-lg flex items-center justify-center gap-2
                   focus:outline-none focus:ring-4 focus:ring-white hover:bg-gray-200 transition-colors">
            <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
            {i18n.t.playNow}
          </button>
          <button onclick={() => outroDismissed = true}
            class="px-4 bg-gray-700 text-white font-bold py-2.5 rounded-lg
                   focus:outline-none focus:ring-4 focus:ring-white hover:bg-gray-600 transition-colors">
            {i18n.t.cancel}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- "Schaust du noch?" – nach Inaktivität pausiert -->
  {#if showStillWatching}
    <div transition:uiFade onoutrostart={dropTrapOnOutro} class="absolute inset-0 z-[120] bg-black/85 flex items-center justify-center">
      <div class="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl p-12 flex flex-col items-center gap-7 max-w-md text-center">
        <svg class="w-16 h-16 text-gray-500" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1 1 0 010-.644C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178a1 1 0 010 .644C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.964-7.178z"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
        </svg>
        <h2 class="text-3xl font-bold text-white">{i18n.t.stillWatching}</h2>
        <button onclick={resumeFromStillWatching} {@attach focusOnMount()}
          class="bg-white text-black font-bold text-xl px-10 py-4 rounded-xl flex items-center gap-3
                 focus:outline-none focus:ring-4 focus:ring-white hover:bg-gray-200 transition-colors">
          <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          {i18n.t.continueWatching}
        </button>
      </div>
    </div>
  {/if}

</div>

<!-- Zur Sammlung / Wiedergabeliste hinzufügen (gemeinsame Komponente) -->
<AddToPicker mode={pickerMode} {item} {selectedUser} {getAuthHeaders}
  onCreated={() => onLibChanged?.()}
  onClose={async () => { pickerMode = null; if (wasPlayingBeforePicker) videoElement?.play().catch(() => {}); wasPlayingBeforePicker = false; await tick(); if (controlOpener && document.contains(controlOpener)) controlOpener.focus(); else playerContainer?.focus(); controlOpener = null; }} />

<style>
  /* Wiedergabeleiste — gesehener Teil blau, Rest hell (konsistent in allen Browsern),
     weißer Griff, dezente Fokus-Aura statt kräftigem Ring (moderner Player-Stil). */
  :global(.seekbar) { -webkit-appearance: none; appearance: none; }
  :global(.seekbar::-webkit-slider-thumb) {
    -webkit-appearance: none; appearance: none;
    width: 16px; height: 16px; border-radius: 9999px;
    background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.5); cursor: pointer;
    transition: box-shadow .15s ease;
  }
  :global(.seekbar::-moz-range-thumb) {
    width: 16px; height: 16px; border: none; border-radius: 9999px;
    background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.5); cursor: pointer;
  }
  :global(.seekbar:focus::-webkit-slider-thumb) {
    width: 24px; height: 24px;
    box-shadow: 0 0 0 5px var(--color-blue-500, #3b82f6), 0 0 16px 3px rgba(59,130,246,.55);
  }
  :global(.seekbar:focus::-moz-range-thumb) {
    width: 24px; height: 24px;
    box-shadow: 0 0 0 5px var(--color-blue-500, #3b82f6), 0 0 16px 3px rgba(59,130,246,.55);
  }

  /* Untertitelgröße (skaliert die nativen VTT-Cues; vh für TV-Abstand) */
  :global(.subs-small video::cue)  { font-size: 2.6vh; }
  :global(.subs-normal video::cue) { font-size: 3.4vh; }
  :global(.subs-large video::cue)  { font-size: 4.8vh; }

  /* Eigener Untertitel-Overlay-Renderer (externe VTT) — kein Kasten, nur kräftiger Schatten */
  .subtitle-box {
    white-space: pre-line; text-align: center; color: #fff; font-weight: 600; line-height: 1.35;
    text-shadow: 0 1px 2px #000, 0 2px 8px rgba(0,0,0,.95), 0 0 4px rgba(0,0,0,.9);
    max-width: 100%;
  }
  .sub-small  { font-size: 2.6vh; }
  .sub-normal { font-size: 3.4vh; }
  .sub-large  { font-size: 4.8vh; }
</style>
