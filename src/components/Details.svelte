<script>
  import { i18n, LANGUAGES, plural, baseLang } from '../i18n.svelte.js';
  import { toggleWatchlist, inWatchlist } from '../watchlist.svelte.js';
  import { dlog, isBackKey, focusOnMount, itemProgress, minutesLeft, episodeCode, backdropUrl, logoUrl, runtimeLabel, endsAtLabel, authHeaders, setPlayed, setFavorite, blurUp, itemBlurHash, blurHashTint, makeFocusReturn, hint, getItemImageUrlWithFallbacks as getItemImageUrl } from '../utils.js';
  import Dialog from './Dialog.svelte';
  import { pickDefaultTracks, rememberChoice, orderTracks } from '../trackmemory.js';
  import { trackLabels } from '../tracklabel.js';
  import { playThemeFor, stopTheme } from '../thememusic.js';
  import { buildPlayQueue, playableFor, hasEarlierEpisodes, markEarlierPlayed } from '../playback.js';
  import { session } from '../session.svelte.js';
  import { onMount, onDestroy, tick, untrack } from 'svelte';
  import AddToPicker from './AddToPicker.svelte';
  import SubtitleSearch from './SubtitleSearch.svelte';
  import CardStatus from './CardStatus.svelte';
  import TitleMeta from './TitleMeta.svelte';
  import PersonCard from './PersonCard.svelte';

  let {
    item,
    selectedUser,
    playbackPrefs = { audioLanguage: 'default', subtitleLanguage: 'default' },
    use24h = true,              // time format for the "ends at" chip (follows the setting)
    spoilerProtection = true,   // slightly obscure thumbnails of unwatched episodes
    detailsBackdrop = true,     // show the hero backdrop on the detail page (own toggle, decoupled from reduceAnimations)
    detailsLogo = false,        // title as a logo graphic instead of text (falls back to text if no logo exists)
    focusItemId = null, focusScrollTop = 0,   // where to land when App brings us back (person page)
    takeResume = null,          // App: hands back, ONCE, what was on screen when we were left for a collection, a person page or the player
    onClose, onLibChanged, onOpenPerson, onOpenCollection, onPlayVideo,   // callback props
    onProgressChanged,          // something was marked (un)watched → App refreshes Continue watching and Up next on the dashboard
  } = $props();

  let fullItem     = $state(null);
  // The title's own colour (poster, else backdrop): page background, the backdrop's fade, the rows'
  // background and the poster's shadow colour. Set as plain values on exactly those four elements —
  // as ONE variable on the root, every title change recalculated the style of the whole page
  // (measured, CODE-HEALTH §47). Solid colours and the existing shadow: no layer, blur or animation.
  let tint = $derived(blurHashTint(itemBlurHash(fullItem) || itemBlurHash(fullItem, 'Backdrop')));
  let relatedItems = $state([]);
  // Series/season pages: what Play starts (playableFor — Next Up, else the first episode), fetched
  // with the page so the button can SAY it ("Play · S2:E2") and the episode row can mark it. Play
  // then starts exactly that one.
  let nextToPlay = $state(null);
  // The episode the row's description panel shows: the one under the focus, else the next one.
  let focusedEpisode = $state(null);
  // "Mark earlier episodes as watched" in the ⋮ menu: null | 'busy' | { n } — see markEarlier().
  let earlier = $state(null);
  // "S1:E2 · Title" — the episode row's panel and the share dialog (the number: episodeCode, utils.js, §141)
  const epTitle = (ep) => [episodeCode(ep), ep?.Name].filter(Boolean).join(' · ');
  let similarItems = $state([]);
  let collections  = $state([]);   // collections (BoxSets) that contain the title — Jellyfin 12+
  let extras       = $state([]);   // special features (making-ofs, deleted scenes, …)
  let isLoading    = $state(true);

  let selectedAudioIndex    = $state(-1);
  let selectedSubtitleIndex = $state(-1);
  let selectedMediaSourceId = $state(null);   // chosen version (FullHD/4K …), when several exist

  // currently chosen source (for stream info, audio/subtitle tracks)
  let selectedSource = $derived(
    fullItem?.MediaSources?.find(s => s.Id === selectedMediaSourceId)
    || fullItem?.MediaSources?.[0] || null
  );

  // Technical badges for the CURRENT version (resolution / dynamic range / codec / premium
  // audio). Derived from selectedSource + selectedAudioIndex, so switching the version or the
  // audio track updates them automatically. SDR and common audio formats are intentionally
  // omitted — the badge row is for standout capabilities, not every codec detail.
  let techBadges = $derived.by(() => {
    const streams = selectedSource?.MediaStreams || [];
    const v = streams.find(s => s.Type === 'Video');
    if (!v) return [];
    const out = [];
    // premium=true → standout capabilities (brighter badge); baseline stays dimmer.
    const r = resLabel(v);
    if (r) out.push({ label: r, premium: r === '4K' });
    const range = rangeLabel(v);
    if (range) out.push({ label: range, premium: true });
    const codec = codecLabel(v);
    if (codec) out.push({ label: codec, premium: false });
    // Premium audio of the SELECTED track (fallback: source default, then first audio)
    const audio = streams.find(s => s.Type === 'Audio' && s.Index === selectedAudioIndex)
               || streams.find(s => s.Type === 'Audio' && s.Index === selectedSource?.DefaultAudioStreamIndex)
               || streams.find(s => s.Type === 'Audio');
    if (audio) {
      const meta = `${audio.Profile || ''} ${audio.DisplayTitle || ''}`.toLowerCase();
      const ac = (audio.Codec || '').toLowerCase();
      if (meta.includes('atmos')) out.push({ label: 'Dolby Atmos', premium: true });
      else if (meta.includes('dts:x') || meta.includes('dts-x')) out.push({ label: 'DTS:X', premium: true });
      else if (ac === 'truehd') out.push({ label: 'Dolby TrueHD', premium: true });
      else if (meta.includes('dts-hd ma')) out.push({ label: 'DTS-HD MA', premium: true });
    }
    return out;
  });

  // Resolution class from a video stream — classify by WIDTH (the standard), not height:
  // widescreen films (e.g. 1920x800, 2.40:1) have reduced height and would otherwise
  // mis-read as 720p even though they are a full 1080p source.
  function resLabel(v) {
    const w = v?.Width || 0, h = v?.Height || 0;
    return (w >= 3840 || h >= 2160) ? '4K'
         : (w >= 1920 || h >= 1080) ? '1080p'
         : (w >= 1280 || h >= 720)  ? '720p'
         : (h ? h + 'p' : '');
  }

  // Dynamic range and codec as the badges and the version list name them; '' for SDR / no codec.
  function rangeLabel(v) {
    const range = (v?.VideoRangeType || v?.VideoRange || '').toUpperCase();
    return range.includes('DOVI') || range.includes('DOLBY') ? 'Dolby Vision'
         : range.includes('HDR10PLUS') || range.includes('HDR10+') ? 'HDR10+'
         : range.includes('HDR10') ? 'HDR10'
         : range.includes('HLG') ? 'HLG'
         : range === 'HDR' ? 'HDR' : '';
  }
  function codecLabel(v) {
    const c = (v?.Codec || '').toLowerCase();
    return c === 'hevc' || c === 'h265' ? 'HEVC' : c === 'av1' ? 'AV1' : c === 'h264' || c === 'avc' ? 'H.264' : c.toUpperCase();
  }

  // A version's own name (§134). Jellyfin names an alternate version after what its file adds to the folder's name
  // ("2160p Remux", "Director's Cut"); the main file, and a version grouped in by hand, after the whole file name,
  // which starts with the title — that prefix and a year after it say nothing here. A name that is only the
  // resolution ("1080p", "2160p", "4K") repeats the technical part and is dropped too.
  const RES_WORDS = { '4K': ['4k', '2160p', 'uhd'], '1080p': ['1080p', 'fhd', 'full hd'], '720p': ['720p', 'hd'] };
  function versionName(src, res) {
    let n = (src?.Name || '').trim();
    const t = (fullItem?.Name || '').trim();
    if (t && n.toLowerCase().startsWith(t.toLowerCase()))
      n = n.slice(t.length).replace(/^[\s._-]*(?:\(?(?:19|20)\d{2}\)?(?=[\s._)-]|$))?[\s._)-]*/, '').trim();
    const plain = n.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return !plain || (RES_WORDS[res] || [res.toLowerCase()]).includes(plain) ? '' : n;
  }
  // Every version's label: { name, tech, extra }. Two versions that still read the same (two 1080p encodes, a
  // version named like the title) get their size, and where even that does not tell them apart, a number —
  // the list used to show "4K HEVC" twice for a Dolby Vision remux and an HDR10 director's cut.
  let sourceLabels = $derived.by(() => {
    const srcs = fullItem?.MediaSources || [];
    const gb = new Intl.NumberFormat(i18n.lang, { style: 'unit', unit: 'gigabyte', maximumFractionDigits: 1 });
    const labels = new Map(srcs.map(src => {
      const v = (src.MediaStreams || []).find(s => s.Type === 'Video');
      const res = resLabel(v);
      const tech = [res, rangeLabel(v), codecLabel(v)].filter(Boolean).join(' ');
      const name = versionName(src, res);
      return [src.Id, { name: name || (tech ? '' : src.Name || i18n.t.source), tech, extra: '' }];
    }));
    const alike = (key) => srcs.reduce((m, src) => { const k = key(labels.get(src.Id)); m.set(k, (m.get(k) || 0) + 1); return m; }, new Map());
    const base = (l) => `${l.name}|${l.tech}`;
    let counts = alike(base);
    for (const src of srcs) { const l = labels.get(src.Id); if (counts.get(base(l)) > 1 && src.Size > 0) l.extra = gb.format(src.Size / 1e9); }
    const full = (l) => `${base(l)}|${l.extra}`;
    counts = alike(full);
    const nth = new Map();
    for (const src of srcs) {
      const l = labels.get(src.Id), k = full(l);
      if (counts.get(k) > 1) { nth.set(k, (nth.get(k) || 0) + 1); l.extra = [l.extra, `#${nth.get(k)}`].filter(Boolean).join(' · '); }
    }
    return labels;
  });

  // The audio and subtitle lists in the order orderTracks gives them (the profile's languages first).
  let audioChoices    = $derived(orderTracks(selectedSource?.MediaStreams, 'Audio', playbackPrefs, baseLang(i18n.lang)));
  let subtitleChoices = $derived(orderTracks(selectedSource?.MediaStreams, 'Subtitle', playbackPrefs, baseLang(i18n.lang)));
  // Their names (tracklabel.js): language, flags and what the Title adds; tracks that read the same get a number
  let trackNames = $derived(trackLabels(selectedSource?.MediaStreams));

  // Choose default audio/subtitle for a source — the shared rule in trackmemory.js, which the Player
  // applies to every start that does not come through this page (series play button, play-all, …).
  let subtitleByHand = false;   // plain let: nothing renders from it
  function applySourceDefaults(src) {
    const t = pickDefaultTracks(src, { seriesId: fullItem?.SeriesId, prefs: playbackPrefs });
    selectedAudioIndex    = t.audio;
    selectedSubtitleIndex = t.subtitle;
    subtitleByHand = false;
  }

  // A track picked here counts like one picked in the Player's menu: it becomes the series' memory.
  // The Player re-applies that memory on its first setup, and used to overrule this page's choice
  // with an older one — "subtitles off" remembered, English picked here, played without subtitles.
  // With "only for foreign audio" the subtitle depends on the audio, so another audio track picks it
  // again — unless a subtitle was picked here by hand (subtitleByHand, above applySourceDefaults).
  function pickTrack(kind, index) {
    if (kind === 'audio') {
      selectedAudioIndex = index;
      if (playbackPrefs.subtitleSmart && !subtitleByHand && selectedSource)
        selectedSubtitleIndex = pickDefaultTracks(selectedSource, { seriesId: fullItem?.SeriesId, prefs: playbackPrefs, audio: index }).subtitle;
    } else { selectedSubtitleIndex = index; subtitleByHand = true; }
    rememberChoice(fullItem?.SeriesId, kind, index, getMediaStreams(kind === 'audio' ? 'Audio' : 'Subtitle'), playbackPrefs);
  }

  // ---- Find subtitles with the server's providers (SubtitleSearch) ---------------------------------
  // Only for profiles the server lets manage subtitles (admin, or "allow subtitle management") — the
  // search and the download both answer 403 otherwise.
  const canSearchSubtitles = $derived(!!(selectedUser?.Policy?.IsAdministrator || selectedUser?.Policy?.EnableSubtitleManagement));
  let subtitleSearchOpen = $state(false);
  const subtitleSearchReturn = makeFocusReturn();
  function openSubtitleSearch() {
    subtitleSearchReturn.capture(openTrigger || document.activeElement);
    closeDropdown(false);
    subtitleSearchOpen = true;
  }
  function closeSubtitleSearch() {
    subtitleSearchOpen = false;
    // Back where it was opened — unless that was the "Search subtitles" button of a title WITHOUT
    // subtitles, which has just turned into the dropdown: then the dropdown.
    const back = document.querySelector('[data-subtitle-trigger]');
    tick().then(() => {
      if (subtitleSearchReturn.pending) subtitleSearchReturn.restore();
      tick().then(() => { if (!document.activeElement || document.activeElement === document.body) back?.isConnected && back.focus(); });
    });
  }
  // The language to search first: the profile's subtitle language, else the app's.
  const subtitleSearchLang = $derived(LANGUAGES.some(l => l.key === playbackPrefs.subtitleLanguage) ? playbackPrefs.subtitleLanguage : baseLang(i18n.lang));
  // The server reads a downloaded subtitle in with a refresh it queues — wait for the new track (a
  // stream this version did not have before, by content, since indexes of external files can shift)
  // and pick it. Bounded; false when it is not there yet, and the dialog says it will turn up.
  async function awaitNewSubtitle() {
    const id = fullItem?.Id, srcId = selectedMediaSourceId;
    const key = (st) => `${st.Codec}|${st.Language}|${st.Path || st.DisplayTitle || ''}|${st.IsForced}`;
    const before = new Set(getMediaStreams('Subtitle').map(key));
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 1500));
      if (!alive || fullItem?.Id !== id) return false;
      try {
        const r = await fetch(`${session.serverUrl}/Items/${id}?UserId=${selectedUser.Id}`, { headers: authHeaders() });
        if (!r.ok) continue;
        const d = await r.json();
        const src = (d.MediaSources || []).find(x => x.Id === srcId) || d.MediaSources?.[0];
        const added = (src?.MediaStreams || []).find(st => st.Type === 'Subtitle' && !before.has(key(st)));
        if (!added || !alive || fullItem?.Id !== id) continue;
        fullItem.MediaSources = d.MediaSources;
        fullItem.MediaStreams = d.MediaStreams;
        pickTrack('subtitle', added.Index);
        dlog('[subtitles] downloaded track on the title after', (i + 1) * 1.5, 's:', added.DisplayTitle || added.Language);
        return true;
      } catch { /* next try */ }
    }
    return false;
  }

  // On resolution/version change: reset the tracks to the source's default values
  function onSourceChange() {
    const src = fullItem?.MediaSources?.find(s => s.Id === selectedMediaSourceId);
    if (src) applySourceDefaults(src);
  }

  // ---- Custom dropdowns (resolution/audio/subtitle) -------------------------------------------
  // A native <select> freezes on webOS on the back button → D-pad-capable custom dropdowns.
  let openDropdown = $state(null);     // 'resolution' | 'audio' | 'subtitle' | 'kebab'
  let openTrigger  = null;     // trigger button (DOM ref; focus returns there on close)

  async function toggleDropdown(key, e) {
    if (openDropdown === key) { openDropdown = null; openTrigger = null; return; }
    openDropdown = key;
    openTrigger  = e.currentTarget;
    // Put focus on the active (blue-highlighted) element, otherwise on the first option —
    // more intuitive than starting at the very top every time.
    const panel = e.currentTarget.closest('[data-dropdown]');
    await tick();
    const active = panel?.querySelector('[data-opt][data-active="true"]');
    // preventScroll: a list scrolls itself to its active entry (placeList), the page stays where it is
    (active || panel?.querySelector('[data-opt]'))?.focus({ preventScroll: true });
  }
  // The open version/audio/subtitle list floats over the page (§134): below its field, or above it where the room
  // below is short and above is larger, as tall as its entries, that room or 60 % of the screen allow, scrolling in
  // itself with the active entry in the middle. Opened above, ▼ from its last entry lands on the field below it —
  // the same as ▲ from the first entry of a list below (and of the inline lists before). Opened inline, 25 subtitles pushed the page along until the field itself was gone.
  function placeList(node) {
    const field = node.previousElementSibling;
    if (!field || !scrollEl) return;
    const area = scrollEl.getBoundingClientRect(), r = field.getBoundingClientRect();
    const gap = 0.5 * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 20);
    const below = area.bottom - r.bottom - 3 * gap, above = r.top - area.top - 3 * gap;
    const h = node.offsetHeight;   // border box, like the max-height it is compared with
    const up = h > below && above > below;
    // at most 60 % of the screen, like the Player's track panel: the page around it stays readable
    node.style.maxHeight = `${Math.max(Math.min(h, up ? above : below, 0.6 * area.height), 8 * gap)}px`;
    if (up) node.style.bottom = `calc(100% + ${gap}px)`; else node.style.top = `calc(100% + ${gap}px)`;
    const active = node.querySelector('[data-active="true"]');
    if (active) node.scrollTop = active.offsetTop - (node.clientHeight - active.offsetHeight) / 2;
  }
  function closeDropdown(refocus = true) {
    const t = openTrigger;
    openDropdown = null; openTrigger = null;
    if (refocus) t?.focus();
  }
  function onDropdownBack(e) {
    // Back closes only the open dropdown — not the detail view.
    if (openDropdown && isBackKey(e)) { e.preventDefault(); e.stopPropagation(); closeDropdown(); }
  }
  function onDropdownOutside(e) {
    // A Magic Remote click outside the dropdown closes it (like a normal dropdown).
    if (openDropdown && !e.target.closest('[data-dropdown]')) closeDropdown(false);
  }
  onMount(()   => { window.addEventListener('keydown', onDropdownBack, true); window.addEventListener('click', onDropdownOutside); });
  onDestroy(() => { window.removeEventListener('keydown', onDropdownBack, true); window.removeEventListener('click', onDropdownOutside); });

  // Display labels for the trigger buttons

  // ---- Add to collection / playlist -----------------------------------------------------------
  // The dialog itself lives in the shared component <AddToPicker>; here only the trigger.
  let pickerMode = $state(null);   // null | 'collection' | 'playlist'

  // Trailer modal
  let trailerEmbedUrl = $state(null);
  let showMediaInfo   = $state(false);   // media info modal
  let mediaInfoScroll = $state();           // the modal's scroll container (bind:this, for D-pad scrolling)
  // ▲▼ scroll a long text in a dialog (media info, the whole plot) instead of moving focus
  function scrollByKey(e, el) {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault(); e.stopPropagation();
    el?.scrollBy({ top: e.key === 'ArrowDown' ? 160 : -160, behavior: 'smooth' });
  }

  // The plot stays clamped to four lines (the hero must leave room for the buttons). Where that cuts it, the text is a
  // button and OK shows all of it in a dialog (CODE-HEALTH §136) — on a TV there was no other way to read the rest.
  // Not cut → the button is disabled, which takes it out of the D-pad and the pointer: no extra stop for nothing.
  let overviewClamped = $state(false);
  let showOverview    = $state(false);
  let overviewScroll  = $state();
  let overviewBtn     = $state();
  const overviewFocus = makeFocusReturn();
  $effect(() => { if (!showOverview && overviewFocus.pending) overviewFocus.restore(); });
  // Measured by a ResizeObserver: its first call comes after layout, and it calls again when the box changes (UI size,
  // font). Reading the text makes the attachment start over for another title — a cut and an uncut plot can fill
  // the same four lines, so the box alone would not tell.
  function measureOverview(node) {
    void fullItem?.Overview;
    const ro = new ResizeObserver(() => { overviewClamped = node.scrollHeight > node.clientHeight + 1; });
    ro.observe(node);
    return () => ro.disconnect();
  }

  // The dialog's plot in paragraphs (§145). Most plots come as ONE block (TMDb), a wall of text in the dialog. Blank
  // lines of its own make paragraphs (single line breaks stay, whitespace-pre-line); a long block without any is cut
  // at sentence ends into parts of about PARA characters, as even as the sentences allow. Never after a word of up to
  // three letters, a number or an initial ("Agentin K. Larsen", "Dr.", "z. B.", "3. Oktober", "U.S.A."): a break
  // missed there costs nothing, a wrong one would cut a sentence in two. Intl.Segmenter: Chromium 87, webOS 25 has it.
  const PARA = 320;
  function bySentences(block) {
    const n = Math.round(block.length / PARA);
    if (n < 2 || block.includes('\n') || typeof Intl.Segmenter !== 'function') return [block];
    const sentences = [];
    for (const { segment } of new Intl.Segmenter(i18n.lang, { granularity: 'sentence' }).segment(block)) {
      const last = sentences.length - 1;
      if (last >= 0 && /(?:^|[\s(„"'.])(?:\p{L}{1,3}|\d+)\.$/u.test(sentences[last].trimEnd())) sentences[last] += segment;
      else sentences.push(segment);
    }
    const target = block.length / n, parts = [];
    let cur = '';
    sentences.forEach((sentence, i) => {
      cur += sentence;
      const next = sentences[i + 1];
      // Close the part here when that lands nearer the target than taking the next sentence along.
      if (next === undefined || (parts.length < n - 1 && Math.abs(cur.length - target) <= Math.abs(cur.length + next.length - target))) {
        parts.push(cur.trim()); cur = '';
      }
    });
    return parts;
  }
  const plotParagraphs = (text) => text.split(/\n\s*\n/).map(b => b.trim()).filter(Boolean).flatMap(bySentences);
  let plotParts = $derived(showOverview && fullItem?.Overview ? plotParagraphs(fullItem.Overview) : []);

  // Share: QR code with a public title link (IMDb/TMDb) — anyone can scan it, no server access needed.
  let showShare = $state(false);
  let kebabBtnEl = $state();                 // three-dots button (bind:this)
  const shareFocus = makeFocusReturn();   // focus return after closing the share modal
  // The same return for media info + playlist/collection picker (never open at once): without it
  // focus fell to the body after closing → the navigation caught it (share was correct,
  // the other three weren't). Now it lands back on the three-dots button.
  const menuReturn = makeFocusReturn();
  // May this profile manage collections? Policy.EnableCollectionManagement comes with the
  // login user. Deliberately hide only on an explicit false: if the field is missing, the entry
  // stays visible and the 403 fallback in AddToPicker kicks in. Admins have true.
  const canManageCollections = $derived(selectedUser?.Policy?.EnableCollectionManagement !== false);
  // After closing the share modal, put focus back on the three dots.
  $effect(() => { if (!showShare && shareFocus.pending) shareFocus.restore(); });
  $effect(() => { if (!showMediaInfo && !pickerMode && menuReturn.pending) menuReturn.restore(); });
  let shareQrSvg = $state(null);
  // Public link (IMDb/TMDb) of an item — or null if none can be built. A season has no public ID of its
  // own and an episode only sometimes (IMDb), so both go through their SERIES' IDs: on IMDb the season's
  // episode list, on TMDb the season or episode page. They used to fall back to the plain series page.
  // An episode prefers TMDb's own page over IMDb's season list, a season IMDb's list; season 0 (specials)
  // has no list on IMDb → its series page.
  function buildShareUrl(item, series) {
    const p = item?.ProviderIds || {};
    if (item?.Type !== 'Season' && p.Imdb) return `https://www.imdb.com/title/${p.Imdb}/`;
    if (item?.Type !== 'Season' && item?.Type !== 'Episode')
      return p.Tmdb && (item?.Type === 'Movie' || item?.Type === 'Series')
        ? `https://www.themoviedb.org/${item.Type === 'Series' ? 'tv' : 'movie'}/${p.Tmdb}` : null;
    const sp = series?.ProviderIds || {};
    const sn = item.Type === 'Season' ? item.IndexNumber : item.ParentIndexNumber;
    const en = item.Type === 'Episode' ? item.IndexNumber : null;
    const imdb = sp.Imdb ? `https://www.imdb.com/title/${sp.Imdb}/${sn >= 1 ? `episodes/?season=${sn}` : ''}` : null;
    const tmdb = sp.Tmdb && sn != null ? `https://www.themoviedb.org/tv/${sp.Tmdb}/season/${sn}${en != null ? `/episode/${en}` : ''}` : null;
    return (en != null ? tmdb || imdb : imdb || tmdb) || null;
  }
  // Title as a readable fallback (a scan shows the name to look up, never a dead link). A season or an
  // episode carries its series — "Season 2" alone finds nothing — and an episode the S02E01 form a search
  // understands.
  function shareTitleText(item) {
    const two = (n) => String(n).padStart(2, '0');
    if (item?.SeriesName && item.Type === 'Episode' && item.ParentIndexNumber != null && item.IndexNumber != null)
      return `${item.SeriesName} S${two(item.ParentIndexNumber)}E${two(item.IndexNumber)} – ${item.Name}`;
    if (item?.SeriesName && (item.Type === 'Season' || item.Type === 'Episode')) return `${item.SeriesName} – ${item.Name}`;
    return item?.ProductionYear ? `${item.Name} (${item.ProductionYear})` : (item?.Name || '');
  }
  async function openShare() {
    shareFocus.capture(kebabBtnEl);
    showShare = true;
    shareQrSvg = null;
    try {
      // A season, or an episode without its own IMDb ID, links through its series (see buildShareUrl).
      let series = null;
      if ((fullItem.Type === 'Season' || fullItem.Type === 'Episode') && fullItem.SeriesId && !fullItem.ProviderIds?.Imdb) {
        try {
          const res = await fetch(`${session.serverUrl}/Items/${fullItem.SeriesId}?UserId=${selectedUser.Id}`, { headers: authHeaders() });
          if (res.ok) series = await res.json();
        } catch { /* series unreachable → title fallback below */ }
      }
      const target = buildShareUrl(fullItem, series) || shareTitleText(fullItem);
      dlog('[share]', fullItem.Type, '→', target);
      const { renderSVG } = await import('uqr');   // dynamically loaded, zero-dependency
      shareQrSvg = renderSVG(target || ' ', { ecc: 'M', border: 1 });   // vector instead of PNG → razor sharp
    } catch (e) { console.warn('[OcenFin] share QR failed', e); }
  }

  function formatBytes(bytes) {
    if (!bytes) return null;
    const gb = bytes / 1073741824;
    if (gb >= 1) return `${gb.toFixed(2)} GB`;
    return `${(bytes / 1048576).toFixed(0)} MB`;
  }

  function formatBitrate(bps) {
    if (!bps) return null;
    return `${(bps / 1000000).toFixed(1)} Mbit/s`;
  }

  const YOUTUBE_APP_ID = 'youtube.leanback.v4';   // LG webOS YouTube app

  // The trailer button, for the way back: the overlay takes the focus and closing it removed the
  // focused element with nothing to land on, so the next key opened the sidebar.
  let trailerOpener = null;

  // Which of the title's trailers: the first whose NAME says the app's language, else the first one.
  // Jellyfin keeps no language per trailer, only URL and name, and a normal metadata refresh APPENDS
  // what it fetched to the trailers it had (MetadataService: Concat … DistinctBy Url). A library once
  // read in English, or an NFO file from Radarr/Sonarr, therefore keeps its English trailer IN FRONT of
  // the German ones TMDb returns now — and the first one was all that ever played. TMDb's German
  // trailers mostly say so in the name ("Trailer Deutsch German", CODE-HEALTH §90). Matched at a word
  // start: the language's own name cut to five letters (Русск… also finds "на русском") and its English
  // name. No language codes — "DE", "IT" or "ES" turn up in titles for other reasons.
  function pickTrailer(list) {
    const lang = baseLang(i18n.lang);   // pt-BR looks for "Portu…"/"Portuguese", not "Brazilian"
    const names = [LANGUAGES.find(l => l.key === lang)?.name?.slice(0, 5)];
    try { names.push(new Intl.DisplayNames(['en'], { type: 'language' }).of(lang).split(' ')[0]); } catch { /* own name only */ }
    // Letters only (language names), so nothing in them needs escaping for the RegExp.
    const words = names.filter(Boolean).map(n => new RegExp(`(^|[^\\p{L}])${n}`, 'iu'));
    const i = Math.max(0, list.findIndex(t => words.some(w => w.test(t?.Name || ''))));
    dlog('[trailer]', list.length, 'trailer(s) · playing', i, `"${list[i]?.Name || ''}"`, '· app language', lang);
    return list[i];
  }

  function openTrailer() {
    if (!fullItem?.RemoteTrailers?.length) return;
    trailerOpener = document.activeElement;
    const url     = pickTrailer(fullItem.RemoteTrailers).Url;
    const match   = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([^&?\s]{11})/);
    const videoId = match ? match[1] : null;

    // On the TV: launch the native YouTube app. Embeds fail on webOS due to the referer/
    // platform restriction (error 153), so launching the native app is the reliable path.
    if (videoId && window.webOS?.service?.request) {
      window.webOS.service.request('luna://com.webos.applicationManager', {
        method: 'launch',
        parameters: { id: YOUTUBE_APP_ID, params: { contentTarget: `v=${videoId}` } },
        onFailure: () => {   // app not present etc. → embed as a fallback
          trailerEmbedUrl = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0&playsinline=1&modestbranding=1`;
        },
      });
      return;   // the YouTube app takes over; no in-app modal needed
    }

    // Browser/development (no webOS) or no YouTube URL → via overlay as before.
    if (videoId) {
      trailerEmbedUrl = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0&playsinline=1&modestbranding=1`;
    } else if (/^https?:\/\//i.test(url)) {
      // Raw fallback = a direct video-file trailer. RemoteTrailers[].Url is EXTERNAL metadata
      // (TMDb/NFO scrape), so accept only an http(s) URL here — a javascript:/data: value must
      // never reach the <video>/<iframe> src below. The iframe branch is additionally pinned to
      // our own youtube-nocookie URLs (see the template), so external input can never select it.
      trailerEmbedUrl = url;
    }
  }

  // Cast: actors (max. 20) from the People data, ONE card per person. Jellyfin lists a person once per role — a voice
  // actor with three characters, as anime metadata names each one — and the row is keyed by Id: the repeated Id threw
  // each_key_duplicate and the page never finished loading (CODE-HEALTH §131). The roles go onto the one card.
  let castMembers = $derived.by(() => {
    const byId = new Map();
    for (const p of fullItem?.People || []) {
      if (p.Type !== 'Actor') continue;
      const seen = byId.get(p.Id);
      if (!seen) byId.set(p.Id, { ...p });
      else if (p.Role && !(seen.Role || '').split(' / ').includes(p.Role)) seen.Role = seen.Role ? `${seen.Role} / ${p.Role}` : p.Role;
    }
    return [...byId.values()].slice(0, 20);
  });

  // An episode's place and air date, in place of the year at the start of the meta line (TitleMeta, CODE-HEALTH §136):
  // "S1:E2", "S1:E2–3" for a double episode (episodeCode, as every card writes it since §141), the date in the UI
  // language. In UTC: PremiereDate is midnight UTC, and local time west of Greenwich showed the day before. With no
  // number, no date and no year there is nothing to lead with — null, and the line starts with the running time.
  let episodeMeta = $derived.by(() => {
    if (fullItem?.Type !== 'Episode') return null;
    const code = episodeCode(fullItem);
    const d = fullItem.PremiereDate ? new Date(fullItem.PremiereDate) : null;
    const date = d && !isNaN(d) ? d.toLocaleDateString(i18n.lang, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }) : '';
    return code || date || fullItem.ProductionYear ? { code, date } : null;
  });
  // A started title says how much is left, in the words of the Continue watching pill (minutesLeft, utils.js), in the
  // meta row before "ends at" — on the Resume button it pushed the icon buttons onto a second line (§137).
  let resumeLeft = $derived(minutesLeft(fullItem));
  // Genres and direction, one quiet line above the plot (CODE-HEALTH §135): the genres the library's info preview
  // shows, plus who directed it — both come with /Items/{id}. Three at most each (an anthology names a dozen
  // directors); a director is listed once per Id, like the cast. Writers and studios left out on purpose.
  let genreLine = $derived((fullItem?.Genres || []).slice(0, 3).join(' · '));
  let directors = $derived.by(() => {
    const names = [...new Map((fullItem?.People || []).filter(p => p.Type === 'Director' && p.Name)
      .map(p => [p.Id || p.Name, p.Name])).values()];
    if (!names.length) return null;
    const list = names.length > 3 ? names.slice(0, 3).join(', ') + ' …'
      : new Intl.ListFormat(i18n.lang, { type: 'conjunction' }).format(names);
    const [pre, post = ''] = i18n.t.directedBy.split('{names}');
    return { pre, list, post };
  });

  function closeTrailer() {
    trailerEmbedUrl = null;
    const el = trailerOpener;
    trailerOpener = null;
    tick().then(() => { if (el?.isConnected) el.focus(); });
  }


  // Stale guard (pattern like in Search/Library): the breadcrumb navigation (episode → series → season)
  // switches the item quickly in succession — only responses to the MOST RECENT request may
  // write fullItem/relatedItems/similarItems, otherwise a slow old response overwrites
  // the new view.
  let detailToken = 0;

  // Reactive: reloads as soon as the 'item' prop changes. untrack() so the effect reacts ONLY to
  // item — not to session/selectedUser that loadFullDetails reads synchronously internally.
  // A change of `item` means a FRESH entry from App, never internal navigation — so the chain
  // starts over and Back leads back out rather than sideways into the previous visit.
  $effect(() => {
    const id = item?.Id;
    if (!id) return;
    untrack(() => {
      // Back from a collection, a person page or the player opened from this page: App returns what was on screen and the chain
      // that led there, so we land on THAT title rather than the entry point. A function, called
      // once — a plain prop would still be lying around for the next, unrelated mount.
      const resume = takeResume?.();
      dlog('[details] mount', id, resume ? `→ shows ${resume.id}, ${resume.stack.length} step(s) back` : '(fresh)');
      navStack = resume ? [...resume.stack] : [];
      restorePending = !!focusItemId;   // set BEFORE the load, so the play button holds back
      if (resume) loadFullDetails(resume.id, resume.card);
      else        loadFullDetails(id, cardOf(item));
      restoreSpot({ focusId: focusItemId, scrollTop: focusScrollTop });
    });
  });

  // Theme music (opt-in): resolve per item and per scope. Movie ↔ scope 'movies', the whole
  // series family (Series/Season/Episode) ↔ scope 'series'; anything else never plays. The module
  // keeps ONE audio element across item changes, so browsing within a series doesn't restart the
  // theme — identity is the ThemeSongsResult.OwnerId, i.e. the series. Everything async and every
  // failure is silent inside the module. Leaving the view (dashboard OR starting playback — both
  // unmount Details, the Player replaces the view) fades out via onDestroy below.
  //
  // Keyed on fullItem, NOT on item: `item` is the ENTRY point and deliberately stays put while the
  // page navigates on (§19), so a jump through "more like this" never reached this effect and the
  // previous title's theme kept playing under a different film. `fullItem` is what is on screen.
  //
  // While it is null the effect does NOT stop anything: navigateTo()/handleBackKey() blank it for
  // the spinner, and stopping there would chop the theme on every step INSIDE a series, which the
  // OwnerId identity above exists to avoid. The new title's own call settles it a moment later —
  // same owner keeps playing, a different owner swaps, and no theme at all resolves to silence
  // inside playThemeFor().
  $effect(() => {
    const shown = fullItem;
    const on    = !!playbackPrefs.themeMusic;
    const scope = playbackPrefs.themeMusicScope || 'both';
    const vol   = playbackPrefs.themeMusicVolume ?? 40;
    if (!on) { stopTheme(); return; }
    if (!shown?.Id) return;                     // still loading — leave what is playing alone
    const type = shown.Type;
    const fits = (type === 'Movie' && scope !== 'series')
              || ((type === 'Series' || type === 'Season' || type === 'Episode') && scope !== 'movies');
    if (fits) untrack(() => playThemeFor(shown, selectedUser.Id, vol));
    else stopTheme();
  });
  onDestroy(stopTheme);

  let loadStartedAt = 0;   // for the similar-row timing below
  // The title could not be loaded: deleted meanwhile (from Continue watching, the watchlist, a
  // suggestion), no access any more, or the server did not answer. The page used to stay EMPTY —
  // no message, nothing focusable, the next key opened the sidebar.
  let loadError = $state(false);
  // What the rows under a title ask for: the type decides, and for an episode or a season so do its
  // series and season. All of that comes with every LIST item too, so the card a title was opened
  // from already knows it — and the rows can be asked for together with the title instead of a round
  // trip after it (§132). `cardOf` keeps only those fields, for the way back as well.
  const cardOf = (it) => (it?.Id && it.Type) ? { Id: it.Id, Type: it.Type, SeriesId: it.SeriesId, SeasonId: it.SeasonId } : null;
  function rowsFor(it) {
    const t = it.Type;
    return {
      similar: (t === 'Season' || t === 'Episode') ? (it.SeriesId || it.Id) : it.Id,
      related: t === 'Episode' ? (it.SeasonId || null) : (t === 'Series' || t === 'Season') ? it.Id : null,
      next:    (t === 'Series' || t === 'Season') ? it.Id : null,
    };
  }
  // What is in flight for the title being loaded. An answer for anything else is dropped — that is
  // how a row asked for on the card's word is corrected once the title says otherwise.
  let asked = { similar: null, related: null, next: null };
  // A row that comes in with the title waits for the frame AFTER the one that first draws it: drawn in
  // the same frame, the rows cost the title 9 ms on a throttled CPU (§132), and the title is what a
  // page is judged by. One frame later is still a whole round trip earlier than they used to come.
  // Not the next episode: it names the play button, which belongs to the title.
  let titleDrawn = Promise.resolve();
  function askRows(it, myToken) {
    const want = rowsFor(it);
    if (want.similar !== asked.similar) { asked.similar = want.similar; similarItems = []; loadSimilarItems(want.similar, myToken); }
    if (want.related !== asked.related) { asked.related = want.related; relatedItems = []; if (want.related) loadRelatedItems(want.related, myToken); }
    if (want.next !== asked.next)       { asked.next = want.next; nextToPlay = null; if (want.next) loadNextToPlay(it, myToken); }
  }

  async function loadFullDetails(itemId, card = null) {
    const myToken = ++detailToken;
    loadStartedAt = performance.now();
    isLoading    = true;
    loadError    = false;
    fullItem     = null;
    relatedItems = [];
    nextToPlay = null;
    focusedEpisode = null;
    similarItems = [];
    collections  = [];
    extras = [];
    earlier = null;
    selectedAudioIndex    = -1;
    selectedSubtitleIndex = -1;
    selectedMediaSourceId = null;
    asked = { similar: null, related: null, next: null };
    let drawn;
    titleDrawn = new Promise(r => { drawn = r; });

    // The rows go out WITH the title, not after it. They stay off screen until it is there
    // ({:else if fullItem}), so a quick one cannot land first.
    loadCollections(itemId, myToken);
    loadExtras(itemId, myToken);
    if (card?.Id === itemId) askRows(card, myToken);

    try {
      const res = await fetch(
        `${session.serverUrl}/Items/${itemId}?UserId=${selectedUser.Id}`,
        { headers: authHeaders() }
      );
      if (res.ok) {
        const data = await res.json();
        if (myToken !== detailToken) return;   // a different item was opened meanwhile → discard
        fullItem = data;
        // The rows now share the server with this request (§132) — this tells whether a server keeps the title quick.
        dlog('[details] title in', Math.round(performance.now() - loadStartedAt), 'ms', card?.Id === itemId ? '(rows asked along)' : '');

        if (fullItem.MediaSources?.length > 0) {
          const src = fullItem.MediaSources[0];
          selectedMediaSourceId = src.Id;   // preselect the first version
          applySourceDefaults(src);
        }

        // "Similar" for a season or an episode goes through the SERIES (otherwise the server returns
        // similar seasons of other series). Asked again only where the title says something else than
        // the card did — or when there was no card to go by.
        askRows(fullItem, myToken);
      } else {
        console.warn('[details] item', itemId, '→ HTTP', res.status);
        if (myToken === detailToken) loadError = true;
      }
    } catch (e) { console.error(e); if (myToken === detailToken) loadError = true; }
    // Only clear the spinner if we're still current — otherwise an old response kills the new one's.
    finally {
      if (myToken === detailToken) isLoading = false;
      requestAnimationFrame(() => requestAnimationFrame(drawn));   // the first frame draws the title
    }
  }

  // Extras / special features of the opened item (movie, series or season).
  // NOTE: the endpoint returns a DIRECT array, not { Items }.
  async function loadExtras(itemId, myToken) {
    try {
      const res = await fetch(
        `${session.serverUrl}/Items/${itemId}/SpecialFeatures?userId=${selectedUser.Id}`,
        { headers: authHeaders() }
      );
      if (res.ok) { const d = await res.json(); await titleDrawn; if (myToken !== detailToken) return; extras = Array.isArray(d) ? d : (d.Items || []); }
    } catch { /* extras are optional */ }
  }

  // Collections that contain this very title — new in Jellyfin 12. Older servers answer 404 and the
  // row simply stays away. Its cards carry data-item-id, so the way back from a collection can land
  // on them; that relies on the row being quick, which the timing line is there to confirm.
  async function loadCollections(itemId, myToken) {
    const t0 = performance.now();
    try {
      const res = await fetch(
        `${session.serverUrl}/Items/${itemId}/Collections?UserId=${selectedUser.Id}`,
        { headers: authHeaders() }
      );
      if (!res.ok) return;
      const d = await res.json();
      await titleDrawn;
      if (myToken !== detailToken) return;
      collections = d.Items || [];
      dlog('[details] collections', collections.length, 'in', Math.round(performance.now() - t0), 'ms');
    } catch { /* optional row */ }
  }

  async function loadSimilarItems(itemId, myToken) {
    const t0 = performance.now();
    try {
      const res = await fetch(
        `${session.serverUrl}/Items/${itemId}/Similar?Limit=10`,
        { headers: authHeaders() }
      );
      if (res.ok) {
        const d = await res.json();
        await titleDrawn;
        if (myToken !== detailToken || asked.similar !== itemId) return;
        similarItems = d.Items || [];
        // The way back onto a suggestion card relies on this row arriving inside restoreSpot's
        // ~1.2 s (CODE-HEALTH §40) — this line tells whether a server still manages that.
        const now = performance.now();
        dlog('[details] similar', similarItems.length, 'items · request', Math.round(now - t0), 'ms · on screen',
             Math.round(now - loadStartedAt), 'ms after the page started (restore waits ~1200 ms)');
      }
    } catch (e) { console.error(e); }
  }

  async function loadNextToPlay(it, myToken) {
    try {
      const ep = await playableFor(it, { serverUrl: session.serverUrl, userId: selectedUser.Id, headers: authHeaders() });
      if (myToken === detailToken && asked.next === it.Id) nextToPlay = ep;
    } catch { /* the button just says "Play"; handlePlay resolves it again */ }
  }

  async function loadRelatedItems(parentId, myToken) {
    try {
      const res = await fetch(
        `${session.serverUrl}/Items?UserId=${selectedUser.Id}&ParentId=${parentId}&Fields=Overview&ImageTypeLimit=1&SortBy=SortName&IsMissing=false&EnableTotalRecordCount=false`,
        { headers: authHeaders() }
      );
      if (res.ok) { const d = await res.json(); await titleDrawn; if (myToken !== detailToken || asked.related !== parentId) return; relatedItems = d.Items || []; }
    } catch (e) { console.error(e); }
  }

  // The series/season starts and the random episode wait on the server. Gone or on another title by
  // the time it answers (Back, a step along the chain, a second press already playing) → nothing
  // is started: the Player used to pop up over whatever was on screen by then.
  let alive = true;
  onDestroy(() => { alive = false; });
  const stillHere = (id) => alive && fullItem?.Id === id;

  async function handlePlay() {
    if (fullItem.Type === 'Series' || fullItem.Type === 'Season') {
      const startedOn = fullItem.Id;
      // Series: Next Up, and once everything is watched the first episode again. Season: its first
      // unwatched episode, else its first. Neither lands on a special or a placeholder episode
      // (playback.js). The season used to ask for "IsNotPlayed", a filter Jellyfin does not have —
      // it was dropped silently, so a season always started at its episode 1.
      try {
        // The one the button names, if it is known already; otherwise resolve it now.
        const ep = nextToPlay || await playableFor(fullItem, { serverUrl: session.serverUrl, userId: selectedUser.Id, headers: authHeaders() });
        if (ep && stillHere(startedOn)) onPlayVideo?.({ item: ep, audioIndex: -1, subtitleIndex: -1 });
      } catch (e) { console.error(e); }
    } else {
      onPlayVideo?.({ item: fullItem, audioIndex: selectedAudioIndex, subtitleIndex: selectedSubtitleIndex, mediaSourceId: selectedMediaSourceId, tracksChosen: true });
    }
  }

  // "From the beginning": same item, but resume position at 0 → the Player starts at zero.
  function playFromBeginning() {
    const fresh = { ...fullItem, UserData: { ...(fullItem.UserData || {}), PlaybackPositionTicks: 0 } };
    onPlayVideo?.({ item: fresh, audioIndex: selectedAudioIndex, subtitleIndex: selectedSubtitleIndex, mediaSourceId: selectedMediaSourceId, tracksChosen: true });
  }

  // Random episode — for long series "just play something". Series → from ALL episodes (recursively across all
  // seasons, specials/season 0 excluded); season → only from this season. Uniformly distributed, incl. already
  // watched ones (deliberately: comfort rewatch). Ends up in the Player via onPlayVideo like handlePlay.
  async function playRandomEpisode() {
    // Shared expansion (playback.js): all episodes across seasons for a series, this season only
    // for a season, specials excluded — the identical pool the old inline query built; the random
    // draw ignores buildPlayQueue's ordering.
    const startedOn = fullItem.Id;
    const pool = await buildPlayQueue([fullItem], { serverUrl: session.serverUrl, userId: selectedUser.Id, headers: authHeaders() });
    if (!pool.length || !stillHere(startedOn)) return;
    onPlayVideo?.({ item: pool[Math.floor(Math.random() * pool.length)], audioIndex: -1, subtitleIndex: -1 });
  }

  // Both toggles act on what is ON SCREEN and additionally write the change into the ENTRY object,
  // because that is the very object the origin list renders — which is what makes the card behind us
  // update without a reload. That second write is only correct while the page still shows the title
  // we came in on: after a jump through "more like this" the entry is a different film, and marking
  // THIS one watched used to put the tick on ITS card in the library. Both are captured once, so a
  // rollback cannot land on a title the user navigated to in the meantime.
  async function togglePlayed() {
    // Toggle optimistically and locally — no reload of the whole detail page
    const shown = fullItem;
    const carry = !!item && item.Id === shown.Id;
    const willBePlayed = !shown.UserData?.Played;
    shown.UserData = { ...shown.UserData, Played: willBePlayed };
    if (carry) item.UserData = { ...item.UserData, Played: willBePlayed };
    if (await setPlayed(shown.Id, selectedUser.Id, willBePlayed)) {
      // The home screen's Continue watching and Up next follow — a series or season marked here takes its
      // episode out of Continue watching, an episode moves Up next on (CODE-HEALTH §140)
      onProgressChanged?.();
    } else {
      // Roll back — an error ANSWER counts too: the tick used to stay although the server had refused
      shown.UserData = { ...shown.UserData, Played: !willBePlayed };
      if (carry) item.UserData = { ...item.UserData, Played: !willBePlayed };
    }
  }

  // "Mark earlier episodes as watched" (playback.js) from the ⋮ menu of an episode or a season. The entry
  // reports in place — how many, or that everything before was watched already — and the menu stays
  // open; episodes in the row below that were marked get their tick at once. Bound to the title it
  // started on: after a step along the chain meanwhile, the new page is left alone. State: `earlier`, above.
  async function markEarlier() {
    if (earlier) return;
    const on = fullItem;
    earlier = 'busy';
    try {
      const { found, done } = await markEarlierPlayed(on, { serverUrl: session.serverUrl, userId: selectedUser.Id, headers: authHeaders() });
      if (done.length) onProgressChanged?.();
      if (fullItem !== on) return;
      const marked = new Set(done);
      for (const ep of relatedItems) if (marked.has(ep.Id)) ep.UserData = { ...ep.UserData, Played: true, PlaybackPositionTicks: 0 };
      earlier = found && !done.length ? null : { n: done.length };
    } catch (e) {
      console.warn('[details] mark earlier episodes:', e?.message || e);
      if (fullItem === on) earlier = null;
    }
  }

  async function toggleFavorite() {
    const shown = fullItem;
    const carry = !!item && item.Id === shown.Id;   // see togglePlayed above
    const willBeFav = !shown.UserData?.IsFavorite;
    shown.UserData = { ...shown.UserData, IsFavorite: willBeFav };
    if (carry) item.UserData = { ...item.UserData, IsFavorite: willBeFav };
    if (!(await setFavorite(shown.Id, selectedUser.Id, willBeFav))) {   // rolled back, see togglePlayed
      shown.UserData = { ...shown.UserData, IsFavorite: !willBeFav };
      if (carry) item.UserData = { ...item.UserData, IsFavorite: !willBeFav };
    }
  }

  // Navigating INSIDE this page — a season from a series, an episode from a season, the series or
  // season from the breadcrumb, another title from "more like this". All of it stays here rather
  // than going through App: `item` is the ENTRY point and App's return logic depends on it staying
  // that way (which card to focus again, whether the opened title still matches the library's
  // filter). What is currently shown is `fullItem`, and that is what this chain tracks.
  //
  // Ids, not objects: coming back reloads through the same path, so related titles, extras and the
  // rest are rebuilt as well instead of a restored item sitting next to stale lists.
  // Each step also carries where you were standing on that page — the card and how far it was
  // scrolled — so coming back lands exactly there instead of at the top, as everywhere else in
  // the app.
  let navStack = [];
  let scrollEl = $state();
  let rootEl;               // the page's root — restoreSpot watches it for the card to appear
  // While a spot is being restored the play button must NOT grab focus on mount, or it would win
  // the race against the card, which only exists once its row has loaded.
  //
  // Deliberately NOT $state, and deliberately never cleared while a restore runs. `{@attach}` is a
  // reactive expression: making this a rune meant Svelte tore the attachment down and built it
  // again the moment the flag flipped back — and building it CALLS it, so the play button grabbed
  // focus right after the card had been given it. Measured with a probe: mount ran with
  // enabled=false (the brake worked), then flipping the flag ran it again with enabled=true and
  // moved focus. It was never the brake that failed, it was releasing it.
  //
  // As a plain variable it is read once, when the button mounts. Every ENTRY point sets it — a
  // forward jump to false, a step back or a hand-off from App to true — so it is always correct at
  // that moment and nothing has to touch it in between.
  let restorePending = false;
  // Passed to {@attach} as the function ITSELF, never as focusOnMount(!restorePending): a call in
  // the template would read the flag there, which both makes Svelte demand $state for it and brings
  // back the bug that costs — as $state the attachment is rebuilt when the flag flips, and building
  // an attachment RUNS it, so the play button stole focus right after the card had it. Read here,
  // the flag is evaluated once, at mount.
  const focusUnlessRestoring = (node) => { if (!restorePending) node.focus(); };
  const NAV_STACK_MAX = 30;   // the app runs for days; series ↔ season ping-pong must not grow forever

  // Every step remembers the card it left from and the scroll offset, the suggestions row included.
  // That row used to be the one exception (§19/§28): /Items/{id}/Similar came too late for
  // restoreSpot on Jellyfin 10.x. On 12.1 it was measured on the B4 at 215–296 ms after the page
  // started (CODE-HEALTH §40), well inside the window, so it is restored like every other row.
  function navigateTo(id, card = null) {
    restorePending = false;   // going forward: the play button is the right landing spot again
    if (fullItem?.Id) {
      navStack.push({
        id: fullItem.Id,
        card: cardOf(fullItem),
        focusId: document.activeElement?.getAttribute?.('data-item-id') ?? null,
        scrollTop: scrollEl?.scrollTop || 0,
      });
      if (navStack.length > NAV_STACK_MAX) navStack.shift();
    }
    isLoading = true;
    fullItem  = null;   // show the spinner immediately
    loadFullDetails(id, cardOf(card));
  }

  // For App, before it leaves for a view that unmounts us: the title on screen and the chain behind
  // it, since both live only in this component. Handed back through takeResume.
  export function snapshot() {
    return fullItem?.Id ? { id: fullItem.Id, card: cardOf(fullItem), stack: navStack.map(s => ({ ...s })) } : null;
  }

  // Back: one level up inside the page first. Returns false once the chain is empty, which is the
  // parent's signal to leave Details altogether — same contract as Collection.handleBackKey().
  export function handleBackKey() {
    const prev = navStack.pop();
    if (prev === undefined) return false;
    restorePending = !!prev.focusId;
    isLoading = true;
    fullItem  = null;
    loadFullDetails(prev.id, prev.card);
    restoreSpot(prev);
    return true;
  }

  // The row holding that card is fetched separately and arrives after the title itself, so this
  // waits for it — bounded attempts, no interval, in the shape App uses for the same job. Scroll
  // first, then focus: focusing alone would only drag the card barely into view and leave the page
  // somewhere else. Stands down as soon as anything else holds focus, so it cannot fight a user
  // who navigated on, and gives up quietly if that card is gone.
  async function restoreSpot({ focusId, scrollTop }) {
    if (!focusId) return;
    const myToken = detailToken;
    let tries = 0, lastTop = null, settled = 0;

    // Applying the offset once is not enough: the page arrives in stages, so with rows still
    // missing below it gets clamped (900 became 602 in a measurement) and with a row arriving above
    // the card slides down. So it re-applies until the card's position and the offset hold still.
    const attempt = () => {
      if (myToken !== detailToken) return sighting?.disconnect();   // a newer navigation took over
      const card = scrollEl?.querySelector(`[data-item-id="${focusId}"]`);
      const active = document.activeElement;
      if (active && active !== document.body && active !== card) return sighting?.disconnect();   // focus moved on
      if (card) {
        sighting?.disconnect();
        scrollEl.scrollTop = scrollTop;                // the view first, then the focus
        card.focus();
        const pos = card.offsetTop;
        settled = (pos === lastTop && scrollEl.scrollTop === scrollTop) ? settled + 1 : 0;
        lastTop = pos;
        if (settled >= 3) return;                      // nothing moved any more — done
      }
      if (++tries < 24) { setTimeout(attempt, 50); return; }   // ~1.2 s, ample for those rows
      sighting?.disconnect();
      // Gave up without the card: its row never came (a server under load) or the card is gone.
      // The play button held back its own focus for this restore, so without this nothing would be
      // focused and the next key press would open the sidebar. Land where a fresh page lands.
      if (!card && (!document.activeElement || document.activeElement === document.body)) {
        scrollEl?.querySelector('[data-primary-action]')?.focus();
      }
    };
    await tick();
    // The card's row lands BETWEEN two steps, and for up to 50 ms the page stood there unscrolled with
    // nothing focused (§132). So the moment the card appears, the spot is applied once — before that
    // frame is painted. Only that first sighting: whether things hold still is still judged by the
    // steps above, which count from their own first sighting exactly as before.
    // Watched on the root: the scroller itself is still missing while the spinner shows.
    const sighting = rootEl && new MutationObserver(() => {
      if (myToken !== detailToken) { sighting.disconnect(); return; }
      const card = scrollEl?.querySelector(`[data-item-id="${focusId}"]`);
      if (!card) return;
      sighting.disconnect();
      const active = document.activeElement;
      if (active && active !== document.body && active !== card) return;
      scrollEl.scrollTop = scrollTop;
      card.focus();
    });
    sighting?.observe(rootEl, { childList: true, subtree: true });
    attempt();
  }



  // Backdrop and logo — the title's own, else its series' (an episode, a season); null → no picture / the text title
  const getItemBackdropUrl = (targetItem) => backdropUrl(targetItem, 1920, 80);
  const getItemLogoUrl = (targetItem) => logoUrl(targetItem, 200);

  // Spoiler protection: slightly obscure unwatched episodes. Excluded are seasons (posters),
  // already started, watched and favorite-marked episodes.
  function epSpoiler(ep) {
    return spoilerProtection
      && ep?.Type === 'Episode'
      && !ep.UserData?.Played
      && !(ep.UserData?.PlaybackPositionTicks > 0)
      && !ep.UserData?.IsFavorite;
  }

  function getMediaStreams(type) {
    return (selectedSource?.MediaStreams || []).filter(s => s.Type === type);
  }

</script>

<!-- The meta line's parts that only the title page has (TitleMeta): an episode's number and air date in place of the
     year, and after the running time what is left of a started title and when it would end -->
{#snippet episodeLead()}
  {#if episodeMeta.code}<span class="text-blue-400 whitespace-nowrap">{episodeMeta.code}</span>{/if}
  {#if episodeMeta.date}<span class="whitespace-nowrap">{episodeMeta.date}</span>{:else if fullItem.ProductionYear}<span>{fullItem.ProductionYear}</span>{/if}
{/snippet}
{#snippet endsAt()}
  <span class="text-base font-normal text-gray-400 ml-1">{resumeLeft ? `${resumeLeft} ${i18n.t.mins} ${i18n.t.remaining} · ` : ''}{endsAtLabel(fullItem, use24h)}</span>
{/snippet}

<!-- An audio or subtitle track: language, forced/SDH/original and what its title adds, then codec or format dimmer (tracklabel.js, §138) -->
{#snippet trackName(s)}
  {@const l = trackNames.get(s?.Index)}
  {#if l}{l.main}{#if l.tech}<span class="opacity-70">{' · ' + l.tech}</span>{/if}{/if}
{/snippet}

<!-- A version as the list and its field name it: its own name, then resolution, range and codec dimmer (sourceLabels) -->
{#snippet versionLabel(src)}
  {@const l = sourceLabels.get(src?.Id)}
  {#if l}{#if l.name}{l.name}{#if l.tech}<span class="opacity-70">{' · ' + l.tech}</span>{/if}{:else}{l.tech}{/if}{#if l.extra}<span class="opacity-70">{' · ' + l.extra}</span>{/if}{/if}
{/snippet}

<div bind:this={rootEl} class="flex flex-col h-full relative overflow-hidden" style:background-color={tint?.bg}>
  {#if isLoading}
    <div class="flex-1 flex items-center justify-center">
      <div class="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
    </div>

  {:else if loadError}
    <div class="flex-1 flex flex-col items-center justify-center gap-6 p-10 text-center" data-focus-group="details-top">
      <p class="text-2xl text-gray-300 font-semibold max-w-xl">{i18n.t.itemLoadFailed}</p>
      <button onclick={() => { if (!handleBackKey()) onClose?.(); }} {@attach focusOnMount()}
        class="bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 px-8 py-3 rounded-lg text-white font-bold focus:outline-none focus:ring-4 focus:ring-white">
        {i18n.t.back}
      </button>
    </div>

  {:else if fullItem}

    <!-- scroll-padding-top: spatial navigation scrolls with block:'nearest', which parks an
         element flush against the top edge — the back button would sit at the very screen
         edge with its ring-4 focus ring clipped. Same value as in Library/Settings. -->
    <div bind:this={scrollEl} class="flex-1 overflow-y-auto hide-scrollbar [scroll-padding-top:4rem]">

      <!-- ════ CINEMATIC HERO BANNER — the backdrop scrolls along, fading into the page colour (title tint, else app gray) at bottom/left ════ -->
      <div class="relative">
        {#if detailsBackdrop && getItemBackdropUrl(fullItem)}
          <div class="absolute inset-0 z-0 max-h-[95vh] overflow-hidden" style:--color-gray-900={tint?.bg}>
            <img src={getItemBackdropUrl(fullItem)} {@attach blurUp(itemBlurHash(fullItem, 'Backdrop'))} alt="" class="w-full h-full object-cover object-top" />
            <div class="absolute inset-0 bg-gradient-to-t from-gray-900 via-gray-900/60 to-gray-900/20"></div>
            <div class="absolute inset-0 bg-gradient-to-r from-gray-900 via-gray-900/40 to-transparent"></div>
          </div>
        {/if}

        <!-- z-20 keeps the hero above the content rows below (z-10): "relative z-10" there
             creates its own stacking level, so the absolutely positioned "More" dropdown
             would otherwise be painted *underneath* the opaque rows and appear cut off. -->
        <div class="relative z-20 p-10 pt-16">

          <!-- BREADCRUMB + BACK -->
      <div class="flex items-center gap-6 mb-10" data-focus-group="details-top">
        <button onclick={() => { if (!handleBackKey()) onClose?.(); }}
          class="bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 px-6 py-2 rounded-lg text-white font-bold focus:outline-none focus:ring-4 focus:ring-white">
          {i18n.t.back}
        </button>
        {#if fullItem.Type === 'Episode'}
          <div class="flex items-center text-xl font-semibold text-gray-400 gap-2">
            <button onclick={() => navigateTo(fullItem.SeriesId, { Id: fullItem.SeriesId, Type: 'Series' })}
              class="hover:text-white focus:text-white focus:outline-none">{fullItem.SeriesName}</button>
            <span>/</span>
            <button onclick={() => navigateTo(fullItem.SeasonId, { Id: fullItem.SeasonId, Type: 'Season', SeriesId: fullItem.SeriesId })}
              class="hover:text-white focus:text-white focus:outline-none">{fullItem.SeasonName}</button>
          </div>
        {:else if fullItem.Type === 'Season' && fullItem.SeriesId}
          <!-- A season page said only "Season 2" — which series, the page did not tell. -->
          <div class="flex items-center text-xl font-semibold text-gray-400 gap-2">
            <button onclick={() => navigateTo(fullItem.SeriesId, { Id: fullItem.SeriesId, Type: 'Series' })}
              class="hover:text-white focus:text-white focus:outline-none">{fullItem.SeriesName}</button>
          </div>
        {/if}
      </div>

      <!-- HERO — the focus group spans the poster too, although nothing in it is focusable. Up/Down
           only hands over to a group that overlaps horizontally (spatialnav nearestGroup), and Back
           sits above the poster: with the group on the text column alone, Down from Back skipped
           the play button and landed in the episodes or cast row below. -->
      <div class="flex gap-12 items-start mb-8" data-focus-group="details-hero">

        <!-- With a picture its own height; without one the shape of the cards (an episode's still is 16:9) — the box had
             no height then and showed as a thin line (§143). -->
        <div class="w-64 shrink-0 rounded-xl overflow-hidden shadow-2xl border-2 border-gray-700 bg-gray-800 relative
          {getItemImageUrl(fullItem) ? '' : fullItem.Type === 'Episode' ? 'aspect-video' : 'aspect-[2/3]'}"
          style:--tw-shadow-color={tint?.glow}>
          {#if getItemImageUrl(fullItem)}
            <img src={getItemImageUrl(fullItem)} {@attach blurUp(itemBlurHash(fullItem))} alt={fullItem.Name} class="w-full h-full object-cover" />
          {/if}
          {#if itemProgress(fullItem) > 0}
            <!-- Resume progress on the poster — same style as the episode thumbnails -->
            <div class="absolute bottom-0 left-0 w-full h-1.5 bg-gray-900/80">
              <div class="h-full bg-blue-500" style="width:{itemProgress(fullItem)}%"></div>
            </div>
          {/if}
        </div>

        <!-- The width cap sits on the text (title, meta, description), not on this column: the action
             row may run past the text into the free space on the right. Capped, it was 1120px wide
             and its labelled buttons shrank until "Von Anfang an" wrapped; the widest rows (Russian,
             series with a trailer) need 1241px of the 1320px there are. Where even that is not
             enough (UI size "large", nearly every language) the row wraps: the icon buttons move to
             a second line instead of a label breaking into three lines or the row running off screen. -->
        <div class="flex-1 min-w-0">
          <!-- line-clamp-2: an unbounded title wraps and pushes the description and the action
               buttons down, and the hero area is capped at 95vh — so they can leave the screen. -->
          <!-- Off by default on purpose: the poster to the left already carries the title as
               artwork, so a logo beside it shows the same thing twice. Kept as a positive opt-in
               ("show the logo") rather than an inverted "show text instead" — an inverted label
               reads as a double negative when switched off, and flipping the meaning of a key that
               is already persisted would silently invert it for everyone who had set it. -->
          {#if detailsLogo}
            <!-- Reserved slot, only while logos are enabled. A logo's height depends entirely on
                 its aspect ratio — a wide wordmark is short, a stacked emblem is tall — and a
                 title without a logo falls back to text at a third height again. Without a floor,
                 the meta row and the play buttons sat at a different height on every title you
                 opened. min-h (not a fixed h) keeps the common cases identical while still letting
                 a rare two-line fallback title have its second line, and costs nothing when the
                 option is off. items-end pins the baseline, so the gap below is always the same. -->
            <div class="min-h-28 max-w-4xl flex items-end mb-4">
              {#if getItemLogoUrl(fullItem)}
                <img src={getItemLogoUrl(fullItem)} alt={fullItem.Name}
                     class="max-h-28 max-w-full w-auto object-contain object-left-bottom drop-shadow-lg" />
              {:else}
                <h1 class="text-6xl leading-[1.3] -my-[0.15em] font-bold text-white drop-shadow-lg line-clamp-2">{fullItem.Name}</h1>
              {/if}
            </div>
          {:else}
            <!-- leading-[1.3] + the negative margin: a clamp hides overflow, and at text-6xl's line height of 1 that cut
                 the descenders (p, g, y) off every title. The margin gives the extra height back, so a one-line title
                 sits where it did (§143). Every big title that clamps or truncates does the same. -->
            <h1 class="max-w-4xl text-6xl leading-[1.3] -mt-[0.15em] mb-[calc(1rem-0.15em)] font-bold text-white drop-shadow-lg line-clamp-2">{fullItem.Name}</h1>
          {/if}

          <!-- META — the line the banner and the library's preview show too (TitleMeta, §141); an episode leads with its
               number and air date (§136), a film or episode adds time left and "ends at" after its running time -->
          <TitleMeta item={fullItem} lead={episodeMeta ? episodeLead : null} extra={endsAt}
            class="max-w-4xl flex items-center flex-wrap gap-4 text-lg font-semibold text-gray-200 mb-6 [text-shadow:0_1px_4px_rgba(0,0,0,0.75)]" />

          {#if techBadges.length}
            <!-- Technical capabilities of the selected version (reactive: see techBadges) -->
            <div class="flex items-center flex-wrap gap-2 -mt-3 mb-6">
              {#each techBadges as badge (badge.label)}
                <span class="px-2.5 py-1 rounded text-sm font-bold tracking-wide border {badge.premium ? 'bg-white/15 border-white/30 text-white' : 'bg-black/40 border-white/15 text-gray-300'}">{badge.label}</span>
              {/each}
            </div>
          {/if}

          {#if genreLine || directors}
            <div class="max-w-4xl flex flex-wrap gap-x-8 gap-y-1 text-lg text-gray-300 mb-4 [text-shadow:0_1px_4px_rgba(0,0,0,0.75)]">
              {#if genreLine}<span>{genreLine}</span>{/if}
              {#if directors}<span><span class="text-gray-400">{directors.pre}</span>{directors.list}<span class="text-gray-400">{directors.post}</span></span>{/if}
            </div>
          {/if}

          <!-- Nothing rather than "No description available": seasons rarely have one, and the filler
               line read like an error. -->
          {#if fullItem.Overview}
            <!-- The padding sits outside the text (negative margins, max width + 1.5rem): it wraps and clamps exactly
                 as the plain paragraph did, and the focus ring gets room around it. -->
            <button bind:this={overviewBtn} disabled={!overviewClamped}
              onclick={() => { overviewFocus.capture(overviewBtn); showOverview = true; }}
              class="block max-w-[57.5rem] text-left -mx-3 -mt-2 px-3 py-2 mb-8 rounded-xl focus:outline-none focus:ring-4 focus:ring-white">
              <span {@attach measureOverview} class="text-xl text-gray-300 line-clamp-4 leading-relaxed">{fullItem.Overview}</span>
            </button>
          {:else}
            <div class="mb-6"></div>
          {/if}

          <!-- ACTION BUTTONS -->
          <div class="flex flex-wrap items-center gap-4 mb-12">
            <button onclick={handlePlay} {@attach focusUnlessRestoring} data-primary-action
              class="bg-white hover:bg-gray-200 focus:bg-gray-200 text-black font-bold text-2xl px-12 py-4 rounded-xl
                     focus:outline-none focus:ring-4 focus:ring-blue-500 flex items-center gap-3 shadow-lg">
              <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 20 20"><path d="M4 4l12 6-12 6z"/></svg>
              {#if nextToPlay && nextToPlay.Type === 'Episode'}
                {nextToPlay.UserData?.PlaybackPositionTicks > 0 ? i18n.t.resumePlay : i18n.t.play}
                <span class="text-xl font-semibold text-gray-600">{episodeCode(nextToPlay)}</span>
              {:else if fullItem.UserData?.PlaybackPositionTicks > 0}{i18n.t.resumePlay}{:else}{i18n.t.play}{/if}
            </button>

            {#if fullItem.Type === 'Series' || fullItem.Type === 'Season'}
              <button onclick={playRandomEpisode}
                class="bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 text-white font-bold text-lg px-8 py-4 rounded-xl
                       focus:outline-none focus:ring-4 focus:ring-blue-500 shadow-lg flex items-center gap-2">
                <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
                  <polyline points="16 3 21 3 21 8"/>
                  <line x1="4" y1="20" x2="21" y2="3"/>
                  <polyline points="21 16 21 21 16 21"/>
                  <line x1="15" y1="15" x2="21" y2="21"/>
                  <line x1="4" y1="4" x2="9" y2="9"/>
                </svg>
                {i18n.t.shuffle}
              </button>
            {/if}

            {#if fullItem.UserData?.PlaybackPositionTicks > 0 && fullItem.Type !== 'Series' && fullItem.Type !== 'Season'}
              <button onclick={playFromBeginning}
                class="bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 text-white font-bold text-lg px-7 py-4 rounded-xl
                       focus:outline-none focus:ring-4 focus:ring-blue-500 shadow-lg flex items-center gap-2">
                <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3"/>
                </svg>
                {i18n.t.playFromStart}
              </button>
            {/if}

            {#if fullItem.RemoteTrailers?.length > 0}
              <button onclick={openTrailer} {@attach hint()} aria-label={i18n.t.trailer}
                class="p-4 rounded-xl bg-gray-800 text-white hover:bg-gray-700 focus:bg-gray-700
                       focus:outline-none focus:ring-4 focus:ring-blue-500 shadow-lg">
                <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M4.5 4.5a3 3 0 00-3 3v9a3 3 0 003 3h8.25a3 3 0 003-3v-9a3 3 0 00-3-3H4.5zM19.94 18.75l-2.69-2.69V7.94l2.69-2.69c.944-.945 2.56-.276 2.56 1.06v11.38c0 1.336-1.616 2.005-2.56 1.06z"/>
                </svg>
              </button>
            {/if}

            <button onclick={togglePlayed} {@attach hint()}
              aria-label={fullItem.UserData?.Played ? i18n.t.markUnwatched : i18n.t.markWatched}
              class="p-4 rounded-xl focus:outline-none focus:ring-4 focus:ring-blue-500 shadow-lg
                     {fullItem.UserData?.Played ? 'bg-green-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white focus:text-white'}">
              <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 20 20">
                <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/>
              </svg>
            </button>

            <button onclick={toggleFavorite} {@attach hint()}
              aria-label={fullItem.UserData?.IsFavorite ? i18n.t.removeFavorite : i18n.t.addFavorite}
              class="p-4 rounded-xl focus:outline-none focus:ring-4 focus:ring-blue-500 shadow-lg
                     {fullItem.UserData?.IsFavorite ? 'bg-red-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white focus:text-white'}">
              <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
              </svg>
            </button>

            <button onclick={() => toggleWatchlist(fullItem)} {@attach hint()}
              aria-label={inWatchlist(fullItem.Id) ? i18n.t.removeFromWatchlist : i18n.t.addToWatchlist}
              class="p-4 rounded-xl focus:outline-none focus:ring-4 focus:ring-blue-500 shadow-lg
                     {inWatchlist(fullItem.Id) ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white focus:text-white'}">
              <svg class="w-8 h-8" fill={inWatchlist(fullItem.Id) ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0z"/>
              </svg>
            </button>

            {#if fullItem.MediaSources?.length > 0 || fullItem.Type === 'Series' || fullItem.Type === 'Season'}
              <div class="relative" data-dropdown data-focus-trap={openDropdown === 'kebab' || undefined}>
                <button bind:this={kebabBtnEl} onclick={(e) => toggleDropdown('kebab', e)} {@attach hint()} aria-label={i18n.t.more}
                  class="p-4 rounded-xl bg-gray-800 text-gray-400 hover:text-white focus:text-white focus:outline-none focus:ring-4 focus:ring-blue-500 shadow-lg">
                  <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
                </button>
                {#if openDropdown === 'kebab'}
                  <div class="absolute right-0 mt-2 z-50 w-80 max-h-[70vh] overflow-y-auto hide-scrollbar flex flex-col gap-1 bg-gray-900 rounded-xl border border-gray-700 p-2 shadow-2xl">
                    {#if hasEarlierEpisodes(fullItem)}
                      <!-- Stays open on purpose: the entry itself reports the result (see markEarlier). -->
                      <button onclick={markEarlier}
                        class="text-left text-base px-4 py-3 rounded-lg text-gray-200 hover:bg-gray-700 focus:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-white flex items-center gap-3 {earlier === 'busy' ? 'opacity-60' : ''}">
                        <svg class="w-6 h-6 shrink-0 {earlier?.n >= 0 ? 'text-green-400' : 'text-gray-400'}" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M1.5 12.5l4.5 4.5 9-10M11 16.5l.5.5 9-10"/></svg>
                        {earlier?.n > 0 ? plural('earlierMarked', earlier.n) : earlier?.n === 0 ? i18n.t.earlierAllWatched : i18n.t.markEarlierWatched}
                      </button>
                    {/if}
                    {#if fullItem.MediaSources?.length > 0}
                      <button onclick={() => { menuReturn.capture(kebabBtnEl); closeDropdown(false); showMediaInfo = true; }}
                        class="text-left text-base px-4 py-3 rounded-lg text-gray-200 hover:bg-gray-700 focus:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-white flex items-center gap-3">
                        <svg class="w-6 h-6 shrink-0 text-gray-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                        {i18n.t.mediaInfo}
                      </button>
                    {/if}
                    <button onclick={() => { menuReturn.capture(kebabBtnEl); closeDropdown(false); pickerMode = 'playlist'; }}
                      class="text-left text-base px-4 py-3 rounded-lg text-gray-200 hover:bg-gray-700 focus:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-white flex items-center gap-3">
                      <svg class="w-6 h-6 shrink-0 text-gray-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 6h13M3 12h9m-9 6h9m4-3v6m3-3h-6"/></svg>
                      {i18n.t.addToPlaylist}
                    </button>
                    {#if canManageCollections}
                    <button onclick={() => { menuReturn.capture(kebabBtnEl); closeDropdown(false); pickerMode = 'collection'; }}
                      class="text-left text-base px-4 py-3 rounded-lg text-gray-200 hover:bg-gray-700 focus:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-white flex items-center gap-3">
                      <svg class="w-6 h-6 shrink-0 text-gray-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/></svg>
                      {i18n.t.addToCollection}
                    </button>
                    {/if}
                    <button onclick={() => { closeDropdown(false); openShare(); }}
                      class="text-left text-base px-4 py-3 rounded-lg text-gray-200 hover:bg-gray-700 focus:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-white flex items-center gap-3">
                      <svg class="w-6 h-6 shrink-0 text-gray-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"/></svg>
                      {i18n.t.share}
                    </button>
                  </div>
                {/if}
              </div>
            {/if}
          </div>

          <!-- STREAM-INFO -->
          {#if fullItem.MediaSources?.length > 0}
            <div class="bg-gray-800/80 border border-gray-700 rounded-xl p-4 flex flex-col gap-4 max-w-2xl">

              <!-- RESOLUTION / VERSION: own dropdown with multiple sources, otherwise static -->
              {#if fullItem.MediaSources.length > 1}
                <div class="flex items-start gap-4 w-full">
                  <svg class="w-6 h-6 text-gray-500 shrink-0 mt-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z"/>
                  </svg>
                  <div class="flex-1 min-w-0 relative" data-dropdown data-focus-trap={openDropdown === 'resolution' || undefined}>
                    <button onclick={(e) => toggleDropdown('resolution', e)}
                      class="w-full flex items-center justify-between bg-gray-900 text-gray-300 text-sm px-4 py-2 rounded border border-gray-600 focus:outline-none focus:ring-2 focus:ring-white">
                      <span class="truncate">{@render versionLabel(selectedSource)}</span>
                      <svg class="w-4 h-4 ml-2 shrink-0 transition-transform {openDropdown === 'resolution' ? 'rotate-180' : ''}" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
                    </button>
                    {#if openDropdown === 'resolution'}
                      <div {@attach placeList} class="absolute inset-x-0 z-30 overflow-y-auto hide-scrollbar flex flex-col gap-1 bg-gray-900 rounded border border-gray-700 p-1 shadow-2xl">
                        {#each fullItem.MediaSources as src (src.Id)}
                          <button onclick={() => { selectedMediaSourceId = src.Id; onSourceChange(); closeDropdown(); }} data-opt data-active={src.Id === selectedMediaSourceId || undefined}
                            class="text-left text-sm px-3 py-2 scroll-my-1 rounded focus:outline-none focus:ring-2 focus:ring-white {src.Id === selectedMediaSourceId ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-700 focus:bg-gray-700'}">
                            {@render versionLabel(src)}
                          </button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
              {:else}
                {#each getMediaStreams('Video') as stream (stream.Index)}
                  <div class="flex items-center gap-4">
                    <svg class="w-6 h-6 text-gray-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z"/>
                    </svg>
                    <span class="text-sm font-semibold text-gray-300">{stream.DisplayTitle || stream.Codec}</span>
                  </div>
                {/each}
              {/if}

              <!-- AUDIO: own dropdown with multiple tracks, otherwise static -->
              {#if getMediaStreams('Audio').length > 1}
                <div class="flex items-start gap-4 w-full">
                  <svg class="w-6 h-6 text-gray-500 shrink-0 mt-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"/>
                  </svg>
                  <div class="flex-1 min-w-0 relative" data-dropdown data-focus-trap={openDropdown === 'audio' || undefined}>
                    <button onclick={(e) => toggleDropdown('audio', e)}
                      class="w-full flex items-center justify-between bg-gray-900 text-gray-300 text-sm px-4 py-2 rounded border border-gray-600 focus:outline-none focus:ring-2 focus:ring-white">
                      <span class="truncate">{@render trackName(getMediaStreams('Audio').find(s => s.Index === selectedAudioIndex))}</span>
                      <svg class="w-4 h-4 ml-2 shrink-0 transition-transform {openDropdown === 'audio' ? 'rotate-180' : ''}" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
                    </button>
                    {#if openDropdown === 'audio'}
                      <div {@attach placeList} class="absolute inset-x-0 z-30 overflow-y-auto hide-scrollbar flex flex-col gap-1 bg-gray-900 rounded border border-gray-700 p-1 shadow-2xl">
                        {#each audioChoices as stream (stream.Index)}
                          <button onclick={() => { pickTrack('audio', stream.Index); closeDropdown(); }} data-opt data-active={stream.Index === selectedAudioIndex || undefined}
                            class="text-left text-sm px-3 py-2 scroll-my-1 rounded focus:outline-none focus:ring-2 focus:ring-white {stream.Index === selectedAudioIndex ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-700 focus:bg-gray-700'}">
                            {@render trackName(stream)}
                          </button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
              {:else if getMediaStreams('Audio').length === 1}
                <div class="flex items-center gap-4">
                  <svg class="w-6 h-6 text-gray-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"/>
                  </svg>
                  <span class="text-sm font-semibold text-gray-300">{@render trackName(getMediaStreams('Audio')[0])}</span>
                </div>
              {/if}

              <!-- SUBTITLES: own dropdown (with "Off") -->
              {#if getMediaStreams('Subtitle').length > 0}
                <div class="flex items-start gap-4 w-full">
                  <svg class="w-6 h-6 text-gray-500 shrink-0 mt-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16"/>
                  </svg>
                  <div class="flex-1 min-w-0 relative" data-dropdown data-focus-trap={openDropdown === 'subtitle' || undefined}>
                    <button onclick={(e) => toggleDropdown('subtitle', e)} data-subtitle-trigger
                      class="w-full flex items-center justify-between bg-gray-900 text-gray-300 text-sm px-4 py-2 rounded border border-gray-600 focus:outline-none focus:ring-2 focus:ring-white">
                      <span class="truncate">{#if selectedSubtitleIndex === -1}{i18n.t.subtitleOff}{:else}{@render trackName(getMediaStreams('Subtitle').find(s => s.Index === selectedSubtitleIndex))}{/if}</span>
                      <svg class="w-4 h-4 ml-2 shrink-0 transition-transform {openDropdown === 'subtitle' ? 'rotate-180' : ''}" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
                    </button>
                    {#if openDropdown === 'subtitle'}
                      <div {@attach placeList} class="absolute inset-x-0 z-30 overflow-y-auto hide-scrollbar flex flex-col gap-1 bg-gray-900 rounded border border-gray-700 p-1 shadow-2xl">
                        <button onclick={() => { pickTrack('subtitle', -1); closeDropdown(); }} data-opt data-active={selectedSubtitleIndex === -1 || undefined}
                          class="text-left text-sm px-3 py-2 scroll-my-1 rounded focus:outline-none focus:ring-2 focus:ring-white {selectedSubtitleIndex === -1 ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-700 focus:bg-gray-700'}">
                          {i18n.t.subtitleOff}
                        </button>
                        {#each subtitleChoices as stream (stream.Index)}
                          <button onclick={() => { pickTrack('subtitle', stream.Index); closeDropdown(); }} data-opt data-active={stream.Index === selectedSubtitleIndex || undefined}
                            class="text-left text-sm px-3 py-2 scroll-my-1 rounded focus:outline-none focus:ring-2 focus:ring-white {stream.Index === selectedSubtitleIndex ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-700 focus:bg-gray-700'}">
                            {@render trackName(stream)}
                          </button>
                        {/each}
                        {#if canSearchSubtitles}
                          <button onclick={openSubtitleSearch} data-opt
                            class="text-left text-sm px-3 py-2 mt-1 scroll-my-1 rounded border-t border-gray-700/70 text-blue-300 hover:bg-gray-700 focus:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-white">
                            {i18n.t.subtitleSearch}
                          </button>
                        {/if}
                      </div>
                    {/if}
                  </div>
                </div>
              {:else}
                <!-- No subtitle tracks: show a non-selectable "No subtitles" entry (consistent with audio/resolution) -->
                <div class="flex items-center gap-4">
                  <svg class="w-6 h-6 text-gray-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16"/>
                  </svg>
                  <span class="text-sm font-semibold text-gray-300">{i18n.t.subtitleOff}</span>
                  <!-- No track at all is exactly when a search helps most. -->
                  {#if canSearchSubtitles}
                    <button onclick={openSubtitleSearch}
                      class="ml-auto text-sm px-4 py-2 rounded border border-gray-600 bg-gray-900 text-blue-300 hover:bg-gray-700 focus:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-white">
                      {i18n.t.subtitleSearch}
                    </button>
                  {/if}
                </div>
              {/if}

            </div>
          {/if}

        </div>
      </div>
        </div>
      </div>
      <!-- ════ /HERO-BANNER ════ -->

      <!-- CONTENT (rows) on the page colour — its own focus group per row,
           so D-pad LEFT at the start of a row jumps directly to the sidebar. -->
      <div class="relative z-10 px-10 pb-16 bg-gray-900 flex flex-col" style:background-color={tint?.bg}>

      <!-- SEASONS / EPISODES -->
      {#if relatedItems.length > 0}
        <div class="mt-8 border-t border-gray-800 pt-8" data-focus-group="details-episodes">
          <h2 class="text-3xl font-bold text-white mb-6">
            {#if fullItem.Type === 'Series'}{i18n.t.seasons}
            {:else if fullItem.Type === 'Season'}{i18n.t.episodes}
            {:else}{i18n.t.moreFromSeason} {fullItem.SeasonName || ''}
            {/if}
          </h2>
          <div data-focus-grid="row" class="flex gap-6 overflow-x-auto hide-scrollbar pt-4 -mt-4 pb-8 px-2">
            {#each relatedItems as ep (ep.Id)}
              <button onclick={() => navigateTo(ep.Id, ep)} data-item-id={ep.Id}
                onfocus={() => { if (ep.Type === 'Episode') focusedEpisode = ep; }}
                class="shrink-0 scroll-m-4 group isolate flex flex-col focus:outline-none text-left relative {ep.Type === 'Season' ? 'w-48' : 'w-80'}">
                <div class="{ep.Type === 'Season' ? 'aspect-[2/3]' : 'aspect-video'} w-full bg-gray-800 rounded-xl overflow-hidden border-4 border-transparent group-focus:border-white group-hover:border-gray-500 scale-100 group-focus:scale-105 group-focus:focus-glow transition-transform duration-200 shadow-xl relative">
                  {#if getItemImageUrl(ep, ep.Type === 'Season' ? 'portrait' : 'landscape')}
                    <img src={getItemImageUrl(ep, ep.Type === 'Season' ? 'portrait' : 'landscape')} {@attach blurUp(itemBlurHash(ep))} alt={ep.Name} loading="lazy"
                      class="w-full h-full object-cover transition-all duration-200 {epSpoiler(ep) ? 'blur-md scale-110' : ''}" />
                  {/if}
                  {#if ep.Id === nextToPlay?.Id && ep.Type === 'Episode'}
                    <div class="absolute top-2 left-2 bg-blue-600 text-white text-xs font-bold px-2 py-1 rounded-md shadow-md">{i18n.t.nextUp}</div>
                  {/if}
                  <CardStatus item={ep} />
                </div>
                <span class="mt-3 text-sm font-bold text-gray-300 group-focus:text-white truncate w-full">
                  {#if ep.IndexNumber && ep.Type !== 'Season'}{ep.IndexNumber}{#if ep.IndexNumberEnd > ep.IndexNumber}–{ep.IndexNumberEnd}{/if}.&nbsp;{/if}{ep.Name}
                </span>
              </button>
            {/each}
          </div>
          <!-- The row showed a number and a title only. Underneath now: the episode under the focus —
               or, until the row is entered, the next one — with its length and description. Fixed
               height, so the page below does not jump while moving along the row. The description
               stays hidden for an episode the spoiler protection blurs. -->
          {#if fullItem.Type !== 'Series'}
            {@const shown = focusedEpisode || relatedItems.find(e => e.Id === nextToPlay?.Id) || null}
            <div class="px-2 -mt-2 min-h-[7.5rem] max-w-5xl">
              {#if shown}
                <p class="text-xl font-bold text-white">
                  {epTitle(shown)}{#if runtimeLabel(shown.RunTimeTicks)}<span class="text-gray-400 font-medium">{' · '}{runtimeLabel(shown.RunTimeTicks)}</span>{/if}
                </p>
                {#if shown.Overview && !epSpoiler(shown)}
                  <p class="text-lg text-gray-300 mt-2 line-clamp-3 leading-relaxed">{shown.Overview}</p>
                {/if}
              {/if}
            </div>
          {/if}
        </div>
      {/if}

      <!-- EXTRAS (special features) — play directly, extras have no own detail page -->
      {#if extras.length > 0}
        <div class="mt-8 border-t border-gray-800 pt-8" data-focus-group="details-extras">
          <h2 class="text-3xl font-bold text-white mb-6">{i18n.t.extras}</h2>
          <div data-focus-grid="row" class="flex gap-6 overflow-x-auto hide-scrollbar pt-4 -mt-4 pb-8 px-2">
            {#each extras as ex (ex.Id)}
              <button onclick={() => onPlayVideo?.({ item: ex, audioIndex: -1, subtitleIndex: -1 })}
                class="shrink-0 w-80 scroll-m-4 group isolate flex flex-col focus:outline-none text-left">
                <div class="aspect-video w-full bg-gray-800 rounded-xl overflow-hidden border-4 border-transparent group-focus:border-white shadow-xl scale-100 group-focus:scale-105 group-focus:focus-glow transition-transform duration-200">
                  {#if getItemImageUrl(ex, 'landscape')}
                    <img src={getItemImageUrl(ex, 'landscape')} {@attach blurUp(itemBlurHash(ex))} alt={ex.Name} class="w-full h-full object-cover" loading="lazy" />
                  {:else}
                    <div class="w-full h-full flex items-center justify-center text-gray-600">
                      <svg class="w-12 h-12" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                    </div>
                  {/if}
                </div>
                <span class="mt-3 text-sm font-bold text-gray-300 group-focus:text-white truncate w-full">{ex.Name}</span>
                {#if runtimeLabel(ex.RunTimeTicks)}<span class="text-xs text-gray-400">{runtimeLabel(ex.RunTimeTicks)}</span>{/if}
              </button>
            {/each}
          </div>
        </div>
      {/if}

      <!-- CAST (tappable → the person's filmography) — belongs to the title, so above Similar -->
      {#if castMembers.length > 0}
        <div class="mt-8 border-t border-gray-800 pt-8" data-focus-group="details-cast">
          <h2 class="text-3xl font-bold text-white mb-6">{i18n.t.cast}</h2>
          <div data-focus-grid="row" class="flex gap-6 overflow-x-auto hide-scrollbar pt-4 -mt-4 pb-8 px-2">
            {#each castMembers as person (person.Id)}
              <PersonCard {person} onclick={() => onOpenPerson?.(person)} caption={person.Role} class="shrink-0 w-36 scroll-m-4" />
            {/each}
          </div>
        </div>
      {/if}

      <!-- INCLUDED IN — the collections holding this title; a card opens the collection view -->
      {#if collections.length > 0}
        <div class="mt-8 border-t border-gray-800 pt-8" data-focus-group="details-collections">
          <h2 class="text-3xl font-bold text-white mb-6">{i18n.t.includedIn}</h2>
          <div data-focus-grid="row" class="flex gap-6 overflow-x-auto hide-scrollbar pt-4 -mt-4 pb-8 px-2">
            {#each collections as col (col.Id)}
              <button onclick={() => onOpenCollection?.(col)} data-item-id={col.Id} class="shrink-0 w-48 scroll-m-4 group isolate flex flex-col focus:outline-none text-left">
                <div class="aspect-[2/3] w-full bg-gray-800 rounded-xl overflow-hidden border-4 border-transparent group-focus:border-white shadow-xl scale-100 group-focus:scale-105 group-focus:focus-glow transition-transform duration-200">
                  {#if getItemImageUrl(col, 'portrait')}
                    <img src={getItemImageUrl(col, 'portrait')} {@attach blurUp(itemBlurHash(col))} alt={col.Name} class="w-full h-full object-cover" loading="lazy" />
                  {/if}
                </div>
                <span class="mt-3 text-sm font-bold text-gray-300 group-focus:text-white truncate w-full">{col.Name}</span>
              </button>
            {/each}
          </div>
        </div>
      {/if}

      <!-- SIMILAR -->
      {#if similarItems.length > 0}
        <div class="mt-8 border-t border-gray-800 pt-8" data-focus-group="details-similar">
          <h2 class="text-3xl font-bold text-white mb-6">{i18n.t.similar}</h2>
          <div data-focus-grid="row" class="flex gap-6 overflow-x-auto hide-scrollbar pt-4 -mt-4 pb-8 px-2">
            {#each similarItems as si (si.Id)}
              <button onclick={() => navigateTo(si.Id, si)} data-item-id={si.Id} class="shrink-0 w-48 scroll-m-4 group isolate flex flex-col focus:outline-none text-left">
                <div class="aspect-[2/3] w-full bg-gray-800 rounded-xl overflow-hidden border-4 border-transparent group-focus:border-white shadow-xl scale-100 group-focus:scale-105 group-focus:focus-glow transition-transform duration-200">
                  {#if getItemImageUrl(si, 'portrait')}
                    <img src={getItemImageUrl(si, 'portrait')} {@attach blurUp(itemBlurHash(si))} alt={si.Name} class="w-full h-full object-cover" loading="lazy" />
                  {/if}
                </div>
                <span class="mt-3 text-sm font-bold text-gray-300 group-focus:text-white truncate w-full">{si.Name}</span>
              </button>
            {/each}
          </div>
        </div>
      {/if}

      </div>
      <!-- ════ /CONTENT ════ -->
    </div>
  {/if}
</div>

<!-- TRAILER MODAL — YouTube embed or direct video -->
{#if trailerEmbedUrl}
  <div
    data-focus-trap
    role="dialog"
    tabindex="-1"
    class="fixed inset-0 bg-black z-[200] flex items-center justify-center"
    onkeydown={(e) => { if (isBackKey(e)) { e.stopPropagation(); closeTrailer(); } }}
  >
    <!-- Close button (top right, above the video) -->
    <button
      onclick={closeTrailer}
      {@attach focusOnMount()}
      aria-label={i18n.t.close}
      class="absolute top-6 right-8 z-10 text-white/80 hover:text-white focus:text-white
             bg-black/50 rounded-full p-3 focus:outline-none focus:ring-4 focus:ring-white transition-colors"
    >
      <svg class="w-9 h-9" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
      </svg>
    </button>

    <!-- Fullscreen: the video fills the screen -->
    {#if trailerEmbedUrl.startsWith('https://www.youtube-nocookie.com/embed/')}
      <iframe
        src={trailerEmbedUrl}
        class="w-full h-full"
        allow="autoplay; fullscreen"
        allowfullscreen
        title={i18n.t.trailer}
      ></iframe>
    {:else}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        src={trailerEmbedUrl}
        class="w-full h-full object-contain"
        autoplay
        controls
      ></video>
    {/if}
  </div>
{/if}

<!-- MEDIA INFO MODAL (codec, bitrate, languages, …) -->
{#if showMediaInfo && fullItem?.MediaSources?.length}
  <Dialog z="z-[200]" onBack={() => showMediaInfo = false} onkeydown={(e) => scrollByKey(e, mediaInfoScroll)}>
    <div bind:this={mediaInfoScroll} class="bg-gray-800 border border-gray-700 rounded-2xl w-full max-w-3xl max-h-[85vh] overflow-y-auto hide-scrollbar shadow-2xl">
      <div class="flex justify-between items-center p-8 pb-4 sticky top-0 bg-gray-800 z-10">
        <h2 class="text-4xl text-white font-bold">{i18n.t.mediaInfo}</h2>
        <button onclick={() => showMediaInfo = false} {@attach focusOnMount()} aria-label={i18n.t.close}
          class="text-gray-400 hover:text-white focus:text-white focus:outline-none focus:ring-4 focus:ring-white rounded-full p-2">
          <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>
      <!-- Shows the currently CHOSEN version (not stubbornly the first) — follows the resolution selection -->
      {#each (selectedSource ? [selectedSource] : []) as src (src.Id)}
        <div class="px-8 pb-8 flex flex-col gap-5">
          <!-- File: container / size / total bitrate -->
          <div class="grid grid-cols-3 gap-3">
            {#if src.Container}
              <div lang="en"><div class="text-gray-400 text-xs uppercase tracking-wider">Container</div><div class="text-white font-semibold uppercase">{src.Container}</div></div>
            {/if}
            {#if formatBytes(src.Size)}
              <div><div class="text-gray-400 text-xs uppercase tracking-wider">{i18n.t.miSize}</div><div class="text-white font-semibold">{formatBytes(src.Size)}</div></div>
            {/if}
            {#if formatBitrate(src.Bitrate)}
              <div><div lang="en" class="text-gray-400 text-xs uppercase tracking-wider">Bitrate</div><div class="text-white font-semibold">{formatBitrate(src.Bitrate)}</div></div>
            {/if}
          </div>

          <!-- Individual tracks -->
          {#each (src.MediaStreams || []) as s (s.Index)}
            <div class="bg-gray-900 rounded-xl p-4 border border-gray-700/50">
              <div class="flex items-center gap-3 mb-2">
                <!-- Video/Audio are the server's English type names: lang="en", or Turkish capitals write VİDEO -->
                <span lang={s.Type === 'Subtitle' ? null : 'en'} class="text-xs uppercase font-bold px-2 py-1 rounded bg-blue-600 text-white shrink-0">{s.Type === 'Subtitle' ? i18n.t.miSubtitle : s.Type}</span>
                <span class="text-white font-semibold truncate">{s.DisplayTitle || s.Codec || '—'}</span>
              </div>
              <div class="grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-gray-300">
                {#if s.Codec}<div><span class="text-gray-500">Codec:&nbsp;</span>{s.Codec.toUpperCase()}</div>{/if}
                {#if s.Type === 'Video' && s.Width}<div><span class="text-gray-500">{i18n.t.miResolution}:&nbsp;</span>{s.Width}×{s.Height}</div>{/if}
                {#if s.Type === 'Video' && s.VideoRange}<div><span class="text-gray-500">HDR:&nbsp;</span>{s.VideoRange}</div>{/if}
                {#if s.Type === 'Video' && s.AverageFrameRate}<div><span class="text-gray-500">{i18n.t.miFramerate}:&nbsp;</span>{s.AverageFrameRate.toFixed(0)} fps</div>{/if}
                {#if s.Type === 'Audio' && s.ChannelLayout}<div><span class="text-gray-500">{i18n.t.miChannels}:&nbsp;</span>{s.ChannelLayout}</div>{/if}
                {#if s.Language}<div><span class="text-gray-500">{i18n.t.miLanguage}:&nbsp;</span>{s.Language}</div>{/if}
                {#if formatBitrate(s.BitRate)}<div><span class="text-gray-500">Bitrate:&nbsp;</span>{formatBitrate(s.BitRate)}</div>{/if}
              </div>
            </div>
          {/each}
        </div>
      {/each}
    </div>
  </Dialog>
{/if}

<!-- THE WHOLE PLOT — opened from the clamped text in the hero (overviewClamped); ▲▼ scroll a long one -->
{#if showOverview && fullItem?.Overview}
  <Dialog z="z-[200]" onBack={() => showOverview = false} onkeydown={(e) => scrollByKey(e, overviewScroll)}>
    <div bind:this={overviewScroll} class="bg-gray-800 border border-gray-700 rounded-2xl w-full max-w-4xl max-h-[85vh] overflow-y-auto hide-scrollbar shadow-2xl">
      <div class="flex justify-between items-start gap-6 p-8 pb-4 sticky top-0 bg-gray-800 z-10">
        <h2 class="text-4xl leading-[1.3] -my-[0.0944em] text-white font-bold line-clamp-2">{fullItem.Name}</h2>
        <button onclick={() => showOverview = false} {@attach focusOnMount()} aria-label={i18n.t.close}
          class="shrink-0 text-gray-400 hover:text-white focus:text-white focus:outline-none focus:ring-4 focus:ring-white rounded-full p-2">
          <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>
      <div class="px-8 pb-8 flex flex-col gap-5 text-2xl text-gray-200 leading-relaxed whitespace-pre-line">
        {#each plotParts as part}<p>{part}</p>{/each}
      </div>
    </div>
  </Dialog>
{/if}

<!-- Share: QR code with a title link (IMDb/TMDb) to scan -->
{#if showShare}
  <Dialog onBack={() => showShare = false}>
    <div data-modal
      class="bg-gray-800 border border-gray-700 rounded-2xl p-8 w-full max-w-lg flex flex-col items-center gap-5 shadow-2xl">
      <div class="flex items-center justify-between gap-4 w-full">
        <h2 class="text-3xl text-white font-bold">{i18n.t.share}</h2>
        <button onclick={() => showShare = false} {@attach focusOnMount()}
          class="px-5 py-3 rounded-xl font-bold bg-gray-700 hover:bg-gray-600 focus:bg-gray-600 text-white
                 focus:outline-none focus:ring-4 focus:ring-white transition-colors">{i18n.t.close}</button>
      </div>
      {#if shareQrSvg}
        <div class="rounded-xl bg-white p-3 [&>svg]:block [&>svg]:w-full [&>svg]:h-full"
             style="width:320px;height:320px;max-width:40vh;max-height:40vh;">{@html shareQrSvg}</div>
      {/if}
      <!-- A season or an episode alone read "Season 2" / "Episode 1": the series first, then which part
           of it, in the episode row's own form ("S2:E1 · title"). -->
      {#if fullItem?.SeriesName && (fullItem.Type === 'Season' || fullItem.Type === 'Episode')}
        <div class="text-center break-words">
          <p class="text-white font-bold">{fullItem.SeriesName}</p>
          <p class="text-gray-300 font-semibold mt-1">{fullItem.Type === 'Episode' ? epTitle(fullItem) : fullItem.Name}</p>
        </div>
      {:else}
        <p class="text-white font-bold text-center break-words">{fullItem?.Name}</p>
      {/if}
      <p class="text-gray-400 text-base text-center max-w-md">{i18n.t.shareHint}</p>
    </div>
  </Dialog>
{/if}

{#if subtitleSearchOpen && fullItem}
  <SubtitleSearch item={fullItem} initialLang={subtitleSearchLang} onClose={closeSubtitleSearch} onDownloaded={awaitNewSubtitle} />
{/if}

<!-- Add to collection / playlist (shared component) -->
<AddToPicker mode={pickerMode} item={fullItem} {selectedUser}
  onCreated={() => onLibChanged?.()} onClose={() => pickerMode = null} />

<style>
  /* Deliberately NO scroll-snap on the rows: on D-pad devices only the focus scrolls
     (scrollIntoView) — proximity snapping pulled its position back phase-dependently
     and cut off the scaled border of the edge card (webOS/B4). */
</style>
