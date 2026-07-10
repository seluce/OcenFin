<script>
  import { i18n } from '../i18n.svelte.js';
  import { isBackKey, focusOnMount, authHeaders, dlog, uiFade, dropTrapOnOutro } from '../utils.js';
  import { session } from '../session.svelte.js';
  import { getPlaybackInfoFast, prefetchPlaybackInfo, resolveStream, externalSubtitleUrl, graphicSubtitleUrl, assSubtitleUrl } from '../playback.js';
  import { sendSyncCommand, setSyncQueue, sendSyncBuffering, sendSyncReady } from '../syncplay.js';
  import { PgsRenderer, VobSubRenderer, initWasm } from 'libbitsub';
  // ASS/SSA with original layout via assjs — a lean DOM/CSS renderer (no WASM/worker). Syncs
  // to the <video> (only time + dimensions, NO pixels → no cross-origin taint, no crossorigin on the <video>).
  // The browser handles the font fallback. Covers almost all ASS tags (rest: VTT fallback via the toggle).
  import ASS from 'assjs';
  import { onMount, onDestroy, tick } from 'svelte';
  import AddToPicker from './AddToPicker.svelte';

  let {
    item,
    selectedAudioIndex = $bindable(),
    selectedSubtitleIndex = $bindable(),
    mediaSourceId = null,   // chosen version (FullHD/4K); null = server default
    selectedUser,
    playbackPrefs = { autoSkipIntro: false, autoSkipCredits: false },
    use24h = true,   // time format (from the setting) for the clock in the Player
    showClock = true, // show the clock in the Player (follows the display setting)
    showChapters = false, // chapter markers on the bar (opt-in)
    seekStep = 30,        // jump distance of the forward/back buttons in seconds (per profile)
    autoPlayStreak = 0,   // "still watching?": episodes auto-started without interaction (from App)
    syncPlayOpen = false, // SyncPlay modal open (from App) → pause playback meanwhile …
    inSyncGroup  = false, // … except in an active group: then do NOT pause locally
    syncCommand = null,   // last received SyncPlayCommand (from App)
    syncQueue   = null,   // current group queue state (from App)
    queueActive = false,  // "play all" queue active (from App) → next/prev follow the queue
    queueNext = null,     // next queue element (null = end of queue → normal end of playback)
    queuePrev = null,     // previous queue element
    remoteCommand = null, // admin remote control (dashboard) (from App)
    serverVobSub = false, // does the server deliver VobSub/DVD externally (.mks, Jellyfin 12.0+)?
    onExit, onPrev, onNext, onSyncplay, onLibChanged,   // callback props (instead of events)
    onPlayState,          // reports the playback status to App (for the screensaver: paused → allowed)
  } = $props();

  // May this profile manage collections? (Policy.EnableCollectionManagement comes with the login user.
  //  Only hide on an explicit false → older server/missing field: visible + 403 fallback.)
  const canManageCollections = $derived(selectedUser?.Policy?.EnableCollectionManagement !== false);

  let videoElement;
  let playerContainer;
  let settingsPanel = $state();       // bind for auto-focus on webOS
  let playPauseBtn;        // bind: so ▼ from the bar jumps directly here
  let seekBarEl;           // bind: so Left/Right jumps directly here when the HUD is hidden
  let isPlaying  = $state(false);
  // Report the playback status outward (App suppresses the screensaver only during ACTIVE playback);
  // on unmount/leaving the Player report false reliably, no matter which way you exit.
  $effect(() => {
    onPlayState?.(isPlaying);
    return () => onPlayState?.(false);
  });
  let currentTime = $state(0);
  let duration    = $state(0);

  // Scrubbing
  let isSeeking  = $state(false);
  let seekTime   = $state(0);
  let seekCommitTimer = null;   // batched seeking: jump ONCE only after a short pause
  let displayTime = $derived(isSeeking ? seekTime : currentTime);
  let seekPct = $derived(duration > 0 ? (displayTime / duration) * 100 : 0);

  // Right time display: tappable, cycles total duration → remaining → end time (subtle, no new element)
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

  // Clock (top right, only visible when the controls are shown — saves OLED)
  let clockNow = $state('');
  let clockTimer;
  function updateClock() {
    clockNow = new Date().toLocaleTimeString(i18n.lang === 'de' ? 'de-DE' : 'en-US',
      { hour: '2-digit', minute: '2-digit', hour12: !use24h });
  }
  $effect(() => { i18n.lang; use24h; updateClock(); });

  // Loading animation + error state
  let isBuffering = $state(true);
  let playbackError = $state(false);     // shows an error message instead of an endless spinner
  let bufferWatchdog = null;

  // If playback REALLY hangs (a stall without an 'error' event), show an error.
  // Important: only if the time has NOT progressed since the watchdog started —
  // otherwise a brief buffering moment in the middle of running playback would falsely
  // trigger an error after 30 s.
  let watchdogAnchor = 0;
  function armBufferWatchdog() {
    clearTimeout(bufferWatchdog);
    watchdogAnchor = videoElement?.currentTime ?? 0;
    bufferWatchdog = setTimeout(() => {
      const progressed = (videoElement?.currentTime ?? 0) > watchdogAnchor + 0.5;
      if (videoElement?.paused) {
        isBuffering = false;          // paused is NOT an error (e.g. user pause at the start / group pause)
      } else if (progressed) {
        isBuffering = false;          // it's playing after all → no error
      } else if (isBuffering) {
        playbackError = true; isBuffering = false;
      }
      bufferWatchdog = null;
    }, 30000);
  }
  function clearBufferWatchdog() { clearTimeout(bufferWatchdog); bufferWatchdog = null; }

  // Micro-dropouts (< ~300 ms) shouldn't flash the spinner → show it delayed.
  let spinnerTimer = null;
  function clearSpinner() { if (spinnerTimer) { clearTimeout(spinnerTimer); spinnerTimer = null; } }

  function onPlayable() {            // canplay / playing
    clearSpinner();
    isBuffering = false;
    playbackError = false;
    clearBufferWatchdog();
  }
  function onWaiting() {             // waiting / stalled
    if (videoElement?.paused) return;   // paused is NOT buffering → no spinner
    armBufferWatchdog();
    if (isBuffering || spinnerTimer) return;
    spinnerTimer = setTimeout(() => {
      spinnerTimer = null;
      if (!videoElement?.paused) isBuffering = true;
    }, 300);
  }
  // Diagnostic logger for <video> lifecycle events
  function vlog(ev, extra) {
    dlog(`[OcenFin] video:${ev}`, { method: playMethod, t: Math.round(videoElement?.currentTime || 0), ...(extra || {}) });
  }
  // If the time is running, playback is running → clear the buffering state reliably.
  function onProgressTick() {
    clearSpinner();
    if (isBuffering) { isBuffering = false; clearBufferWatchdog(); }
  }
  function onVideoError() {
    // The MediaError code helps with diagnosis: 3 = DECODE (codec/decoder),
    // 4 = SRC_NOT_SUPPORTED (format/container), 2 = NETWORK.
    const err = videoElement?.error;
    console.error('[OcenFin] <video> error:', { code: err?.code, message: err?.message, playMethod });
    // Direct Play failed on the device (e.g. MKV demux/audio not playable) →
    // fall back to transcode ONCE instead of showing the error page immediately.
    // Exactly this "try Direct Play first, then transcode" is what LiteFin/Breezefin do.
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
    flushProgress();          // also save the position on a playback error
  }
  function retryPlayback() {
    playbackError = false;
    isBuffering = true;
    resumeApplied = false;          // on retry, jump back to the position if needed
    if (videoElement) { videoElement.load(); videoElement.play(); }
    armBufferWatchdog();
  }

  // UI
  let showControls  = $state(true);
  let showSettings  = $state(false);
  let controlOpener = null;        // button that opened the panel/picker → focus returns there
  let pickerMode    = $state(null);        // null | 'collection' | 'playlist' – controls <AddToPicker>
  let wasPlayingBeforePicker = false;
  // Pause when opening the "add" dialog (otherwise it keeps playing in the background).
  function openPicker(mode) {
    const el = document.activeElement;
    if (el instanceof HTMLElement) controlOpener = el;   // focus back there later
    wasPlayingBeforePicker = isPlaying;
    videoElement?.pause();
    pickerMode = mode;
  }
  // SyncPlay modal open → pause like with the picker — but NOT during an active group sync
  // (there a local pause would disturb the synchronization). Resume on close.
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
      // Focus back into the Player + show the HUD. Without this the focus stays stuck on the
      // closed SyncPlay dialog and the Player no longer accepts inputs.
      resetControlsTimeout();
      tick().then(() => playerContainer?.focus());
    }
  }

  // ── SyncPlay engine (phase 2a): send local actions + apply received commands ──
  let syncReady        = false;   // send only after a real playback start (prevents sending on the resume seek/autostart)
  let syncQueueSet     = false;   // SetNewQueue for this item already sent/confirmed?
  let syncSuppressUntil = 0;      // briefly suppress outgoing sends while a received command takes effect
  let _appliedSyncSeq  = 0;       // last applied command (dedupe)
  let _expectSeekEcho  = false;   // the next 'seeked' comes from a received command → don't send it back (robust even on a slow seek)
  let _groupWantsPaused = false;  // the group last commanded pause → undo unwanted auto-play (transcode restart)
  let _userPlayIntent  = 0;       // timestamp of a real user play action (backstop)
  function posTicks() { return Math.round((videoElement?.currentTime || 0) * 10000000); }

  // Send a local control event to the group (unless it currently originates from a received command).
  function syncEmit(action) {
    if (!inSyncGroup || !syncReady) return;
    if (Date.now() < syncSuppressUntil) return;
    dlog('[SyncPlay] →', action, posTicks());
    sendSyncCommand(session.serverUrl, session.token, action, posTicks());
  }
  // The first start in a group sets the queue (the server plays for everyone); later plays = Unpause.
  async function onLocalPlay() {
    if (!inSyncGroup) return;
    // Transcode streams start automatically (and unwanted) after (re)loading. If the group is paused
    // and there's no real user play → pause again, don't report to the group.
    if (_groupWantsPaused && (Date.now() - _userPlayIntent) > 1500) {
      dlog('[SyncPlay] auto-play suppressed (group paused)');
      syncSuppressUntil = Date.now() + 600;
      videoElement?.pause();
      return;
    }
    _groupWantsPaused = false;
    if (syncQueueSet) { syncEmit('Unpause'); return; }
    syncQueueSet = true;
    if (syncQueue && syncQueue.itemId === item.Id) { syncReady = true; return; }  // the group already plays this item
    dlog('[SyncPlay] → SetNewQueue', item.Id, posTicks());
    await setSyncQueue(session.serverUrl, session.token, item.Id, posTicks());
    syncReady = true;
  }
  function onLocalPause() { syncEmit('Pause'); }
  function onLocalSeeked() {
    if (_expectSeekEcho) { _expectSeekEcho = false; return; }   // echo of a received seek → don't send it back
    syncEmit('Seek');
  }

  // Buffer handshake: tell the server whether we're ready. Buffering → the group waits; Ready → release.
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
    if (!_syncBuffering && _syncReadySent) return;   // nothing new since the last Ready
    _syncBuffering = false; _syncReadySent = true;
    dlog('[SyncPlay] → Ready', posTicks());
    sendSyncReady(session.serverUrl, session.token, posTicks(), true, syncQueue.playlistItemId);
  }

  // Apply a received group command (with a rough time reference via "When"; fine sync = phase 2b).
  function applySyncCommand(cmd) {
    if (!cmd || cmd._seq === _appliedSyncSeq || !videoElement) return;
    _appliedSyncSeq = cmd._seq;
    const command = cmd.Command;
    const pos   = (cmd.PositionTicks || 0) / 10000000;
    const when  = cmd.When ? new Date(cmd.When).getTime() : Date.now();
    const delay = Math.max(0, when - Date.now());
    syncSuppressUntil = Date.now() + delay + 600;   // backstop for play/pause follow-up events
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

  // ---- Admin remote control (Jellyfin dashboard) ------------------------------------------
  // Initialize to the current state → don't retroactively apply commands sent before opening.
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
    // Volume/mute (GeneralCommand)
    else if (cmd === 'setvolume' && videoElement) { const v = parseInt(c.args?.Volume, 10); if (!isNaN(v)) videoElement.volume = Math.max(0, Math.min(1, v / 100)); }
    else if (cmd === 'volumeup'   && videoElement) videoElement.volume = Math.min(1, videoElement.volume + 0.1);
    else if (cmd === 'volumedown' && videoElement) videoElement.volume = Math.max(0, videoElement.volume - 0.1);
    else if ((cmd === 'mute' || cmd === 'unmute' || cmd === 'togglemute') && videoElement)
      videoElement.muted = cmd === 'mute' ? true : cmd === 'unmute' ? false : !videoElement.muted;
  }
  let settingsTab   = $state('audio');     // 'audio' | 'subtitle' — which section is shown in the panel
  let controlsTimeout;
  let isFavorite = $state(item.UserData?.IsFavorite || false);

  // Playback
  let progressTimer;
  let startTicks    = item.UserData?.PlaybackPositionTicks || 0;
  let resumeApplied = false;   // execute the resume jump only once
  let playSessionId = crypto.randomUUID();  // replaced by PlaybackInfo
  let playMethod    = $state('DirectPlay');         // DirectPlay | DirectStream | Transcode
  let triedTranscodeFallback = false;       // one-time auto fallback when Direct Play fails on the device
  let hls           = null;                 // hls.js instance (only for transcode/HLS)
  let maxBitrate    = 120000000;            // 120 Mbit/s (local network) — limit for Direct Play
  // When transcoding (e.g. burning forced ASS subtitles into the picture) the source bitrate
  // is often too high (HEVC remuxes ~100+ Mbit/s) → real-time transcode stutters (fragLoadTimeOut/bufferStalled).
  // So cap the transcode target; Direct Play stays unlimited (the B4 decodes natively).
  const TRANSCODE_MAX_BITRATE = 20000000;   // 20 Mbit/s — high 1080p quality, transcodes well

  // After 'loadedmetadata', jump to the resume position (the file is seekable then).
  function seekToResume() {
    duration = videoElement?.duration ?? 0;
    if (!resumeApplied && startTicks > 0 && videoElement) {
      resumeApplied = true;
      videoElement.currentTime = startTicks / 10000000;
    }
  }

  // Streams
  let mediaStreams   = $state([]);
  let currentMediaSource = null;   // currently running source – for the instant switch of text subtitles
  let audioStreams = $derived(mediaStreams.filter(s => s.Type === 'Audio'));
  let subtitleStreams = $derived(mediaStreams.filter(s => s.Type === 'Subtitle'));

  // --- Playback info overlay (opt-in via playbackPrefs.showPlaybackInfo) ----------------------
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

  // --- Trickplay: preview thumbnails while seeking (Jellyfin 10.9+) -------------------------
  // Jellyfin delivers tile sheets (e.g. 10×10 thumbnails/image). Per time we compute the
  // correct sheet + the position within it and crop it via background-position. Sheets
  // stay in the browser cache → smooth scrubbing, only reloaded at sheet boundaries.
  let trickplayInfo = $state(null);   // { width, Width, Height, TileWidth, TileHeight, ThumbnailCount, Interval }
  let trickplayMsId = null;
  function parseTrickplay(data) {
    trickplayInfo = null; trickplayMsId = null;
    const tp = data?.Trickplay;
    if (!tp) return;
    // mediaSourceId key: prefers the running source, otherwise the first entry.
    const srcId = data.MediaSources?.[0]?.Id;
    const msId  = (srcId && tp[srcId]) ? srcId : Object.keys(tp)[0];
    const byWidth = msId && tp[msId];
    if (!byWidth) return;
    const w = Object.keys(byWidth).map(Number).filter(n => !isNaN(n)).sort((a, b) => b - a)[0]; // largest width
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
  // PLAYBACK SETUP — PlaybackInfo decides Direct Play vs. transcode
  // ============================================================

  // Fetches the server's decision and attaches the matching source to the <video>.
  // On errors: fall back to the old Direct Play logic (behavior as before).
  async function setupPlayback(audioIndex, subtitleIndex, forceTranscode = false) {
    if (hls) { try { hls.destroy(); } catch {} hls = null; }
    if (!forceTranscode) triedTranscodeFallback = false;   // fresh attempt → allow the fallback again
    try {
      // For the Direct Play decision we need the title's audio tracks. When jumping via
      // "next episode" the episode object (from the lightweight episode list) carries NO MediaStreams →
      // load them once, otherwise the default-audio detection fails and it falsely
      // transcodes (while a direct start from the details plays fine).
      let titleStreams = (item?.MediaStreams?.length ? item.MediaStreams : mediaStreams) || [];
      if (!titleStreams.length && item?.Id) {
        try {
          const r = await fetch(`${session.serverUrl}/Users/${selectedUser.Id}/Items/${item.Id}?Fields=MediaStreams`, { headers: getAuthHeaders() });
          if (r.ok) { const full = await r.json(); if (full?.MediaStreams?.length) titleStreams = full.MediaStreams; }
        } catch {}
      }
      // Audio counts as "explicit" (→ transcode, so the server outputs the CHOSEN track) only
      // when the default track is KNOWN AND the chosen one differs from it. If the default track
      // is unknown (no streams), it does NOT transcode — Direct Play takes precedence.
      const allStreams = titleStreams;
      const audioTracks = allStreams.filter(s => s.Type === 'Audio');
      const defaultAudioIndex = (audioTracks.find(s => s.IsDefault) || audioTracks[0])?.Index ?? -1;
      const explicitAudio = audioIndex !== -1 && defaultAudioIndex !== -1 && audioIndex !== defaultAudioIndex;
      // A subtitle forces a transcode only when it is BURNED IN:
      // text subtitles only with burn-in enabled, graphic subtitles (PGS/VobSub) always.
      // External text subtitles (VTT overlay) need NO transcode → Direct Play stays possible,
      // and the subtitle switch can happen softly (without reloading).
      const subStreams = allStreams;
      const subStream  = subtitleIndex !== -1 ? subStreams.find(s => s.Index === subtitleIndex && s.Type === 'Subtitle') : null;
      const subCodec    = (subStream?.Codec || '').toLowerCase();
      const isPgsSub    = ['pgssub', 'pgs'].includes(subCodec);
      const isVobSub    = ['dvdsub', 'vobsub', 'sub'].includes(subCodec);          // DVD/VobSub → .mks from 12.0
      const isGraphicSub = isPgsSub || isVobSub || ['dvbsub'].includes(subCodec);
      // libbitsub renders client-side (when enabled): PGS always, VobSub only once the server
      // delivers .mks (Jellyfin 12.0+). Otherwise the graphic subtitle has to be burned in.
      const graphicClientRender = clientGraphicRender && (isPgsSub || (isVobSub && serverVobSub));
      const subWillBurn = subtitleIndex !== -1 && (playbackPrefs.burnSubtitles || (isGraphicSub && !graphicClientRender));

      const enableDirectPlay = !explicitAudio && !subWillBurn && !forceTranscode;
      // On an explicit audio switch/burned-in subtitle: DirectStream OFF + re-encode audio → the
      // server is guaranteed to output the CHOSEN track instead of copying the default (German) track.
      const enableDirectStream = !explicitAudio && !subWillBurn && !forceTranscode;
      const allowAudioStreamCopy = !explicitAudio;
      dlog('[OcenFin] setupPlayback →', { item: item?.Name, audioIndex, subtitleIndex, enableDirectPlay, enableDirectStream, allowAudioStreamCopy, forceTranscode });
      // Direct Play: full bitrate; transcode: cap it so the server keeps up in real time.
      const requestBitrate = enableDirectPlay ? maxBitrate : Math.min(maxBitrate, TRANSCODE_MAX_BITRATE);
      const info = await getPlaybackInfoFast({
        serverUrl: session.serverUrl, userId: selectedUser.Id, token: session.token, itemId: item.Id,
        audioStreamIndex: audioIndex, subtitleStreamIndex: subtitleIndex,
        maxBitrate: requestBitrate, startTicks: 0,   // resume happens client-side (seekToResume)
        enableDirectPlay, enableDirectStream, allowAudioStreamCopy,
        burnSubtitles: playbackPrefs.burnSubtitles,
        clientGraphicSubs: clientGraphicRender, serverVobSub,
        mediaSourceId,
      });
      if (info.playSessionId) playSessionId = info.playSessionId;
      const ms = info.mediaSource;
      currentMediaSource = ms;   // remember for the on-the-fly subtitle switch
      const resolved = resolveStream({ serverUrl: session.serverUrl, token: session.token, itemId: item.Id, mediaSource: ms, audioStreamIndex: audioIndex, subtitleStreamIndex: subtitleIndex });
      playMethod = resolved.method;
      dlog('[OcenFin] resolveStream →', { method: resolved.method, isHls: resolved.isHls, url: resolved.url });
      // Why does the server transcode? TranscodeReasons names it directly (VideoCodecNotSupported,
      // AudioCodecNotSupported, ContainerBitrateExceedsLimit, SubtitleCodecNotSupported …).
      // As warn → always lands in the log buffer, even without debug mode.
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

  // Attaches a source to the video. HLS via hls.js, if the browser can't do HLS natively.
  async function attachSource(url, isHls) {
    if (!videoElement) return;
    isBuffering = true;
    playbackError = false;

    const nativeHls = videoElement.canPlayType('application/vnd.apple.mpegurl');
    if (isHls && !nativeHls) {
      try {
        const Hls = (await import('hls.js')).default;
        if (Hls.isSupported()) {
          // More look-ahead buffer (60 s, up to 120 s on a free network) → more robust against dropouts on
          // a slow network/server. Keep backBufferLength small (save memory on the TV).
          hls = new Hls({ maxBufferLength: 60, maxMaxBufferLength: 120, enableWorker: true, backBufferLength: 30 });
          hls.loadSource(url);
          hls.attachMedia(videoElement);
          hls.on(Hls.Events.ERROR, (_e, data) => {
            // Detailed diagnostics: type, detail, codec hint, HTTP status
            console.error('[OcenFin] hls.js error:', {
              type: data?.type, details: data?.details, fatal: data?.fatal,
              reason: data?.reason || data?.err?.message,
              httpStatus: data?.response?.code, url: data?.url,
            });
            if (data?.fatal) onVideoError();
          });
        } else {
          videoElement.src = url;   // last attempt native
        }
      } catch (err) {
        console.error('hls.js could not be loaded:', err);
        videoElement.src = url;
      }
    } else {
      videoElement.removeAttribute('src');
      videoElement.src = url;       // Direct Play or native HLS player
      videoElement.load();
    }
    armBufferWatchdog();
    videoElement.play().catch(() => {});
  }

  // Render external text subtitles ourselves: fetch the VTT (Jellyfin allows CORS) and
  // parse it instead of setting a <track>. A cross-origin <track> is blocked by the browser,
  // and webOS renders native cues unreliably anyway. This way we have full control.
  let subtitleCues = $state([]);           // [{ start, end, text }] in seconds
  // Subtitle offset (text overlay only = VTT/SRT/ASS-to-VTT). + = subtitles later (delayed),
  // − = earlier. Reset per track/title; deliberately NOT saved (it's content-specific).
  let subtitleOffset = $state(0);
  function adjustSubtitleOffset(delta) {
    subtitleOffset = Math.round(Math.max(-10, Math.min(10, subtitleOffset + delta)) * 10) / 10;
  }
  function formatOffset(s) {
    return (s > 0 ? '+' : '') + s.toFixed(1).replace('.', ',') + ' s';
  }
  let subtitleFetchToken = 0;      // ignores responses from a superseded switch
  let graphicRenderer = $state(null);      // libbitsub instance for the currently visible graphic-subtitle overlay
  // Render graphic subtitles client-side? Only if enabled AND not everything is burned in anyway.
  let clientGraphicRender = $derived(playbackPrefs.pgsRendering && !playbackPrefs.burnSubtitles);
  // Render ASS/SSA with original layout (assjs)? Off → plain text overlay, both Direct Play.
  let assRenderer = null;
  let assContainer = $state(null);  // host <div>; assjs injects its DOM overlay here (over the video)
  let clientAssRender = $derived(playbackPrefs.assRendering && !playbackPrefs.burnSubtitles);

  // Text subtitle styling (ONLY for the .subtitle-box overlay = WebVTT/SRT). PGS/VobSub are bitmaps
  // (only scalable), ASS brings its own styling. Defaults = previous behavior.
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
  // VTT font — deliberately ALWAYS set explicitly (even for 'system' → browser default stack),
  // so the UI font choice (html level) doesn't inherit through into the subtitles. ASS is untouched.
  let subFontCss = $derived(({ arimo: "font-family:'Arimo',sans-serif;",
                               noto:  "font-family:'Noto Sans',sans-serif;",
                               tinos: "font-family:'Tinos',serif;" })[playbackPrefs.subtitleFont]
        ?? 'font-family:ui-sans-serif,system-ui,sans-serif;');
  // -webkit-text-fill-color in addition to color: with -webkit-text-stroke set, on webOS the
  // FILL color determines the rendering and falsely falls back to black there instead of inheriting color → subtitles
  // otherwise black despite the color choice. Setting it explicitly forces the chosen color (a no-op on desktop anyway).
  let subStyle = $derived(`color:${subColor};-webkit-text-fill-color:${subColor};${subFontCss}${subEdgeCss}${subBgCss}`);

  // Subtitle size → libbitsub scaling (variant B: applies to PGS AND VobSub, not just VTT).
  function graphicSubScale() {
    const s = playbackPrefs.subtitleSize || 'normal';
    return s === 'small' ? 0.85 : s === 'large' ? 1.25 : 1.0;
  }
  // Filename hint so libbitsub recognizes the format (PGS=.sup, VobSub=.mks via DeliveryUrl).
  function graphicSubFileName(url, stream) {
    const m = (url.split('?')[0] || '').match(/\.(\w+)$/);
    if (m) return `track.${m[1].toLowerCase()}`;
    const codec = (stream?.Codec || '').toLowerCase();
    return ['dvdsub', 'vobsub', 'sub'].includes(codec) ? 'track.mks' : 'track.sup';
  }

  // Apply subtitle – routes by codec: PGS/VobSub → libbitsub overlay, text → VTT overlay.
  function applySubtitleOverlay(index, ms) {
    subtitleFetchToken++;   // invalidate in-flight VTT fetches (otherwise a text overlay next to graphic/ASS)
    subtitleOffset = 0;     // new track switch → reset the offset (content-specific)
    if (index === -1 || !ms) { disposeGraphic(); clearAss(); subtitleCues = []; return; }
    const stream = (ms.MediaStreams || []).find(s => s.Index === index && s.Type === 'Subtitle');
    const codec  = (stream?.Codec || '').toLowerCase();
    const isPgs = ['pgssub', 'pgs'].includes(codec);
    const isVob = ['dvdsub', 'vobsub', 'sub'].includes(codec);
    const isAss = ['ass', 'ssa'].includes(codec);
    if (stream && clientGraphicRender && (isPgs || (isVob && serverVobSub))) {
      clearAss();
      subtitleCues = [];                    // no VTT overlay alongside
      applyGraphicSubtitle(stream, ms);     // soft switch without a gap (see below)
    } else if (stream && isAss && clientAssRender && (stream.DeliveryMethod || '').toLowerCase() !== 'encode') {
      disposeGraphic();
      subtitleCues = [];                    // assjs renders itself → no VTT overlay alongside
      applyAssSubtitle(stream, ms);         // original layout (positions, fonts, typesetting)
    } else {
      disposeGraphic();                     // leaving graphic/ASS → remove the overlay immediately
      clearAss();
      applyExternalSubtitleIfNeeded(index, ms);   // text → VTT (burned-in graphic → nothing to do)
    }
  }
  // Render ASS/SSA client-side with full styling via assjs (DOM/CSS, no WASM/worker). assjs mounts its
  // overlay into assContainer and syncs time + size to the <video> itself (reads NO pixels → no
  // cross-origin taint, no crossorigin on the <video>). The browser handles the font fallback. resampling controls the
  // behavior when the script resolution (PlayResX/Y) ≠ video resolution (letterbox); the default 'video_height' usually fits.
  // assjs has no setTrack → track switch/re-apply via rebuild (the DOM overlay is detached/re-attached).
  async function applyAssSubtitle(stream, ms) {
    if (!videoElement || !assContainer) return;
    const url = assSubtitleUrl({ serverUrl: session.serverUrl, itemId: item.Id, mediaSourceId: ms.Id, stream, token: session.token });
    try {
      const res = await fetch(url);            // the ApiKey is in the URL → a simple GET, no preflight
      if (!res.ok) { console.warn('[OcenFin] ASS fetch failed:', res.status); return; }
      const content = await res.text();
      ensureVideoFrameCallback();               // webOS: rVFC polyfill active BEFORE assjs reads it
      disposeAss();                            // no setTrack → remove the old overlay, rebuild fresh
      assRenderer = new ASS(content, videoElement, { container: assContainer });
      // assjs drives its render loop via requestAnimationFrame, started by the video's 'play'/'playing'
      // event. On a track switch in the MIDDLE of playback the video is already running → it fires
      // no new event → the loop would never start and the subtitle would stay frozen at the state from
      // the switch. So kick it once if playback is already running. ('playing' instead of 'play': onplaying is
      // side-effect-free, onplay would report to SyncPlay.)
      if (!videoElement.paused) videoElement.dispatchEvent(new Event('playing'));
      // The overlay is built ASYNCHRONOUSLY — i.e. AFTER changeTrack, which had already set the focus.
      // Mounting the assjs DOM can lose the focus; so secure it again here. Onto the same
      // trigger button as changeTrack (visible + consistent), not onto the invisible container.
      if (!showSettings) restoreControlFocus();
      dlog('[OcenFin] ASS subtitle via assjs:', stream.Index, stream.Codec);
    } catch (e) { console.warn('[OcenFin] assjs error:', e?.message); }
  }
  // Hide ASS (switch to PGS/text/off): remove the overlay.
  function clearAss() { disposeAss(); }
  function disposeAss() {
    if (assRenderer) {
      try { assRenderer.destroy(); } catch {}
      assRenderer = null;
    }
  }
  // webOS reports requestVideoFrameCallback as present (feature detection true) but NEVER calls the
  // callback. The bug is in LG's media integration, not in Chromium → version-independent (on desktop it
  // doesn't occur). assjs drives its render loop with it → ASS subtitles run on desktop but freeze on
  // the TV on the picture at setup time. So on webOS replace rVFC on the <video> with a rAF polyfill
  // that really calls back (60 fps is plenty for subtitle timing). webOS only — desktop
  // keeps its native, frame-accurate rVFC. Idempotent.
  let rvfcPatched = false;
  function ensureVideoFrameCallback() {
    if (rvfcPatched || !videoElement) return;
    if (!window.webOSSystem && !window.webOS) { rvfcPatched = true; return; }  // no webOS → keep native rVFC
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
    // TV-friendly: STRICTLY SEQUENTIAL. First fully destroy the old renderer (free worker/WASM),
    // then create the new one. On webOS two concurrent WASM workers are risky (limit → libbitsub
    // falls back to the main thread → 2–3 s freeze). A short gap on a manual switch is acceptable.
    disposeGraphic();
    const codec = (stream?.Codec || '').toLowerCase();
    const opts = {
      video: videoElement, subUrl: url,
      displaySettings: { scale: graphicSubScale(), aspectMode: 'contain' },
      onWarning: (w) => dlog('[OcenFin] libbitsub notice:', w?.code || w?.message || w),
      onError: (e) => { dlog('[OcenFin] libbitsub error:', e?.code || '', e?.message || e); disposeGraphic(); },
      onEvent: (ev) => {
        // backend 'worker' = off-main-thread (good); anything else = main-thread fallback (freeze cause on TV).
        // Always log both (console.warn) so the B4 backend state is visible even without debug.
        if (ev?.type === 'renderer-change') console.warn('[OcenFin] libbitsub backend:', ev.renderer);
        else if (ev?.type === 'worker-state') console.warn('[OcenFin] libbitsub worker-state:', ev.state ?? ev);
        else if (ev?.type === 'loaded') dlog('[OcenFin] libbitsub loaded:', ev.format, 'cues=' + (ev.metadata?.cueCount ?? '?'));
      },
    };
    try {
      // The codec is known → pick the explicit renderer (no format auto-detection needed).
      graphicRenderer = ['pgssub', 'pgs'].includes(codec)
        ? new PgsRenderer(opts)
        : new VobSubRenderer({ ...opts, fileName: graphicSubFileName(url, stream) });   // VobSub/DVD: .mks container
      dlog('[OcenFin] image subtitle via libbitsub:', stream.Index, stream.Codec);
    } catch (e) { dlog('[OcenFin] libbitsub renderer error:', e?.message); disposeGraphic(); }
  }
  function disposeGraphic() {
    if (graphicRenderer) { try { graphicRenderer.dispose(); } catch {} graphicRenderer = null; }
  }
  // Apply a size change at runtime live to the running renderer.
  $effect(() => { if (graphicRenderer && (playbackPrefs.subtitleSize || 'normal')) {
    const sc = graphicSubScale();
    try { graphicRenderer.setDisplaySettings({ scale: sc }); } catch {}
  } });

  // VTT timestamp "HH:MM:SS.mmm" or "MM:SS.mmm" → seconds
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

  // Derive the active cue from the current time (reactive, follows currentTime)
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
    if (method === 'encode' || graphic) return;   // burned in or graphic subtitle → no VTT overlay

    const url = externalSubtitleUrl({ serverUrl: session.serverUrl, itemId: item.Id, mediaSourceId: ms.Id, stream, token: session.token });
    try {
      const res = await fetch(url);
      if (!res.ok || myToken !== subtitleFetchToken) return;   // superseded or error
      const text = await res.text();
      if (myToken !== subtitleFetchToken) return;
      subtitleCues = parseVtt(text);
      dlog('[OcenFin] subtitles loaded:', subtitleCues.length, 'cues');
    } catch (e) { dlog('[OcenFin] subtitle fetch error:', e?.message); }
  }

  // Intro Skipper / Media Segments
  let introData = $state(null);
  let segmentsChecked = $state(false);     // plugin APIs queried → chapter fallback may kick in
  let chapterFallbackDone = false;
  let showSkipIntro = $derived(introData?.Introduction?.Valid
    && currentTime >= (introData.Introduction.ShowSkipPromptAt ?? 0)
    && currentTime <= (introData.Introduction.HideSkipPromptAt ?? 0));

  // Outro/credits (media-segments/plugin data) — trigger for auto-skip & auto-play countdown
  let showSkipCredits = $derived(introData?.Credits?.Valid
    && currentTime >= (introData.Credits.ShowSkipPromptAt ?? Infinity));

  // Auto-play the next episode with a countdown overlay (Netflix principle).
  // Starts near the end; "auto-skip credits" takes precedence (immediate jump).
  let chapters          = $state([]);
  let nextCountdown     = $state(null);   // remaining seconds (integer, for the text), null = inactive
  let countdownProgress = $state(0);      // 1 → 0, drives the bar
  let countdownTimer    = null;
  let countdownEnd      = 0;
  let countdownDismissed = false; // per episode: don't restart after a cancel
  let outroDismissed = $state(false); // manual outro prompt for THIS episode dismissed → stay put
  const COUNTDOWN_FROM  = 20;
  const OUTRO_FALLBACK  = 45;     // without chapter/segment data: show the "next episode" card in the last X s
  const STILL_WATCHING_TIMEOUT = 120;  // "still watching?": closes the Player after X s without a reaction (relieve the NAS)

  // Chapter fallback for intro/credits: kicks in reactively once the plugin APIs returned nothing
  // AND the chapters are loaded (only clearly named chapters, otherwise no prompt).
  $effect(() => { if (segmentsChecked && !chapterFallbackDone && introData === null && chapters.length) {
    chapterFallbackDone = true;
    introData = chaptersToIntroData(chapters);
  } });

  let nearEnd = $derived(duration > 0 && currentTime > 0 && (
    showSkipCredits || (duration - currentTime) <= COUNTDOWN_FROM
  ));
  // Show the "next episode" card (manual): with real credits data from credits start, otherwise
  // as a reliable fallback in the last OUTRO_FALLBACK seconds (even without chapters/segments).
  // The auto-play countdown (nearEnd, 20 s) stays unaffected so content is never cut off.
  let outroPromptActive = $derived(duration > 0 && currentTime > 0 && (
    showSkipCredits || (duration - currentTime) <= OUTRO_FALLBACK
  ));
  // An interactive overlay is open → OK should trigger its focused button, not pause.
  let overlayActive = $derived(showSkipIntro || showStillWatching || (outroPromptActive && !!nextEpisode));
  // Exactly then ONE outro decision prompt is visible (timer OR manual) → trap focus there.
  let outroPromptShowing = $derived(!!nextEpisode && (nextCountdown !== null || (outroPromptActive && !outroDismissed)));
  $effect(() => { if (playbackPrefs.autoPlayNext && !stopAfterThis && nextEpisode && !playbackPrefs.autoSkipCredits
         && nearEnd && nextCountdown === null && !countdownDismissed) {
    startCountdown();
  } });

  // Lightly prefetch the next episode (only PlaybackInfo/stream URL, no video pre-buffering)
  // so the switch saves the round-trip. Applies only when the parameters match at switch time.
  // Shared helper for BOTH switch paths: countdown AND auto-skip credits.
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
    nextCountdown = COUNTDOWN_FROM;   // immediately visible → the card appears
    countdownProgress = 1;
    countdownEnd = Date.now() + COUNTDOWN_FROM * 1000;
    // setInterval (reliable in this project) every 100 ms → text per second, bar smooth.
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
    countdownDismissed = true;   // don't show again for this episode
    resetControlsTimeout();
  }
  function onVideoEnded() {
    // "Only this episode": at the end do NOT advance, but close the Player
    // (back to the just-watched episode) — the actual sleep behavior.
    if (stopAfterThis) { onExit?.(); return; }
    // Otherwise advance automatically at the end, if enabled and not cancelled
    if (playbackPrefs.autoPlayNext && nextEpisode && !countdownDismissed) {
      stopCountdown();
      goToNextEpisode();
    }
  }

  // Current chapter name (for display while seeking). Meaningless auto-names (timestamps,
  // "Chapter N", plain numbers) are replaced by a clean "Chapter N".
  let currentChapterName = $derived.by(() => {
    if (!chapters?.length) return null;
    let idx = -1;
    for (let i = 0; i < chapters.length; i++) {
      if ((chapters[i].StartPositionTicks / 10000000) <= displayTime) idx = i; else break;
    }
    if (idx < 0) return null;
    const raw = (chapters[idx].Name || '').trim();
    const junk = !raw
      || /^\(?\d+\)?[\s:.]*\d{1,2}[:.]\d{2}([:.]\d{2})?([:.]\d{1,3})?$/.test(raw)   // (01)00:00:00:000 etc.
      || /^(chapter|kapitel|chapitre|capitolo|cap[ií]tulo)\b/i.test(raw)
      || /^\d{1,3}$/.test(raw);
    return junk ? `${i18n.t.chapter} ${idx + 1}` : raw;
  });

  // Auto-skip (depends on the setting + installed intro-skipper plugin).
  // Flags prevent repeated jumping; reset on episode change via the {#key} remount.
  let introAutoSkipped   = false;
  let creditsAutoSkipped = false;
  $effect(() => { if (playbackPrefs.autoSkipIntro && showSkipIntro && !introAutoSkipped && videoElement) {
    introAutoSkipped = true;
    skipIntro();
  } });
  $effect(() => { if (playbackPrefs.autoSkipCredits && !stopAfterThis && showSkipCredits && !creditsAutoSkipped && nextEpisode) {
    creditsAutoSkipped = true;
    prefetchNextEpisode();   // this path bypasses the countdown → the fetch runs parallel to the Player remount
    goToNextEpisode();
  } });

  // Series episodes (all seasons) for reliable next/prev navigation across season boundaries
  let seriesEpisodes = $state([]);
  let episodeIndex   = $state(-1);
  // "Play all" queue (from App): when active it replaces the series sequence as the source for
  // next/prev. The ENTIRE advancing machinery (outro prompt, countdown, auto-play,
  // onVideoEnded, nexttrack remote, buttons) hangs on these two derivations and
  // thus follows the queue automatically. queueNext === null at the end of the queue → ends normally.
  let prevEpisode = $derived(queueActive ? queuePrev : (episodeIndex > 0 ? seriesEpisodes[episodeIndex - 1] : null));
  let nextByIndex = $derived(queueActive ? queueNext : (episodeIndex >= 0 && episodeIndex < seriesEpisodes.length - 1
                   ? seriesEpisodes[episodeIndex + 1] : null));
  let nextEpisode = $derived(nextByIndex);   // auto-play/outro use the same sequential next episode (also into the next season)

  // "Only this episode" — one-shot sleep switch (opt-in via playbackPrefs.sleepButton).
  // Blocks ONLY the automatic transitions (outro countdown, video end, auto-skip credits);
  // manual advancing (button/remote) stays allowed. The {#key} remount per episode
  // resets the flag by itself → real one-shot behavior without cleanup.
  let stopAfterThis = $state(false);
  // Only show the button if it can do something: there is a next element AND
  // some auto-advance is active (auto-play OR auto-skip credits, which switch independently).
  let autoAdvanceOn = $derived(!!nextEpisode && (playbackPrefs.autoPlayNext || playbackPrefs.autoSkipCredits));
  function toggleStopAfter() {
    stopAfterThis = !stopAfterThis;
    if (stopAfterThis) stopCountdown();   // immediately stop a running auto-play countdown
    resetControlsTimeout();
  }
  // Position in the season for the top-left display: "Episode X of Y"
  let seasonTotal = $derived((item?.Type === 'Episode' && item.ParentIndexNumber != null)
                   ? seriesEpisodes.filter(e => e.ParentIndexNumber === item.ParentIndexNumber).length : 0);
  let episodePosition = $derived((item?.Type === 'Episode' && item.IndexNumber != null && seasonTotal > 0)
                   ? `${i18n.t.episode} ${item.IndexNumber} ${i18n.t.of} ${seasonTotal}` : '');

  // Info line for the next episode: "S2 · E1 · 52 min · ends at 11:59"
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

  // "Still watching?" – best practice (Netflix style): NOT time-based, but after
  // several auto-played episodes in a row without interaction. So it only applies to
  // series auto-play (sleep protection) and never interrupts a movie or an actively watched episode.
  // The counter (autoPlayStreak) lives in App.svelte, because the Player resets per episode.
  let showStillWatching = $state(false);
  let interacted = false;   // did the user do anything in THIS episode? (keypress/remote/click)
  function markInteraction() { interacted = true; }
  function resumeFromStillWatching() {
    showStillWatching = false;
    // The user is awake → advance to the next episode; reset the counter in App.
    if (nextEpisode) onNext?.({ episode: nextEpisode, resetStreak: true });
  }

  // If no one reacts to "still watching?", the user has most likely
  // fallen asleep (the prompt only comes after several episodes without interaction). Then
  // close the Player instead of leaving it open all night — this reports stop and disconnects the
  // session so the NAS doesn't stay active permanently. The effect cleanup clears the timer
  // on "continue" (showStillWatching → false), episode change or unmount automatically.
  $effect(() => {
    if (!showStillWatching) return;
    const t = setTimeout(() => onExit?.(), STILL_WATCHING_TIMEOUT * 1000);
    return () => clearTimeout(t);
  });

  onMount(async () => {
    resetControlsTimeout();
    if (playerContainer) playerContainer.focus();

    // Compile the libbitsub WASM early (deduplicated, non-blocking) → the first PGS/VobSub sub doesn't
    // have to wait for the WASM compile. If it fails, libbitsub falls back cleanly later anyway.
    initWasm().then(() => dlog('[OcenFin] libbitsub WASM ready')).catch((e) => dlog('[OcenFin] libbitsub WASM init failed:', e?.message));

    fetchMediaSources();
    fetchIntroTimestamps();
    fetchSeriesEpisodes();   // next/prev + auto-play + position display (across all seasons)

    // Interaction tracking for "still watching?": every deliberate input marks the user as awake.
    window.addEventListener('keydown', markInteraction);
    window.addEventListener('pointermove', markInteraction);
    window.addEventListener('click', markInteraction);
    // Also save the position on app suspend (webOS Home) / close / reload.
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);

    // PlaybackInfo decides Direct Play vs. transcode; sets the source + HLS if needed.
    // Resume (startTicks) happens client-side after 'loadedmetadata' (seekToResume).
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
        // Track list only for the selection UI (audio/subtitle). The actual
        // delivery (track vs. burned in) is decided by PlaybackInfo in setupPlayback.
        if (data.MediaSources?.[0]?.MediaStreams) mediaStreams = data.MediaSources[0].MediaStreams;
        parseTrickplay(data);
      }
    } catch (e) { console.error('fetchMediaSources:', e); }
  }

  async function fetchIntroTimestamps() {
    if (item.Type !== 'Episode') return;
    // 1) Modern Media Segments API (Intro Skipper from Jellyfin 10.9 delivers via this).
    //    Query without a type filter and filter ourselves — more robust against server/version differences.
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
        dlog('[OcenFin] media segments HTTP', res.status);   // e.g. 404 = endpoint missing, 401 = auth
      }
    } catch (e) { dlog('[OcenFin] media segments error:', e?.message); }
    // 2) Older ConfusedPolarBear plugin API. Some versions deliver the intro flat
    //    ({ Valid, IntroStart, … }), others as { Introduction, Credits } → handle both shapes.
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
    // 3) No plugin hit → chapter fallback (kicks in reactively once chapters are loaded)
    dlog('[OcenFin] no media segments / plugin data → chapter fallback');
    segmentsChecked = true;
  }

  // Converts media segments (ticks) into the introData structure (seconds). Null if neither intro nor outro.
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

  // Fallback from named chapters — only unambiguous hits, otherwise null (no false prompt).
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

  // All episodes of the series (across seasons, in order) – for next/prev, auto-play and position display
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

  // Save the current position immediately (even paused) — `keepalive` lets the request survive the app suspend/
  // teardown and keeps the auth header. For visibilitychange→hidden and playback errors,
  // so the position is never lost (without ending the session — hence Progress, not Stopped).
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

  // The app is backgrounded/suspended (webOS Home, tab switch): flush the position.
  // pagehide = final close/reload → clean Stopped (keepalive survives the teardown).
  function onVisibilityChange() { if (document.hidden) flushProgress(); }
  function onPageHide() { reportPlaybackStopped(true); }

  // ============================================================
  // TRACK SWITCHING
  // ============================================================

  async function changeTrack(type, index) {
    // Release the panel trap IMMEDIATELY, before state mutates and focus returns. Otherwise the spatial
    // nav's onFocusIn pulls focus back into the still-fading panel (transition:uiFade → gone only after the
    // outro), which unmounts right after → focus lands nowhere. On close this doesn't happen, because
    // there no panel-internal state mutates anymore and dropTrapOnOutro removes the trap in time.
    settingsPanel?.removeAttribute('data-focus-trap');
    showSettings = false;
    resetControlsTimeout();

    if (type === 'subtitle') {
      const oldStream = mediaStreams.find(s => s.Index === selectedSubtitleIndex && s.Type === 'Subtitle');
      const newStream = mediaStreams.find(s => s.Index === index && s.Type === 'Subtitle');
      // A soft switch is possible when the subtitle doesn't need to be burned in: "Off", or
      // a text subtitle (whether delivered externally or embedded → we fetch it as VTT).
      const graphicCodecs = ['pgssub', 'dvdsub', 'pgs', 'dvbsub', 'vobsub', 'sub'];
      const isSoftSub = (s, idx) => {
        if (idx === -1) return true;
        if (!s) return false;
        if ((s.DeliveryMethod || '').toLowerCase() === 'encode') return false;      // burned in → reload
        const codec = (s.Codec || '').toLowerCase();
        if (['pgssub', 'pgs'].includes(codec)) return clientGraphicRender;          // PGS: client-side → soft, otherwise burned in
        if (['dvdsub', 'vobsub', 'sub'].includes(codec)) return clientGraphicRender && serverVobSub;  // VobSub: soft from Jellyfin 12.0
        if (graphicCodecs.includes(codec)) return false;                            // other graphic → not as VTT
        return true;
      };
      const oldIsExternal = isSoftSub(oldStream, selectedSubtitleIndex);
      const newIsExternal = isSoftSub(newStream, index);

      selectedSubtitleIndex = index;

      // Instant switch: if neither the old nor the new subtitle needs burning into the picture
      // (text, PGS client-side or "Off"), we just swap the overlay – without reloading.
      if (oldIsExternal && newIsExternal && currentMediaSource) {
        applySubtitleOverlay(index, currentMediaSource);
        // Return focus ONLY AFTER all reactive changes (selectedSubtitleIndex, subtitleCues, panel outro)
        // — otherwise the subsequent re-render throws it away again. Exactly like the close path,
        // which mutates nothing after restoreControlFocus(). (ASS additionally secures the focus again after
        // mounting assjs in applyAssSubtitle.)
        await tick();
        restoreControlFocus();
        return;
      }
    } else {
      selectedAudioIndex = index;
    }

    // Hard reload (fallback): an audio switch or burned-in subtitles require a new
    // server stream. Save the position → seekToResume restores it after the rebuild.
    const savedPosition = videoElement?.currentTime ?? 0;
    startTicks    = Math.round(savedPosition * 10000000);
    resumeApplied = false;
    await setupPlayback(selectedAudioIndex, selectedSubtitleIndex);
    await tick();
    restoreControlFocus();   // also after a hard reload (audio switch / burned-in subtitle) onto the trigger
  }

  // ============================================================
  // ACTIONS
  // ============================================================

  function skipIntro() {
    if (!videoElement || !introData?.Introduction?.IntroEnd) return;
    videoElement.currentTime = introData.Introduction.IntroEnd;
    // On skip do NOT show the controls — you want to keep watching directly. Put focus on the
    // Player, since the skip button vanishes shortly → keypresses keep working.
    playerContainer?.focus();
  }

  // manual=true → triggered by the user (button/prompt); manual=false → auto-play (countdown/end/credits).
  function goToNextEpisode(manual = false) {
    stopCountdown();
    if (!nextEpisode) return;
    const awake = manual || interacted;
    // Sleep protection: only for series auto-play, when the user hasn't done anything for a while.
    if (!awake && playbackPrefs.stillWatching && item.Type === 'Episode'
        && autoPlayStreak >= (playbackPrefs.stillWatchingEpisodes || 3)) {
      videoElement?.pause();
      showStillWatching = true;
      return;
    }
    // resetStreak: awake → counter in App to 0; otherwise increment.
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
    if (controlsTimeout) clearTimeout(controlsTimeout); // controls stay visible
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

  // Seeking like Netflix/Jellyfin: several fast presses only move the PREVIEW
  // and jump to the spot ONCE only after a short pause — no reload on every press.
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
    currentTime = seekTime;   // apply immediately, no brief jump-back until the timeupdate
    isSeeking = false;
  }

  // Chapter jumps — only useful/visible when the video has real chapter markers
  let hasChapterNav = $derived(showChapters && chapters.length > 1);
  function chapterStartsSorted() {
    return chapters.map(c => c.StartPositionTicks / 10000000).sort((a, b) => a - b);
  }
  function chapterPrev() {
    if (!videoElement) return;
    const t = videoElement.currentTime;
    // 3 s tolerance: shortly after a chapter start you jump to the previous chapter
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

  // Focus after closing the panel/switching tracks back onto the triggering button (subtitle/audio/gear),
  // so a VISIBLE control is focused — not the invisible container. Falls back to the
  // Player container if the button doesn't (any longer) exist (first start, hard reload).
  function restoreControlFocus() {
    if (controlOpener && document.contains(controlOpener)) controlOpener.focus();
    else playerContainer?.focus();
  }

  // FIX: auto-focus the settings panel for the webOS D-pad
  async function toggleSettings() {
    if (!showSettings) {
      // Remember the opening button (if it's outside the panel)
      const el = document.activeElement;
      if (el instanceof HTMLElement && !settingsPanel?.contains(el)) controlOpener = el;
    }
    showSettings = !showSettings;
    if (showSettings) {
      if (controlsTimeout) clearTimeout(controlsTimeout);
      await tick();
      // Focus the first button in the settings panel
      const firstBtn = settingsPanel?.querySelector('button');
      if (firstBtn) firstBtn.focus();
    } else {
      resetControlsTimeout();
      await tick();
      // Focus back onto the triggering button (audio/subtitle/gear), otherwise onto the Player
      restoreControlFocus();
      controlOpener = null;
    }
  }

  // Opens the panel directly on the audio or subtitle section (dedicated buttons instead of the gear).
  // Same key with the same tab open → close.
  async function openSettings(tab) {
    if (showSettings && settingsTab === tab) { toggleSettings(); return; }
    // Remember the active button on a tab switch too (e.g. from audio to subtitle)
    const el = document.activeElement;
    if (el instanceof HTMLElement && !settingsPanel?.contains(el)) controlOpener = el;
    settingsTab = tab;
    if (!showSettings) { await toggleSettings(); }
    else { await tick(); settingsPanel?.querySelector('button')?.focus(); }
  }

  // Slider: Left/Right seek (±10 s), Up/Down leaves the bar
  // (the native value change on Up/Down is suppressed; the group navigation
  // takes over the jump to the control buttons).
  function onSeekKey(e) {
    if (e.key === 'ArrowLeft')      { e.preventDefault(); e.stopPropagation(); skip(-10); resetControlsTimeout(); }
    else if (e.key === 'ArrowRight'){ e.preventDefault(); e.stopPropagation(); skip(10);  resetControlsTimeout(); }
    // OK on the bar: apply the pending jump immediately, then toggle play/pause.
    else if (e.key === 'Enter' || e.keyCode === 13) {
      e.preventDefault(); e.stopPropagation();
      if (isSeeking) commitSeek();
      togglePlay();
    }
    // ▼ jumps directly to play/pause (the most common case) instead of the left rewind button.
    else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); if (isSeeking) commitSeek(); playPauseBtn?.focus(); resetControlsTimeout(); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); /* upward via the FocusManager */ }
  }

  function handleKeyDown(e) {
    // Error overlay open: arrows/OK control only the two buttons (spatial nav + button click), Back exits.
    if (playbackError) {
      if (isBackKey(e)) { e.preventDefault(); e.stopPropagation(); onExit?.(); }
      return;
    }
    if (showSettings) {
      if (isBackKey(e)) { e.preventDefault(); e.stopPropagation(); toggleSettings(); }
      return;
    }
    // If the auto-play countdown is running, Back cancels it first (instead of leaving the Player)
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
    // Outro decision prompt open: arrows move ONLY between its buttons (spatial nav in the
    // prompt's data-focus-trap) — not to the playback bar, and without showing the HUD.
    if (outroPromptShowing && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'
                            || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      return;
    }
    // HUD hidden (you're watching) → OK pauses/plays directly and focuses play/pause,
    // so another OK resumes immediately. With an overlay open do NOT intervene — there
    // OK should trigger the focused button (skip intro/outro, keep watching).
    if ((e.key === 'Enter' || e.keyCode === 13) && !showControls && !overlayActive) {
      e.preventDefault();
      togglePlay();
      resetControlsTimeout();
      playPauseBtn?.focus();
      return;
    }
    // HUD hidden + Left/Right → focus the playback bar and seek (like Jellyfin).
    if (!showControls && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault(); e.stopPropagation();
      resetControlsTimeout();
      seekBarEl?.focus();
      skip(e.key === 'ArrowLeft' ? -10 : 10);
      return;
    }
    // Arrow keys/Enter are otherwise handled by the group navigation or the focused
    // buttons — here just show the controls again.
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

  <!-- ASS/SSA subtitles: assjs injects its DOM overlay here, synced to the <video> (reads NO pixels
       → no taint). The container overlaps the video (absolute inset-0); z below spinner/controls. -->
  <div bind:this={assContainer} class="absolute inset-0 pointer-events-none z-[20]"></div>

  <!-- LOADING ANIMATION — visible while the video buffers or the NAS wakes up -->
  {#if isBuffering && !playbackError}
    <div class="absolute inset-0 flex items-center justify-center z-[30] pointer-events-none">
      <div class="flex flex-col items-center gap-5">
        <div class="w-20 h-20 border-4 border-white/20 border-t-white rounded-full animate-spin"></div>
        <p class="text-white/50 text-lg font-medium tracking-wider">{i18n.t.loading}</p>
      </div>
    </div>
  {/if}

  <!-- ERROR — instead of an endless spinner: a clear message + actions -->
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

  <!-- PLAYBACK INFO OVERLAY (opt-in, toggled by the info button) -->
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

  <!-- MAIN OVERLAY — clicking the empty picture area (|self, not on buttons) pauses/plays -->
  <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/50 flex flex-col justify-between p-10 transition-opacity duration-500 z-50
              {showControls ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}"
       onclick={(e) => { if (e.target === e.currentTarget) togglePlay(); }}>

    <!-- TOP: title + clock -->
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

    <!-- BOTTOM: progress + buttons -->
    <div class="w-full flex flex-col gap-6">

      <!-- PROGRESS BAR — clean scrubbing, chapter markers only when enabled -->
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
            <!-- Preview follows the scrubber; chapter name (if any) stacked above → no overlap -->
            <div class="absolute bottom-full mb-4 -translate-x-1/2 pointer-events-none whitespace-nowrap flex flex-col items-center gap-0.5"
                 style="left: {Math.min(96, Math.max(4, seekPct))}%;">
              {#if trickplayTile}
                <!-- Trickplay preview image: cropped from the tile sheet -->
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
            {#each chapters as ch (ch.StartPositionTicks)}
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

          <!-- Previous episode: |◄ — transport navigation (sequential) -->
          <button onclick={() => prevEpisode && onPrev?.(prevEpisode)}
            disabled={!prevEpisode}
            class="p-3 text-gray-400 hover:text-white focus:text-white focus:outline-none disabled:opacity-30"
            title={i18n.t.prevEpisode}>
            <!-- |◄ : bar on the left + triangle points LEFT -->
            <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/>
            </svg>
          </button>

          <!-- Chapter back — only when enabled AND chapter markers exist.
               Icon deliberately DIFFERENT from the episode skip: chevron onto a dot (= chapter marker). -->
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

          <!-- Chapter forward — only when enabled AND chapter markers exist.
               Icon deliberately DIFFERENT from the episode skip: chevron onto a dot (= chapter marker). -->
          {#if hasChapterNav}
            <button onclick={chapterNext} class="p-2.5 text-gray-500 hover:text-white focus:text-white focus:outline-none" title={i18n.t.chapterNext}>
              <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M9 7l5 5-5 5"/>
                <circle cx="16" cy="12" r="1.6" fill="currentColor" stroke="none"/>
              </svg>
            </button>
          {/if}

          <!-- Next episode: ►| — transport navigation (sequential), counts as a deliberate action -->
          <button onclick={() => goToNextEpisode(true)}
            disabled={!nextByIndex}
            class="p-3 text-gray-400 hover:text-white focus:text-white focus:outline-none disabled:opacity-30"
            title={i18n.t.nextEpisode}>
            <!-- ►| : triangle points RIGHT + bar on the right -->
            <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
              <path d="M16 6h2v12h-2zm-10 0l9 6-9 6V6z"/>
            </svg>
          </button>
        </div>

        <div class="flex items-center gap-4">

          <!-- ONLY THIS EPISODE — one-shot sleep switch (opt-in), first of the right group.
               Only visible when enabled AND an auto-advance is active (otherwise pointless). -->
          {#if playbackPrefs.sleepButton && autoAdvanceOn}
            <button onclick={(e) => { e.stopPropagation(); toggleStopAfter(); }} title={i18n.t.stopAfterEpisode} aria-label={i18n.t.stopAfterEpisode}
              class="p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-white transition-colors
                     {stopAfterThis ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white focus:text-white'}">
              <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M21 12.79A9 9 0 1111.21 3 7 7 0 0021 12.79z"/>
              </svg>
            </button>
          {/if}
          <!-- Favorite -->
          <button onclick={toggleFavorite}
            class="p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-white transition-colors {isFavorite ? 'text-red-500' : 'text-gray-400 hover:text-white focus:text-white'}">
            <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
            </svg>
          </button>

          <!-- Add to playlist -->
          <button onclick={(e) => { e.stopPropagation(); openPicker('playlist'); }} title={i18n.t.addToPlaylist} aria-label={i18n.t.addToPlaylist}
            class="p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-white transition-colors text-gray-400 hover:text-white focus:text-white">
            <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 6h13M3 12h9m-9 6h9m4-3v6m3-3h-6"/></svg>
          </button>

          {#if canManageCollections}
          <!-- Add to collection -->
          <button onclick={(e) => { e.stopPropagation(); openPicker('collection'); }} title={i18n.t.addToCollection} aria-label={i18n.t.addToCollection}
            class="p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-white transition-colors text-gray-400 hover:text-white focus:text-white">
            <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/></svg>
          </button>
          {/if}

          <!-- AUDIO — icon only (replaces the gear) -->
          <button onclick={(e) => { e.stopPropagation(); openSettings('audio'); }} title={i18n.t.audio} aria-label={i18n.t.audio}
            class="p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-white transition-colors
                   {showSettings && settingsTab === 'audio' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white focus:text-white'}">
            <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"/>
            </svg>
          </button>

          <!-- SUBTITLES — icon only -->
          <button onclick={(e) => { e.stopPropagation(); openSettings('subtitle'); }} title={i18n.t.subtitles} aria-label={i18n.t.subtitles}
            class="p-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-white transition-colors
                   {showSettings && settingsTab === 'subtitle' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white focus:text-white'}">
            <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/>
              <text x="12" y="15.6" text-anchor="middle" font-size="8.5" font-weight="700" fill="currentColor" stroke="none" font-family="ui-sans-serif, system-ui, sans-serif">CC</text>
            </svg>
          </button>

          <!-- PLAYBACK INFO — only when enabled in the settings -->
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

    <!-- SETTINGS PANEL — bind:this for webOS D-pad focus -->
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
            {#each audioStreams as stream (stream.Index)}
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
            {#each subtitleStreams as stream (stream.Index)}
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
  <!-- END MAIN OVERLAY -->


  <!-- SUBTITLE OVERLAY — our own VTT renderer (native track display is unreliable on webOS).
       Moves up when the control bar is visible so nothing is covered. -->
  {#if currentSubtitleText}
    <div class="absolute inset-x-0 z-[65] flex justify-center px-[8%] pointer-events-none transition-all duration-200
                {showControls ? 'bottom-44' : 'bottom-[7%]'}">
      <span class="subtitle-box sub-{playbackPrefs.subtitleSize || 'normal'}" style={subStyle}>{currentSubtitleText}</span>
    </div>
  {/if}


  <!-- SKIP INTRO — bottom left -->
  {#if showSkipIntro}
    <div transition:uiFade class="absolute bottom-36 left-12 z-[70]">
      <button onclick={skipIntro} {@attach focusOnMount()}
        class="bg-white/10 backdrop-blur-md border-2 border-white text-white font-bold text-xl
               px-8 py-4 rounded-xl flex items-center gap-3 shadow-2xl
               hover:bg-white hover:text-black focus:bg-white focus:text-black
               focus:outline-none transition-all duration-200">
        <!-- Double arrow right for "skip" -->
        <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
          <path d="M5.59 7.41L10.18 12l-4.59 4.59L7 18l6-6-6-6zM16 6h2v12h-2z"/>
        </svg>
        {i18n.t.skipIntro}
      </button>
    </div>
  {/if}


  <!-- NEXT EPISODE — bottom right -->
  <!-- AUTO-PLAY COUNTDOWN — Netflix style, with "Play now" / "Cancel" -->
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

  <!-- Manual "next episode" prompt (no countdown): appears with auto-play disabled OR after
       cancelling the timer. The user decides — "Cancel" stays on the current episode (outro). -->
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

  <!-- "Still watching?" – paused after inactivity -->
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
        <p class="text-gray-500 text-sm">{i18n.t.stillWatchingTimeout}</p>
      </div>
    </div>
  {/if}

</div>

<!-- Add to collection / playlist (shared component) -->
<AddToPicker mode={pickerMode} {item} {selectedUser} {getAuthHeaders}
  onCreated={() => onLibChanged?.()}
  onClose={async () => { pickerMode = null; if (wasPlayingBeforePicker) videoElement?.play().catch(() => {}); wasPlayingBeforePicker = false; await tick(); if (controlOpener && document.contains(controlOpener)) controlOpener.focus(); else playerContainer?.focus(); controlOpener = null; }} />

<style>
  /* Seek bar — watched part blue, rest light (consistent across all browsers),
     white handle, subtle focus aura instead of a strong ring (modern player style). */
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

  /* Subtitle size (scales the native VTT cues; vh for TV distance) */
  :global(.subs-small video::cue)  { font-size: 2.6vh; }
  :global(.subs-normal video::cue) { font-size: 3.4vh; }
  :global(.subs-large video::cue)  { font-size: 4.8vh; }

  /* Our own subtitle overlay renderer (external VTT) — no box, just a strong shadow */
  .subtitle-box {
    white-space: pre-line; text-align: center; color: #fff; font-weight: 600; line-height: 1.35;
    text-shadow: 0 1px 2px #000, 0 2px 8px rgba(0,0,0,.95), 0 0 4px rgba(0,0,0,.9);
    max-width: 100%;
  }
  .sub-small  { font-size: 2.6vh; }
  .sub-normal { font-size: 3.4vh; }
  .sub-large  { font-size: 4.8vh; }
</style>
