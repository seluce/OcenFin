<script>
  import { i18n, setLang, LANGUAGES } from '../i18n.svelte.js';
  import { startQuickConnect as startQC } from '../quickconnect.js';
  import QuickConnectPanel from './QuickConnectPanel.svelte';
  import { isBackKey, focusOnMount, tvKeyboard, buildNavEntries, applyNavConfig, NAV_ICON_PALETTE, NAV_ICON_KEYS,
           AVATAR_ICONS, AVATAR_ICON_KEYS, AVATAR_COLORS, renderAvatarPng, renderImageAvatarPng, authHeaders, setDebug, runtimeVersions, getTvDeviceInfo, probeBrowserCodecs, formatLog, clearLogBuffer, makeFocusReturn, uiFade, dropTrapOnOutro } from '../utils.js';
  import { session } from '../session.svelte.js';
  import { APP_VERSION } from '../version.js';
  import { tick, onDestroy, onMount } from 'svelte';

  let {
    selectedUser,
    selectedServer,
    savedTokens         = {},
    screensaverSettings = { enabled: true, timeout: 90 },
    reduceAnimations    = false,
    displaySettings     = { clock: true, hero: true, episodeCount: true },
    playbackPrefs       = { audioLanguage: 'default', subtitleLanguage: 'default', subtitleSize: 'normal' },
    serverVersion       = '',      // Jellyfin server version (status page)
    serverVobSub        = false,   // does the server deliver graphic subtitles client-side?
    libraries           = [],      // real libraries (for the navigation editor)
    publicUsers         = [],      // selectable profiles (public list from the server)
    sharedProfile       = { enabled: false, members: [] },
    sharedTokens        = {},      // own token store for watch together
    clientAuthHeader    = '',      // auth header without a user reference (Quick Connect Initiate)
    onSharedToggle       = () => {},
    onSharedSetMember    = async () => 'error',   // (slot, user, pw, presetToken)
                                                 //   → 'ok'|'needPassword'|'sameUser'|'error'
    onSharedRemoveMember = () => {},
    // Callback props (replace the former events)
    onToggleSave, onSwitchUser, onLogout, onScreensaverChange, onReduceAnimationsChange,
    onDisplayChange, onReorderingChange, onProfileImageChanged, onPlaybackPrefsChange, onClearCache,
  } = $props();


  // Audio/subtitle language options for the modals
  let audioLangOptions = $derived([
    { key: 'default', name: i18n.t.langDefault },
    ...LANGUAGES
  ]);
  let subtitleLangOptions = $derived([
    { key: 'off',     name: i18n.t.langOff },
    { key: 'default', name: i18n.t.langDefault },
    ...LANGUAGES
  ]);
  let audioLangName    = $derived((audioLangOptions.find(o => o.key === playbackPrefs.audioLanguage)    || audioLangOptions[0]).name);
  let subtitleLangName = $derived((subtitleLangOptions.find(o => o.key === playbackPrefs.subtitleLanguage) || subtitleLangOptions[0]).name);

  // Colour-button actions — a deliberately curated, closed list (see the wiring comment in
  // Player.svelte). Labels for chapters/episodes are reused from the player's own strings.
  let remoteActionOptions = $derived([
    { key: 'off',            name: i18n.t.remoteActionOff },
    { key: 'chapterPrev',    name: i18n.t.chapterPrev },
    { key: 'chapterNext',    name: i18n.t.chapterNext },
    { key: 'subtitleToggle', name: i18n.t.remoteActionSubtitleToggle },
    { key: 'subtitleMenu',   name: i18n.t.remoteActionSubtitleMenu },
    { key: 'audioMenu',      name: i18n.t.remoteActionAudioMenu },
    { key: 'episodeNext',    name: i18n.t.nextEpisode },
    { key: 'episodePrev',    name: i18n.t.prevEpisode },
    { key: 'playPause',      name: i18n.t.remoteActionPlayPause },
  ]);
  // The four rows, in the order they sit on the remote. `dot` is a FIXED hex, not a Tailwind
  // class: blue-* utilities are the accent and get rewritten by data-theme (App.svelte), so a
  // bg-blue-500 swatch would render emerald under the emerald theme, right next to the real
  // green dot. These dots depict the remote's literal button colors and must never follow it.
  let remoteColorRows = $derived([
    { pref: 'remoteColorRed',    label: i18n.t.remoteColorRed,    dot: '#ef4444' },
    { pref: 'remoteColorGreen',  label: i18n.t.remoteColorGreen,  dot: '#22c55e' },
    { pref: 'remoteColorYellow', label: i18n.t.remoteColorYellow, dot: '#facc15' },
    { pref: 'remoteColorBlue',   label: i18n.t.remoteColorBlue,   dot: '#3b82f6' },
  ]);
  let remoteActionPref = $state('remoteColorRed');   // which colour the open picker is editing
  const remoteActionName = (pref) =>
    (remoteActionOptions.find(o => o.key === playbackPrefs[pref]) || remoteActionOptions[0]).name;

  function openRemoteAction(pref) {
    remoteActionPref = pref;
    openModal('remoteAction');
  }
  // ── One option-picker modal for every "choose one value for a pref" dialog ────────────────
  // audioLang / subtitleLang / remoteAction shared three near-identical modal bodies that had
  // already drifted from the app-language picker in padding and focus-ring style — the next tweak
  // would predictably have landed in some copies and not others. Each entry names its title,
  // options, current value and where the pick goes; the markup exists once. The app-language
  // modal stays separate on purpose (flags, immediate setLang semantics).
  let pickerModals = $derived({
    audioLang:    { title: i18n.t.audioLanguage,      options: audioLangOptions,
                    value: playbackPrefs.audioLanguage,
                    set: (k) => onPlaybackPrefsChange?.({ ...playbackPrefs, audioLanguage: k }) },
    subtitleLang: { title: i18n.t.subtitleLanguage,   options: subtitleLangOptions,
                    value: playbackPrefs.subtitleLanguage,
                    set: (k) => onPlaybackPrefsChange?.({ ...playbackPrefs, subtitleLanguage: k }) },
    remoteAction: { title: i18n.t.remoteButtonAction, options: remoteActionOptions,
                    value: playbackPrefs[remoteActionPref],
                    set: (k) => onPlaybackPrefsChange?.({ ...playbackPrefs, [remoteActionPref]: k }) },
  });

  function togglePlaybackPref(key) {
    onPlaybackPrefsChange?.({ ...playbackPrefs, [key]: !playbackPrefs[key] });
  }

  function setSubtitleSize(size) {
    onPlaybackPrefsChange?.({ ...playbackPrefs, subtitleSize: size });
  }
  // Generic for the text styling selectors (color/edge/background).
  function setSubtitlePref(key, val) {
    onPlaybackPrefsChange?.({ ...playbackPrefs, [key]: val });
  }

  function setStillWatchingEpisodes(n) {
    onPlaybackPrefsChange?.({ ...playbackPrefs, stillWatchingEpisodes: n });
  }

  function setThemeScope(v) {
    onPlaybackPrefsChange?.({ ...playbackPrefs, themeMusicScope: v });
  }
  function stepThemeVolume(d) {
    const cur = playbackPrefs.themeMusicVolume ?? 40;
    onPlaybackPrefsChange?.({ ...playbackPrefs, themeMusicVolume: Math.max(5, Math.min(100, cur + d)) });
  }

  // Version: YYYYMMDD — adjust here on updates
  // APP_VERSION now comes centrally from version.js (source: appinfo.json)

  let isCurrentUserSaved = $derived(!!(
    selectedUser && selectedServer &&
    savedTokens[selectedServer.id]?.[selectedUser.Id]
  ));

  let activeModal  = $state(null);
  const modalFocus = makeFocusReturn();   // trigger button that focus returns to after closing
  let currentPw    = $state('');
  let showCurrentPw = $state(false);  // eye toggle for the current password
  let newPw        = $state('');
  let showNewPw    = $state(false);   // eye toggle: briefly reveal the new password to check it
  let pwMessage    = $state('');
  let qcCode       = $state('');
  let qcMessage    = $state('');
  let modalTimeout = null;  // for a memory-leak-free setTimeout

  // Watch together — picker state
  let sharedPickerSlot = $state(null);   // 0 | 1 (which slot is being filled)
  let sharedPickerUser = $state(null);   // chosen profile (password step)
  let sharedPw    = $state('');
  let sharedBusy  = $state(false);
  let sharedError = $state('');
  let sharedMembers = $derived([0, 1].map(i => sharedProfile.members?.[i] || null));
  let sharedManualName = $state('');
  let sharedQcCode  = $state(null);
  let sharedQcQr    = $state(null);
  let sharedQcSess  = null;

  // Quick Connect for a watch-together member. The strongest option of the three: the partner
  // confirms on their OWN device, so their password is never typed on the TV nor known to whoever
  // is setting this up — and it reaches hidden profiles too, since no list is involved.
  async function startSharedQuickConnect() {
    sharedQcSess?.cancel();
    sharedError = ''; sharedQcCode = null; sharedQcQr = null;
    // Assign the session BEFORE any await: closeModal() cancels via sharedQcSess, so backing out
    // during the modal's own tick would otherwise leave a poll running with no dialog attached.
    sharedQcSess = startQC(session.serverUrl, clientAuthHeader, ({ code, qrSvg }) => { sharedQcCode = code; sharedQcQr = qrSvg; });
    await openModal('sharedQc');
    try {
      const { user, token } = await sharedQcSess.promise;
      const r = await onSharedSetMember(sharedPickerSlot, user, '', token);
      if (r === 'ok') {
        closeModal();
        await tick();
        document.querySelector(`[data-slot-btn="${sharedPickerSlot}"]`)?.focus();
      } else {
        sharedQcCode = null; sharedQcQr = null;
        sharedError = r === 'sameUser' ? i18n.t.sharedInvalidChoice : i18n.t.errLogin;
      }
    } catch (err) {
      if (err === 'cancelled') return;
      sharedQcCode = null; sharedQcQr = null;
      sharedError = err === 'networkError' ? i18n.t.networkError : i18n.t.qcError;
    }
  }
  function cancelSharedQuickConnect() { sharedQcSess?.cancel(); sharedQcSess = null; sharedQcCode = sharedQcQr = null; }

  let timeoutOptions = $derived([
    { label: `1 ${i18n.t.minuteShort}`,  value: 60  },
    { label: `90 ${i18n.t.secondShort}`, value: 90  },
    { label: `2 ${i18n.t.minuteShort}`,  value: 120 },
    { label: `5 ${i18n.t.minuteShort}`,  value: 300 },
  ]);

  onDestroy(() => { if (modalTimeout) clearTimeout(modalTimeout); sharedQcSess?.cancel(); });

  const getAuthHeaders = () => authHeaders(session.token);

  async function openModal(name) {
    modalFocus.capture();
    pwMessage = ''; qcMessage = '';
    currentPw = ''; newPw = ''; qcCode = ''; showNewPw = false; showCurrentPw = false;
    if (modalTimeout) clearTimeout(modalTimeout);
    activeModal = name;
    await tick();
    document.querySelector('[data-modal] input, [data-modal] button')?.focus();
  }

  function closeModal() {
    if (modalTimeout) clearTimeout(modalTimeout);
    cancelSharedQuickConnect();   // back/cancel leaves the dialog — the poll must not survive it
    activeModal = null;
  }

  // ── Watch together ─────────────────────────────────────────────────────────
  // Selectable: not one's own (shared) profile, not the one in the other slot.
  function pickableUsers(slot) {
    const otherId = sharedMembers[slot === 0 ? 1 : 0]?.id;
    return publicUsers.filter(u => u.Id !== selectedUser?.Id && u.Id !== otherId);
  }
  async function openSharedPicker(slot) {
    sharedPickerSlot = slot; sharedPickerUser = null; sharedPw = ''; sharedError = '';
    await openModal('sharedPicker');
  }
  // Hidden profiles never appear in /Users/Public, so they cannot be picked from the list — the
  // same reason the sign-in screen offers a manual entry. Name plus password, verified by the
  // server exactly like any other profile.
  async function openSharedManual() {
    sharedManualName = ''; sharedPw = ''; sharedError = '';
    await openModal('sharedManual');
  }
  async function commitSharedManual() {
    const name = sharedManualName.trim();
    if (!name) return;
    await commitSharedUser({ Name: name }, sharedPw);   // no Id yet — the server supplies it
  }
  async function chooseSharedUser(user) {
    sharedError = '';
    const sid = selectedServer?.id;
    const hasToken = !!(sharedTokens[sid]?.[user.Id] || savedTokens[sid]?.[user.Id]);
    if (user.HasPassword && !hasToken) {        // password needed → entry step
      sharedPickerUser = user; sharedPw = '';
      await openModal('sharedPassword');
      return;
    }
    await commitSharedUser(user, '');           // otherwise immediately (existing token / no password)
  }
  async function commitSharedUser(user, pw) {
    sharedBusy = true;
    const slot = sharedPickerSlot;
    const r = await onSharedSetMember(slot, user, pw);
    sharedBusy = false;
    if (r === 'ok') {
      closeModal();
      await tick();   // the slot now shows the remove button → focus there (instead of lost to the sidebar)
      document.querySelector(`[data-slot-btn="${slot}"]`)?.focus();
    }
    else if (r === 'needPassword')  { sharedPickerUser = user; sharedPw = ''; await openModal('sharedPassword'); }
    else if (r === 'sameUser')      sharedError = i18n.t.sharedInvalidChoice;
    else                            sharedError = i18n.t.errLogin;
  }
  // Remove the member + focus onto the "choose profile" button of the same slot that then appears.
  async function removeMember(slot) {
    await onSharedRemoveMember(slot);
    await tick();
    document.querySelector(`[data-slot-btn="${slot}"]`)?.focus();
  }

  function setLanguage(lang) {
    setLang(lang);
    try { localStorage.setItem('app_language', lang); } catch {}   // the choice survives a restart
    closeModal();
  }
  let currentLangName = $derived((LANGUAGES.find(l => l.key === i18n.lang) || {}).name || 'English');

  async function changePassword() {
    pwMessage = '';
    try {
      const res = await fetch(`${session.serverUrl}/Users/${selectedUser.Id}/Password`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ Id: selectedUser.Id, CurrentPw: currentPw, NewPw: newPw })
      });
      pwMessage = res.ok ? i18n.t.pwChangedSuccess : i18n.t.pwChangedError;
      if (res.ok) {
        currentPw = ''; newPw = '';
        modalTimeout = setTimeout(closeModal, 2000);
      }
    } catch { pwMessage = i18n.t.networkError; }
  }

  async function authorizeQuickConnect() {
    qcMessage = '';
    try {
      const res = await fetch(`${session.serverUrl}/QuickConnect/Authorize`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ Code: qcCode })
      });
      qcMessage = res.ok ? i18n.t.qcSuccess : i18n.t.qcError;
      if (res.ok) { qcCode = ''; modalTimeout = setTimeout(closeModal, 2000); }
    } catch { qcMessage = i18n.t.networkError; }
  }

  function updateScreensaver(patch) {
    onScreensaverChange?.({ ...screensaverSettings, ...patch });
  }

  // Diagnostic logging: a device-wide opt-in switch (like the screensaver, not tied to a profile).
  // setDebug takes effect immediately on all dlog calls (shared utils module); localStorage persists it.
  let debugLogging = $state(localStorage.getItem('ocenfin_debug') === '1');
  function toggleDebugLogging() {
    debugLogging = !debugLogging;
    localStorage.setItem('ocenfin_debug', debugLogging ? '1' : '0');
    setDebug(debugLogging);
  }

  // In-app log viewer: show the buffer, clear it, share it as a QR (last lines).
  // No "copy": on the TV there's no target to paste into — QR (to the phone) and
  // taking a photo are the sensible ways.
  let showLog = $state(false);
  let logText = $state('');
  let qrSvg = $state(null);
  let qrBtnEl = $state();   // for focus return when leaving the QR view
  let logEl = $state(null);   // <pre> with the log lines (for auto-scroll + paging)
  // Newest entries are at the bottom → jump to the end on open.
  function scrollLogToBottom() { if (logEl) logEl.scrollTop = logEl.scrollHeight; }
  // D-pad paging: ~85% of the visible height per press, focus stays on the button.
  function scrollLog(dir) { logEl?.scrollBy({ top: dir * logEl.clientHeight * 0.85, behavior: 'smooth' }); }
  async function openLog()  { modalFocus.capture(); logText = formatLog(); qrSvg = null; showLog = true; await tick(); scrollLogToBottom(); }
  function clearLog() { clearLogBuffer(); logText = formatLog(); qrSvg = null; }
  function hideQr()   { qrSvg = null; tick().then(() => { qrBtnEl?.focus(); scrollLogToBottom(); }); }
  async function showLogQr() {
    try {
      const { renderSVG } = await import('uqr');   // dynamic → not in the startup bundle, zero-dependency
      const tail = formatLog(1200);                 // only the most recent ~1200 chars (QR capacity)
      qrSvg = renderSVG(tail || ' ', { ecc: 'L', border: 1 });   // vector instead of PNG → razor sharp
    } catch (e) { console.warn('[OcenFin] QR generation failed', e); }
  }

  // Help / FAQ: QR to the OcenFin wiki — scan with a phone instead of typing the URL on the TV.
  let showWikiQr = $state(false);
  let wikiQrSvg  = $state(null);
  const WIKI_URL = 'https://github.com/seluce/OcenFin/wiki';
  async function openWikiQr() {
    modalFocus.capture();
    wikiQrSvg = null;
    showWikiQr = true;
    try {
      const { renderSVG } = await import('uqr');
      wikiQrSvg = renderSVG(WIKI_URL, { ecc: 'M', border: 1 });
    } catch (e) { console.warn('[OcenFin] Wiki QR generation failed', e); }
  }

  // Versions for the status page (Chromium from UA, hls.js/libbitsub from package.json) — static.
  const envVersions = runtimeVersions();

  // TV capabilities for the status page: panel flags (deviceInfo) + codec probe (browser).
  let tvInfo = $state(null);        // { available, modelName, uhd, uhd8K, oled, hdr10, dolbyVision, dolbyAtmos, ... }
  let codecs = $state({});          // { h264, hevc, vp9, av1 } – according to the browser decoder
  onMount(async () => {
    codecs = probeBrowserCodecs();
    tvInfo = await getTvDeviceInfo();
  });
  let tvResolution = $derived(!tvInfo?.available ? null
       : tvInfo.uhd8K === true ? '8K'
       : tvInfo.uhd === true ? '4K (UHD)'
       : (tvInfo.screenWidth ? `${tvInfo.screenWidth}×${tvInfo.screenHeight}` : null));
  // Tri-state: true → yes (green), false → no (gray), undefined → unknown (muted)
  const capText  = (v) => v === true ? i18n.t.statusYes : v === false ? i18n.t.statusNo : i18n.t.statusUnknown;
  const capClass = (v) => v === true ? 'text-green-400' : v === false ? 'text-gray-400' : 'text-gray-600';
  // Collapsible status groups (focusable headers → the D-pad can move down/scroll).
  // All collapsed by default: a shorter list, and from each subtitle menu item you reach
  // the settings cleanly via Right without intervening content.
  let openStatus = $state({ tv: false, runtime: false, components: false });
  const toggleStatus = (k) => { openStatus = { ...openStatus, [k]: !openStatus[k] }; };
  // When focusing a header, scroll the whole card (incl. content) into view — otherwise
  // the content of the lowest open group would stay hidden (no focusable element below it).
  const scrollGroupIntoView = (e) => {
    const card = e.currentTarget?.parentElement;
    if (card?.scrollIntoView) card.scrollIntoView({ block: 'nearest' });
  };

  function toggleReduceAnimations() {
    onReduceAnimationsChange?.(!reduceAnimations);
  }

  function toggleDisplay(key) {
    onDisplayChange?.({ ...displaySettings, [key]: !displaySettings[key] });
  }

  function setClockFormat(fmt) {
    onDisplayChange?.({ ...displaySettings, clockFormat: fmt });
  }

  function setUiSize(size) {
    onDisplayChange?.({ ...displaySettings, uiSize: size });
  }
  function setRecRows(n) {
    onDisplayChange?.({ ...displaySettings, recommendationRows: n });
  }
  function setTheme(theme) {
    onDisplayChange?.({ ...displaySettings, theme });
  }
  function setUiFont(font) {
    onDisplayChange?.({ ...displaySettings, uiFont: font });
  }
  function setSeekStep(sec) {
    onDisplayChange?.({ ...displaySettings, seekStep: sec });
  }

  // ---- Navigation editor (arrange/hide sidebar entries, per profile) ----
  // Same source as the sidebar; shows ALL entries here incl. hidden ones.
  let navEntries = $derived(applyNavConfig(buildNavEntries(libraries, i18n.t, displaySettings.navIcons || {}), displaySettings.navOrder || [], displaySettings.navHidden || []));
  let grabbedId = $state(null);   // lifted entry (grab mode) – null = none
  let navListEl = $state();          // bind: to refocus after moving
  let lastGrabToggle = 0; // against auto-repeat: a held OK key = one toggle
  let iconPickerFor = $state(null);   // entry ID for which an icon is being chosen (null = closed)
  let iconGridEl = $state();             // bind: auto-focus in the icon picker

  // Set grabbedId centrally + report to App so the focus manager locks the sidebar meanwhile.
  function setGrabbed(id) {
    grabbedId = id;
    onReorderingChange?.(id !== null);
  }
  function toggleGrab(entry) {
    const now = Date.now();
    if (now - lastGrabToggle < 350) return;   // don't trigger a held OK key 100×
    lastGrabToggle = now;
    setGrabbed(grabbedId === entry.id ? null : entry.id);   // OK lifts / drops
  }
  async function moveGrabbed(dir) {
    const ids = navEntries.map(e => e.id);
    const i = ids.indexOf(grabbedId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    onDisplayChange?.({ ...displaySettings, navOrder: ids });
    await tick();
    navListEl?.querySelector(`[data-nav-id="${grabbedId}"]`)?.focus();   // focus follows the entry
  }
  function toggleHidden(entry) {
    if (entry.locked) return;
    const hidden = new Set(displaySettings.navHidden || []);
    hidden.has(entry.id) ? hidden.delete(entry.id) : hidden.add(entry.id);
    onDisplayChange?.({ ...displaySettings, navHidden: [...hidden] });
  }
  // --- Icon picker ---
  async function openIconPicker(entry) {
    iconPickerFor = entry.id;
    await tick();
    iconGridEl?.querySelector('button')?.focus();
  }
  function pickIcon(key) {
    onDisplayChange?.({ ...displaySettings, navIcons: { ...(displaySettings.navIcons || {}), [iconPickerFor]: key } });
    iconPickerFor = null;
  }
  function onIconPickerKey(e) {
    if (isBackKey(e)) { e.preventDefault(); e.stopPropagation(); iconPickerFor = null; }
  }

  // --- Profile picture (symbol avatar OR poster of a recently watched title → Jellyfin) ---
  let avatarIcon  = $state(null);                  // null = nothing chosen yet (no avatar marked)
  let avatarColor = $state(null);                  // null = nothing chosen yet (no color marked)
  let avatarSaving = $state(false);
  let avatarSaved  = $state(false);                // brief confirmation hint after uploading
  let hasEditedAvatar = $state(false);             // false → the preview shows the real current profile picture
  let avatarModalOpen = $state(false);             // "customize" modal
  let avatarTab = $state('recent');                // 'recent' = posters of recently watched titles, 'symbols' = icon+color
  let recentTitles = $state([]);                   // [{ id, name, imageUrl }] – newest first, deduplicated
  let recentLoading = $state(false);
  let avatarPoster = $state(null);                 // poster chosen in the 'recent' tab (otherwise null)
  function onAvatarModalKey(e) {
    if (isBackKey(e)) { e.preventDefault(); e.stopPropagation(); avatarModalOpen = false; }
  }
  // Effective values only for rendering/uploading (fallback to default); the marking stays on the raw values.
  let effectiveIcon  = $derived(avatarIcon  || AVATAR_ICON_KEYS[0]);
  let effectiveColor = $derived(avatarColor || AVATAR_COLORS[0]);
  // When leaving "profile & security" without saving → reset the preview/selection.
  $effect(() => { if (activeCategory !== 'security' && hasEditedAvatar) {
    hasEditedAvatar = false; avatarIcon = null; avatarColor = null; avatarPoster = null;
  } });
  $effect(() => { if (activeCategory !== 'security' && avatarModalOpen) avatarModalOpen = false; });

  // After closing a modal (whichever/however), put focus back on the triggering button.
  $effect(() => {
    const anyModalOpen = !!activeModal || avatarModalOpen || showLog || showWikiQr;
    if (!anyModalOpen && modalFocus.pending) modalFocus.restore();
  });

  // Fetch recently watched movies/series as avatar suggestions: newest first, episodes → series,
  // deduplicated, at most as many as there are symbols. Fresh on every open (current order).
  async function loadRecentTitles() {
    recentLoading = true;
    try {
      const base = `${session.serverUrl}/Users/${selectedUser.Id}/Items?Recursive=true&IncludeItemTypes=Movie,Episode`
        + `&Fields=SeriesId,SeriesPrimaryImageTag,UserData&EnableImageTypes=Primary&ImageTypeLimit=1`
        + `&SortBy=DatePlayed&SortOrder=Descending&EnableTotalRecordCount=false&Limit=72`;
      const [played, resume] = await Promise.all([
        fetch(`${base}&Filters=IsPlayed`,    { headers: getAuthHeaders() }).then(r => r.ok ? r.json() : { Items: [] }),
        fetch(`${base}&Filters=IsResumable`, { headers: getAuthHeaders() }).then(r => r.ok ? r.json() : { Items: [] }),
      ]);
      const all = [...(resume.Items || []), ...(played.Items || [])]
        .sort((a, b) => new Date(b.UserData?.LastPlayedDate || 0) - new Date(a.UserData?.LastPlayedDate || 0));
      const seen = new Set(); const list = [];
      for (const it of all) {
        const isEp = it.Type === 'Episode' && it.SeriesId;
        const id   = isEp ? it.SeriesId : it.Id;
        const tag  = isEp ? it.SeriesPrimaryImageTag : it.ImageTags?.Primary;
        if (!id || !tag || seen.has(id)) continue;
        seen.add(id);
        list.push({
          id,
          name: isEp ? (it.SeriesName || it.Name) : it.Name,
          imageUrl: `${session.serverUrl}/Items/${id}/Images/Primary?tag=${tag}&fillHeight=300&quality=90&format=webp&ApiKey=${session.token}`,
        });
        if (list.length >= AVATAR_ICON_KEYS.length) break;
      }
      recentTitles = list;
    } catch { recentTitles = []; }
    finally {
      recentLoading = false;
      avatarTab = recentTitles.length ? 'recent' : 'symbols';   // new user without history → symbols
    }
  }
  function openAvatarModal() { modalFocus.capture(); avatarModalOpen = true; loadRecentTitles(); }

  async function saveProfileImage() {
    if (avatarSaving) return;
    avatarSaving = true; avatarSaved = false;
    try {
      const base64 = (avatarTab === 'recent' && avatarPoster)
        ? await renderImageAvatarPng(avatarPoster.imageUrl)
        : await renderAvatarPng(effectiveIcon, effectiveColor);
      const res = await fetch(`${session.serverUrl}/Users/${selectedUser.Id}/Images/Primary`, {
        method: 'POST',
        headers: { ...authHeaders(session.token), 'Content-Type': 'image/png' },   // one auth scheme, one source
        body: base64,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      avatarSaved = true;
      onProfileImageChanged?.();     // App reloads selectedUser → the sidebar shows it immediately
      setTimeout(() => avatarSaved = false, 2500);
    } catch (e) {
      console.error('[OcenFin] avatar upload failed:', e);
    } finally {
      avatarSaving = false;
    }
  }
  // In grab mode intercept ▲/▼ (before the focus manager, bubble phase) and move.
  // OK (click) drops; Back cancels grab mode.
  function onNavRowKey(e, entry) {
    if (grabbedId !== entry.id) return;
    if (e.key === 'ArrowUp')        { e.preventDefault(); e.stopPropagation(); moveGrabbed(-1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); moveGrabbed(1); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); } // don't leave in grab mode
    else if (isBackKey(e))          { e.preventDefault(); e.stopPropagation(); setGrabbed(null); }
  }

  // Accent colors (preview color = the 500 tone). OLED-friendly, vivid tones.
  const themeSwatches = [
    { id: 'blue',    color: '#3b82f6', label: i18n.t.themeBlue },
    { id: 'sky',     color: '#0ea5e9', label: i18n.t.themeSky },
    { id: 'teal',    color: '#14b8a6', label: i18n.t.themeTeal },
    { id: 'emerald', color: '#10b981', label: i18n.t.themeEmerald },
    { id: 'indigo',  color: '#6366f1', label: i18n.t.themeIndigo },
    { id: 'violet',  color: '#8b5cf6', label: i18n.t.themeViolet },
    { id: 'fuchsia', color: '#d946ef', label: i18n.t.themeFuchsia },
    { id: 'rose',    color: '#f43f5e', label: i18n.t.themeRose },
    { id: 'orange',  color: '#f97316', label: i18n.t.themeOrange },
    { id: 'amber',   color: '#f59e0b', label: i18n.t.themeAmber },
  ];

  // Display elements grouped: home rows vs. general interface
  let sharedSetUp = $derived(sharedProfile.enabled && sharedProfile.members.filter(m => m && m.id).length >= 1);
  let homeToggles = $derived([
    { key: 'hero',            label: i18n.t.displayHero },
    { key: 'libraries',       label: i18n.t.displayLibraries },
    { key: 'nextUp',          label: i18n.t.nextUp },
    { key: 'watchlist',       label: i18n.t.watchlist },
    { key: 'history',         label: i18n.t.displayHistory },
    ...(sharedSetUp ? [{ key: 'sharedSuggestions', label: i18n.t.sharedSuggestions }] : []),
    { key: 'recommendations', label: i18n.t.displayRecommendations },
    { key: 'latest',          label: i18n.t.displayLatest },
    { key: 'collections',     label: i18n.t.collections },
  ]);
  let uiToggles = $derived([
    { key: 'showLogo',        label: i18n.t.displayLogo },
    { key: 'clock',           label: i18n.t.displayClock },
    { key: 'episodeCount',    label: i18n.t.displayEpisodeCount },
    { key: 'backdropPreview', label: i18n.t.displayBackdropPreview },
    { key: 'dashboardBackdrop', label: i18n.t.displayDashboardBackdrop },
  ]);
  let detailToggles = $derived([
    { key: 'detailsBackdrop',   label: i18n.t.displayDetailsBackdrop },
    { key: 'detailsLogo',       label: i18n.t.displayDetailsLogo },
    { key: 'spoilerProtection', label: i18n.t.spoilerProtection },
  ]);

  // Two-column navigation: pick the category on the left, content on the right (no long scrolling)
  let activeCategory = $state('appearance');
  let contentEl = $state();
  // Reset the content scroll position on category switch, so a new category always starts at the
  // top instead of inheriting the previous category's scroll depth.
  $effect(() => { activeCategory; if (contentEl) contentEl.scrollTop = 0; });
  // Close the "display elements" sub-item as soon as you leave the appearance tab
  let categories = $derived([
    { id: 'appearance', label: i18n.t.settingsDisplay,    icon: 'M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z' },
    { id: 'displayElements', label: i18n.t.displayElements, icon: 'M3.75 6A2.25 2.25 0 016 3.75h2.25A2.25 2.25 0 0110.5 6v2.25a2.25 2.25 0 01-2.25 2.25H6a2.25 2.25 0 01-2.25-2.25V6zM3.75 15.75A2.25 2.25 0 016 13.5h2.25a2.25 2.25 0 012.25 2.25V18a2.25 2.25 0 01-2.25 2.25H6A2.25 2.25 0 013.75 18v-2.25zM13.5 6a2.25 2.25 0 012.25-2.25H18A2.25 2.25 0 0120.25 6v2.25A2.25 2.25 0 0118 10.5h-2.25a2.25 2.25 0 01-2.25-2.25V6zM13.5 15.75a2.25 2.25 0 012.25-2.25H18a2.25 2.25 0 012.25 2.25V18A2.25 2.25 0 0118 20.25h-2.25A2.25 2.25 0 0113.5 18v-2.25z' },
    { id: 'navigation', label: i18n.t.settingsNavigation, icon: 'M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zM3.75 12h.007v.008H3.75V12zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm-.375 5.25h.007v.008H3.75v-.008zm.375 0a.375.375 0 11-.75 0 .375.375 0 01.75 0z' },
    { id: 'remote',     label: i18n.t.settingsRemote,      icon: 'M10.5 3.75h3a2.25 2.25 0 012.25 2.25v12a2.25 2.25 0 01-2.25 2.25h-3A2.25 2.25 0 018.25 18V6a2.25 2.25 0 012.25-2.25zM12 7.5h.008v.008H12V7.5zm0 3h.008v.008H12V10.5zm0 3h.008v.008H12V13.5z' },
    { id: 'oled',       label: i18n.t.screensaverSection, icon: 'M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
    { id: 'playback',   label: i18n.t.playback,           icon: 'M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.348a1.125 1.125 0 010 1.971l-11.54 6.347a1.125 1.125 0 01-1.667-.985V5.653z' },
    { id: 'subtitles',  label: i18n.t.subtitles,          icon: 'M7.5 8.25h9m-9 3H12m-9.75 1.51c0 1.6 1.123 2.994 2.707 3.227 1.129.166 2.27.293 3.423.379.35.026.67.21.865.501L12 21l2.755-4.133a1.14 1.14 0 01.865-.501 48.172 48.172 0 003.423-.379c1.584-.233 2.707-1.626 2.707-3.228V6.741c0-1.602-1.123-2.995-2.707-3.228A48.394 48.394 0 0012 3c-2.392 0-4.744.175-7.043.513C3.373 3.746 2.25 5.14 2.25 6.741v6.018z' },
    { id: 'security',   label: i18n.t.profileSecurity,    icon: 'M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z' },
    { id: 'account',    label: i18n.t.settingsAccount,    icon: 'M5.25 14.25h13.5m-13.5 0a3 3 0 01-3-3m3 3a3 3 0 100 6h13.5a3 3 0 100-6m-16.5-3a3 3 0 013-3h13.5a3 3 0 013 3m-19.5 0a4.5 4.5 0 01.9-2.7L5.7 5.1a3.375 3.375 0 012.7-1.35h7.13c1.06 0 2.06.5 2.7 1.35l2.59 3.45a4.5 4.5 0 01.9 2.7' },
    { id: 'status',     label: i18n.t.statusSection,      icon: 'M3.75 3v11.25A2.25 2.25 0 006 16.5h2.25M3.75 3h-1.5m1.5 0h16.5m0 0h1.5m-1.5 0v11.25A2.25 2.25 0 0118 16.5h-2.25m-7.5 0h7.5m-7.5 0l-1 3m8.5-3l1 3m0 0l.5 1.5m-.5-1.5h-9.5m0 0l-.5 1.5M9 11.25v1.5M12 9v3.75m3-6v6' },
  ]);
</script>

<div class="flex h-full">

  <!-- LEFT: category navigation. data-hbar: enter via Left/Right, Up/Down moves
       within; when entering from the right, focus lands on the active category (data-hbar-current). -->
  <nav data-hbar class="w-72 shrink-0 bg-gray-900/60 border-r border-gray-800 p-6 pt-16 flex flex-col gap-2 overflow-y-auto hide-scrollbar">
    <h1 class="text-3xl font-bold text-white mb-4 ml-2">{i18n.t.settings}</h1>
    {#each categories as cat}
      <button onclick={() => activeCategory = cat.id}
        data-hbar-current={activeCategory === cat.id ? '' : null}
        class="flex items-center gap-4 px-4 py-4 rounded-xl text-left font-bold text-lg focus:outline-none focus:ring-4 focus:ring-white transition-all
               {activeCategory === cat.id ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-800 focus:bg-gray-800'}">
        <svg class="w-6 h-6 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d={cat.icon}/>
        </svg>
        <span>{cat.label}</span>
      </button>
    {/each}
    <div class="mt-auto pt-6 text-center">
      <span class="text-gray-600 font-mono text-xs tracking-widest block">OcenFin</span>
      <span class="text-gray-600 font-mono text-xs tracking-widest">{i18n.t.version} {APP_VERSION}</span>
    </div>
  </nav>

  <!-- RIGHT: content of the active category. data-enter-top: when switching from the left, focus
       always starts at the top element of the respective category, not geometrically in the middle. -->
  <!-- scroll-padding on BOTH edges: spatial navigation scrolls with block:'nearest', which parks
       an element flush against whichever edge it entered from. Unlike the card rows elsewhere
       in the app, the setting rows carry no scroll-margin of their own, so the container has to
       provide the breathing room — otherwise a row revealed downwards (e.g. the profile picker
       appearing under "watch together") sits right on the bottom edge with its ring clipped. -->
  <div bind:this={contentEl} data-enter-top class="flex-1 overflow-y-auto hide-scrollbar p-10 pt-16 [scroll-padding-top:4rem] [scroll-padding-bottom:4rem]">
    <div class="max-w-4xl flex flex-col gap-10 pb-32">
    <!-- ══════════════════════════════════════════
         1. APPEARANCE
    ══════════════════════════════════════════ -->
    {#if activeCategory === 'appearance'}
    <section class="flex flex-col gap-4">
      <h2 class="text-xl font-bold text-gray-400 uppercase tracking-wider ml-2">{i18n.t.settingsDisplay}</h2>
      <div class="bg-gray-800/80 border border-gray-700 rounded-2xl overflow-hidden shadow-xl">

        <!-- Language -->
        <button onclick={() => openModal('lang')}
          class="flex items-center justify-between w-full p-6 hover:bg-gray-700 focus:bg-gray-700
                 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left first:rounded-t-2xl last:rounded-b-2xl">
          <div>
            <span class="text-2xl text-white font-medium block">{i18n.t.language}</span>
            <span class="text-gray-400 mt-1 block text-sm">{i18n.t.languageDesc}</span>
          </div>
          <span class="text-xl font-bold text-gray-300">{currentLangName}</span>
        </button>

        <div class="h-px bg-gray-700"></div>

        <!-- Reduce animations -->
        <button onclick={toggleReduceAnimations}
          class="flex items-center justify-between w-full p-6 hover:bg-gray-700 focus:bg-gray-700
                 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left first:rounded-t-2xl last:rounded-b-2xl">
          <div>
            <span class="text-2xl text-white font-medium block">{i18n.t.reduceAnimations}</span>
            <span class="text-gray-400 mt-1 block text-sm">{i18n.t.reduceAnimationsDesc}</span>
          </div>
          <div class="w-16 h-8 rounded-full flex items-center p-1 transition-colors shrink-0
                      {reduceAnimations ? 'bg-blue-500' : 'bg-gray-600'}">
            <div class="bg-white w-6 h-6 rounded-full shadow-md transform transition-transform
                        {reduceAnimations ? 'translate-x-8' : ''}"></div>
          </div>
        </button>

        <div class="h-px bg-gray-700"></div>

        <!-- Interface size — its own item, scales the entire app -->
        <div class="p-6">
          <span class="text-2xl text-white font-medium block">{i18n.t.uiSize}</span>
          <span class="text-gray-400 mt-1 mb-4 block text-sm">{i18n.t.uiSizeDesc}</span>
          <div class="flex gap-3">
            {#each [['small', i18n.t.sizeSmall],['medium', i18n.t.sizeMedium],['large', i18n.t.sizeLarge]] as [val, label]}
              <button onclick={() => setUiSize(val)}
                class="flex-1 py-3 rounded-xl font-bold text-lg focus:outline-none focus:ring-4 focus:ring-white transition-all
                       {(displaySettings.uiSize || 'medium') === val ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-300 hover:bg-gray-700'}">
                {label}
              </button>
            {/each}
          </div>
        </div>

        <div class="h-px bg-gray-700"></div>

        <!-- Font — its own item, applies to the entire interface. ASS subtitles are
             excluded (they bring their own fonts); the VTT display inherits the choice.
             The buttons each show themselves in their own font (preview). -->
        <div class="p-6">
          <span class="text-2xl text-white font-medium block">{i18n.t.uiFont}</span>
          <span class="text-gray-400 mt-1 mb-4 block text-sm">{i18n.t.uiFontDesc}</span>
          <div class="flex gap-3">
            {#each [['system', i18n.t.fontSystem, ''], ['arimo', 'Arimo', "'Arimo', sans-serif"], ['noto', 'Noto Sans', "'Noto Sans', sans-serif"]] as [val, label, fam]}
              <button onclick={() => setUiFont(val)}
                class="flex-1 py-3 rounded-xl font-bold text-lg focus:outline-none focus:ring-4 focus:ring-white transition-all
                       {(displaySettings.uiFont || 'system') === val ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-300 hover:bg-gray-700'}"
                style={fam ? `font-family: ${fam}` : ''}>
                {label}
              </button>
            {/each}
          </div>
        </div>

        <div class="h-px bg-gray-700"></div>

        <!-- Accent color — its own item, changes the highlight color -->
        <div class="p-6">
          <span class="text-2xl text-white font-medium block">{i18n.t.accentColor}</span>
          <span class="text-gray-400 mt-1 mb-4 block text-sm">{i18n.t.accentColorDesc}</span>
          <div class="flex gap-4 flex-wrap">
            {#each themeSwatches as sw}
              <button onclick={() => setTheme(sw.id)} title={sw.label}
                class="w-14 h-14 rounded-full focus:outline-none focus:ring-4 focus:ring-white transition-all
                       {(displaySettings.theme || 'blue') === sw.id ? 'ring-4 ring-white scale-110' : 'hover:scale-105'}"
                style="background-color: {sw.color}">
                {#if (displaySettings.theme || 'blue') === sw.id}
                  <svg class="w-7 h-7 mx-auto text-white drop-shadow" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
                  </svg>
                {/if}
              </button>
            {/each}
          </div>
        </div>

      </div>
    </section>
    {/if}

    {#if activeCategory === 'displayElements'}
    <section class="flex flex-col gap-4">
      <h2 class="text-xl font-bold text-gray-400 uppercase tracking-wider ml-2">{i18n.t.displayElements}</h2>
      <div class="bg-gray-800/80 border border-gray-700 rounded-2xl overflow-hidden shadow-xl">
          <!-- Group: interface (general elements) -->
          <div class="px-6 pt-4 pb-2">
            <h3 class="text-xs font-bold text-gray-500 uppercase tracking-widest">{i18n.t.groupInterface}</h3>
          </div>
          {#each uiToggles as tg}
            <button onclick={() => toggleDisplay(tg.key)}
              class="flex items-center justify-between w-full px-6 py-4 hover:bg-gray-700 focus:bg-gray-700
                     focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left first:rounded-t-2xl last:rounded-b-2xl">
              <span class="text-lg text-gray-200">{tg.label}</span>
              <div class="w-14 h-7 rounded-full flex items-center p-1 transition-colors shrink-0
                          {displaySettings[tg.key] ? 'bg-blue-500' : 'bg-gray-600'}">
                <div class="bg-white w-5 h-5 rounded-full shadow-md transform transition-transform
                            {displaySettings[tg.key] ? 'translate-x-7' : ''}"></div>
              </div>
            </button>
          {/each}

          <!-- Time format (applies to both clocks) -->
          <div class="px-6 py-4">
            <span class="text-lg text-gray-200 block mb-3">{i18n.t.clockFormat}</span>
            <div class="flex gap-2">
              {#each [['auto', i18n.t.clockAuto],['24h', i18n.t.clock24h],['12h', i18n.t.clock12h]] as [val, label]}
                <button onclick={() => setClockFormat(val)}
                  class="flex-1 py-2.5 rounded-lg font-bold text-base focus:outline-none focus:ring-4 focus:ring-white transition-all
                         {(displaySettings.clockFormat || 'auto') === val ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}">
                  {label}
                </button>
              {/each}
            </div>
          </div>

          <!-- Group: home (dashboard rows) -->
          <div class="px-6 pt-5 pb-2 border-t border-gray-700/40">
            <h3 class="text-xs font-bold text-gray-500 uppercase tracking-widest">{i18n.t.groupHome}</h3>
          </div>
          {#each homeToggles as tg}
            <button onclick={() => toggleDisplay(tg.key)}
              class="flex items-center justify-between w-full px-6 py-4 hover:bg-gray-700 focus:bg-gray-700
                     focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left first:rounded-t-2xl last:rounded-b-2xl">
              <span class="text-lg text-gray-200">{tg.label}</span>
              <div class="w-14 h-7 rounded-full flex items-center p-1 transition-colors shrink-0
                          {displaySettings[tg.key] ? 'bg-blue-500' : 'bg-gray-600'}">
                <div class="bg-white w-5 h-5 rounded-full shadow-md transform transition-transform
                            {displaySettings[tg.key] ? 'translate-x-7' : ''}"></div>
              </div>
            </button>
          {/each}

          <!-- Number of recommendation rows — only relevant when recommendations are active -->
          {#if displaySettings.recommendations}
            <div class="px-6 py-4">
              <span class="text-lg text-gray-200 block mb-3">{i18n.t.recommendationRows}</span>
              <div class="flex gap-2">
                {#each [[1, i18n.t.rowsOne],[2, i18n.t.rowsTwo]] as [val, label]}
                  <button onclick={() => setRecRows(val)}
                    class="flex-1 py-2.5 rounded-lg font-bold text-base focus:outline-none focus:ring-4 focus:ring-white transition-all
                           {(displaySettings.recommendationRows || 1) === val ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}">
                    {label}
                  </button>
                {/each}
              </div>
            </div>
          {/if}

          <!-- Group: details (detail page of a movie/series) -->
          <div class="px-6 pt-5 pb-2 border-t border-gray-700/40">
            <h3 class="text-xs font-bold text-gray-500 uppercase tracking-widest">{i18n.t.groupDetails}</h3>
          </div>
          {#each detailToggles as tg}
            <button onclick={() => toggleDisplay(tg.key)}
              class="flex items-center justify-between w-full px-6 py-4 hover:bg-gray-700 focus:bg-gray-700
                     focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left first:rounded-t-2xl last:rounded-b-2xl">
              <span class="text-lg text-gray-200">{tg.label}</span>
              <div class="w-14 h-7 rounded-full flex items-center p-1 transition-colors shrink-0
                          {displaySettings[tg.key] ? 'bg-blue-500' : 'bg-gray-600'}">
                <div class="bg-white w-5 h-5 rounded-full shadow-md transform transition-transform
                            {displaySettings[tg.key] ? 'translate-x-7' : ''}"></div>
              </div>
            </button>
          {/each}
      </div>
    </section>
    {/if}

    <!-- ══════════════════════════════════════════
         NAVIGATION (arrange/hide sidebar entries)
    ══════════════════════════════════════════ -->
    {#if activeCategory === 'navigation'}
    <section class="flex flex-col gap-3">
      <h2 class="text-xl font-bold text-gray-400 uppercase tracking-wider ml-2">{i18n.t.settingsNavigation}</h2>
      <p class="text-gray-400 text-sm ml-2">{i18n.t.navEditHint}</p>
      <div bind:this={navListEl} class="bg-gray-800/80 border border-gray-700 rounded-2xl overflow-hidden shadow-xl flex flex-col">
        {#each navEntries as entry (entry.id)}
          <div class="flex items-center gap-2 px-3 py-1.5 border-b border-gray-700/40 last:border-b-0 {entry.hidden ? 'opacity-50' : ''}">
            <!-- Lift / move (OK grabs, ▲▼ moves) -->
            <button data-nav-id={entry.id} onclick={() => toggleGrab(entry)} onkeydown={(e) => onNavRowKey(e, entry)}
              class="flex-1 flex items-center gap-4 p-3 rounded-xl text-left focus:outline-none transition-all
                     {grabbedId === entry.id
                       ? 'bg-blue-600 text-white ring-4 ring-white scale-[1.02] shadow-xl'
                       : 'text-gray-200 hover:bg-gray-700 focus:bg-gray-700 focus:ring-4 focus:ring-white'}">
              <svg class="w-6 h-6 shrink-0 opacity-50" fill="currentColor" viewBox="0 0 24 24"><path d="M8 6h2v2H8V6zm0 5h2v2H8v-2zm0 5h2v2H8v-2zm6-10h2v2h-2V6zm0 5h2v2h-2v-2zm0 5h2v2h-2v-2z"/></svg>
              <svg class="w-7 h-7 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d={entry.icon}/></svg>
              <span class="text-xl font-semibold flex-1">{entry.label}</span>
              {#if grabbedId === entry.id}
                <span class="text-sm font-medium opacity-90 whitespace-nowrap">{i18n.t.navGrabbedHint}</span>
              {/if}
            </button>
            <!-- Choose icon -->
            <button onclick={() => openIconPicker(entry)}
              class="p-3 rounded-xl text-gray-400 hover:text-white focus:text-white focus:outline-none focus:ring-4 focus:ring-white transition-colors"
              title={i18n.t.chooseIcon}>
              <svg class="w-7 h-7" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d={entry.icon}/></svg>
            </button>
            <!-- Visibility -->
            {#if entry.locked}
              <div class="p-3 text-gray-600" title={i18n.t.navAlwaysVisible}>
                <svg class="w-7 h-7" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 10.5V6.75a4.5 4.5 0 10-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 002.25-2.25v-6.75a2.25 2.25 0 00-2.25-2.25H6.75a2.25 2.25 0 00-2.25 2.25v6.75a2.25 2.25 0 002.25 2.25z"/></svg>
              </div>
            {:else}
              <button onclick={() => toggleHidden(entry)}
                class="p-3 rounded-xl focus:outline-none focus:ring-4 focus:ring-white transition-colors
                       {entry.hidden ? 'text-gray-500 hover:text-white focus:text-white' : 'text-blue-400 hover:text-white focus:text-white'}"
                title={entry.hidden ? i18n.t.navShow : i18n.t.navHide}>
                {#if entry.hidden}
                  <svg class="w-7 h-7" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.243 4.243L9.88 9.88"/></svg>
                {:else}
                  <svg class="w-7 h-7" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                {/if}
              </button>
            {/if}
          </div>
        {/each}
      </div>

      <!-- Icon picker (modal, D-pad grid) -->
      {#if iconPickerFor}
        <div class="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-8"
             data-focus-trap onkeydown={onIconPickerKey} role="dialog" tabindex="-1">
          <div class="bg-gray-800 border border-gray-700 rounded-2xl p-6 shadow-2xl max-w-xl w-full">
            <div class="flex justify-between items-center mb-5">
              <h3 class="text-2xl font-bold text-white">{i18n.t.chooseIcon}</h3>
              <button onclick={() => iconPickerFor = null} aria-label={i18n.t.close} class="text-gray-400 hover:text-white focus:text-white focus:outline-none focus:ring-2 focus:ring-white rounded-lg p-1">
                <svg class="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
              </button>
            </div>
            <div bind:this={iconGridEl} class="grid grid-cols-5 gap-3 max-h-[58vh] overflow-y-auto hide-scrollbar p-2">
              {#each NAV_ICON_KEYS as key}
                <button onclick={() => pickIcon(key)} aria-label={key}
                  class="aspect-square flex items-center justify-center rounded-xl bg-gray-700 hover:bg-gray-600 focus:bg-blue-600 focus:outline-none focus:ring-4 focus:ring-white transition-colors">
                  <svg class="w-8 h-8 text-white" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d={NAV_ICON_PALETTE[key]}/></svg>
                </button>
              {/each}
            </div>
          </div>
        </div>
      {/if}
    </section>
    {/if}


    <!-- ══════════════════════════════════════════
         REMOTE — shortcuts that only apply inside the player
    ══════════════════════════════════════════ -->
    {#if activeCategory === 'remote'}
    <section class="flex flex-col gap-4">
      <h2 class="text-xl font-bold text-gray-400 uppercase tracking-wider ml-2">{i18n.t.settingsRemote}</h2>
      <div class="bg-gray-800/80 border border-gray-700 rounded-2xl overflow-hidden shadow-xl">

        <!-- Number keys → n×10 % of the runtime. Opt-out: on by default, but the description is the
             real point of this row — it is where people discover the shortcut in the first place. -->
        <button onclick={() => togglePlaybackPref('remoteDigitSeek')}
          class="flex items-center justify-between w-full p-6 hover:bg-gray-700 focus:bg-gray-700
                 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left first:rounded-t-2xl last:rounded-b-2xl">
          <div>
            <span class="text-2xl text-white font-medium block">{i18n.t.remoteDigitSeek}</span>
            <span class="text-gray-400 mt-1 block text-sm">{i18n.t.remoteDigitSeekDesc}</span>
          </div>
          <div class="w-16 h-8 rounded-full flex items-center p-1 transition-colors shrink-0
                      {playbackPrefs.remoteDigitSeek ? 'bg-blue-500' : 'bg-gray-600'}">
            <div class="bg-white w-6 h-6 rounded-full shadow-md transform transition-transform
                        {playbackPrefs.remoteDigitSeek ? 'translate-x-8' : ''}"></div>
          </div>
        </button>

        <div class="h-px bg-gray-700"></div>

        <!-- Channel rocker → next/previous episode. Same opt-out; turning it off also protects
             against the accidental press, since the rocker is the easiest key to hit by mistake. -->
        <button onclick={() => togglePlaybackPref('remoteChannelZap')}
          class="flex items-center justify-between w-full p-6 hover:bg-gray-700 focus:bg-gray-700
                 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left first:rounded-t-2xl last:rounded-b-2xl">
          <div>
            <span class="text-2xl text-white font-medium block">{i18n.t.remoteChannelZap}</span>
            <span class="text-gray-400 mt-1 block text-sm">{i18n.t.remoteChannelZapDesc}</span>
          </div>
          <div class="w-16 h-8 rounded-full flex items-center p-1 transition-colors shrink-0
                      {playbackPrefs.remoteChannelZap ? 'bg-blue-500' : 'bg-gray-600'}">
            <div class="bg-white w-6 h-6 rounded-full shadow-md transform transition-transform
                        {playbackPrefs.remoteChannelZap ? 'translate-x-8' : ''}"></div>
          </div>
        </button>
      </div>

      <h2 class="text-xl font-bold text-gray-400 uppercase tracking-wider ml-2 mt-6">{i18n.t.remoteColorButtons}</h2>
      <p class="text-gray-400 text-sm ml-2 -mt-2">{i18n.t.remoteColorButtonsDesc}</p>
      <div class="bg-gray-800/80 border border-gray-700 rounded-2xl overflow-hidden shadow-xl">
        {#each remoteColorRows as row, i (row.pref)}
          {#if i > 0}<div class="h-px bg-gray-700"></div>{/if}
          <button onclick={() => openRemoteAction(row.pref)}
            class="flex items-center justify-between w-full p-6 hover:bg-gray-700 focus:bg-gray-700
                   focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left first:rounded-t-2xl last:rounded-b-2xl">
            <span class="flex items-center gap-4">
              <span class="w-5 h-5 rounded-full shrink-0" style="background:{row.dot}"></span>
              <span class="text-2xl text-white font-medium">{row.label}</span>
            </span>
            <span class="text-xl font-bold text-gray-300">{remoteActionName(row.pref)}</span>
          </button>
        {/each}
      </div>
    </section>
    {/if}

    <!-- ══════════════════════════════════════════
         2. OLED PROTECTION
    ══════════════════════════════════════════ -->
    {#if activeCategory === 'oled'}
    <section class="flex flex-col gap-4">
      <h2 class="text-xl font-bold text-gray-400 uppercase tracking-wider ml-2">{i18n.t.screensaverSection}</h2>
      <div class="bg-gray-800/80 border border-gray-700 rounded-2xl overflow-hidden shadow-xl">

        <!-- Screensaver Toggle -->
        <button onclick={() => updateScreensaver({ enabled: !screensaverSettings.enabled })}
          class="flex items-center justify-between w-full px-6 py-5 hover:bg-gray-700 focus:bg-gray-700
                 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left first:rounded-t-2xl last:rounded-b-2xl">
          <div>
            <span class="text-2xl text-white font-medium block">{i18n.t.screensaverTitle}</span>
            <span class="text-gray-400 mt-0.5 block text-sm">{i18n.t.screensaverDesc}</span>
          </div>
          <div class="w-16 h-8 rounded-full flex items-center p-1 transition-colors shrink-0
                      {screensaverSettings.enabled ? 'bg-blue-500' : 'bg-gray-600'}">
            <div class="bg-white w-6 h-6 rounded-full shadow-md transform transition-transform
                        {screensaverSettings.enabled ? 'translate-x-8' : ''}"></div>
          </div>
        </button>

        <!-- Timeout (only when active) -->
        {#if screensaverSettings.enabled}
          <!-- Activate after -->
          <div class="h-px bg-gray-700"></div>
          <div class="p-6">
            <span class="text-base text-gray-400 font-medium block mb-3">{i18n.t.screensaverAfter}</span>
            <div class="flex gap-3">
              {#each timeoutOptions as opt}
                <button onclick={() => updateScreensaver({ timeout: opt.value })}
                  class="flex-1 py-3 rounded-xl font-bold text-lg focus:outline-none focus:ring-4 focus:ring-white transition-all
                         {screensaverSettings.timeout === opt.value ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-300 hover:bg-gray-700'}">
                  {opt.label}
                </button>
              {/each}
            </div>
          </div>

          <!-- Style: clock vs. art mode -->
          <div class="h-px bg-gray-700"></div>
          <div class="p-6">
            <span class="text-base text-gray-400 font-medium block mb-3">{i18n.t.screensaverStyle}</span>
            <div class="flex gap-3">
              {#each [['clock', i18n.t.screensaverModeClock, i18n.t.screensaverModeClockDesc], ['art', i18n.t.screensaverModeArt, i18n.t.screensaverModeArtDesc]] as [val, label, desc]}
                <button onclick={() => updateScreensaver({ mode: val })}
                  class="flex-1 text-left p-4 rounded-xl focus:outline-none focus:ring-4 focus:ring-white transition-all
                         {screensaverSettings.mode === val ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-300 hover:bg-gray-700'}">
                  <span class="block font-bold text-lg">{label}</span>
                  <span class="block text-sm mt-0.5 {screensaverSettings.mode === val ? 'text-blue-100' : 'text-gray-500'}">{desc}</span>
                </button>
              {/each}
            </div>
          </div>

          <!-- Backdrop source (only in art mode) -->
          {#if screensaverSettings.mode === 'art'}
            <div class="h-px bg-gray-700"></div>
            <div class="p-6">
              <span class="text-base text-gray-400 font-medium block mb-3">{i18n.t.screensaverArtSource}</span>
              <div class="flex gap-3">
                {#each [['watched', i18n.t.screensaverArtWatched], ['unwatched', i18n.t.screensaverArtUnwatched], ['random', i18n.t.screensaverArtRandom]] as [val, label]}
                  <button onclick={() => updateScreensaver({ artSource: val })}
                    class="flex-1 py-3 rounded-xl font-bold text-base focus:outline-none focus:ring-4 focus:ring-white transition-all
                           {screensaverSettings.artSource === val ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-300 hover:bg-gray-700'}">
                    {label}
                  </button>
                {/each}
              </div>
            </div>
            <!-- Brightness (art mode only) -->
            <div class="h-px bg-gray-700"></div>
            <div class="p-6">
              <span class="text-base text-gray-400 font-medium block mb-3">{i18n.t.screensaverBrightness}</span>
              <div class="flex gap-3">
                {#each [[0.45, i18n.t.brightnessDim], [0.65, i18n.t.brightnessMedium], [0.85, i18n.t.brightnessBright]] as [val, label]}
                  <button onclick={() => updateScreensaver({ brightness: val })}
                    class="flex-1 py-3 rounded-xl font-bold text-base focus:outline-none focus:ring-4 focus:ring-white transition-all
                           {screensaverSettings.brightness === val ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-300 hover:bg-gray-700'}">
                    {label}
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        {/if}

      </div>
    </section>
    {/if}

    <!-- ══════════════════════════════════════════
         PLAYBACK — default languages
    ══════════════════════════════════════════ -->
    {#if activeCategory === 'playback'}
    <section class="flex flex-col gap-4">
      <h2 class="text-xl font-bold text-gray-400 uppercase tracking-wider ml-2">{i18n.t.playback}</h2>
      <div class="bg-gray-800/80 border border-gray-700 rounded-2xl overflow-hidden shadow-xl">

        <!-- Default audio language -->
        <button onclick={() => openModal('audioLang')}
          class="flex items-center justify-between w-full p-6 hover:bg-gray-700 focus:bg-gray-700
                 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left first:rounded-t-2xl last:rounded-b-2xl">
          <span class="text-2xl text-white font-medium">{i18n.t.audioLanguage}</span>
          <span class="text-xl font-bold text-gray-300">{audioLangName}</span>
        </button>

        <div class="h-px bg-gray-700"></div>

        <!-- Remember audio track per series -->
        <button onclick={() => togglePlaybackPref('rememberAudioTrack')}
          class="flex items-center justify-between w-full p-6 hover:bg-gray-700 focus:bg-gray-700
                 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left first:rounded-t-2xl last:rounded-b-2xl">
          <div>
            <span class="text-2xl text-white font-medium block">{i18n.t.rememberAudioTrack}</span>
            <span class="text-gray-400 mt-1 block text-sm">{i18n.t.rememberAudioTrackDesc}</span>
          </div>
          <div class="w-16 h-8 rounded-full flex items-center p-1 transition-colors shrink-0
                      {playbackPrefs.rememberAudioTrack ? 'bg-blue-500' : 'bg-gray-600'}">
            <div class="bg-white w-6 h-6 rounded-full shadow-md transform transition-transform
                        {playbackPrefs.rememberAudioTrack ? 'translate-x-8' : ''}"></div>
          </div>
        </button>

        <div class="h-px bg-gray-700"></div>

        <!-- Jump distance of the forward/back buttons (stacked + flex-1 so it's reachable via D-pad) -->
        <div class="p-6">
          <span class="text-2xl text-white font-medium block">{i18n.t.seekInterval}</span>
          <span class="text-gray-400 mt-1 mb-4 block text-sm">{i18n.t.seekIntervalDesc}</span>
          <div class="flex gap-3">
            {#each [10, 30, 60] as sec}
              <button onclick={() => setSeekStep(sec)}
                class="flex-1 py-3 rounded-xl font-bold text-lg focus:outline-none focus:ring-4 focus:ring-white transition-all
                       {(displaySettings.seekStep || 30) === sec ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-300 hover:bg-gray-700'}">
                {sec}s
              </button>
            {/each}
          </div>
        </div>

        <div class="h-px bg-gray-700"></div>

        <!-- Show chapter markers in the Player (a Player display element → belongs to playback) -->
        <button onclick={() => toggleDisplay('showChapters')}
          class="flex items-center justify-between w-full p-6 hover:bg-gray-700 focus:bg-gray-700
                 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left">
          <div>
            <span class="text-2xl text-white font-medium block">{i18n.t.displayChapters}</span>
            <span class="text-gray-400 mt-1 block text-sm">{i18n.t.displayChaptersDesc}</span>
          </div>
          <div class="w-16 h-8 rounded-full flex items-center p-1 transition-colors shrink-0
                      {displaySettings.showChapters ? 'bg-blue-500' : 'bg-gray-600'}">
            <div class="bg-white w-6 h-6 rounded-full shadow-md transform transition-transform
                        {displaySettings.showChapters ? 'translate-x-8' : ''}"></div>
          </div>
        </button>

        <div class="h-px bg-gray-700"></div>

        <!-- Auto-Skip Intro -->
        <button onclick={() => togglePlaybackPref('autoSkipIntro')}
          class="flex items-center justify-between w-full p-6 hover:bg-gray-700 focus:bg-gray-700
                 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left first:rounded-t-2xl last:rounded-b-2xl">
          <div>
            <span class="text-2xl text-white font-medium block">{i18n.t.autoSkipIntro}</span>
            <span class="text-gray-400 mt-1 block text-sm">{i18n.t.autoSkipDesc}</span>
          </div>
          <div class="w-16 h-8 rounded-full flex items-center p-1 transition-colors shrink-0
                      {playbackPrefs.autoSkipIntro ? 'bg-blue-500' : 'bg-gray-600'}">
            <div class="bg-white w-6 h-6 rounded-full shadow-md transform transition-transform
                        {playbackPrefs.autoSkipIntro ? 'translate-x-8' : ''}"></div>
          </div>
        </button>

        <div class="h-px bg-gray-700"></div>

        <!-- Auto-Skip Outro -->
        <button onclick={() => togglePlaybackPref('autoSkipCredits')}
          class="flex items-center justify-between w-full p-6 hover:bg-gray-700 focus:bg-gray-700
                 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left first:rounded-t-2xl last:rounded-b-2xl">
          <div>
            <span class="text-2xl text-white font-medium block">{i18n.t.autoSkipOutro}</span>
            <span class="text-gray-400 mt-1 block text-sm">{i18n.t.autoSkipOutroDesc}</span>
          </div>
          <div class="w-16 h-8 rounded-full flex items-center p-1 transition-colors shrink-0
                      {playbackPrefs.autoSkipCredits ? 'bg-blue-500' : 'bg-gray-600'}">
            <div class="bg-white w-6 h-6 rounded-full shadow-md transform transition-transform
                        {playbackPrefs.autoSkipCredits ? 'translate-x-8' : ''}"></div>
          </div>
        </button>

        <!-- Next episode automatically -->
        <button onclick={() => togglePlaybackPref('autoPlayNext')}
          class="flex items-center justify-between w-full p-6 hover:bg-gray-700 focus:bg-gray-700
                 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left first:rounded-t-2xl last:rounded-b-2xl">
          <div>
            <span class="text-2xl text-white font-medium block">{i18n.t.autoPlayNext}</span>
            <span class="text-gray-400 mt-1 block text-sm">{i18n.t.autoPlayNextDesc}</span>
          </div>
          <div class="w-16 h-8 rounded-full flex items-center p-1 transition-colors shrink-0
                      {playbackPrefs.autoPlayNext ? 'bg-blue-500' : 'bg-gray-600'}">
            <div class="bg-white w-6 h-6 rounded-full shadow-md transform transition-transform
                        {playbackPrefs.autoPlayNext ? 'translate-x-8' : ''}"></div>
          </div>
        </button>

        <!-- Playback info – unlock the info button in the Player (live details as an overlay) -->
        <button onclick={() => togglePlaybackPref('showPlaybackInfo')}
          class="flex items-center justify-between w-full p-6 border-t border-gray-700/50 hover:bg-gray-700 focus:bg-gray-700
                 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left first:rounded-t-2xl last:rounded-b-2xl">
          <div>
            <span class="text-2xl text-white font-medium block">{i18n.t.playbackInfo}</span>
            <span class="text-gray-400 mt-1 block text-sm">{i18n.t.playbackInfoDesc}</span>
          </div>
          <div class="w-16 h-8 rounded-full flex items-center p-1 transition-colors shrink-0
                      {playbackPrefs.showPlaybackInfo ? 'bg-blue-500' : 'bg-gray-600'}">
            <div class="bg-white w-6 h-6 rounded-full shadow-md transform transition-transform
                        {playbackPrefs.showPlaybackInfo ? 'translate-x-8' : ''}"></div>
          </div>
        </button>

        <!-- Only-this-episode – unlock the sleep button in the Player (stops auto-play after the episode) -->
        <button onclick={() => togglePlaybackPref('sleepButton')}
          class="flex items-center justify-between w-full p-6 border-t border-gray-700/50 hover:bg-gray-700 focus:bg-gray-700
                 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left first:rounded-t-2xl last:rounded-b-2xl">
          <div>
            <span class="text-2xl text-white font-medium block">{i18n.t.sleepButton}</span>
            <span class="text-gray-400 mt-1 block text-sm">{i18n.t.sleepButtonDesc}</span>
          </div>
          <div class="w-16 h-8 rounded-full flex items-center p-1 transition-colors shrink-0
                      {playbackPrefs.sleepButton ? 'bg-blue-500' : 'bg-gray-600'}">
            <div class="bg-white w-6 h-6 rounded-full shadow-md transform transition-transform
                        {playbackPrefs.sleepButton ? 'translate-x-8' : ''}"></div>
          </div>
        </button>

        <!-- Preview images while seeking (Trickplay) – opt-out, falls back to chapters/time -->
        <button onclick={() => togglePlaybackPref('trickplay')}
          class="flex items-center justify-between w-full p-6 border-t border-gray-700/50 hover:bg-gray-700 focus:bg-gray-700
                 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left first:rounded-t-2xl last:rounded-b-2xl">
          <div>
            <span class="text-2xl text-white font-medium block">{i18n.t.trickplay}</span>
            <span class="text-gray-400 mt-1 block text-sm">{i18n.t.trickplayDesc}</span>
          </div>
          <div class="w-16 h-8 rounded-full flex items-center p-1 transition-colors shrink-0
                      {playbackPrefs.trickplay !== false ? 'bg-blue-500' : 'bg-gray-600'}">
            <div class="bg-white w-6 h-6 rounded-full shadow-md transform transition-transform
                        {playbackPrefs.trickplay !== false ? 'translate-x-8' : ''}"></div>
          </div>
        </button>

        <!-- Still watching? – pause playback after inactivity -->
        <button onclick={() => togglePlaybackPref('stillWatching')}
          class="flex items-center justify-between w-full p-6 border-t border-gray-700/50 hover:bg-gray-700 focus:bg-gray-700
                 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left first:rounded-t-2xl last:rounded-b-2xl">
          <div>
            <span class="text-2xl text-white font-medium block">{i18n.t.stillWatching}</span>
            <span class="text-gray-400 mt-1 block text-sm">{i18n.t.stillWatchingDesc}</span>
          </div>
          <div class="w-16 h-8 rounded-full flex items-center p-1 transition-colors shrink-0
                      {playbackPrefs.stillWatching ? 'bg-blue-500' : 'bg-gray-600'}">
            <div class="bg-white w-6 h-6 rounded-full shadow-md transform transition-transform
                        {playbackPrefs.stillWatching ? 'translate-x-8' : ''}"></div>
          </div>
        </button>

        {#if playbackPrefs.stillWatching}
          <div class="p-6 border-t border-gray-700/50 last:rounded-b-2xl">
            <span class="text-2xl text-white font-medium block">{i18n.t.stillWatchingAfter}</span>
            <div class="flex gap-3 mt-4">
              {#each [2, 3, 4] as n}
                <button onclick={() => setStillWatchingEpisodes(n)}
                  class="flex-1 py-3 rounded-xl font-bold text-lg focus:outline-none focus:ring-4 focus:ring-white transition-all
                         {(playbackPrefs.stillWatchingEpisodes || 3) === n ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-300 hover:bg-gray-700'}">
                  {n} {i18n.t.episodes}
                </button>
              {/each}
            </div>
          </div>
        {/if}

        <div class="h-px bg-gray-700"></div>

        <!-- Theme music on the details page (opt-in). Scope + volume only show while enabled. -->
        <button onclick={() => togglePlaybackPref('themeMusic')}
          class="flex items-center justify-between w-full p-6 hover:bg-gray-700 focus:bg-gray-700
                 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left first:rounded-t-2xl last:rounded-b-2xl">
          <div>
            <span class="text-2xl text-white font-medium block">{i18n.t.themeMusic}</span>
            <span class="text-gray-400 mt-1 block text-sm">{i18n.t.themeMusicDesc}</span>
          </div>
          <div class="w-16 h-8 rounded-full flex items-center p-1 transition-colors shrink-0
                      {playbackPrefs.themeMusic ? 'bg-blue-500' : 'bg-gray-600'}">
            <div class="bg-white w-6 h-6 rounded-full shadow-md transform transition-transform
                        {playbackPrefs.themeMusic ? 'translate-x-8' : ''}"></div>
          </div>
        </button>

        {#if playbackPrefs.themeMusic}
          <div class="p-6 pt-2 pb-0">
            <div class="flex gap-3">
              {#each [['both', i18n.t.themeMusicBoth], ['movies', i18n.t.movies], ['series', i18n.t.series]] as [key, label]}
                <button onclick={() => setThemeScope(key)}
                  class="flex-1 py-3 rounded-xl font-bold text-lg focus:outline-none focus:ring-4 focus:ring-white transition-all
                         {(playbackPrefs.themeMusicScope || 'both') === key ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-300 hover:bg-gray-700'}">
                  {label}
                </button>
              {/each}
            </div>
          </div>
          <!-- Volume as a regular settings row: label left, control right — matching the toggle rows. -->
          <div class="flex items-center justify-between w-full p-6">
            <span class="text-2xl text-white font-medium">{i18n.t.themeMusicVolume}</span>
            <div class="flex items-center gap-3 shrink-0">
              <button onclick={() => stepThemeVolume(-5)}
                class="w-14 h-12 rounded-xl font-bold text-2xl bg-gray-900 text-gray-300 hover:bg-gray-700
                       focus:outline-none focus:ring-4 focus:ring-white transition-all">&minus;</button>
              <span class="text-xl font-bold text-gray-300 w-20 text-center tabular-nums">{playbackPrefs.themeMusicVolume ?? 40}&nbsp;%</span>
              <button onclick={() => stepThemeVolume(5)}
                class="w-14 h-12 rounded-xl font-bold text-2xl bg-gray-900 text-gray-300 hover:bg-gray-700
                       focus:outline-none focus:ring-4 focus:ring-white transition-all">+</button>
            </div>
          </div>
        {/if}

      </div>
    </section>
    {/if}

    {#if activeCategory === 'subtitles'}
    <section class="flex flex-col gap-4">
      <h2 class="text-xl font-bold text-gray-400 uppercase tracking-wider ml-2">{i18n.t.subtitles}</h2>
      <div class="bg-gray-800/80 border border-gray-700 rounded-2xl overflow-hidden shadow-xl">

        <!-- Default subtitle: which track is chosen automatically -->
        <button onclick={() => openModal('subtitleLang')}
          class="flex items-center justify-between w-full p-6 hover:bg-gray-700 focus:bg-gray-700
                 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left first:rounded-t-2xl">
          <span class="text-2xl text-white font-medium">{i18n.t.subtitleLanguage}</span>
          <span class="text-xl font-bold text-gray-300">{subtitleLangName}</span>
        </button>

        <!-- Remember subtitle track per series -->
        <button onclick={() => togglePlaybackPref('rememberSubtitleTrack')}
          class="flex items-center justify-between w-full p-6 border-t border-gray-700/50 hover:bg-gray-700 focus:bg-gray-700
                 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left">
          <div>
            <span class="text-2xl text-white font-medium block">{i18n.t.rememberSubtitleTrack}</span>
            <span class="text-gray-400 mt-1 block text-sm">{i18n.t.rememberSubtitleTrackDesc}</span>
          </div>
          <div class="w-16 h-8 rounded-full flex items-center p-1 transition-colors shrink-0
                      {playbackPrefs.rememberSubtitleTrack ? 'bg-blue-500' : 'bg-gray-600'}">
            <div class="bg-white w-6 h-6 rounded-full shadow-md transform transition-transform
                        {playbackPrefs.rememberSubtitleTrack ? 'translate-x-8' : ''}"></div>
          </div>
        </button>

        <!-- Automatically choose forced/default GRAPHIC subtitles (DVDSUB) — needs transcode (no Direct Play).
             Text and PGS subtitles are chosen automatically without a transcode anyway. -->
        <button onclick={() => togglePlaybackPref('forcedGraphicSubs')}
          class="flex items-center justify-between w-full p-6 border-t border-gray-700/50 hover:bg-gray-700 focus:bg-gray-700
                 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left first:rounded-t-2xl last:rounded-b-2xl">
          <div>
            <span class="text-2xl text-white font-medium block">{i18n.t.forcedGraphicSubs}</span>
            <span class="text-gray-400 mt-1 block text-sm">{i18n.t.forcedGraphicSubsDesc}</span>
          </div>
          <div class="w-16 h-8 rounded-full flex items-center p-1 transition-colors shrink-0
                      {playbackPrefs.forcedGraphicSubs ? 'bg-blue-500' : 'bg-gray-600'}">
            <div class="bg-white w-6 h-6 rounded-full shadow-md transform transition-transform
                        {playbackPrefs.forcedGraphicSubs ? 'translate-x-8' : ''}"></div>
          </div>
        </button>

        <!-- Burn in subtitles -->
        <button onclick={() => togglePlaybackPref('burnSubtitles')}
          class="flex items-center justify-between w-full p-6 border-t border-gray-700/50 hover:bg-gray-700 focus:bg-gray-700
                 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left first:rounded-t-2xl last:rounded-b-2xl">
          <div>
            <span class="text-2xl text-white font-medium block">{i18n.t.burnSubtitles}</span>
            <span class="text-gray-400 mt-1 block text-sm">{i18n.t.burnSubtitlesDesc}</span>
          </div>
          <div class="w-16 h-8 rounded-full flex items-center p-1 transition-colors shrink-0
                      {playbackPrefs.burnSubtitles ? 'bg-blue-500' : 'bg-gray-600'}">
            <div class="bg-white w-6 h-6 rounded-full shadow-md transform transition-transform
                        {playbackPrefs.burnSubtitles ? 'translate-x-8' : ''}"></div>
          </div>
        </button>

        <!-- PGS rendering + subtitle size are irrelevant when everything is burned in → then hide them -->
        {#if !playbackPrefs.burnSubtitles}
          <button onclick={() => togglePlaybackPref('pgsRendering')}
            class="flex items-center justify-between w-full p-6 border-t border-gray-700/50 hover:bg-gray-700 focus:bg-gray-700
                   focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left first:rounded-t-2xl last:rounded-b-2xl">
            <div>
              <span class="text-2xl text-white font-medium block">{i18n.t.pgsRendering}</span>
              <span class="text-gray-400 mt-1 block text-sm">{i18n.t.pgsRenderingDesc}</span>
            </div>
            <div class="w-16 h-8 rounded-full flex items-center p-1 transition-colors shrink-0
                        {playbackPrefs.pgsRendering ? 'bg-blue-500' : 'bg-gray-600'}">
              <div class="bg-white w-6 h-6 rounded-full shadow-md transform transition-transform
                          {playbackPrefs.pgsRendering ? 'translate-x-8' : ''}"></div>
            </div>
          </button>

          <!-- ASS/SSA with original layout (assjs) — off: plain text overlay, both Direct Play -->
          <button onclick={() => togglePlaybackPref('assRendering')}
            class="flex items-center justify-between w-full p-6 border-t border-gray-700/50 hover:bg-gray-700 focus:bg-gray-700
                   focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left first:rounded-t-2xl last:rounded-b-2xl">
            <div>
              <span class="text-2xl text-white font-medium block">{i18n.t.assRendering}</span>
              <span class="text-gray-400 mt-1 block text-sm">{i18n.t.assRenderingDesc}</span>
            </div>
            <div class="w-16 h-8 rounded-full flex items-center p-1 transition-colors shrink-0
                        {playbackPrefs.assRendering ? 'bg-blue-500' : 'bg-gray-600'}">
              <div class="bg-white w-6 h-6 rounded-full shadow-md transform transition-transform
                          {playbackPrefs.assRendering ? 'translate-x-8' : ''}"></div>
            </div>
          </button>

          <div class="p-6 border-t border-gray-700/50 last:rounded-b-2xl">
            <span class="text-2xl text-white font-medium block">{i18n.t.subtitleSize}</span>
            <span class="text-gray-400 mt-1 mb-4 block text-sm">{i18n.t.subtitleSizeDesc}</span>
            <div class="flex gap-3">
              {#each [['small', i18n.t.sizeSmall], ['normal', i18n.t.sizeNormal], ['large', i18n.t.sizeLarge]] as [val, label]}
                <button onclick={() => setSubtitleSize(val)}
                  class="flex-1 py-3 rounded-xl font-bold text-lg focus:outline-none focus:ring-4 focus:ring-white transition-all
                         {playbackPrefs.subtitleSize === val ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-300 hover:bg-gray-700'}">
                  {label}
                </button>
              {/each}
            </div>
          </div>

          <!-- VTT font — text subtitles only, deliberately separate from the UI font (appearance).
               Buttons show themselves in their own font (preview); Tinos = serif, selectable only here. -->
          <div class="p-6 border-t border-gray-700/50 last:rounded-b-2xl">
            <span class="text-2xl text-white font-medium block">{i18n.t.subtitleFont}</span>
            <span class="text-gray-400 mt-1 mb-4 block text-sm">{i18n.t.subtitleFontDesc}</span>
            <div class="flex gap-3">
              {#each [['system', i18n.t.fontSystem, ''], ['arimo', 'Arimo', "'Arimo', sans-serif"], ['noto', 'Noto Sans', "'Noto Sans', sans-serif"], ['tinos', 'Tinos', "'Tinos', serif"]] as [val, label, fam]}
                <button onclick={() => setSubtitlePref('subtitleFont', val)}
                  class="flex-1 py-3 rounded-xl font-bold text-lg focus:outline-none focus:ring-4 focus:ring-white transition-all
                         {(playbackPrefs.subtitleFont || 'system') === val ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-300 hover:bg-gray-700'}"
                  style={fam ? `font-family: ${fam}` : ''}>
                  {label}
                </button>
              {/each}
            </div>
          </div>

          <!-- Text subtitle styling (color/edge/background) — only WebVTT/SRT, not PGS/VobSub -->
          <div class="p-6 border-t border-gray-700/50 last:rounded-b-2xl">
            <span class="text-2xl text-white font-medium block">{i18n.t.subtitleColor}</span>
            <span class="text-gray-400 mt-1 mb-4 block text-sm">{i18n.t.subtitleStyleHint}</span>
            <div class="flex gap-3">
              {#each [['white', i18n.t.colorWhite], ['yellow', i18n.t.colorYellow], ['green', i18n.t.colorGreen], ['cyan', i18n.t.colorCyan]] as [val, label]}
                <button onclick={() => setSubtitlePref('subtitleColor', val)}
                  class="flex-1 py-3 rounded-xl font-bold text-lg focus:outline-none focus:ring-4 focus:ring-white transition-all
                         {(playbackPrefs.subtitleColor || 'white') === val ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-300 hover:bg-gray-700'}">
                  {label}
                </button>
              {/each}
            </div>
          </div>

          <div class="p-6 border-t border-gray-700/50 last:rounded-b-2xl">
            <span class="text-2xl text-white font-medium block mb-4">{i18n.t.subtitleEdge}</span>
            <div class="flex gap-3">
              {#each [['none', i18n.t.styleNone], ['shadow', i18n.t.edgeShadow], ['outline', i18n.t.edgeOutline]] as [val, label]}
                <button onclick={() => setSubtitlePref('subtitleEdge', val)}
                  class="flex-1 py-3 rounded-xl font-bold text-lg focus:outline-none focus:ring-4 focus:ring-white transition-all
                         {(playbackPrefs.subtitleEdge || 'shadow') === val ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-300 hover:bg-gray-700'}">
                  {label}
                </button>
              {/each}
            </div>
          </div>

          <div class="p-6 border-t border-gray-700/50 last:rounded-b-2xl">
            <span class="text-2xl text-white font-medium block mb-4">{i18n.t.subtitleBackground}</span>
            <div class="flex gap-3">
              {#each [['none', i18n.t.styleNone], ['semi', i18n.t.bgSemi], ['solid', i18n.t.bgSolid]] as [val, label]}
                <button onclick={() => setSubtitlePref('subtitleBackground', val)}
                  class="flex-1 py-3 rounded-xl font-bold text-lg focus:outline-none focus:ring-4 focus:ring-white transition-all
                         {(playbackPrefs.subtitleBackground || 'none') === val ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-300 hover:bg-gray-700'}">
                  {label}
                </button>
              {/each}
            </div>
          </div>
        {/if}

      </div>
    </section>
    {/if}

    {#if activeCategory === 'security'}
    <section class="flex flex-col gap-4">
      <h2 class="text-xl font-bold text-gray-400 uppercase tracking-wider ml-2">{i18n.t.profileSecurity}</h2>

      <!-- Profile picture: preset avatar + background color, uploaded as the Jellyfin profile picture -->
      <div class="bg-gray-800/80 border border-gray-700 rounded-2xl p-6 shadow-xl flex flex-col gap-5">
        <div class="flex items-center gap-5">
          <div class="w-20 h-20 rounded-full overflow-hidden flex items-center justify-center shrink-0 shadow-md" style="background:{(hasEditedAvatar && avatarTab === 'recent' && avatarPoster) || (!hasEditedAvatar && selectedUser?.PrimaryImageTag) ? 'transparent' : effectiveColor}">
            <!-- Mirrors EXACTLY the save condition (avatarTab + avatarPoster): preview = what would be saved -->
            {#if hasEditedAvatar && avatarTab === 'recent' && avatarPoster}
              <img src={avatarPoster.imageUrl} alt={avatarPoster.name} class="w-full h-full object-cover" />
            {:else if !hasEditedAvatar && selectedUser?.PrimaryImageTag}
              <img src="{session.serverUrl}/Users/{selectedUser.Id}/Images/Primary?tag={selectedUser.PrimaryImageTag}&fillWidth=160&fillHeight=160&quality=90&format=webp" alt={i18n.t.profilePicture} class="w-full h-full object-cover" />
            {:else}
              <svg class="w-11 h-11 text-white" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d={AVATAR_ICONS[effectiveIcon]}/></svg>
            {/if}
          </div>
          <div class="flex-1">
            <span class="text-2xl text-white font-medium block">{i18n.t.profilePicture}</span>
            <span class="text-gray-400 mt-1 block text-sm">{i18n.t.profilePictureHint}</span>
          </div>
          <div class="flex gap-3 shrink-0">
            <button onclick={openAvatarModal}
              class="px-5 py-3 rounded-xl font-bold text-base bg-gray-700 text-white hover:bg-gray-600 focus:outline-none focus:ring-4 focus:ring-white transition-colors">
              {i18n.t.customize}
            </button>
            <button onclick={saveProfileImage} disabled={!hasEditedAvatar}
              class="px-6 py-3 rounded-xl font-bold text-base focus:outline-none focus:ring-4 focus:ring-white transition-colors
                     {avatarSaved ? 'bg-green-600 text-white' : 'bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50'}">
              {avatarSaved ? i18n.t.saved : avatarSaving ? i18n.t.saving : i18n.t.save}
            </button>
          </div>
        </div>
      </div>

      <!-- "Customize" modal: live preview + icon grid + color swatches (padding p-2 → focus rings at the edge not cut off) -->
      {#if avatarModalOpen}
        <div class="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-8"
             data-focus-trap onkeydown={onAvatarModalKey} role="dialog" tabindex="-1">
          <div class="bg-gray-800 border border-gray-700 rounded-2xl p-6 shadow-2xl max-w-2xl w-full flex flex-col gap-5">
            <div class="flex justify-between items-center">
              <h3 class="text-2xl font-bold text-white">{i18n.t.profilePicture}</h3>
              <button onclick={() => avatarModalOpen = false} {@attach focusOnMount()} aria-label={i18n.t.close} class="text-gray-400 hover:text-white focus:text-white focus:outline-none focus:ring-2 focus:ring-white rounded-lg p-1">
                <svg class="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/></svg>
              </button>
            </div>
            <!-- Toggle: recently watched titles ↔ symbols -->
            <div class="flex gap-2 bg-gray-900/60 p-1 rounded-xl">
              <button onclick={() => avatarTab = 'recent'}
                class="flex-1 py-2.5 rounded-lg font-bold text-sm focus:outline-none focus:ring-4 focus:ring-white transition-colors
                       {avatarTab === 'recent' ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-700'}">
                {i18n.t.avatarTabRecent}
              </button>
              <button onclick={() => avatarTab = 'symbols'}
                class="flex-1 py-2.5 rounded-lg font-bold text-sm focus:outline-none focus:ring-4 focus:ring-white transition-colors
                       {avatarTab === 'symbols' ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-700'}">
                {i18n.t.avatarTabSymbols}
              </button>
            </div>
            <!-- Live preview -->
            <div class="flex justify-center">
              <div class="w-24 h-24 rounded-full overflow-hidden flex items-center justify-center shadow-md"
                   style="background:{(avatarTab === 'recent' && avatarPoster) ? 'transparent' : effectiveColor}">
                {#if avatarTab === 'recent' && avatarPoster}
                  <img src={avatarPoster.imageUrl} alt={avatarPoster.name} class="w-full h-full object-cover" />
                {:else}
                  <svg class="w-12 h-12 text-white" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d={AVATAR_ICONS[effectiveIcon]}/></svg>
                {/if}
              </div>
            </div>

            {#if avatarTab === 'recent'}
              {#if recentLoading}
                <div class="flex justify-center py-10">
                  <div class="w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full animate-spin"></div>
                </div>
              {:else if recentTitles.length}
                <!-- Posters of recently watched titles (newest first), cropped centered into the round avatar -->
                <div class="grid grid-cols-6 gap-3 max-h-[42vh] overflow-y-auto hide-scrollbar p-2 scroll-py-3 content-start">
                  {#each recentTitles as t (t.id)}
                    <button onclick={() => { avatarPoster = t; hasEditedAvatar = true; }} title={t.name}
                      class="aspect-square rounded-xl overflow-hidden focus:outline-none focus:ring-4 focus:ring-white transition-all
                             {avatarPoster?.id === t.id ? 'ring-4 ring-blue-500' : 'hover:opacity-80'}">
                      <img src={t.imageUrl} alt={t.name} class="w-full h-full object-cover" loading="lazy" decoding="async" />
                    </button>
                  {/each}
                </div>
              {:else}
                <div class="text-center text-gray-400 py-10 px-4">{i18n.t.avatarRecentEmpty}</div>
              {/if}
            {:else}
              <!-- Icons on the left (full rows of 6) · colors on the right as a narrow 2-column strip → reachable
                   via the D-pad with a single Right press, without navigating through all icon rows. -->
              <div class="flex gap-5 items-start">
                <div class="grid grid-cols-6 gap-3 flex-1 max-h-[42vh] overflow-y-auto hide-scrollbar p-2 scroll-py-3 content-start">
                  {#each AVATAR_ICON_KEYS as key}
                    <button onclick={() => { avatarIcon = key; hasEditedAvatar = true; }} aria-label={key}
                      class="aspect-square flex items-center justify-center rounded-xl focus:outline-none focus:ring-4 focus:ring-white transition-all
                             {effectiveIcon === key ? 'bg-blue-600' : 'bg-gray-700 hover:bg-gray-600'}">
                      <svg class="w-7 h-7 text-white" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d={AVATAR_ICONS[key]}/></svg>
                    </button>
                  {/each}
                </div>
                <div class="grid grid-cols-2 gap-2.5 shrink-0 p-2 content-start">
                  {#each AVATAR_COLORS as color}
                    <button onclick={() => { avatarColor = color; hasEditedAvatar = true; }}
                      class="w-10 h-10 rounded-full focus:outline-none focus:ring-4 focus:ring-white transition-all {effectiveColor === color ? 'ring-2 ring-white scale-110' : ''}"
                      style="background:{color}" aria-label={i18n.t.customize}></button>
                  {/each}
                </div>
              </div>
            {/if}
            <button onclick={() => avatarModalOpen = false}
              class="w-full py-3 rounded-xl font-bold text-base bg-blue-600 text-white hover:bg-blue-500 focus:outline-none focus:ring-4 focus:ring-white transition-colors">
              {i18n.t.close}
            </button>
          </div>
        </div>
      {/if}

      <div class="bg-gray-800/80 border border-gray-700 rounded-2xl overflow-hidden shadow-xl">

        <!-- Save password / quick switch (formerly its own "Profile" category) -->
        <button onclick={() => onToggleSave?.()}
          class="flex items-center justify-between w-full p-6 hover:bg-gray-700 focus:bg-gray-700
                 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left first:rounded-t-2xl last:rounded-b-2xl">
          <div>
            <span class="text-2xl text-white font-medium block">{i18n.t.savePasswords}</span>
            <span class="text-gray-400 mt-1 block text-sm">{i18n.t.fastSwitchDesc}</span>
          </div>
          <div class="w-16 h-8 rounded-full flex items-center p-1 transition-colors shrink-0
                      {isCurrentUserSaved ? 'bg-blue-500' : 'bg-gray-600'}">
            <div class="bg-white w-6 h-6 rounded-full shadow-md transform transition-transform
                        {isCurrentUserSaved ? 'translate-x-8' : ''}"></div>
          </div>
        </button>

        <div class="h-px bg-gray-700"></div>

        <!-- Change password -->
        <button onclick={() => openModal('password')}
          class="flex items-center justify-between w-full p-6 hover:bg-gray-700 focus:bg-gray-700
                 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left first:rounded-t-2xl last:rounded-b-2xl">
          <div>
            <span class="text-2xl text-white font-medium block">{i18n.t.changePassword}</span>
            <span class="text-gray-400 mt-1 block text-sm">{i18n.t.changePwDesc}</span>
          </div>
          <svg class="w-7 h-7 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
          </svg>
        </button>

        <div class="h-px bg-gray-700"></div>

        <!-- Quick Connect (authorize a device) -->
        <button onclick={() => openModal('quickConnect')}
          class="flex items-center justify-between w-full p-6 hover:bg-gray-700 focus:bg-gray-700
                 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left first:rounded-t-2xl last:rounded-b-2xl">
          <div>
            <span class="text-2xl text-white font-medium block">{i18n.t.quickConnect}</span>
            <span class="text-gray-400 mt-1 block text-sm">{i18n.t.qcDesc}</span>
          </div>
          <svg class="w-7 h-7 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
          </svg>
        </button>

      </div>

      <!-- Watch together: merge two profiles -->
      <div class="bg-gray-800/80 border border-gray-700 rounded-2xl overflow-hidden shadow-xl">
        <button onclick={onSharedToggle}
          class="flex items-center justify-between w-full p-6 hover:bg-gray-700 focus:bg-gray-700
                 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left first:rounded-t-2xl last:rounded-b-2xl">
          <div>
            <span class="text-2xl text-white font-medium block">{i18n.t.sharedWatching}</span>
            <span class="text-gray-400 mt-1 block text-sm">{i18n.t.sharedWatchingDesc}</span>
          </div>
          <div class="w-16 h-8 rounded-full flex items-center p-1 transition-colors shrink-0
                      {sharedProfile.enabled ? 'bg-blue-500' : 'bg-gray-600'}">
            <div class="bg-white w-6 h-6 rounded-full shadow-md transform transition-transform
                        {sharedProfile.enabled ? 'translate-x-8' : ''}"></div>
          </div>
        </button>

        {#if sharedProfile.enabled}
          <div class="h-px bg-gray-700"></div>
          <div class="p-6 flex flex-col gap-4">
            <span class="text-gray-400 text-sm">{i18n.t.sharedWatchingPick}</span>
            <div class="grid grid-cols-2 gap-4">
              {#each [0, 1] as slot}
                {@const m = sharedMembers[slot]}
                <div class="bg-gray-900/60 border border-gray-700 rounded-xl p-4 flex flex-col items-center justify-center gap-2 min-h-[8rem]">
                  {#if m}
                    <span class="text-white font-bold text-lg text-center break-words">{m.name}</span>
                    {#if sharedTokens[selectedServer?.id]?.[m.id] || savedTokens[selectedServer?.id]?.[m.id]}
                      <span class="text-green-400 text-xs font-bold">{i18n.t.sharedMemberReady}</span>
                    {:else}
                      <span class="text-amber-400 text-xs font-bold">{i18n.t.sharedNeedsLogin}</span>
                    {/if}
                    <button data-slot-btn={slot} onclick={() => removeMember(slot)}
                      class="mt-1 text-red-400 hover:text-red-300 focus:text-red-300 text-sm font-bold
                             focus:outline-none focus:ring-2 focus:ring-white rounded px-3 py-1.5">
                      {i18n.t.remove}
                    </button>
                  {:else}
                    <button data-slot-btn={slot} onclick={() => openSharedPicker(slot)}
                      class="flex flex-col items-center gap-2 text-gray-400 hover:text-white focus:text-white
                             focus:outline-none focus:ring-4 focus:ring-white rounded-lg px-4 py-3">
                      <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
                      </svg>
                      <span class="text-sm font-bold">{i18n.t.selectProfile}</span>
                    </button>
                  {/if}
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </section>
    {/if}

    <!-- ══════════════════════════════════════════
         5. ACCOUNT & SERVER
    ══════════════════════════════════════════ -->
    {#if activeCategory === 'account'}
    <section class="flex flex-col gap-4">
      <h2 class="text-xl font-bold text-gray-400 uppercase tracking-wider ml-2">{i18n.t.settingsAccount}</h2>

      <!-- Server info -->
      {#if selectedServer}
        <div class="bg-gray-800/80 border border-gray-700 rounded-2xl p-5">
          <p class="text-xs text-gray-500 uppercase tracking-wider font-bold mb-1">{i18n.t.connectedServer}</p>
          <p class="text-xl text-white font-bold">{selectedServer.name}</p>
          <p class="text-gray-400 mt-0.5 text-sm font-mono">{selectedServer.url}{#if selectedServer.url?.startsWith('http://')}<span title={i18n.t.insecureHttpHint} class="ml-2 inline-block px-1.5 py-0.5 rounded bg-yellow-900/70 text-yellow-300 text-[0.65rem] font-bold align-middle font-sans">HTTP</span>{/if}</p>
        </div>
      {/if}

      <!-- Clear cache (directly below the server address) -->
      <button onclick={() => onClearCache?.()}
        class="bg-gray-800/80 border border-gray-700 rounded-2xl shadow-xl flex items-center justify-between w-full p-6
               hover:bg-gray-700 focus:bg-gray-700 focus:outline-none focus:ring-4 focus:ring-white transition-all text-left">
        <div>
          <span class="text-xl text-white font-bold block">{i18n.t.clearCache}</span>
          <span class="text-gray-400 mt-1 block text-sm">{i18n.t.clearCacheDesc}</span>
        </div>
        <svg class="w-7 h-7 text-gray-400 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
        </svg>
      </button>

      <!-- Switch user / sign out -->
      <div class="grid grid-cols-2 gap-5">
        <button onclick={() => onSwitchUser?.()}
          class="flex flex-col items-center justify-center p-7 bg-gray-800 border border-gray-700 rounded-2xl
                 hover:bg-gray-700 hover:scale-105 focus:scale-105
                 focus:outline-none focus:ring-4 focus:ring-white transition-all shadow-xl">
          <svg class="w-11 h-11 text-white mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7"/>
          </svg>
          <span class="text-xl text-white font-bold">{i18n.t.switchUser}</span>
          <span class="text-gray-400 mt-1 text-center text-sm">{i18n.t.switchUserDesc}</span>
        </button>

        <button onclick={() => onLogout?.()}
          class="flex flex-col items-center justify-center p-7 bg-red-900/40 border border-red-800/50 rounded-2xl
                 hover:bg-red-600 focus:bg-red-600 focus:scale-105
                 focus:outline-none focus:ring-4 focus:ring-white transition-all shadow-xl group">
          <svg class="w-11 h-11 text-red-500 group-hover:text-white group-focus:text-white mb-3 transition-colors"
            fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
              d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
          </svg>
          <span class="text-xl text-white font-bold">{i18n.t.logout}</span>
          <span class="text-red-300 group-hover:text-red-100 group-focus:text-red-100 mt-1 text-center text-sm transition-colors">
            {i18n.t.logoutDesc}
          </span>
        </button>
      </div>

    </section>
    {/if}

    <!-- ══════════════════════════════════════════
         STATUS / LOGS — diagnostics
    ══════════════════════════════════════════ -->
    {#if activeCategory === 'status'}
    <section class="flex flex-col gap-4">
      <h2 class="text-xl font-bold text-gray-400 uppercase tracking-wider ml-2">{i18n.t.statusSection}</h2>

      <!-- Diagnostic logging toggle (device-wide, opt-in) -->
      <div class="bg-gray-800/80 border border-gray-700 rounded-2xl overflow-hidden shadow-xl">
        <button onclick={toggleDebugLogging}
          class="flex items-center justify-between w-full px-6 py-5 hover:bg-gray-700 focus:bg-gray-700
                 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left rounded-2xl">
          <div class="pr-4">
            <span class="text-2xl text-white font-medium block">{i18n.t.debugLogging}</span>
            <span class="text-gray-400 mt-0.5 block text-sm">{i18n.t.debugLoggingDesc}</span>
          </div>
          <div class="w-16 h-8 rounded-full flex items-center p-1 transition-colors shrink-0
                      {debugLogging ? 'bg-blue-500' : 'bg-gray-600'}">
            <div class="bg-white w-6 h-6 rounded-full shadow-md transform transition-transform
                        {debugLogging ? 'translate-x-8' : ''}"></div>
          </div>
        </button>
      </div>

      <!-- Show log: in-app log viewer (no ares inspect needed) -->
      <button onclick={openLog}
        class="flex items-center justify-between w-full px-6 py-5 bg-gray-800/80 border border-gray-700 rounded-2xl
               hover:bg-gray-700 focus:bg-gray-700 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left">
        <div class="pr-4">
          <span class="text-2xl text-white font-medium block">{i18n.t.logShow}</span>
          <span class="text-gray-400 mt-0.5 block text-sm">{i18n.t.logShowDesc}</span>
        </div>
        <svg class="w-7 h-7 text-gray-400 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
      </button>

      <!-- Help / FAQ: QR to the wiki (scan with a phone) -->
      <button onclick={openWikiQr}
        class="flex items-center justify-between w-full px-6 py-5 bg-gray-800/80 border border-gray-700 rounded-2xl
               hover:bg-gray-700 focus:bg-gray-700 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-all text-left">
        <div class="pr-4">
          <span class="text-2xl text-white font-medium block">{i18n.t.helpFaq}</span>
          <span class="text-gray-400 mt-0.5 block text-sm">{i18n.t.helpFaqHint}</span>
        </div>
        <svg class="w-7 h-7 text-gray-400 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 013.75 9.375v-4.5zM3.75 14.625c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5a1.125 1.125 0 01-1.125-1.125v-4.5zM13.5 4.875c0-.621.504-1.125 1.125-1.125h4.5c.621 0 1.125.504 1.125 1.125v4.5c0 .621-.504 1.125-1.125 1.125h-4.5A1.125 1.125 0 0113.5 9.375v-4.5z"/><path stroke-linecap="round" stroke-linejoin="round" d="M6.75 6.75h.008v.008H6.75V6.75zM6.75 16.5h.008v.008H6.75V16.5zM16.5 6.75h.008v.008H16.5V6.75zM13.5 13.5h.008v.008H13.5V13.5zM13.5 19.5h.008v.008H13.5V19.5zM19.5 13.5h.008v.008H19.5V13.5zM19.5 19.5h.008v.008H19.5V19.5zM16.5 16.5h.008v.008H16.5V16.5z"/></svg>
      </button>

      <!-- Status groups: collapsible. Focusable headers give the D-pad steps downward
           (fixes scrolling) and a Right jump target from the menu. -->

      <!-- TV (collapsed by default): panel capabilities (deviceInfo) + codec probe -->
      <div class="bg-gray-800/80 border border-gray-700 rounded-2xl overflow-hidden shadow-xl">
        <button onclick={() => toggleStatus('tv')} onfocus={scrollGroupIntoView}
          class="flex items-center justify-between w-full p-6 rounded-t-2xl {openStatus.tv ? '' : 'rounded-b-2xl'} hover:bg-gray-700/50 focus:bg-gray-700/50 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-colors text-left gap-4">
          <span class="text-sm text-gray-300 uppercase tracking-wider font-bold flex items-center gap-3">
            <svg class="w-4 h-4 shrink-0 transition-transform {openStatus.tv ? 'rotate-90' : ''}" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
            {i18n.t.statusTv}
          </span>
          <span class="font-mono text-xs text-gray-500 truncate">{tvInfo?.available ? `${tvInfo.modelName || ''}${tvInfo.oled === true ? ' · OLED' : ''}` : i18n.t.statusOnlyOnTv}</span>
        </button>
        {#if openStatus.tv}
          <div class="px-6 pb-6 flex flex-col gap-4">
            {#if tvInfo?.available}
              <div class="flex justify-between items-baseline gap-4">
                <span class="text-sm text-gray-500 uppercase tracking-wider font-bold">{i18n.t.statusResolution}</span>
                <span class="text-white font-mono text-sm">{tvResolution || '—'}</span>
              </div>
              <div class="h-px bg-gray-700/70"></div>
              <div class="flex justify-between items-baseline gap-4">
                <span class="text-sm text-gray-500 uppercase tracking-wider font-bold">HDR10</span>
                <span class="font-mono text-sm font-bold {capClass(tvInfo.hdr10)}">{capText(tvInfo.hdr10)}</span>
              </div>
              <div class="h-px bg-gray-700/70"></div>
              <div class="flex justify-between items-baseline gap-4">
                <span class="text-sm text-gray-500 uppercase tracking-wider font-bold">Dolby Vision</span>
                <span class="font-mono text-sm font-bold {capClass(tvInfo.dolbyVision)}">{capText(tvInfo.dolbyVision)}</span>
              </div>
              <div class="h-px bg-gray-700/70"></div>
              <div class="flex justify-between items-baseline gap-4">
                <span class="text-sm text-gray-500 uppercase tracking-wider font-bold">Dolby Atmos</span>
                <span class="font-mono text-sm font-bold {capClass(tvInfo.dolbyAtmos)}">{capText(tvInfo.dolbyAtmos)}</span>
              </div>
              {#if tvInfo.dolbyAtmos === false}
                <p class="text-xs text-gray-500 leading-snug">{i18n.t.statusAtmosHint}</p>
              {/if}
              <div class="h-px bg-gray-700/70"></div>
            {/if}
            <span class="text-xs text-gray-500 uppercase tracking-wider font-bold">{i18n.t.statusCodecsBrowser}</span>
            <div class="flex flex-wrap gap-x-6 gap-y-2">
              {#each [{ l: 'H.264', k: 'h264' }, { l: 'HEVC', k: 'hevc' }, { l: 'VP9', k: 'vp9' }, { l: 'AV1', k: 'av1' }] as c}
                <span class="font-mono text-sm font-bold {codecs[c.k] ? 'text-green-400' : 'text-gray-400'}">{c.l}: {codecs[c.k] ? i18n.t.statusYes : i18n.t.statusNo}</span>
              {/each}
            </div>
          </div>
        {/if}
      </div>

      <!-- App & Server -->
      <div class="bg-gray-800/80 border border-gray-700 rounded-2xl overflow-hidden shadow-xl">
        <button onclick={() => toggleStatus('runtime')} onfocus={scrollGroupIntoView}
          class="flex items-center justify-between w-full p-6 rounded-t-2xl {openStatus.runtime ? '' : 'rounded-b-2xl'} hover:bg-gray-700/50 focus:bg-gray-700/50 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-colors text-left">
          <span class="text-sm text-gray-300 uppercase tracking-wider font-bold flex items-center gap-3">
            <svg class="w-4 h-4 shrink-0 transition-transform {openStatus.runtime ? 'rotate-90' : ''}" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
            {i18n.t.statusGroupApp}
          </span>
        </button>
        {#if openStatus.runtime}
          <div class="px-6 pb-6 flex flex-col gap-4">
            <div class="flex justify-between items-baseline gap-4">
              <span class="text-sm text-gray-500 uppercase tracking-wider font-bold">{i18n.t.statusChromium}</span>
              <span class="text-white font-mono text-sm">{envVersions.chromium || '—'}</span>
            </div>
            <div class="h-px bg-gray-700/70"></div>
            <div class="flex justify-between items-baseline gap-4">
              <span class="text-sm text-gray-500 uppercase tracking-wider font-bold">{i18n.t.statusAppVersion}</span>
              <span class="text-white font-mono text-sm">{APP_VERSION}</span>
            </div>
            <div class="h-px bg-gray-700/70"></div>
            <div class="flex justify-between items-baseline gap-4">
              <span class="text-sm text-gray-500 uppercase tracking-wider font-bold">{i18n.t.statusServerVersion}</span>
              <span class="text-white font-mono text-sm">{serverVersion || '—'}</span>
            </div>
            <div class="h-px bg-gray-700/70"></div>
            <div class="flex justify-between items-start gap-4">
              <div class="pr-2">
                <span class="text-sm text-gray-300 font-bold block">{i18n.t.statusClientGraphicSubs}</span>
                <span class="text-xs text-gray-500 mt-0.5 block">{i18n.t.statusClientGraphicSubsDesc}</span>
              </div>
              <span class="font-mono text-sm font-bold shrink-0 mt-0.5 {serverVobSub ? 'text-green-400' : 'text-gray-400'}">
                {serverVobSub ? i18n.t.statusYes : i18n.t.statusNo}
              </span>
            </div>
          </div>
        {/if}
      </div>

      <!-- Components — relevant when reporting playback/subtitle issues -->
      <div class="bg-gray-800/80 border border-gray-700 rounded-2xl overflow-hidden shadow-xl">
        <button onclick={() => toggleStatus('components')} onfocus={scrollGroupIntoView}
          class="flex items-center justify-between w-full p-6 rounded-t-2xl {openStatus.components ? '' : 'rounded-b-2xl'} hover:bg-gray-700/50 focus:bg-gray-700/50 focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white transition-colors text-left">
          <span class="text-sm text-gray-300 uppercase tracking-wider font-bold flex items-center gap-3">
            <svg class="w-4 h-4 shrink-0 transition-transform {openStatus.components ? 'rotate-90' : ''}" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7"/></svg>
            {i18n.t.statusGroupComponents}
          </span>
        </button>
        {#if openStatus.components}
          <div class="px-6 pb-6 flex flex-col gap-4">
            <div class="flex justify-between items-baseline gap-4">
              <span class="text-sm text-gray-500 uppercase tracking-wider font-bold">{i18n.t.statusHls}</span>
              <span class="text-white font-mono text-sm">{envVersions.hls || '—'}</span>
            </div>
            <div class="h-px bg-gray-700/70"></div>
            <div class="flex justify-between items-baseline gap-4">
              <span class="text-sm text-gray-500 uppercase tracking-wider font-bold">{i18n.t.statusLibbitsub}</span>
              <span class="text-white font-mono text-sm">{envVersions.libbitsub || '—'}</span>
            </div>
            <div class="h-px bg-gray-700/70"></div>
            <div class="flex justify-between items-baseline gap-4">
              <span class="text-sm text-gray-500 uppercase tracking-wider font-bold">{i18n.t.statusAssjs}</span>
              <span class="text-white font-mono text-sm">{envVersions.assjs || '—'}</span>
            </div>
          </div>
        {/if}
      </div>
    </section>
    {/if}

    </div>
  </div>
</div>

<!-- ══════════════════════════════════════════
     LOG VIEWER (own modal, wider than the standard modals)
══════════════════════════════════════════ -->
{#if showLog}
  <div class="fixed inset-0 bg-black/90 z-[100] flex items-center justify-center p-8" role="dialog" tabindex="-1"
    transition:uiFade onoutrostart={dropTrapOnOutro}
    onkeydown={(e) => { if (isBackKey(e)) { e.stopPropagation(); if (qrSvg) hideQr(); else showLog = false; } }}>

    <div data-modal data-focus-trap
      class="bg-gray-800 border border-gray-700 p-8 rounded-2xl w-full max-w-4xl max-h-[88vh] flex flex-col gap-5 shadow-2xl">

      <div class="flex items-center justify-between gap-4 shrink-0">
        <h2 class="text-4xl text-white font-bold">{i18n.t.logTitle}</h2>
        <div class="flex items-center gap-3">
          <button bind:this={qrBtnEl} onclick={showLogQr}
            class="px-5 py-3 rounded-xl font-bold bg-blue-600 hover:bg-blue-500 focus:bg-blue-500 text-white
                   focus:outline-none focus:ring-4 focus:ring-white transition-colors">{i18n.t.logQrButton}</button>
          <button onclick={() => showLog = false} {@attach focusOnMount()}
            class="px-5 py-3 rounded-xl font-bold bg-gray-700 hover:bg-gray-600 focus:bg-gray-600 text-white
                   focus:outline-none focus:ring-4 focus:ring-white transition-colors">{i18n.t.close}</button>
        </div>
      </div>

      {#if qrSvg}
        <div class="flex flex-col items-center justify-center gap-5 flex-1 min-h-0">
          <div class="rounded-xl bg-white p-3 [&>svg]:block [&>svg]:w-full [&>svg]:h-full"
               style="width:320px;height:320px;max-width:40vh;max-height:40vh;">{@html qrSvg}</div>
          <p class="text-gray-400 text-lg text-center max-w-md">{i18n.t.logQrHint}</p>
          <button onclick={hideQr} {@attach focusOnMount()}
            class="px-6 py-3 rounded-xl font-bold bg-gray-700 hover:bg-gray-600 focus:bg-gray-600 text-white
                   focus:outline-none focus:ring-4 focus:ring-white transition-colors">{i18n.t.logBackToText}</button>
        </div>
      {:else}
        <pre bind:this={logEl} class="flex-1 min-h-0 overflow-auto hide-scrollbar bg-black/50 rounded-xl p-5 text-sm text-gray-300
                    font-mono whitespace-pre-wrap break-words leading-relaxed">{logText || i18n.t.logEmpty}</pre>
        <div class="flex items-center justify-between gap-3 shrink-0">
          <div class="flex gap-3">
            <button onclick={() => scrollLog(-1)} aria-label="↑"
              class="px-5 py-3 rounded-xl bg-gray-700 hover:bg-gray-600 focus:bg-gray-600 text-white focus:outline-none focus:ring-4 focus:ring-white transition-colors">
              <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7"/></svg>
            </button>
            <button onclick={() => scrollLog(1)} aria-label="↓"
              class="px-5 py-3 rounded-xl bg-gray-700 hover:bg-gray-600 focus:bg-gray-600 text-white focus:outline-none focus:ring-4 focus:ring-white transition-colors">
              <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
            </button>
          </div>
          <button onclick={clearLog}
            class="px-6 py-3 rounded-xl font-bold bg-gray-700 hover:bg-red-600 focus:bg-red-600 text-white
                   focus:outline-none focus:ring-4 focus:ring-white transition-colors">{i18n.t.clear}</button>
        </div>
      {/if}
    </div>
  </div>
{/if}

<!-- ══════════════════════════════════════════
     MODAL (help / FAQ QR)
══════════════════════════════════════════ -->
{#if showWikiQr}
  <div class="fixed inset-0 bg-black/90 z-[100] flex items-center justify-center p-8"
    transition:uiFade onoutrostart={dropTrapOnOutro}>
    <div data-modal data-focus-trap role="dialog" tabindex="-1"
      onkeydown={(e) => { if (isBackKey(e)) { e.stopPropagation(); showWikiQr = false; } }}
      class="bg-gray-800 border border-gray-700 p-8 rounded-2xl w-full max-w-lg flex flex-col items-center gap-5 shadow-2xl text-center">
      <h2 class="text-4xl text-white font-bold">{i18n.t.helpFaq}</h2>
      {#if wikiQrSvg}
        <div class="rounded-xl bg-white p-3 [&>svg]:block [&>svg]:w-full [&>svg]:h-full"
             style="width:320px;height:320px;max-width:40vh;max-height:40vh;">{@html wikiQrSvg}</div>
      {/if}
      <p class="text-gray-400 text-lg max-w-md">{i18n.t.helpFaqHint}</p>
      <button onclick={() => showWikiQr = false} {@attach focusOnMount()}
        class="px-6 py-3 rounded-xl font-bold bg-gray-700 hover:bg-gray-600 focus:bg-gray-600 text-white
               focus:outline-none focus:ring-4 focus:ring-white transition-colors">{i18n.t.close}</button>
    </div>
  </div>
{/if}

<!-- ══════════════════════════════════════════
     MODAL (language / password / Quick Connect)
══════════════════════════════════════════ -->
{#if activeModal}
  <div class="fixed inset-0 bg-black/90 z-[100] flex items-center justify-center p-8" role="dialog" tabindex="-1"
    transition:uiFade onoutrostart={dropTrapOnOutro}
    onkeydown={(e) => { if (isBackKey(e)) { e.stopPropagation(); closeModal(); } }}>

    <div data-modal data-focus-trap
      class="bg-gray-800 border border-gray-700 p-10 rounded-2xl w-full {activeModal === 'sharedQc' && sharedQcQr ? 'max-w-3xl' : 'max-w-xl'} flex flex-col gap-6 shadow-2xl">

      {#if activeModal === 'lang'}
        <h2 class="text-4xl text-white font-bold mb-2">{i18n.t.language}</h2>
        <div class="flex flex-col gap-3 max-h-[60vh] overflow-y-auto hide-scrollbar p-2 -m-2">
          {#each LANGUAGES as l (l.key)}
            <button onclick={() => setLanguage(l.key)}
              class="w-full text-left p-6 text-2xl font-bold text-white rounded-xl transition-colors
                     focus:outline-none focus:ring-4 focus:ring-white
                     {i18n.lang === l.key ? 'bg-blue-600' : 'bg-gray-900 hover:bg-blue-600 focus:bg-blue-600'}">
              {l.flag}&nbsp; {l.name}
            </button>
          {/each}
        </div>

      {:else if pickerModals[activeModal]}
        {@const picker = pickerModals[activeModal]}
        <h2 class="text-4xl text-white font-bold mb-2">{picker.title}</h2>
        <div class="flex flex-col gap-2 max-h-[55vh] overflow-y-auto hide-scrollbar">
          {#each picker.options as opt (opt.key)}
            <button onclick={() => { picker.set(opt.key); closeModal(); }}
              class="w-full text-left p-5 text-xl font-bold text-white rounded-xl transition-colors
                     focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white
                     {picker.value === opt.key ? 'bg-blue-600' : 'bg-gray-900 hover:bg-blue-600 focus:bg-blue-600'}">
              {opt.name}
            </button>
          {/each}
        </div>
      {:else if activeModal === 'password'}
        <h2 class="text-4xl text-white font-bold mb-2">{i18n.t.changePassword}</h2>
        <div class="relative">
          <input type={showCurrentPw ? 'text' : 'password'} bind:value={currentPw} placeholder={i18n.t.currentPassword}
            {@attach tvKeyboard}
            onkeydown={(e) => e.key === 'Enter' && changePassword()}
            class="w-full bg-gray-900 text-white text-2xl p-6 pr-20 rounded-xl border border-gray-600
                   focus:outline-none focus:ring-4 focus:ring-blue-500" />
          <button type="button" onclick={() => showCurrentPw = !showCurrentPw}
            aria-label={showCurrentPw ? i18n.t.hidePassword : i18n.t.showPassword} title={showCurrentPw ? i18n.t.hidePassword : i18n.t.showPassword}
            class="absolute right-4 top-1/2 -translate-y-1/2 p-2 rounded-lg text-gray-400 hover:text-white focus:text-white
                   focus:outline-none focus:ring-2 focus:ring-white transition-colors">
            {#if showCurrentPw}
              <svg class="w-7 h-7" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18"/></svg>
            {:else}
              <svg class="w-7 h-7" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
            {/if}
          </button>
        </div>
        <div class="relative">
          <input type={showNewPw ? 'text' : 'password'} bind:value={newPw} placeholder={i18n.t.newPassword}
            {@attach tvKeyboard}
            onkeydown={(e) => e.key === 'Enter' && changePassword()}
            class="w-full bg-gray-900 text-white text-2xl p-6 pr-20 rounded-xl border border-gray-600
                   focus:outline-none focus:ring-4 focus:ring-blue-500" />
          <button type="button" onclick={() => showNewPw = !showNewPw}
            aria-label={showNewPw ? i18n.t.hidePassword : i18n.t.showPassword} title={showNewPw ? i18n.t.hidePassword : i18n.t.showPassword}
            class="absolute right-4 top-1/2 -translate-y-1/2 p-2 rounded-lg text-gray-400 hover:text-white focus:text-white
                   focus:outline-none focus:ring-2 focus:ring-white transition-colors">
            {#if showNewPw}
              <svg class="w-7 h-7" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18"/></svg>
            {:else}
              <svg class="w-7 h-7" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/></svg>
            {/if}
          </button>
        </div>
        {#if pwMessage}<p class="text-blue-400 font-bold text-lg">{pwMessage}</p>{/if}
        <button onclick={changePassword}
          class="w-full bg-blue-600 hover:bg-blue-500 focus:bg-blue-500 text-white font-bold text-2xl py-6 rounded-xl
                 focus:outline-none focus:ring-4 focus:ring-white mt-2">{i18n.t.save}</button>

      {:else if activeModal === 'quickConnect'}
        <h2 class="text-4xl text-white font-bold mb-2">{i18n.t.quickConnect}</h2>
        <p class="text-gray-400 text-lg">{i18n.t.qcAuthInstruction}</p>
        <input type="text" bind:value={qcCode} placeholder={i18n.t.qcPlaceholder}
          onkeydown={(e) => e.key === 'Enter' && authorizeQuickConnect()}
          class="w-full bg-gray-900 text-white text-4xl tracking-widest text-center p-6 rounded-xl border border-gray-600
                 focus:outline-none focus:ring-4 focus:ring-blue-500" />
        {#if qcMessage}<p class="text-blue-400 font-bold text-lg">{qcMessage}</p>{/if}
        <button onclick={authorizeQuickConnect}
          class="w-full bg-blue-600 hover:bg-blue-500 focus:bg-blue-500 text-white font-bold text-2xl py-6 rounded-xl
                 focus:outline-none focus:ring-4 focus:ring-white mt-2">{i18n.t.qcAuthorizeBtn}</button>

      {:else if activeModal === 'sharedPicker'}
        <h2 class="text-4xl text-white font-bold mb-2">{i18n.t.selectProfile}</h2>
        <div class="flex flex-col gap-2 max-h-[42vh] overflow-y-auto hide-scrollbar">
          {#each pickableUsers(sharedPickerSlot) as u (u.Id)}
            <button onclick={() => chooseSharedUser(u)}
              class="w-full text-left p-5 text-xl font-bold text-white rounded-xl transition-colors
                     bg-gray-900 hover:bg-blue-600 focus:bg-blue-600
                     focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white">
              {u.Name}
            </button>
          {:else}
            <p class="text-gray-400 text-lg p-4">{i18n.t.noProfiles}</p>
          {/each}
        </div>
        <!-- Outside the scroll box on purpose: these two are always available, so a long profile
             list must not push them out of reach. They stay BELOW the list so opening the dialog
             still lands focus on the profiles, which is what almost everyone came here for. -->
        <div class="h-px bg-gray-700"></div>
        <div class="flex flex-col gap-2">
          <button onclick={startSharedQuickConnect}
            class="w-full text-left p-5 text-xl font-bold text-gray-300 rounded-xl transition-colors
                   bg-transparent border border-gray-600 hover:bg-gray-700 focus:bg-gray-700
                   focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white">
            {i18n.t.sharedQuickConnect}
          </button>
          <button onclick={openSharedManual}
            class="w-full text-left p-5 text-xl font-bold text-gray-300 rounded-xl transition-colors
                   bg-transparent border border-gray-600 hover:bg-gray-700 focus:bg-gray-700
                   focus:outline-none focus:ring-inset focus:ring-4 focus:ring-white">
            {i18n.t.manualLogin}
          </button>
        </div>
        {#if sharedError}<p class="text-red-400 font-bold">{sharedError}</p>{/if}

      {:else if activeModal === 'sharedQc'}
        <h2 class="text-4xl text-white font-bold mb-2">{i18n.t.sharedQuickConnect}</h2>
        <QuickConnectPanel code={sharedQcCode} qrSvg={sharedQcQr} />
        {#if sharedError}<p class="text-red-400 font-bold text-lg">{sharedError}</p>{/if}

      {:else if activeModal === 'sharedManual'}
        <h2 class="text-4xl text-white font-bold mb-2">{i18n.t.manualLogin}</h2>
        <input type="text" bind:value={sharedManualName} placeholder={i18n.t.username}
          {@attach tvKeyboard} {@attach focusOnMount()}
          class="w-full bg-gray-900 text-white text-2xl p-6 rounded-xl border border-gray-600
                 focus:outline-none focus:ring-4 focus:ring-blue-500" />
        <input type="password" bind:value={sharedPw} placeholder={i18n.t.password}
          {@attach tvKeyboard}
          onkeydown={(e) => e.key === 'Enter' && commitSharedManual()}
          class="w-full bg-gray-900 text-white text-2xl p-6 rounded-xl border border-gray-600
                 focus:outline-none focus:ring-4 focus:ring-blue-500" />
        {#if sharedError}<p class="text-red-400 font-bold text-lg">{sharedError}</p>{/if}
        <button onclick={commitSharedManual} disabled={sharedBusy || !sharedManualName.trim()}
          class="w-full bg-blue-600 hover:bg-blue-500 focus:bg-blue-500 text-white font-bold text-2xl py-6 rounded-xl
                 focus:outline-none focus:ring-4 focus:ring-white mt-2 disabled:opacity-50">{i18n.t.confirm}</button>

      {:else if activeModal === 'sharedPassword'}
        <h2 class="text-4xl text-white font-bold mb-2">{sharedPickerUser?.Name}</h2>
        <input type="password" bind:value={sharedPw} placeholder={i18n.t.password}
          {@attach tvKeyboard}
          onkeydown={(e) => e.key === 'Enter' && commitSharedUser(sharedPickerUser, sharedPw)}
          class="w-full bg-gray-900 text-white text-2xl p-6 rounded-xl border border-gray-600
                 focus:outline-none focus:ring-4 focus:ring-blue-500" />
        {#if sharedError}<p class="text-red-400 font-bold text-lg">{sharedError}</p>{/if}
        <button onclick={() => commitSharedUser(sharedPickerUser, sharedPw)} disabled={sharedBusy}
          class="w-full bg-blue-600 hover:bg-blue-500 focus:bg-blue-500 text-white font-bold text-2xl py-6 rounded-xl
                 focus:outline-none focus:ring-4 focus:ring-white mt-2 disabled:opacity-50">{i18n.t.confirm}</button>
      {/if}

      <button onclick={closeModal}
        class="w-full bg-transparent hover:bg-gray-700 focus:bg-gray-700 text-gray-400 font-bold text-xl py-4 rounded-xl
               border border-gray-600 focus:outline-none focus:ring-4 focus:ring-white mt-2">{i18n.t.qcCancel}</button>

    </div>
  </div>
{/if}

