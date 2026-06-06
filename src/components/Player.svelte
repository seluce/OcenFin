<script>
  import { t, currentLang } from '../i18n.js';
  import { isBackKey, focusOnMount } from '../utils.js';
  import { getPlaybackInfoFast, prefetchPlaybackInfo, resolveStream, externalSubtitleUrl } from '../playback.js';
  import { createEventDispatcher, onMount, onDestroy, tick } from 'svelte';
  import AddToPicker from './AddToPicker.svelte';

  export let item;
  export let serverUrl;
  export let activeToken;
  export let selectedAudioIndex;
  export let selectedSubtitleIndex;
  export let mediaSourceId = null;   // gewählte Version (FullHD/4K); null = Server-Standard
  export let selectedUser;
  export let playbackPrefs = { autoSkipIntro: false, autoSkipCredits: false };
  export let use24h = true;   // Uhrzeit-Format (aus Einstellung) für die Uhr im Player
  export let showClock = true; // Uhr im Player anzeigen (folgt der Anzeige-Einstellung)
  export let showChapters = false; // Kapitelmarken auf der Leiste (Opt-in)
  export let seekStep = 30;        // Sprungweite der Vor-/Zurück-Buttons in Sekunden (pro Profil)
  export let autoPlayStreak = 0;   // "Schaust du noch?": Folgen, die ohne Interaktion auto-gestartet wurden (von App gehalten)

  const dispatch = createEventDispatcher();

  let videoElement;
  let playerContainer;
  let settingsPanel;       // bind für Auto-Fokus auf WebOS
  let playPauseBtn;        // bind: damit ▼ von der Leiste direkt hierher springt
  let seekBarEl;           // bind: damit Links/Rechts bei verborgenem HUD direkt hierher springt
  let isPlaying  = false;
  let currentTime = 0;
  let duration    = 0;

  // Scrubbing
  let isSeeking  = false;
  let seekTime   = 0;
  let seekCommitTimer = null;   // gebündeltes Spulen: erst nach kurzer Pause EINMAL springen
  $: displayTime = isSeeking ? seekTime : currentTime;
  $: seekPct     = duration > 0 ? (displayTime / duration) * 100 : 0;

  // Rechte Zeit-Anzeige: tippbar, wechselt Gesamtdauer → Restzeit → Endzeit (dezent, kein neues Element)
  let timeMode = 'total';
  function cycleTimeMode() {
    timeMode = timeMode === 'total' ? 'remaining' : timeMode === 'remaining' ? 'end' : 'total';
    resetControlsTimeout();
  }
  $: rightTimeLabel = (() => {
    if (!duration) return formatTime(0);
    if (timeMode === 'remaining') return '-' + formatTime(Math.max(0, duration - displayTime));
    if (timeMode === 'end') {
      const end = new Date(Date.now() + Math.max(0, duration - currentTime) * 1000);
      return end.toLocaleTimeString($currentLang === 'de' ? 'de-DE' : 'en-US', { hour: '2-digit', minute: '2-digit', hour12: !use24h });
    }
    return formatTime(duration);
  })();

  // Uhrzeit (oben rechts, nur sichtbar wenn Steuerung eingeblendet — schont OLED)
  let clockNow = '';
  let clockTimer;
  function updateClock() {
    clockNow = new Date().toLocaleTimeString($currentLang === 'de' ? 'de-DE' : 'en-US',
      { hour: '2-digit', minute: '2-digit', hour12: !use24h });
  }
  $: $currentLang, use24h, updateClock();

  // Ladeanimation + Fehlerzustand
  let isBuffering = true;
  let playbackError = false;     // zeigt Fehlermeldung statt endlosem Spinner
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
      if (progressed) {
        isBuffering = false;          // läuft doch → kein Fehler
      } else if (isBuffering) {
        playbackError = true; isBuffering = false;
      }
      bufferWatchdog = null;
    }, 30000);
  }
  function clearBufferWatchdog() { clearTimeout(bufferWatchdog); bufferWatchdog = null; }

  function onPlayable() {            // canplay / playing
    isBuffering = false;
    playbackError = false;
    clearBufferWatchdog();
  }
  function onWaiting() {             // waiting / stalled
    isBuffering = true;
    armBufferWatchdog();
  }
  // Diagnose-Logger für <video>-Lebenszyklus-Events
  function vlog(ev, extra) {
    console.log(`[OcenFin] video:${ev}`, { method: playMethod, t: Math.round(videoElement?.currentTime || 0), ...(extra || {}) });
  }
  // Läuft die Zeit, läuft die Wiedergabe → Pufferzustand sicher aufheben.
  function onProgressTick() {
    if (isBuffering) { isBuffering = false; clearBufferWatchdog(); }
  }
  function onVideoError() {
    // MediaError-Code hilft bei der Diagnose: 3 = DECODE (Codec/Decoder),
    // 4 = SRC_NOT_SUPPORTED (Format/Container), 2 = NETWORK.
    const err = videoElement?.error;
    console.error('[OcenFin] <video> Fehler:', { code: err?.code, message: err?.message, playMethod });
    // Direct Play am Gerät gescheitert (z.B. MKV-Demux/Audio nicht abspielbar) →
    // EINMALIG auf Transcode zurückfallen, statt sofort die Fehlerseite zu zeigen.
    // Genau dieses "erst Direct Play versuchen, dann transkodieren" machen LiteFin/Breezefin.
    if (playMethod !== 'Transcode' && !triedTranscodeFallback) {
      triedTranscodeFallback = true;
      console.warn('[OcenFin] Direct Play fehlgeschlagen → erzwinge Transcode-Fallback');
      clearBufferWatchdog();
      isBuffering = true; playbackError = false;
      setupPlayback(selectedAudioIndex, selectedSubtitleIndex, true);
      return;
    }
    clearBufferWatchdog();
    isBuffering = false;
    playbackError = true;
  }
  function retryPlayback() {
    playbackError = false;
    isBuffering = true;
    resumeApplied = false;          // beim Neuversuch ggf. wieder an die Position springen
    if (videoElement) { videoElement.load(); videoElement.play(); }
    armBufferWatchdog();
  }

  // UI
  let showControls  = true;
  let showSettings  = false;
  let pickerMode    = null;        // null | 'collection' | 'playlist' – steuert <AddToPicker>
  let settingsTab   = 'audio';     // 'audio' | 'subtitle' — welcher Bereich im Panel gezeigt wird
  let controlsTimeout;
  let isFavorite = item.UserData?.IsFavorite || false;

  // Playback
  let progressTimer;
  let startTicks    = item.UserData?.PlaybackPositionTicks || 0;
  let resumeApplied = false;   // Fortsetzen-Sprung nur einmal ausführen
  let playSessionId = crypto.randomUUID();  // wird durch PlaybackInfo ersetzt
  let playMethod    = 'DirectPlay';         // DirectPlay | DirectStream | Transcode
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
  let mediaStreams   = [];
  let currentMediaSource = null;   // aktuell laufende Quelle – für den Instant-Switch von Textuntertiteln
  $: audioStreams    = mediaStreams.filter(s => s.Type === 'Audio');
  $: subtitleStreams = mediaStreams.filter(s => s.Type === 'Subtitle');

  // ============================================================
  // WIEDERGABE-AUFBAU — PlaybackInfo entscheidet Direct Play vs. Transcode
  // ============================================================

  // Holt die Server-Entscheidung und hängt die passende Quelle ans <video>.
  // Bei Fehlern: Fallback auf die alte Direct-Play-Logik (Verhalten wie zuvor).
  async function setupPlayback(audioIndex, subtitleIndex, forceTranscode = false) {
    if (hls) { try { hls.destroy(); } catch {} hls = null; }
    if (!forceTranscode) triedTranscodeFallback = false;   // frischer Versuch → Fallback wieder erlauben
    try {
      const explicitAudio = audioIndex !== -1;
      // Ein Untertitel erzwingt nur dann einen Transcode, wenn er GEBRANNT wird:
      // Textuntertitel nur bei aktiviertem Einbrennen, Grafikuntertitel (PGS/VobSub) immer.
      // Externe Textuntertitel (VTT-Overlay) brauchen KEINEN Transcode → Direct Play bleibt möglich,
      // und der Untertitelwechsel kann weich (ohne Neuladen) erfolgen.
      const subStreams = (item?.MediaStreams?.length ? item.MediaStreams : mediaStreams) || [];
      const subStream  = subtitleIndex !== -1 ? subStreams.find(s => s.Index === subtitleIndex && s.Type === 'Subtitle') : null;
      const graphicSub = ['pgssub', 'dvdsub', 'pgs', 'dvbsub', 'vobsub', 'sub'].includes((subStream?.Codec || '').toLowerCase());
      const subWillBurn = subtitleIndex !== -1 && (playbackPrefs.burnSubtitles || graphicSub);

      const enableDirectPlay = !explicitAudio && !subWillBurn && !forceTranscode;
      // Bei explizitem Audiowechsel/gebranntem Untertitel: DirectStream AUS + Audio NEU kodieren → der
      // Server gibt garantiert die GEWÄHLTE Spur aus, statt die Standardspur (deutsch) zu kopieren.
      const enableDirectStream = !explicitAudio && !subWillBurn && !forceTranscode;
      const allowAudioStreamCopy = !explicitAudio;
      console.log('[OcenFin] setupPlayback →', { item: item?.Name, audioIndex, subtitleIndex, enableDirectPlay, enableDirectStream, allowAudioStreamCopy, forceTranscode });
      // Direct Play: volle Bitrate; Transcode: deckeln, damit der Server in Echtzeit mitkommt.
      const requestBitrate = enableDirectPlay ? maxBitrate : Math.min(maxBitrate, TRANSCODE_MAX_BITRATE);
      const info = await getPlaybackInfoFast({
        serverUrl, userId: selectedUser.Id, token: activeToken, itemId: item.Id,
        audioStreamIndex: audioIndex, subtitleStreamIndex: subtitleIndex,
        maxBitrate: requestBitrate, startTicks: 0,   // Resume passiert client-seitig (seekToResume)
        enableDirectPlay, enableDirectStream, allowAudioStreamCopy,
        burnSubtitles: playbackPrefs.burnSubtitles,
        mediaSourceId,
      });
      if (info.playSessionId) playSessionId = info.playSessionId;
      const ms = info.mediaSource;
      currentMediaSource = ms;   // für den fliegenden Untertitel-Wechsel merken
      const resolved = resolveStream({ serverUrl, token: activeToken, itemId: item.Id, mediaSource: ms, audioStreamIndex: audioIndex, subtitleStreamIndex: subtitleIndex });
      playMethod = resolved.method;
      console.log('[OcenFin] resolveStream →', { method: resolved.method, isHls: resolved.isHls, url: resolved.url });
      await attachSource(resolved.url, resolved.isHls);
      applyExternalSubtitleIfNeeded(subtitleIndex, ms);
    } catch (e) {
      console.error('PlaybackInfo fehlgeschlagen, Fallback auf Direct Play:', e);
      playMethod = 'DirectPlay';
      const url = `${serverUrl}/Videos/${item.Id}/stream?static=true&api_key=${activeToken}` +
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
          hls = new Hls({ maxBufferLength: 30, enableWorker: true, backBufferLength: 30 });
          hls.loadSource(url);
          hls.attachMedia(videoElement);
          hls.on(Hls.Events.ERROR, (_e, data) => {
            // Ausführliche Diagnose: Typ, Detail, Codec-Hinweis, HTTP-Status
            console.error('[OcenFin] hls.js Fehler:', {
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
        console.error('hls.js konnte nicht geladen werden:', err);
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
  let currentSubtitleText = '';
  let subtitleCues = [];           // [{ start, end, text }] in Sekunden
  let subtitleFetchToken = 0;      // ignoriert Antworten eines überholten Wechsels

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
  $: currentSubtitleText = subtitleCues.length
    ? (subtitleCues.find(c => currentTime >= c.start && currentTime <= c.end)?.text ?? '')
    : '';

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

    const url = externalSubtitleUrl({ serverUrl, itemId: item.Id, mediaSourceId: ms.Id, stream, token: activeToken });
    try {
      const res = await fetch(url);
      if (!res.ok || myToken !== subtitleFetchToken) return;   // überholt oder Fehler
      const text = await res.text();
      if (myToken !== subtitleFetchToken) return;
      subtitleCues = parseVtt(text);
      console.log('[OcenFin] Untertitel geladen:', subtitleCues.length, 'Cues');
    } catch (e) { console.log('[OcenFin] Untertitel-Fetch-Fehler:', e?.message); }
  }

  // Intro Skipper / Media Segments
  let introData = null;
  let segmentsChecked = false;     // Plugin-APIs abgefragt → Kapitel-Fallback darf greifen
  let chapterFallbackDone = false;
  $: showSkipIntro = introData?.Introduction?.Valid
    && currentTime >= (introData.Introduction.ShowSkipPromptAt ?? 0)
    && currentTime <= (introData.Introduction.HideSkipPromptAt ?? 0);

  // Outro/Abspann (Media-Segments-/Plugin-Daten) — Auslöser für Auto-Skip & Auto-Play-Countdown
  $: showSkipCredits = introData?.Credits?.Valid
    && currentTime >= (introData.Credits.ShowSkipPromptAt ?? Infinity);

  // Auto-Play der nächsten Folge mit Countdown-Overlay (Netflix-Prinzip).
  // Startet nahe dem Ende; "Abspann automatisch überspringen" hat Vorrang (sofortiger Sprung).
  let chapters          = [];
  let nextCountdown     = null;   // verbleibende Sekunden (ganzzahlig, für den Text), null = inaktiv
  let countdownProgress = 0;      // 1 → 0, treibt den Balken
  let countdownTimer    = null;
  let countdownEnd      = 0;
  let countdownDismissed = false; // pro Folge: nach Abbruch nicht erneut starten
  const COUNTDOWN_FROM  = 12;

  // Kapitel-Fallback für Intro/Abspann: greift reaktiv, sobald die Plugin-APIs nichts lieferten
  // UND die Kapitel geladen sind (nur eindeutig benannte Kapitel, sonst kein Prompt).
  $: if (segmentsChecked && !chapterFallbackDone && introData === null && chapters.length) {
    chapterFallbackDone = true;
    introData = chaptersToIntroData(chapters);
  }

  $: nearEnd = duration > 0 && currentTime > 0 && (
    showSkipCredits || (duration - currentTime) <= COUNTDOWN_FROM
  );
  $: if (playbackPrefs.autoPlayNext && nextEpisode && !playbackPrefs.autoSkipCredits
         && nearEnd && nextCountdown === null && !countdownDismissed) {
    startCountdown();
  }

  function startCountdown() {
    // Nächste Folge leicht vorladen (nur PlaybackInfo/Stream-URL, kein Video-Pre-Buffering),
    // damit der Wechsel den Roundtrip spart. Greift nur, wenn die Parameter beim Wechsel passen.
    if (nextEpisode?.Id) {
      prefetchPlaybackInfo({
        serverUrl, userId: selectedUser.Id, token: activeToken, itemId: nextEpisode.Id,
        audioStreamIndex: selectedAudioIndex, subtitleStreamIndex: selectedSubtitleIndex,
        maxBitrate, burnSubtitles: playbackPrefs.burnSubtitles, mediaSourceId: null,
      });
    }
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

  // Aktueller Kapitelname (für Anzeige beim Spulen)
  $: currentChapterName = chapters.length
    ? (chapters.filter(c => (c.StartPositionTicks / 10000000) <= displayTime).pop()?.Name ?? null)
    : null;

  // Auto-Skip (abhängig von Einstellung + installiertem Intro-Skipper-Plugin).
  // Flags verhindern wiederholtes Springen; werden beim Episodenwechsel via {#key}-Remount zurückgesetzt.
  let introAutoSkipped   = false;
  let creditsAutoSkipped = false;
  $: if (playbackPrefs.autoSkipIntro && showSkipIntro && !introAutoSkipped && videoElement) {
    introAutoSkipped = true;
    skipIntro();
  }
  $: if (playbackPrefs.autoSkipCredits && showSkipCredits && !creditsAutoSkipped && nextEpisode) {
    creditsAutoSkipped = true;
    goToNextEpisode();
  }

  // Serien-Episoden (alle Staffeln) für zuverlässige Vor/Zurück-Navigation über Staffelgrenzen hinweg
  let seriesEpisodes = [];
  let episodeIndex   = -1;
  $: prevEpisode = episodeIndex > 0 ? seriesEpisodes[episodeIndex - 1] : null;
  $: nextByIndex = episodeIndex >= 0 && episodeIndex < seriesEpisodes.length - 1
                   ? seriesEpisodes[episodeIndex + 1] : null;
  $: nextEpisode = nextByIndex;   // Auto-Play/Outro nutzen dieselbe sequentielle nächste Folge (auch zur nächsten Staffel)
  // Position in der Staffel für die Anzeige oben links: "Folge X von Y"
  $: seasonTotal = (item?.Type === 'Episode' && item.ParentIndexNumber != null)
                   ? seriesEpisodes.filter(e => e.ParentIndexNumber === item.ParentIndexNumber).length : 0;
  $: episodePosition = (item?.Type === 'Episode' && item.IndexNumber != null && seasonTotal > 0)
                   ? `${$t.episode} ${item.IndexNumber} ${$t.of} ${seasonTotal}` : '';

  // Infozeile zur nächsten Folge: "S2 · E1 · 52 Min · endet um 11:59"
  $: nextEpisodeMeta = (() => {
    if (!nextEpisode) return '';
    const parts = [];
    if (nextEpisode.ParentIndexNumber != null && nextEpisode.IndexNumber != null)
      parts.push(`S${nextEpisode.ParentIndexNumber} · E${nextEpisode.IndexNumber}`);
    const mins = nextEpisode.RunTimeTicks ? Math.round(nextEpisode.RunTimeTicks / 600000000) : 0;
    if (mins) {
      parts.push(`${mins} ${$t.minShort}`);
      const end = new Date(Date.now() + mins * 60000);
      parts.push(`${$t.endsAt} ${end.toLocaleTimeString($currentLang === 'de' ? 'de-DE' : 'en-US', { hour: '2-digit', minute: '2-digit', hour12: !use24h })}`);
    }
    return parts.join(' · ');
  })();

  // ============================================================
  // LIFECYCLE
  // ============================================================

  // "Schaust du noch?" – Best Practice (Netflix-Stil): NICHT zeitbasiert, sondern nach
  // mehreren automatisch abgespielten Folgen in Folge ohne Interaktion. Greift damit nur bei
  // Serien-Auto-Play (Einschlaf-Schutz) und unterbricht nie einen Film oder eine aktiv geschaute Folge.
  // Der Zähler (autoPlayStreak) lebt in App.svelte, weil der Player pro Folge neu aufsetzt.
  let showStillWatching = false;
  let interacted = false;   // hat der Nutzer in DIESER Folge etwas getan? (Tastendruck/Remote/Klick)
  function markInteraction() { interacted = true; }
  function resumeFromStillWatching() {
    showStillWatching = false;
    // Nutzer ist wach → weiter zur nächsten Folge; Zähler in App zurücksetzen.
    if (nextEpisode) dispatch('next', { episode: nextEpisode, resetStreak: true });
  }

  onMount(async () => {
    resetControlsTimeout();
    if (playerContainer) playerContainer.focus();

    fetchMediaSources();
    fetchIntroTimestamps();
    fetchSeriesEpisodes();   // Vor/Zurück + Auto-Play + Positionsanzeige (über alle Staffeln)

    // Interaktions-Tracking für "Schaust du noch?": jede bewusste Eingabe markiert den Nutzer als wach.
    window.addEventListener('keydown', markInteraction);
    window.addEventListener('pointermove', markInteraction);
    window.addEventListener('click', markInteraction);

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
    if (controlsTimeout) clearTimeout(controlsTimeout);
    if (progressTimer)   clearInterval(progressTimer);
    if (countdownTimer)  clearInterval(countdownTimer);
    if (seekCommitTimer) clearTimeout(seekCommitTimer);
    if (clockTimer)      clearInterval(clockTimer);
    clearBufferWatchdog();
    if (hls) { try { hls.destroy(); } catch {} hls = null; }
    reportPlaybackStopped();
  });

  // ============================================================
  // API
  // ============================================================

  function getAuthHeaders() {
    return {
      "Authorization": `MediaBrowser Token="${activeToken}"`,
      "Content-Type": "application/json"
    };
  }

  async function fetchMediaSources() {
    try {
      const res = await fetch(
        `${serverUrl}/Users/${selectedUser.Id}/Items/${item.Id}?Fields=MediaSources,Chapters`,
        { headers: getAuthHeaders() }
      );
      if (res.ok) {
        const data = await res.json();
        chapters = data.Chapters || [];
        // Spurenliste nur für die Auswahl-UI (Audio/Untertitel). Die tatsächliche
        // Lieferung (Spur vs. eingebrannt) entscheidet PlaybackInfo in setupPlayback.
        if (data.MediaSources?.[0]?.MediaStreams) mediaStreams = data.MediaSources[0].MediaStreams;
      }
    } catch (e) { console.error('fetchMediaSources:', e); }
  }

  async function fetchIntroTimestamps() {
    if (item.Type !== 'Episode') return;
    // 1) Moderne Media-Segments-API (Intro Skipper ab Jellyfin 10.9 liefert hierüber).
    //    Ohne Typ-Filter abfragen und selbst filtern — robuster gegen Server-/Versionsunterschiede.
    try {
      const res = await fetch(`${serverUrl}/MediaSegments/${item.Id}`, { headers: getAuthHeaders() });
      if (res.ok) {
        const segs = (await res.json()).Items || [];
        console.log('[OcenFin] Media-Segments:', segs.map(s => s.Type));
        const d = segs.length ? segmentsToIntroData(segs) : null;
        if (d) {
          console.log('[OcenFin] Media-Segments → Intro', d.Introduction.Valid, '| Outro', d.Credits.Valid);
          introData = d; return;
        }
      } else {
        console.log('[OcenFin] Media-Segments HTTP', res.status);   // z. B. 404 = Endpunkt fehlt, 401 = Auth
      }
    } catch (e) { console.log('[OcenFin] Media-Segments Fehler:', e?.message); }
    // 2) Ältere ConfusedPolarBear-Plugin-API. Manche Versionen liefern das Intro flach
    //    ({ Valid, IntroStart, … }), andere als { Introduction, Credits } → beide Formen abfangen.
    try {
      const res = await fetch(`${serverUrl}/Episode/${item.Id}/IntroTimestamps/v1`, { headers: getAuthHeaders() });
      if (res.ok) {
        const data = await res.json();
        console.log('[OcenFin] IntroTimestamps/v1:', JSON.stringify(data));
        introData = (data.Introduction || data.Credits) ? data : { Introduction: data, Credits: { Valid: false } };
        return;
      } else {
        console.log('[OcenFin] IntroTimestamps/v1 HTTP', res.status);
      }
    } catch (e) { console.log('[OcenFin] IntroTimestamps/v1 Fehler:', e?.message); }
    // 3) Kein Plugin-Treffer → Kapitel-Fallback (greift reaktiv, sobald Kapitel geladen sind)
    console.log('[OcenFin] Keine Media-Segments/Plugin-Daten → Kapitel-Fallback');
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
        `${serverUrl}/Shows/${item.SeriesId}/Episodes?UserId=${selectedUser.Id}`,
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
      await fetch(`${serverUrl}/Sessions/Playing`, {
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
      await fetch(`${serverUrl}/Sessions/Playing/Progress`, {
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

  async function reportPlaybackStopped() {
    if (!videoElement) return;
    try {
      await fetch(`${serverUrl}/Sessions/Playing/Stopped`, {
        method: "POST",
        headers: getAuthHeaders(),
        body: JSON.stringify({
          ItemId: item.Id,
          PositionTicks: Math.round(videoElement.currentTime * 10000000),
          PlaySessionId: playSessionId
        })
      });
    } catch { }
  }

  // ============================================================
  // TRACK WECHSEL
  // ============================================================

  async function changeTrack(type, index) {
    showSettings = false;
    resetControlsTimeout();
    if (playerContainer) playerContainer.focus();

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
        if (graphicCodecs.includes((s.Codec || '').toLowerCase())) return false;     // Grafik → nicht als VTT
        return true;
      };
      const oldIsExternal = isSoftSub(oldStream, selectedSubtitleIndex);
      const newIsExternal = isSoftSub(newStream, index);

      selectedSubtitleIndex = index;

      // Instant-Switch: müssen weder alter noch neuer Untertitel ins Bild gebrannt werden
      // (reine Textuntertitel oder "Aus"), tauschen wir nur die <track>-Spur aus – ohne
      // das Video neu zu laden. Gebrannte (PGS/ASS) Untertitel brauchen weiter einen Transcode.
      if (oldIsExternal && newIsExternal && currentMediaSource) {
        applyExternalSubtitleIfNeeded(index, currentMediaSource);
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
  }

  // ============================================================
  // AKTIONEN
  // ============================================================

  function skipIntro() {
    if (!videoElement || !introData?.Introduction?.IntroEnd) return;
    videoElement.currentTime = introData.Introduction.IntroEnd;
    resetControlsTimeout();
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
    dispatch('next', { episode: nextEpisode, resetStreak: awake });
  }

  async function toggleFavorite() {
    isFavorite = !isFavorite;
    resetControlsTimeout();
    try {
      await fetch(`${serverUrl}/Users/${selectedUser.Id}/FavoriteItems/${item.Id}`, {
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
    if (isPlaying) videoElement.pause();
    else           videoElement.play();
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
  $: hasChapterNav = showChapters && chapters.length > 1;
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

  // FIX: Settings Panel auto-fokussieren für WebOS D-Pad
  async function toggleSettings() {
    showSettings = !showSettings;
    if (showSettings) {
      if (controlsTimeout) clearTimeout(controlsTimeout);
      await tick();
      // Ersten Button im Settings-Panel fokussieren
      const firstBtn = settingsPanel?.querySelector('button');
      if (firstBtn) firstBtn.focus();
    } else {
      resetControlsTimeout();
      if (playerContainer) playerContainer.focus();
    }
  }

  // Öffnet das Panel direkt auf Audio- oder Untertitel-Bereich (eigene Buttons statt Zahnrad).
  // Gleiche Taste bei offenem, gleichem Tab → schließen.
  async function openSettings(tab) {
    if (showSettings && settingsTab === tab) { toggleSettings(); return; }
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
      dispatch('exit');
      return;
    }
    // HUD verborgen (man schaut gerade) → OK pausiert/spielt direkt. preventDefault
    // unterbindet einen zusätzlichen Klick auf den (unsichtbar fokussierten) Button.
    if ((e.key === 'Enter' || e.keyCode === 13) && !showControls) {
      e.preventDefault();
      togglePlay();
      resetControlsTimeout();
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
  on:mousemove={resetControlsTimeout}
  on:pointermove={resetControlsTimeout}
  on:keydown={handleKeyDown}
>

  <video
    bind:this={videoElement}
    class="w-full h-full object-contain"
    on:play={() => { vlog('play'); isPlaying = true; onPlayable(); }}
    on:playing={() => { vlog('playing'); onPlayable(); }}
    on:pause={() => isPlaying = false}
    on:waiting={() => { vlog('waiting'); onWaiting(); }}
    on:stalled={() => { vlog('stalled'); onWaiting(); }}
    on:canplay={onPlayable}
    on:loadstart={() => vlog('loadstart')}
    on:suspend={() => vlog('suspend')}
    on:error={onVideoError}
    on:timeupdate={() => { if (!isSeeking) currentTime = videoElement?.currentTime ?? 0; onProgressTick(); }}
    on:loadedmetadata={() => { vlog('loadedmetadata', { dur: Math.round(videoElement?.duration || 0), w: videoElement?.videoWidth, h: videoElement?.videoHeight }); seekToResume(); }}
    on:ended={onVideoEnded}
    on:click={togglePlay}
  />

  <!-- LADEANIMATION — sichtbar solange Video puffert oder NAS aufwacht -->
  {#if isBuffering && !playbackError}
    <div class="absolute inset-0 flex items-center justify-center z-[30] pointer-events-none">
      <div class="flex flex-col items-center gap-5">
        <div class="w-20 h-20 border-4 border-white/20 border-t-white rounded-full animate-spin"></div>
        <p class="text-white/50 text-lg font-medium tracking-wider">{$t.loading}</p>
      </div>
    </div>
  {/if}

  <!-- FEHLER — statt endlosem Spinner: klare Meldung + Aktionen -->
  {#if playbackError}
    <div class="absolute inset-0 flex items-center justify-center z-[80] bg-black/80">
      <div class="flex flex-col items-center gap-5 max-w-md text-center px-8">
        <svg class="w-16 h-16 text-red-500" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m0 3.75h.008M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
        <p class="text-white text-2xl font-bold">{$t.playbackError}</p>
        <p class="text-gray-400">{$t.playbackErrorHint}</p>
        <div class="flex gap-4 mt-2">
          <button on:click={retryPlayback} use:focusOnMount
            class="bg-white text-black font-bold px-6 py-3 rounded-xl focus:outline-none focus:ring-4 focus:ring-white hover:bg-gray-200 transition-colors">
            {$t.retry}
          </button>
          <button on:click={() => dispatch('exit')}
            class="bg-gray-700 text-white font-bold px-6 py-3 rounded-xl focus:outline-none focus:ring-4 focus:ring-white hover:bg-gray-600 transition-colors">
            {$t.back}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- HAUPT-OVERLAY — Klick auf die leere Bildfläche (|self, nicht auf Buttons) pausiert/spielt -->
  <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/50 flex flex-col justify-between p-10 transition-opacity duration-500 z-50
              {showControls ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}"
       on:click|self={togglePlay}>

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
      {#if showClock}
        <span class="text-2xl font-semibold text-white/90 drop-shadow-lg tabular-nums shrink-0">{clockNow}</span>
      {/if}
    </div>

    <!-- UNTEN: Progress + Buttons -->
    <div class="w-full flex flex-col gap-6">

      <!-- PROGRESS BAR — sauberes Scrubbing, Kapitelmarken nur wenn aktiviert -->
      {#if showChapters && isSeeking && currentChapterName}
        <div class="text-center text-sm font-semibold text-white/80 -mb-2 drop-shadow">{currentChapterName}</div>
      {/if}
      <div class="flex items-center gap-4 w-full">
        <span class="text-sm font-mono w-16 tabular-nums">{formatTime(displayTime)}</span>
        <div class="relative flex-1 flex items-center">
          <input
            type="range"
            min="0"
            max={duration || 0}
            value={isSeeking ? seekTime : currentTime}
            bind:this={seekBarEl}
            on:pointerdown={onSeekStart}
            on:input={onSeekInput}
            on:pointerup={onSeekEnd}
            on:keydown={onSeekKey}
            style="background: linear-gradient(to right, var(--color-blue-500, #3b82f6) {seekPct}%, rgba(255,255,255,0.22) {seekPct}%);"
            class="seekbar w-full h-1.5 rounded-full appearance-none cursor-pointer focus:outline-none"
          />
          {#if isSeeking}
            <div class="absolute bottom-full mb-4 -translate-x-1/2 pointer-events-none whitespace-nowrap"
                 style="left: {Math.min(96, Math.max(4, seekPct))}%;">
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
            <span class="absolute bottom-full right-2 mb-0.5 text-[11px] font-medium text-gray-400 whitespace-nowrap pointer-events-none">{$t.endsAt}</span>
          {/if}
          <button on:click|stopPropagation={cycleTimeMode}
            class="text-sm font-mono text-right tabular-nums cursor-pointer rounded-md px-2 py-1
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
          <button on:click={() => prevEpisode && dispatch('prev', prevEpisode)}
            disabled={!prevEpisode}
            class="p-3 text-gray-400 hover:text-white focus:text-white focus:outline-none disabled:opacity-30"
            title={$t.prevEpisode}>
            <!-- |◄ : bar links + Dreieck zeigt LINKS -->
            <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/>
            </svg>
          </button>

          <!-- Kapitel zurück — nur wenn aktiviert UND Kapitelmarken vorhanden.
               Icon bewusst ANDERS als Folgen-Skip: Chevron auf einen Punkt (= Kapitelmarke). -->
          {#if hasChapterNav}
            <button on:click={chapterPrev} class="p-2.5 text-gray-500 hover:text-white focus:text-white focus:outline-none" title={$t.chapterPrev}>
              <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M15 7l-5 5 5 5"/>
                <circle cx="8" cy="12" r="1.6" fill="currentColor" stroke="none"/>
              </svg>
            </button>
          {/if}

          <button on:click={() => skip(-seekStep)} class="p-3 text-gray-400 hover:text-white focus:text-white focus:outline-none" title="-{seekStep}s">
            <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M12.066 11.2a1 1 0 000 1.6l5.334 4A1 1 0 0019 16V8a1 1 0 00-1.6-.8l-5.334 4zM4.066 11.2a1 1 0 000 1.6l5.334 4A1 1 0 0011 16V8a1 1 0 00-1.6-.8l-5.334 4z"/>
            </svg>
          </button>

          <button on:click={togglePlay} use:focusOnMount bind:this={playPauseBtn}
            class="p-4 bg-white text-black rounded-full hover:scale-110 focus:scale-110 transition-transform focus:outline-none shadow-xl">
            {#if isPlaying}
              <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
            {:else}
              <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
            {/if}
          </button>

          <button on:click={() => skip(seekStep)} class="p-3 text-gray-400 hover:text-white focus:text-white focus:outline-none" title="+{seekStep}s">
            <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M11.934 12.8a1 1 0 000-1.6l-5.334-4A1 1 0 005 8v8a1 1 0 001.6.8l5.334-4zM19.934 12.8a1 1 0 000-1.6l-5.334-4A1 1 0 0013 8v8a1 1 0 001.6.8l5.334-4z"/>
            </svg>
          </button>

          <!-- Kapitel vor — nur wenn aktiviert UND Kapitelmarken vorhanden.
               Icon bewusst ANDERS als Folgen-Skip: Chevron auf einen Punkt (= Kapitelmarke). -->
          {#if hasChapterNav}
            <button on:click={chapterNext} class="p-2.5 text-gray-500 hover:text-white focus:text-white focus:outline-none" title={$t.chapterNext}>
              <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 7l5 5-5 5"/>
                <circle cx="16" cy="12" r="1.6" fill="currentColor" stroke="none"/>
              </svg>
            </button>
          {/if}

          <!-- Nächste Folge: ►| — Transport-Navigation (sequentiell), zählt als bewusste Aktion -->
          <button on:click={() => goToNextEpisode(true)}
            disabled={!nextByIndex}
            class="p-3 text-gray-400 hover:text-white focus:text-white focus:outline-none disabled:opacity-30"
            title={$t.nextEpisode}>
            <!-- ►| : Dreieck zeigt RECHTS + bar rechts -->
            <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
              <path d="M16 6h2v12h-2zm-10 0l9 6-9 6V6z"/>
            </svg>
          </button>
        </div>

        <div class="flex items-center gap-4">

          <!-- Favorit -->
          <button on:click={toggleFavorite}
            class="p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-white transition-colors {isFavorite ? 'text-red-500' : 'text-gray-400 hover:text-white focus:text-white'}">
            <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
            </svg>
          </button>

          <!-- Zur Wiedergabeliste hinzufügen -->
          <button on:click|stopPropagation={() => pickerMode = 'playlist'} title={$t.addToPlaylist} aria-label={$t.addToPlaylist}
            class="p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-white transition-colors text-gray-400 hover:text-white focus:text-white">
            <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 6h13M3 12h9m-9 6h9m4-3v6m3-3h-6"/></svg>
          </button>

          <!-- Zur Sammlung hinzufügen -->
          <button on:click|stopPropagation={() => pickerMode = 'collection'} title={$t.addToCollection} aria-label={$t.addToCollection}
            class="p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-white transition-colors text-gray-400 hover:text-white focus:text-white">
            <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/></svg>
          </button>

          <!-- AUDIO — nur Icon (ersetzt das Zahnrad) -->
          <button on:click|stopPropagation={() => openSettings('audio')} title={$t.audio} aria-label={$t.audio}
            class="p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-white transition-colors
                   {showSettings && settingsTab === 'audio' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white focus:text-white'}">
            <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"/>
            </svg>
          </button>

          <!-- UNTERTITEL — nur Icon -->
          <button on:click|stopPropagation={() => openSettings('subtitle')} title={$t.subtitles} aria-label={$t.subtitles}
            class="p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-white transition-colors
                   {showSettings && settingsTab === 'subtitle' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white focus:text-white'}">
            <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M4 6h16M4 10h12M4 14h16M4 18h8"/>
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- EINSTELLUNGS-PANEL — bind:this für WebOS D-Pad Fokus -->
    {#if showSettings}
      <div bind:this={settingsPanel} data-focus-trap
        class="absolute bottom-32 right-12 bg-gray-900/95 backdrop-blur-md border border-gray-700 rounded-2xl shadow-2xl z-[60] p-6 flex flex-col gap-6 w-96 max-h-[60vh] animate-fade-in">

        <div class="flex justify-between items-center">
          <h2 class="text-2xl font-bold text-white">{settingsTab === 'audio' ? $t.audio : $t.subtitles}</h2>
          <button on:click={toggleSettings} class="text-gray-400 hover:text-white focus:text-white focus:outline-none focus:ring-2 focus:ring-white rounded-lg p-1">
            <svg class="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        <div class="overflow-y-auto hide-scrollbar flex flex-col gap-2">

          {#if settingsTab === 'audio'}
            {#each audioStreams as stream}
              <button on:click={() => changeTrack('audio', stream.Index)}
                class="text-left p-3 rounded-lg font-medium text-sm focus:outline-none focus:ring-2 focus:ring-inset focus:ring-white transition-colors
                       {selectedAudioIndex === stream.Index ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700 focus:bg-gray-700'}">
                {stream.DisplayTitle || `${stream.Language || 'Unbekannt'} – ${stream.Codec}`}
              </button>
            {:else}
              <p class="text-gray-500 text-sm p-3">—</p>
            {/each}
          {:else}
            <button on:click={() => changeTrack('subtitle', -1)}
              class="text-left p-3 rounded-lg font-medium text-sm focus:outline-none focus:ring-2 focus:ring-inset focus:ring-white transition-colors
                     {selectedSubtitleIndex === -1 ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700 focus:bg-gray-700'}">
              {$t.subtitleOff}
            </button>
            {#each subtitleStreams as stream}
              <button on:click={() => changeTrack('subtitle', stream.Index)}
                class="text-left p-3 rounded-lg font-medium text-sm focus:outline-none focus:ring-2 focus:ring-inset focus:ring-white transition-colors
                       {selectedSubtitleIndex === stream.Index ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700 focus:bg-gray-700'}">
                {stream.DisplayTitle || stream.Language || 'Unbekannt'}
              </button>
            {/each}
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
      <span class="subtitle-box sub-{playbackPrefs.subtitleSize || 'normal'}">{currentSubtitleText}</span>
    </div>
  {/if}


  <!-- INTRO ÜBERSPRINGEN — unten links -->
  {#if showSkipIntro}
    <div class="absolute bottom-36 left-12 z-[70] animate-fade-in">
      <button on:click={skipIntro} use:focusOnMount
        class="bg-white/10 backdrop-blur-md border-2 border-white text-white font-bold text-xl
               px-8 py-4 rounded-xl flex items-center gap-3 shadow-2xl
               hover:bg-white hover:text-black focus:bg-white focus:text-black
               focus:outline-none transition-all duration-200">
        <!-- Doppelpfeil rechts für "überspringen" -->
        <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
          <path d="M5.59 7.41L10.18 12l-4.59 4.59L7 18l6-6-6-6zM16 6h2v12h-2z"/>
        </svg>
        {$t.skipIntro}
      </button>
    </div>
  {/if}


  <!-- NÄCHSTE FOLGE — unten rechts -->
  <!-- AUTO-PLAY COUNTDOWN — Netflix-Stil, mit "Jetzt abspielen" / "Abbrechen" -->
  {#if nextCountdown !== null && nextEpisode}
    <div class="absolute bottom-36 right-12 z-[70] animate-fade-in">
      <div class="bg-gray-900/95 border border-gray-700 rounded-2xl shadow-2xl p-5 w-80 flex flex-col gap-3">
        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">{$t.nextEpisodeIn} {nextCountdown} {nextCountdown === 1 ? $t.secondOne : $t.secondsMany}</span>
        <span class="text-lg font-bold text-white truncate">{nextEpisode.Name}</span>
        {#if nextEpisodeMeta}<span class="text-sm text-gray-400 truncate">{nextEpisodeMeta}</span>{/if}
        <div class="h-1 bg-gray-700 rounded-full overflow-hidden">
          <div class="h-full bg-blue-500" style="width: {countdownProgress * 100}%; transition: width 0.12s linear;"></div>
        </div>
        <div class="flex gap-3">
          <button on:click={() => goToNextEpisode(true)} use:focusOnMount
            class="flex-1 bg-white text-black font-bold py-2.5 rounded-lg flex items-center justify-center gap-2
                   focus:outline-none focus:ring-4 focus:ring-white hover:bg-gray-200 transition-colors">
            <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
            {$t.playNow}
          </button>
          <button on:click={cancelCountdown}
            class="px-4 bg-gray-700 text-white font-bold py-2.5 rounded-lg
                   focus:outline-none focus:ring-4 focus:ring-white hover:bg-gray-600 transition-colors">
            {$t.cancel}
          </button>
        </div>
      </div>
    </div>
  {/if}

  <!-- Manueller "Nächste Folge"-Hinweis (wenn kein Countdown läuft, z. B. Auto-Play aus) -->
  {#if nearEnd && nextEpisode && nextCountdown === null}
    <div class="absolute bottom-36 right-12 z-[70] animate-fade-in">
      <div class="bg-gray-900/95 border border-gray-700 rounded-2xl shadow-2xl p-5 w-80 flex flex-col gap-3">
        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">{$t.nextEpisode}</span>
        <span class="text-lg font-bold text-white truncate">{nextEpisode.Name}</span>
        {#if nextEpisodeMeta}<span class="text-sm text-gray-400 truncate">{nextEpisodeMeta}</span>{/if}
        <button on:click={() => goToNextEpisode(true)} use:focusOnMount
          class="bg-white text-black font-bold py-2.5 rounded-lg flex items-center justify-center gap-2
                 focus:outline-none focus:ring-4 focus:ring-white hover:bg-gray-200 transition-colors">
          <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          {$t.playNow}
        </button>
      </div>
    </div>
  {/if}

  <!-- "Schaust du noch?" – nach Inaktivität pausiert -->
  {#if showStillWatching}
    <div class="absolute inset-0 z-[120] bg-black/85 flex items-center justify-center animate-fade-in">
      <div class="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl p-12 flex flex-col items-center gap-7 max-w-md text-center">
        <svg class="w-16 h-16 text-gray-500" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1 1 0 010-.644C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178a1 1 0 010 .644C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.964-7.178z"/>
          <path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
        </svg>
        <h2 class="text-3xl font-bold text-white">{$t.stillWatching}</h2>
        <button on:click={resumeFromStillWatching} use:focusOnMount
          class="bg-white text-black font-bold text-xl px-10 py-4 rounded-xl flex items-center gap-3
                 focus:outline-none focus:ring-4 focus:ring-white hover:bg-gray-200 transition-colors">
          <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          {$t.continueWatching}
        </button>
      </div>
    </div>
  {/if}

</div>

<!-- Zur Sammlung / Wiedergabeliste hinzufügen (gemeinsame Komponente) -->
<AddToPicker mode={pickerMode} {item} {serverUrl} {selectedUser} {getAuthHeaders}
  on:created={() => dispatch('libchanged')}
  on:close={async () => { pickerMode = null; await tick(); playerContainer?.focus(); }} />

<style>
  .hide-scrollbar::-webkit-scrollbar { display: none; }
  .hide-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }

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
