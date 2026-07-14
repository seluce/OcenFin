<script>
  import { i18n, LANGUAGES } from '../i18n.svelte.js';
  import { toggleWatchlist, inWatchlist } from '../watchlist.svelte.js';
  import { isBackKey, focusOnMount, personImageUrl, itemProgress, authHeaders, blurUp, itemBlurHash, makeFocusReturn, uiFade, dropTrapOnOutro, hint } from '../utils.js';
  import { session } from '../session.svelte.js';
  import { onMount, onDestroy, tick, untrack } from 'svelte';
  import AddToPicker from './AddToPicker.svelte';

  let {
    item,
    selectedUser,
    playbackPrefs = { audioLanguage: 'default', subtitleLanguage: 'default' },
    use24h = true,              // time format for the "ends at" chip (follows the setting)
    serverVobSub = false,       // does the server deliver VobSub/DVD externally (.mks, Jellyfin 12.0+)?
    spoilerProtection = true,   // slightly obscure thumbnails of unwatched episodes
    detailsBackdrop = true,     // show the hero backdrop on the detail page (own toggle, decoupled from reduceAnimations)
    detailsLogo = false,        // title as a logo graphic instead of text (falls back to text if no logo exists)
    onClose, onLibChanged, onOpenItemById, onOpenPerson, onPlayVideo,   // callback props (instead of events)
  } = $props();

  let fullItem     = $state(null);
  let relatedItems = $state([]);
  let similarItems = $state([]);
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

  // Label for the resolution selection, e.g. "4K HEVC" / "1080p HEVC"
  function sourceLabel(src) {
    const v = (src?.MediaStreams || []).find(s => s.Type === 'Video');
    const h = v?.Height || 0;
    const res = h >= 2160 ? '4K' : h >= 1080 ? '1080p' : h >= 720 ? '720p' : (h ? h + 'p' : '');
    const codec = (v?.Codec || '').toUpperCase();
    return [res, codec].filter(Boolean).join(' ') || src?.Name || i18n.t.source;
  }

  // Choose default audio/subtitle for a source (preferences + server defaults)
  function applySourceDefaults(src) {
    const streams = src?.MediaStreams || [];
    selectedAudioIndex = -1;
    const audioPref = matchLanguageStream(streams, 'Audio', playbackPrefs.audioLanguage);
    if (audioPref != null)                        selectedAudioIndex = audioPref;
    else if (src?.DefaultAudioStreamIndex != null) selectedAudioIndex = src.DefaultAudioStreamIndex;

    if (playbackPrefs.subtitleLanguage === 'off') {
      selectedSubtitleIndex = -1;
    } else {
      const subPref = matchLanguageStream(streams, 'Subtitle', playbackPrefs.subtitleLanguage);
      if (subPref != null)                              selectedSubtitleIndex = subPref;
      else if (playbackPrefs.subtitleLanguage === 'default')
        selectedSubtitleIndex = pickForcedSubtitle(streams, selectedAudioIndex, src?.DefaultSubtitleStreamIndex);
      else if (src?.DefaultSubtitleStreamIndex != null) selectedSubtitleIndex = src.DefaultSubtitleStreamIndex;
      else selectedSubtitleIndex = -1;
    }
  }

  // On resolution/version change: reset the tracks to the source's default values
  function onSourceChange() {
    const src = fullItem?.MediaSources?.find(s => s.Id === selectedMediaSourceId);
    if (src) applySourceDefaults(src);
  }

  // ---- Custom dropdowns (resolution/audio/subtitle) -------------------------------------------
  // A native <select> freezes on webOS on the back button → D-pad-capable custom dropdowns.
  let openDropdown = $state(null);     // 'resolution' | 'audio' | 'subtitle'
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
    (active || panel?.querySelector('[data-opt]'))?.focus();
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
  function audioLabel(s)    { return s ? (s.DisplayTitle || `${s.Language || i18n.t.unknown} – ${s.Codec}`) : ''; }
  function subtitleLabel(s) { return s ? (s.DisplayTitle || s.Language || i18n.t.unknown) : ''; }

  // ---- Add to collection / playlist -----------------------------------------------------------
  // The dialog itself lives in the shared component <AddToPicker>; here only the trigger.
  let pickerMode = $state(null);   // null | 'collection' | 'playlist'

  // Trailer modal
  let trailerEmbedUrl = $state(null);
  let showMediaInfo   = $state(false);   // media info modal
  let mediaInfoScroll = $state();           // the modal's scroll container (bind:this, for D-pad scrolling)

  // Share: QR code with a public title link (IMDb/TMDb) — anyone can scan it, no server access needed.
  let showShare = $state(false);
  let kebabBtnEl = $state();                 // three-dots button (bind:this, always in the DOM)
  const shareFocus = makeFocusReturn();   // focus return after closing the share modal
  // The same return for media info + playlist/collection picker (never open at once): without it
  // focus fell to the body after closing → the navigation caught it (share was correct,
  // the other three weren't). Now it lands back on the three-dots button.
  const menuReturn = makeFocusReturn();
  // May this profile manage collections? Policy.EnableCollectionManagement comes with the
  // login user. Deliberately hide only on an explicit false: if the field is missing (older server),
  // the entry stays visible and the 403 fallback in AddToPicker kicks in. Admins have true.
  const canManageCollections = $derived(selectedUser?.Policy?.EnableCollectionManagement !== false);
  // After closing the share modal, put focus back on the three dots.
  $effect(() => { if (!showShare && shareFocus.pending) shareFocus.restore(); });
  $effect(() => { if (!showMediaInfo && !pickerMode && menuReturn.pending) menuReturn.restore(); });
  let shareQrSvg = $state(null);
  // Public link (IMDb/TMDb) of an item — or null if no own ID exists.
  function buildShareUrl(item) {
    const p = item?.ProviderIds || {};
    if (p.Imdb) return `https://www.imdb.com/title/${p.Imdb}/`;
    if (p.Tmdb && (item.Type === 'Movie' || item.Type === 'Series'))
      return `https://www.themoviedb.org/${item.Type === 'Series' ? 'tv' : 'movie'}/${p.Tmdb}`;
    return null;
  }
  // Title as a readable fallback (a scan shows the name to look up, never a dead link).
  function shareTitleText(item) {
    return item?.ProductionYear ? `${item.Name} (${item.ProductionYear})` : (item?.Name || '');
  }
  async function openShare() {
    shareFocus.capture(kebabBtnEl);
    showShare = true;
    shareQrSvg = null;
    try {
      let target = buildShareUrl(fullItem);
      // No own public link (e.g. season/episode without an ID) → fall back to the series link.
      if (!target && fullItem.SeriesId) {
        try {
          const res = await fetch(`${session.serverUrl}/Users/${selectedUser.Id}/Items/${fullItem.SeriesId}?Fields=ProviderIds`, { headers: getAuthHeaders() });
          if (res.ok) target = buildShareUrl(await res.json());
        } catch { /* series unreachable → title fallback below */ }
      }
      target = target || shareTitleText(fullItem);
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

  function openTrailer() {
    if (!fullItem?.RemoteTrailers?.length) return;
    const url     = fullItem.RemoteTrailers[0].Url;
    const match   = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([^&?\s]{11})/);
    const videoId = match ? match[1] : null;

    // On the TV: launch the native YouTube app. Embeds fail on webOS due to the referer/
    // platform restriction (error 153) — LiteFin/Jellyfin-webOS do it the same way.
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
    } else {
      trailerEmbedUrl = url;
    }
  }

  // Cast: actors (max. 20) from the People data
  let castMembers = $derived((fullItem?.People || []).filter(p => p.Type === 'Actor').slice(0, 20));

  // Finds the index of the first stream (audio/subtitle) whose language matches the preference.
  // Returns null if no preference is set ('default') or there's no match.
  function matchLanguageStream(streams, type, prefKey) {
    if (!prefKey || prefKey === 'default') return null;
    const lang = LANGUAGES.find(l => l.key === prefKey);
    if (!lang) return null;
    const match = streams.find(s =>
      s.Type === type && s.Language && lang.codes.includes(s.Language.toLowerCase())
    );
    return match ? match.Index : null;
  }

  // Like Jellyfin in default mode: show a forced ("Forced") subtitle in the language of the
  // chosen audio track. Auto-selectable are: TEXT (VTT) always; PGS, when
  // client-side rendering is on (libbitsub → Direct Play); VobSub/DVD likewise, AS SOON AS the
  // server delivers them as .mks (Jellyfin 12.0+) → then also Direct Play. On older
  // servers only the opt-out option applies for DVD (then deliberately with transcode/burn-in).
  const GRAPHIC_SUB_CODECS = ['pgssub', 'pgs', 'dvdsub', 'dvbsub', 'vobsub', 'sub'];
  function isGraphicSub(s) { return GRAPHIC_SUB_CODECS.includes((s?.Codec || '').toLowerCase()); }
  function subtitleAutoEligible(s) {
    if (!isGraphicSub(s)) return true;                                  // text → always
    if (playbackPrefs.pgsRendering === false) return false;            // graphic rendering globally off
    const codec = (s?.Codec || '').toLowerCase();
    if (['pgssub', 'pgs'].includes(codec)) return true;               // PGS → client-side (Direct Play)
    if (serverVobSub) return true;                                    // VobSub/DVD via .mks → client-side (Direct Play)
    return !!playbackPrefs.forcedGraphicSubs;                          // old server: only via the option (burned in)
  }
  function pickForcedSubtitle(streams, audioIndex, serverDefault) {
    const audioLang = streams.find(s => s.Type === 'Audio' && s.Index === audioIndex)?.Language?.toLowerCase();
    const subs = streams.filter(s => s.Type === 'Subtitle');
    const pick = subs.find(s => s.IsForced && subtitleAutoEligible(s) && audioLang && s.Language?.toLowerCase() === audioLang)
              ?? subs.find(s => s.IsForced && subtitleAutoEligible(s));
    if (pick) return pick.Index;
    if (serverDefault != null) {
      const def = subs.find(s => s.Index === serverDefault);
      if (def && subtitleAutoEligible(def)) return serverDefault;
    }
    return -1;
  }

  function closeTrailer() {
    trailerEmbedUrl = null;
  }

  const getAuthHeaders = () => authHeaders(session.token);

  // Stale guard (pattern like in Search/Library): the breadcrumb navigation (episode → series → season)
  // switches the item quickly in succession — only responses to the MOST RECENT request may
  // write fullItem/relatedItems/similarItems, otherwise a slow old response overwrites
  // the new view.
  let detailToken = 0;

  // Reactive: reloads as soon as the 'item' prop changes. untrack() so the effect reacts ONLY to
  // item — not to stores/user that loadFullDetails reads synchronously internally.
  $effect(() => { const id = item?.Id; if (id) untrack(() => loadFullDetails(id)); });

  async function loadFullDetails(itemId) {
    const myToken = ++detailToken;
    isLoading    = true;
    fullItem     = null;
    relatedItems = [];
    similarItems = [];
    extras = [];
    selectedAudioIndex    = -1;
    selectedSubtitleIndex = -1;
    selectedMediaSourceId = null;

    try {
      const res = await fetch(
        `${session.serverUrl}/Users/${selectedUser.Id}/Items/${itemId}?Fields=MediaSources,Overview,Path,ProviderIds,People,RemoteTrailers`,
        { headers: getAuthHeaders() }
      );
      if (res.ok) {
        const data = await res.json();
        if (myToken !== detailToken) return;   // a different item was opened meanwhile → discard
        fullItem = data;

        if (fullItem.MediaSources?.length > 0) {
          const src = fullItem.MediaSources[0];
          selectedMediaSourceId = src.Id;   // preselect the first version
          applySourceDefaults(src);
        }

        // Load in parallel
        // Query "similar" for season/episode via the SERIES (otherwise the server returns
        // similar seasons of different series). For a series, its ID directly.
        const similarId = (fullItem.Type === 'Season' || fullItem.Type === 'Episode')
          ? (fullItem.SeriesId || itemId)
          : itemId;
        loadSimilarItems(similarId, myToken);
        loadExtras(itemId, myToken);
        if (fullItem.Type === 'Episode' && fullItem.SeasonId) {
          loadRelatedItems(fullItem.SeasonId, myToken);
        } else if (fullItem.Type === 'Series' || fullItem.Type === 'Season') {
          loadRelatedItems(fullItem.Id, myToken);
        }
      }
    } catch (e) { console.error(e); }
    // Only clear the spinner if we're still current — otherwise an old response kills the new one's.
    finally     { if (myToken === detailToken) isLoading = false; }
  }

  // Extras / special features of the opened item (movie, series or season).
  // NOTE: the endpoint returns a DIRECT array (like /Items/Latest), not { Items }.
  async function loadExtras(itemId, myToken) {
    try {
      const res = await fetch(
        `${session.serverUrl}/Items/${itemId}/SpecialFeatures?userId=${selectedUser.Id}`,
        { headers: getAuthHeaders() }
      );
      if (res.ok) { const d = await res.json(); if (myToken !== detailToken) return; extras = Array.isArray(d) ? d : (d.Items || []); }
    } catch { /* extras are optional */ }
  }

  async function loadSimilarItems(itemId, myToken) {
    try {
      const res = await fetch(
        `${session.serverUrl}/Items/${itemId}/Similar?Limit=10&Fields=PrimaryImageAspectRatio`,
        { headers: getAuthHeaders() }
      );
      if (res.ok) { const d = await res.json(); if (myToken !== detailToken) return; similarItems = d.Items || []; }
    } catch (e) { console.error(e); }
  }

  async function loadRelatedItems(parentId, myToken) {
    try {
      const res = await fetch(
        `${session.serverUrl}/Users/${selectedUser.Id}/Items?ParentId=${parentId}&Fields=Overview,PrimaryImageAspectRatio&SortBy=SortName&EnableTotalRecordCount=false`,
        { headers: getAuthHeaders() }
      );
      if (res.ok) { const d = await res.json(); if (myToken !== detailToken) return; relatedItems = d.Items || []; }
    } catch (e) { console.error(e); }
  }

  async function handlePlay() {
    if (fullItem.Type === 'Series' || fullItem.Type === 'Season') {
      const url = fullItem.Type === 'Series'
        ? `${session.serverUrl}/Shows/NextUp?SeriesId=${fullItem.Id}&UserId=${selectedUser.Id}&Limit=1&EnableTotalRecordCount=false`
        : `${session.serverUrl}/Users/${selectedUser.Id}/Items?ParentId=${fullItem.Id}&IncludeItemTypes=Episode&Filters=IsNotPlayed&Limit=1&SortBy=SortName&EnableTotalRecordCount=false`;
      try {
        const res  = await fetch(url, { headers: getAuthHeaders() });
        const data = await res.json();
        if (data.Items?.length > 0) {
          onPlayVideo?.({ item: data.Items[0], audioIndex: -1, subtitleIndex: -1 });
        } else {
          // Fallback: first episode
          const fb = await fetch(
            `${session.serverUrl}/Users/${selectedUser.Id}/Items?ParentId=${fullItem.Id}&IncludeItemTypes=Episode&Recursive=true&Limit=1&SortBy=SortName&EnableTotalRecordCount=false`,
            { headers: getAuthHeaders() }
          );
          const fd = await fb.json();
          if (fd.Items?.length > 0) onPlayVideo?.({ item: fd.Items[0], audioIndex: -1, subtitleIndex: -1 });
        }
      } catch (e) { console.error(e); }
    } else {
      onPlayVideo?.({ item: fullItem, audioIndex: selectedAudioIndex, subtitleIndex: selectedSubtitleIndex, mediaSourceId: selectedMediaSourceId });
    }
  }

  // "From the beginning": same item, but resume position at 0 → the Player starts at zero.
  function playFromBeginning() {
    const fresh = { ...fullItem, UserData: { ...(fullItem.UserData || {}), PlaybackPositionTicks: 0 } };
    onPlayVideo?.({ item: fresh, audioIndex: selectedAudioIndex, subtitleIndex: selectedSubtitleIndex, mediaSourceId: selectedMediaSourceId });
  }

  // Random episode — for long series "just play something". Series → from ALL episodes (recursively across all
  // seasons, specials/season 0 excluded); season → only from this season. Uniformly distributed, incl. already
  // watched ones (deliberately: comfort rewatch). Ends up in the Player via onPlayVideo like handlePlay.
  async function playRandomEpisode() {
    const isSeries = fullItem.Type === 'Series';
    const url = `${session.serverUrl}/Users/${selectedUser.Id}/Items?ParentId=${fullItem.Id}`
      + `&IncludeItemTypes=Episode${isSeries ? '&Recursive=true' : ''}&EnableTotalRecordCount=false`;
    try {
      const res  = await fetch(url, { headers: getAuthHeaders() });
      const data = await res.json();
      let pool = (data.Items || []).filter(e => e.Type === 'Episode');
      if (isSeries) pool = pool.filter(e => e.ParentIndexNumber !== 0);   // exclude specials (season 0)
      if (!pool.length) return;
      const pick = pool[Math.floor(Math.random() * pool.length)];
      onPlayVideo?.({ item: pick, audioIndex: -1, subtitleIndex: -1 });
    } catch (e) { console.error(e); }
  }

  async function togglePlayed() {
    // Toggle optimistically and locally — no reload of the whole detail page
    const willBePlayed = !fullItem.UserData?.Played;
    fullItem.UserData = { ...fullItem.UserData, Played: willBePlayed };
    if (item) item.UserData = { ...item.UserData, Played: willBePlayed };   // carry the original list item along → the origin list updates
    try {
      await fetch(`${session.serverUrl}/Users/${selectedUser.Id}/PlayedItems/${fullItem.Id}`, {
        method: willBePlayed ? "POST" : "DELETE",
        headers: getAuthHeaders()
      });
    } catch (e) {
      // Roll back on error
      console.warn('[OcenFin] played-status toggle failed, rolled back:', e);
      fullItem.UserData = { ...fullItem.UserData, Played: !willBePlayed };
      if (item) item.UserData = { ...item.UserData, Played: !willBePlayed };
    }
  }

  async function toggleFavorite() {
    const willBeFav = !fullItem.UserData?.IsFavorite;
    fullItem.UserData = { ...fullItem.UserData, IsFavorite: willBeFav };
    if (item) item.UserData = { ...item.UserData, IsFavorite: willBeFav };   // carry the original list item along → the favorites view removes/adds reactively
    try {
      await fetch(`${session.serverUrl}/Users/${selectedUser.Id}/FavoriteItems/${fullItem.Id}`, {
        method: willBeFav ? "POST" : "DELETE",
        headers: getAuthHeaders()
      });
    } catch (e) {
      console.warn('[OcenFin] favorite toggle failed, rolled back:', e);
      fullItem.UserData = { ...fullItem.UserData, IsFavorite: !willBeFav };
      if (item) item.UserData = { ...item.UserData, IsFavorite: !willBeFav };
    }
  }

  // FIX: only dispatch — the reactive $: if(item) in this file takes over the loading.
  // No direct loadFullDetails() here anymore, otherwise a duplicate API call.
  function navigateTo(id) {
    isLoading = true;
    fullItem  = null;   // show the spinner immediately
    onOpenItemById?.(id);
  }

  function getItemImageUrl(targetItem, format = "portrait") {
    if (format === 'landscape') {
      if (targetItem.Type === 'Episode' && targetItem.ImageTags?.Primary)
        return `${session.serverUrl}/Items/${targetItem.Id}/Images/Primary?tag=${targetItem.ImageTags.Primary}&maxWidth=600&quality=80&format=webp`;
      if (targetItem.BackdropImageTags?.length > 0)
        return `${session.serverUrl}/Items/${targetItem.Id}/Images/Backdrop?tag=${targetItem.BackdropImageTags[0]}&maxWidth=600&quality=80&format=webp`;
    }
    if (targetItem.ImageTags?.Primary)
      return `${session.serverUrl}/Items/${targetItem.Id}/Images/Primary?tag=${targetItem.ImageTags.Primary}&fillHeight=400&quality=80&format=webp`;
    if (targetItem.SeriesPrimaryImageTag)
      return `${session.serverUrl}/Items/${targetItem.SeriesId}/Images/Primary?tag=${targetItem.SeriesPrimaryImageTag}&fillHeight=400&quality=80&format=webp`;
    return null;
  }

  function getItemBackdropUrl(targetItem) {
    if (targetItem.BackdropImageTags?.length > 0)
      return `${session.serverUrl}/Items/${targetItem.Id}/Images/Backdrop?tag=${targetItem.BackdropImageTags[0]}&maxWidth=1920&quality=80&format=webp`;
    if (targetItem.ParentBackdropImageTags?.length > 0)
      return `${session.serverUrl}/Items/${targetItem.ParentBackdropItemId}/Images/Backdrop?tag=${targetItem.ParentBackdropImageTags[0]}&maxWidth=1920&quality=80&format=webp`;
    return null;
  }

  // Title logo (transparent PNG) of the episode/series; for episodes the series. Null → the caller falls back to text.
  function getItemLogoUrl(targetItem) {
    if (targetItem.ImageTags?.Logo)
      return `${session.serverUrl}/Items/${targetItem.Id}/Images/Logo?tag=${targetItem.ImageTags.Logo}&maxHeight=200&quality=90&format=webp`;
    if (targetItem.ParentLogoImageTag)
      return `${session.serverUrl}/Items/${targetItem.ParentLogoItemId}/Images/Logo?tag=${targetItem.ParentLogoImageTag}&maxHeight=200&quality=90&format=webp`;
    return null;
  }

  function getRuntimeMinutes(ticks) {
    return !ticks ? "" : Math.round(ticks / 10000000 / 60) + ` ${i18n.t.mins}`;
  }

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

  function getEndTime(targetItem) {
    if (!targetItem?.RunTimeTicks) return "";
    const remainingTicks = targetItem.RunTimeTicks - (targetItem.UserData?.PlaybackPositionTicks || 0);
    const endDate = new Date(Date.now() + remainingTicks / 10000);
    return `${i18n.t.endsAt} ${endDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: !use24h })}`;   // i18n instead of hardcoded German
  }
</script>

<div class="flex flex-col h-full relative overflow-hidden">
  {#if isLoading}
    <div class="flex-1 flex items-center justify-center">
      <div class="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
    </div>

  {:else if fullItem}

    <div class="flex-1 overflow-y-auto hide-scrollbar">

      <!-- ════ CINEMATIC HERO BANNER — the backdrop scrolls along, fading into the app gray at bottom/left ════ -->
      <div class="relative">
        {#if detailsBackdrop && getItemBackdropUrl(fullItem)}
          <div class="absolute inset-0 z-0">
            <img src={getItemBackdropUrl(fullItem)} {@attach blurUp(itemBlurHash(fullItem, 'Backdrop'))} alt="" class="w-full h-full object-cover object-top" />
            <div class="absolute inset-0 bg-gradient-to-t from-gray-900 via-gray-900/60 to-gray-900/20"></div>
            <div class="absolute inset-0 bg-gradient-to-r from-gray-900 via-gray-900/40 to-transparent"></div>
          </div>
        {/if}

        <div class="relative z-10 p-10 pt-16">

          <!-- BREADCRUMB + BACK -->
      <div class="flex items-center gap-6 mb-10" data-focus-group="details-top">
        <button onclick={() => onClose?.()}
          class="bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 px-6 py-2 rounded-lg text-white font-bold focus:outline-none focus:ring-4 focus:ring-white">
          {i18n.t.back}
        </button>
        {#if fullItem.Type === 'Episode'}
          <div class="flex items-center text-xl font-semibold text-gray-400 gap-2">
            <button onclick={() => navigateTo(fullItem.SeriesId)}
              class="hover:text-white focus:text-white focus:outline-none">{fullItem.SeriesName}</button>
            <span>/</span>
            <button onclick={() => navigateTo(fullItem.SeasonId)}
              class="hover:text-white focus:text-white focus:outline-none">{fullItem.SeasonName}</button>
          </div>
        {/if}
      </div>

      <!-- HERO -->
      <div class="flex gap-12 items-start mb-8">

        <div class="w-64 shrink-0 rounded-xl overflow-hidden shadow-2xl border-2 border-gray-700 bg-gray-800">
          {#if getItemImageUrl(fullItem)}
            <img src={getItemImageUrl(fullItem)} {@attach blurUp(itemBlurHash(fullItem))} alt={fullItem.Name} class="w-full h-full object-cover" />
          {/if}
        </div>

        <div class="flex-1 max-w-4xl" data-focus-group="details-hero">
          {#if detailsLogo && getItemLogoUrl(fullItem)}
            <img src={getItemLogoUrl(fullItem)} alt={fullItem.Name} class="max-h-28 max-w-full w-auto object-contain object-left mb-4 drop-shadow-lg" />
          {:else}
            <h1 class="text-6xl font-bold text-white mb-4 drop-shadow-lg">{fullItem.Name}</h1>
          {/if}

          <!-- META -->
          <div class="flex items-center flex-wrap gap-4 text-lg font-semibold text-gray-300 mb-6">
            {#if fullItem.ProductionYear}
              <span class="text-blue-400">{fullItem.ProductionYear}</span>
            {/if}
            {#if fullItem.RunTimeTicks}
              <span class="flex items-center gap-2">
                • {getRuntimeMinutes(fullItem.RunTimeTicks)}
                <span class="text-sm font-normal text-gray-400 bg-gray-800/80 px-2 py-0.5 rounded-md border border-gray-700 ml-1">
                  {getEndTime(fullItem)}
                </span>
              </span>
            {/if}
            {#if fullItem.CommunityRating}
              <span class="flex items-center gap-1 text-yellow-400">
                •
                <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/>
                </svg>
                {fullItem.CommunityRating.toFixed(1)}
              </span>
            {/if}
            {#if fullItem.CriticRating}
              <span class="flex items-center gap-1 text-gray-200">
                •
                <svg class="w-5 h-5 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                  <circle cx="12" cy="14" r="7.5" fill="#ef4444"/>
                  <ellipse cx="9.5" cy="6.5" rx="2.5" ry="1.3" fill="#22c55e" transform="rotate(-25 9.5 6.5)"/>
                  <ellipse cx="14.5" cy="6.5" rx="2.5" ry="1.3" fill="#22c55e" transform="rotate(25 14.5 6.5)"/>
                  <rect x="11.3" y="4.5" width="1.4" height="3" rx="0.7" fill="#22c55e"/>
                </svg>
                {fullItem.CriticRating}%
              </span>
            {/if}
          </div>

          <p class="text-xl text-gray-300 mb-10 line-clamp-4 leading-relaxed">{fullItem.Overview || i18n.t.noDescription}</p>

          <!-- ACTION BUTTONS -->
          <div class="flex items-center gap-4 mb-12">
            <button onclick={handlePlay} {@attach focusOnMount()}
              class="bg-white hover:bg-gray-200 focus:bg-gray-200 text-black font-bold text-2xl px-12 py-4 rounded-xl
                     focus:outline-none focus:ring-4 focus:ring-blue-500 transition-all flex items-center gap-3 shadow-lg">
              <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 20 20"><path d="M4 4l12 6-12 6z"/></svg>
              {#if fullItem.UserData?.PlaybackPositionTicks > 0}{i18n.t.resumePlay}{:else}{i18n.t.play}{/if}
            </button>

            {#if fullItem.Type === 'Series' || fullItem.Type === 'Season'}
              <button onclick={playRandomEpisode}
                class="bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 text-white font-bold text-lg px-8 py-4 rounded-xl
                       focus:outline-none focus:ring-4 focus:ring-blue-500 transition-colors shadow-lg flex items-center gap-2">
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
                       focus:outline-none focus:ring-4 focus:ring-blue-500 transition-colors shadow-lg flex items-center gap-2">
                <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3"/>
                </svg>
                {i18n.t.playFromStart}
              </button>
            {/if}

            {#if fullItem.RemoteTrailers?.length > 0}
              <button onclick={openTrailer} {@attach hint()} aria-label={i18n.t.trailer}
                class="p-4 rounded-xl bg-gray-800 text-white hover:bg-gray-700 focus:bg-gray-700
                       focus:outline-none focus:ring-4 focus:ring-blue-500 transition-colors shadow-lg">
                <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M4.5 4.5a3 3 0 00-3 3v9a3 3 0 003 3h8.25a3 3 0 003-3v-9a3 3 0 00-3-3H4.5zM19.94 18.75l-2.69-2.69V7.94l2.69-2.69c.944-.945 2.56-.276 2.56 1.06v11.38c0 1.336-1.616 2.005-2.56 1.06z"/>
                </svg>
              </button>
            {/if}

            <button onclick={togglePlayed} {@attach hint()}
              aria-label={fullItem.UserData?.Played ? i18n.t.markUnwatched : i18n.t.markWatched}
              class="p-4 rounded-xl focus:outline-none focus:ring-4 focus:ring-blue-500 transition-colors shadow-lg
                     {fullItem.UserData?.Played ? 'bg-green-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white focus:text-white'}">
              <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 20 20">
                <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/>
              </svg>
            </button>

            <button onclick={toggleFavorite} {@attach hint()}
              aria-label={fullItem.UserData?.IsFavorite ? i18n.t.removeFavorite : i18n.t.addFavorite}
              class="p-4 rounded-xl focus:outline-none focus:ring-4 focus:ring-blue-500 transition-colors shadow-lg
                     {fullItem.UserData?.IsFavorite ? 'bg-red-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white focus:text-white'}">
              <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
              </svg>
            </button>

            <button onclick={() => toggleWatchlist(fullItem)} {@attach hint()}
              aria-label={inWatchlist(fullItem.Id) ? i18n.t.removeFromWatchlist : i18n.t.addToWatchlist}
              class="p-4 rounded-xl focus:outline-none focus:ring-4 focus:ring-blue-500 transition-colors shadow-lg
                     {inWatchlist(fullItem.Id) ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white focus:text-white'}">
              <svg class="w-8 h-8" fill={inWatchlist(fullItem.Id) ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0z"/>
              </svg>
            </button>

            {#if fullItem.MediaSources?.length > 0 || fullItem.Type === 'Series' || fullItem.Type === 'Season'}
              <div class="relative" data-dropdown data-focus-trap={openDropdown === 'kebab' || undefined}>
                <button bind:this={kebabBtnEl} onclick={(e) => toggleDropdown('kebab', e)} {@attach hint()} aria-label={i18n.t.more}
                  class="p-4 rounded-xl bg-gray-800 text-gray-400 hover:text-white focus:text-white focus:outline-none focus:ring-4 focus:ring-blue-500 transition-colors shadow-lg">
                  <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
                </button>
                {#if openDropdown === 'kebab'}
                  <div class="absolute right-0 mt-2 z-50 w-80 flex flex-col gap-1 bg-gray-900 rounded-xl border border-gray-700 p-2 shadow-2xl">
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
                  <div class="flex-1" data-dropdown data-focus-trap={openDropdown === 'resolution' || undefined}>
                    <button onclick={(e) => toggleDropdown('resolution', e)}
                      class="w-full flex items-center justify-between bg-gray-900 text-gray-300 text-sm px-4 py-2 rounded border border-gray-600 focus:outline-none focus:ring-2 focus:ring-white">
                      <span>{sourceLabel(selectedSource)}</span>
                      <svg class="w-4 h-4 ml-2 shrink-0 transition-transform {openDropdown === 'resolution' ? 'rotate-180' : ''}" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
                    </button>
                    {#if openDropdown === 'resolution'}
                      <div class="mt-2 flex flex-col gap-1 bg-gray-900 rounded border border-gray-700 p-1">
                        {#each fullItem.MediaSources as src (src.Id)}
                          <button onclick={() => { selectedMediaSourceId = src.Id; onSourceChange(); closeDropdown(); }} data-opt data-active={src.Id === selectedMediaSourceId || undefined}
                            class="text-left text-sm px-3 py-2 rounded focus:outline-none focus:ring-2 focus:ring-white {src.Id === selectedMediaSourceId ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-700 focus:bg-gray-700'}">
                            {sourceLabel(src)}
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
                  <div class="flex-1" data-dropdown data-focus-trap={openDropdown === 'audio' || undefined}>
                    <button onclick={(e) => toggleDropdown('audio', e)}
                      class="w-full flex items-center justify-between bg-gray-900 text-gray-300 text-sm px-4 py-2 rounded border border-gray-600 focus:outline-none focus:ring-2 focus:ring-white">
                      <span>{audioLabel(getMediaStreams('Audio').find(s => s.Index === selectedAudioIndex))}</span>
                      <svg class="w-4 h-4 ml-2 shrink-0 transition-transform {openDropdown === 'audio' ? 'rotate-180' : ''}" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
                    </button>
                    {#if openDropdown === 'audio'}
                      <div class="mt-2 flex flex-col gap-1 bg-gray-900 rounded border border-gray-700 p-1">
                        {#each getMediaStreams('Audio') as stream (stream.Index)}
                          <button onclick={() => { selectedAudioIndex = stream.Index; closeDropdown(); }} data-opt data-active={stream.Index === selectedAudioIndex || undefined}
                            class="text-left text-sm px-3 py-2 rounded focus:outline-none focus:ring-2 focus:ring-white {stream.Index === selectedAudioIndex ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-700 focus:bg-gray-700'}">
                            {audioLabel(stream)}
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
                  <span class="text-sm font-semibold text-gray-300">{getMediaStreams('Audio')[0].DisplayTitle || getMediaStreams('Audio')[0].Language || getMediaStreams('Audio')[0].Codec}</span>
                </div>
              {/if}

              <!-- SUBTITLES: own dropdown (with "Off") -->
              {#if getMediaStreams('Subtitle').length > 0}
                <div class="flex items-start gap-4 w-full">
                  <svg class="w-6 h-6 text-gray-500 shrink-0 mt-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16"/>
                  </svg>
                  <div class="flex-1" data-dropdown data-focus-trap={openDropdown === 'subtitle' || undefined}>
                    <button onclick={(e) => toggleDropdown('subtitle', e)}
                      class="w-full flex items-center justify-between bg-gray-900 text-gray-300 text-sm px-4 py-2 rounded border border-gray-600 focus:outline-none focus:ring-2 focus:ring-white">
                      <span>{selectedSubtitleIndex === -1 ? i18n.t.subtitleOff : subtitleLabel(getMediaStreams('Subtitle').find(s => s.Index === selectedSubtitleIndex))}</span>
                      <svg class="w-4 h-4 ml-2 shrink-0 transition-transform {openDropdown === 'subtitle' ? 'rotate-180' : ''}" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
                    </button>
                    {#if openDropdown === 'subtitle'}
                      <div class="mt-2 flex flex-col gap-1 bg-gray-900 rounded border border-gray-700 p-1">
                        <button onclick={() => { selectedSubtitleIndex = -1; closeDropdown(); }} data-opt data-active={selectedSubtitleIndex === -1 || undefined}
                          class="text-left text-sm px-3 py-2 rounded focus:outline-none focus:ring-2 focus:ring-white {selectedSubtitleIndex === -1 ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-700 focus:bg-gray-700'}">
                          {i18n.t.subtitleOff}
                        </button>
                        {#each getMediaStreams('Subtitle') as stream (stream.Index)}
                          <button onclick={() => { selectedSubtitleIndex = stream.Index; closeDropdown(); }} data-opt data-active={stream.Index === selectedSubtitleIndex || undefined}
                            class="text-left text-sm px-3 py-2 rounded focus:outline-none focus:ring-2 focus:ring-white {stream.Index === selectedSubtitleIndex ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-700 focus:bg-gray-700'}">
                            {subtitleLabel(stream)}
                          </button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
              {/if}

            </div>
          {/if}

        </div>
      </div>
        </div>
      </div>
      <!-- ════ /HERO-BANNER ════ -->

      <!-- CONTENT (rows) on full app gray — its own focus group per row,
           so D-pad LEFT at the start of a row jumps directly to the sidebar. -->
      <div class="relative z-10 px-10 pb-16 bg-gray-900 flex flex-col">

      <!-- SEASONS / EPISODES -->
      {#if relatedItems.length > 0}
        <div class="mt-8 border-t border-gray-800 pt-8" data-focus-group="details-episodes">
          <h2 class="text-3xl font-bold text-white mb-6">
            {#if fullItem.Type === 'Series'}{i18n.t.seasons}
            {:else if fullItem.Type === 'Season'}{i18n.t.episodes}
            {:else}{i18n.t.moreFromSeason} {fullItem.SeasonName || ''}
            {/if}
          </h2>
          <div class="flex gap-6 overflow-x-auto hide-scrollbar pt-4 -mt-4 pb-8 px-2">
            {#each relatedItems as ep (ep.Id)}
              <button onclick={() => { fullItem = null; loadFullDetails(ep.Id); }}
                class="shrink-0 scroll-m-4 group flex flex-col focus:outline-none text-left relative {ep.Type === 'Season' ? 'w-48' : 'w-80'}">
                <div class="{ep.Type === 'Season' ? 'aspect-[2/3]' : 'aspect-video'} w-full bg-gray-800 rounded-xl overflow-hidden border-4 border-transparent group-focus:border-white group-hover:border-gray-500 group-focus:scale-105 transition-transform duration-200 shadow-xl relative">
                  {#if getItemImageUrl(ep, ep.Type === 'Season' ? 'portrait' : 'landscape')}
                    <img src={getItemImageUrl(ep, ep.Type === 'Season' ? 'portrait' : 'landscape')} {@attach blurUp(itemBlurHash(ep))} alt={ep.Name} loading="lazy"
                      class="w-full h-full object-cover transition-all duration-200 {epSpoiler(ep) ? 'blur-md scale-110' : ''}" />
                  {/if}
                  {#if itemProgress(ep) > 0}
                    <div class="absolute bottom-0 left-0 w-full h-1.5 bg-gray-900/80">
                      <div class="h-full bg-blue-500" style="width:{itemProgress(ep)}%"></div>
                    </div>
                  {/if}
                  {#if ep.UserData?.Played}
                    <div class="absolute top-2 right-2 bg-green-500 text-white rounded-full p-1 shadow-md">
                      <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/>
                      </svg>
                    </div>
                  {/if}
                </div>
                <span class="mt-3 text-sm font-bold text-gray-300 group-focus:text-white truncate w-full">
                  {#if ep.IndexNumber && ep.Type !== 'Season'}{ep.IndexNumber}.&nbsp;{/if}{ep.Name}
                </span>
              </button>
            {/each}
          </div>
        </div>
      {/if}

      <!-- EXTRAS (special features) — play directly, extras have no own detail page -->
      {#if extras.length > 0}
        <div class="mt-8 border-t border-gray-800 pt-8" data-focus-group="details-extras">
          <h2 class="text-3xl font-bold text-white mb-6">{i18n.t.extras}</h2>
          <div class="flex gap-6 overflow-x-auto hide-scrollbar pt-4 -mt-4 pb-8 px-2">
            {#each extras as ex (ex.Id)}
              <button onclick={() => onPlayVideo?.({ item: ex, audioIndex: -1, subtitleIndex: -1 })}
                class="shrink-0 w-80 scroll-m-4 group flex flex-col focus:outline-none text-left">
                <div class="aspect-video w-full bg-gray-800 rounded-xl overflow-hidden border-4 border-transparent group-focus:border-white shadow-xl group-focus:scale-105 transition-transform duration-200">
                  {#if getItemImageUrl(ex, 'landscape')}
                    <img src={getItemImageUrl(ex, 'landscape')} {@attach blurUp(itemBlurHash(ex))} alt={ex.Name} class="w-full h-full object-cover" loading="lazy" />
                  {:else}
                    <div class="w-full h-full flex items-center justify-center text-gray-600">
                      <svg class="w-12 h-12" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                    </div>
                  {/if}
                </div>
                <span class="mt-3 text-sm font-bold text-gray-300 group-focus:text-white truncate w-full">{ex.Name}</span>
                {#if ex.RunTimeTicks}<span class="text-xs text-gray-500">{getRuntimeMinutes(ex.RunTimeTicks)}</span>{/if}
              </button>
            {/each}
          </div>
        </div>
      {/if}

      <!-- CAST (tappable → the person's filmography) — belongs to the title, so above Similar -->
      {#if castMembers.length > 0}
        <div class="mt-8 border-t border-gray-800 pt-8" data-focus-group="details-cast">
          <h2 class="text-3xl font-bold text-white mb-6">{i18n.t.cast}</h2>
          <div class="flex gap-6 overflow-x-auto hide-scrollbar pt-4 -mt-4 pb-8 px-2">
            {#each castMembers as person (person.Id)}
              <button onclick={() => onOpenPerson?.(person)} class="shrink-0 w-36 scroll-m-4 group focus:outline-none text-center">
                <div class="aspect-square w-full bg-gray-800 rounded-full overflow-hidden border-4 border-transparent group-focus:border-white shadow-xl mx-auto group-focus:scale-105 transition-transform duration-200">
                  {#if personImageUrl(session.serverUrl, person)}
                    <img src={personImageUrl(session.serverUrl, person)} {@attach blurUp(itemBlurHash(person))} alt={person.Name} class="w-full h-full object-cover" loading="lazy" />
                  {:else}
                    <div class="w-full h-full flex items-center justify-center text-gray-600">
                      <svg class="w-14 h-14" fill="currentColor" viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
                    </div>
                  {/if}
                </div>
                <span class="mt-3 text-sm font-bold text-gray-300 group-focus:text-white truncate w-full block">{person.Name}</span>
                {#if person.Role}<span class="text-xs text-gray-500 truncate w-full block">{person.Role}</span>{/if}
              </button>
            {/each}
          </div>
        </div>
      {/if}

      <!-- SIMILAR -->
      {#if similarItems.length > 0}
        <div class="mt-8 border-t border-gray-800 pt-8" data-focus-group="details-similar">
          <h2 class="text-3xl font-bold text-white mb-6">{i18n.t.similar}</h2>
          <div class="flex gap-6 overflow-x-auto hide-scrollbar pt-4 -mt-4 pb-8 px-2">
            {#each similarItems as si (si.Id)}
              <button onclick={() => navigateTo(si.Id)} class="shrink-0 w-48 scroll-m-4 group flex flex-col focus:outline-none text-left">
                <div class="aspect-[2/3] w-full bg-gray-800 rounded-xl overflow-hidden border-4 border-transparent group-focus:border-white shadow-xl group-focus:scale-105 transition-transform duration-200">
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
    {#if trailerEmbedUrl.includes('/embed/')}
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
  <div data-focus-trap role="dialog" tabindex="-1" transition:uiFade onoutrostart={dropTrapOnOutro} class="fixed inset-0 bg-black/90 z-[200] flex items-center justify-center p-8"
    onkeydown={(e) => {
      if (isBackKey(e)) { e.stopPropagation(); showMediaInfo = false; return; }
      if (e.key === 'ArrowDown')    { e.preventDefault(); e.stopPropagation(); mediaInfoScroll?.scrollBy({ top: 160, behavior: 'smooth' }); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); mediaInfoScroll?.scrollBy({ top: -160, behavior: 'smooth' }); }
    }}>
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
              <div><div class="text-gray-500 text-xs uppercase tracking-wider">Container</div><div class="text-white font-semibold uppercase">{src.Container}</div></div>
            {/if}
            {#if formatBytes(src.Size)}
              <div><div class="text-gray-500 text-xs uppercase tracking-wider">{i18n.t.miSize}</div><div class="text-white font-semibold">{formatBytes(src.Size)}</div></div>
            {/if}
            {#if formatBitrate(src.Bitrate)}
              <div><div class="text-gray-500 text-xs uppercase tracking-wider">Bitrate</div><div class="text-white font-semibold">{formatBitrate(src.Bitrate)}</div></div>
            {/if}
          </div>

          <!-- Individual tracks -->
          {#each (src.MediaStreams || []) as s (s.Index)}
            <div class="bg-gray-900 rounded-xl p-4 border border-gray-700/50">
              <div class="flex items-center gap-3 mb-2">
                <span class="text-xs uppercase font-bold px-2 py-1 rounded bg-blue-600 text-white shrink-0">{s.Type === 'Subtitle' ? i18n.t.miSubtitle : s.Type}</span>
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
  </div>
{/if}

<!-- Share: QR code with a title link (IMDb/TMDb) to scan -->
{#if showShare}
  <div class="fixed inset-0 bg-black/90 z-[100] flex items-center justify-center p-8" role="dialog" tabindex="-1"
    transition:uiFade onoutrostart={dropTrapOnOutro}
    onkeydown={(e) => { if (isBackKey(e)) { e.stopPropagation(); showShare = false; } }}>
    <div data-modal data-focus-trap
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
      <p class="text-white font-bold text-center break-words">{fullItem?.Name}</p>
      <p class="text-gray-400 text-base text-center max-w-md">{i18n.t.shareHint}</p>
    </div>
  </div>
{/if}

<!-- Add to collection / playlist (shared component) -->
<AddToPicker mode={pickerMode} item={fullItem} {selectedUser} {getAuthHeaders}
  onCreated={() => onLibChanged?.()} onClose={() => pickerMode = null} />

<style>
  /* Deliberately NO scroll-snap on the rows: on D-pad devices only the focus scrolls
     (scrollIntoView) — proximity snapping pulled its position back phase-dependently
     and cut off the scaled border of the edge card (webOS/B4). */
</style>
