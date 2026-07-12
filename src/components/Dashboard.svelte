<script>
  import { i18n } from '../i18n.svelte.js';
  import { itemProgress, itemBadge, longPress, authHeaders, blurUp, itemBlurHash, uiFade, getItemSubtitle } from '../utils.js';
  import { session } from '../session.svelte.js';
  import { watchlist, refreshWatchlist } from '../watchlist.svelte.js';
  import { onMount, onDestroy } from 'svelte';

  let {
    selectedUser,
    apiCache,
    reduceAnimations = false,   // controls the hero auto-rotation
    showHero         = true,    // show the hero banner (setting)
    dashboardBackdrop = true,   // backdrop of the focused title behind the dashboard (opt-out)
    showLibraries    = true,    // show the "My Libraries" row
    showHistory      = true,    // show the "Recently Watched" row
    showNextUp       = true,    // show the "Up Next" row
    showWatchlist    = true,    // show the watchlist row (unwatched titles only)
    showRecommendations = true, // show the "Because you watched …" row
    recommendationRows   = 1,   // 1 or 2 recommendation rows
    showLatest       = true,    // "Recently Added" (movies + series)
    showCollections  = true,    // "Collections" (BoxSets)
    sharedSuggestions = [],     // "For you both" — titles that match the shared preference
    showSharedSuggestions = false, // show the row (only when a shared profile is set up)
    resumeStale = false,        // App: playback happened since the last dashboard visit → fetch Resume/NextUp fresh
    onResumeRefreshed,          // () => void — App resets the flag
    onLibrariesLoaded, onOpenCollection, onOpenContext, onOpenDetails, onOpenLibrary,   // callback props
  } = $props();

  let isLoading        = $state(false);
  let libraries        = $state([]);
  // Report to App as soon as the libraries are there (cache hit or fetch) — feeds the
  // sidebar/navigation reactively without App having to fetch separately (prevents a race).
  $effect(() => { if (libraries.length) onLibrariesLoaded?.(libraries); });
  let continueWatching = $state([]);
  let nextUp           = $state([]);
  let latestMovies     = $state([]);
  let latestSeries     = $state([]);
  let recentlyWatched  = $state([]);
  // Watchlist row: watched titles are hidden here but stay in the playlist until removed
  // manually. Series are stored as ONE representative episode (see watchlist.svelte.js)
  // and are displayed as the series itself (poster + name, opens the series details).
  let watchlistDisplay = $derived.by(() => {
    const seen = new Set(); const out = [];
    for (const it of (watchlist.items || [])) {
      if (it.UserData?.Played) continue;
      if (it.Type === 'Episode' && it.SeriesId) {
        if (seen.has(it.SeriesId)) continue;
        seen.add(it.SeriesId);
        out.push({ Id: it.SeriesId, Type: 'Series', Name: it.SeriesName || it.Name,
          // Same as in dedupeHistory: carry the episode's inherited series backdrop along
          // so the focus backdrop preview works for series entries too.
          ParentBackdropItemId: it.ParentBackdropItemId ?? it.SeriesId,
          ParentBackdropImageTags: it.ParentBackdropImageTags,
          _imgUrl: `${session.serverUrl}/Items/${it.SeriesId}/Images/Primary?fillHeight=400&fillWidth=266&quality=80&format=webp${it.SeriesPrimaryImageTag ? `&tag=${it.SeriesPrimaryImageTag}` : ''}` });
      } else {
        if (seen.has(it.Id)) continue;
        seen.add(it.Id);
        out.push(it);
      }
    }
    return out;
  });   // "Recently Watched" (history)
  let recommendations  = $state([]);   // [{ seedTitle, items }] — "Because you watched X"
  let collections      = $state([]);   // BoxSets ("Collections")

  // Derive "Continue Watching" reactively: an item marked/reset as watched in place
  // (the ContextMenu mutates item.UserData directly) disappears from the row immediately — without a reload.
  let resumeRow = $derived(continueWatching.filter(
    i => !i.UserData?.Played && (i.UserData?.PlaybackPositionTicks || 0) > 0
  ));

  // HERO BANNER: rotating featured item (Netflix style)
  let heroItems  = $state([]);
  let heroIndex  = $state(0);
  let prevHeroIndex = $state(-1);   // the previous image stays as a base during the switch (crossfade instead of dip-to-black)
  let heroTimer;
  let heroBuilt  = false;   // per load: true once the hero is built (prevents reshuffling on the second latest fetch)
  let heroForYouPending = false;   // true while the "For You" fetch runs → the new-additions fallback waits until it has decided
  let heroLoading = $state(false);   // true while the featured data is still loading → reserve the space (no shifting up)
  let heroCurrent = $derived(heroItems[heroIndex] || null);

  const skeletons = Array(6).fill(0);

  onMount(() => { loadDashboardData(); });
  onDestroy(() => { clearInterval(heroTimer); clearTimeout(previewTimer); clearTimeout(clearTimer); });

  // ── Backdrop preview (like in the Library): 700 ms after focusing a card, fade in its backdrop
  //    behind the dashboard; remove it again on leaving. Opt-out via dashboardBackdrop. ──
  let previewBackdrop = $state("");
  let previewTimer, clearTimer;
  function previewItem(item) {
    if (!dashboardBackdrop || !item) return;
    clearTimeout(clearTimer);   // a card focus follows directly → do NOT clear (no card→card flicker)
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      const tag  = item.BackdropImageTags?.[0];
      const pTag = item.ParentBackdropImageTags?.[0];
      if (tag)       previewBackdrop = `${session.serverUrl}/Items/${item.Id}/Images/Backdrop?tag=${tag}&maxWidth=1280&quality=70&format=webp`;
      else if (pTag) previewBackdrop = `${session.serverUrl}/Items/${item.ParentBackdropItemId}/Images/Backdrop?tag=${pTag}&maxWidth=1280&quality=70&format=webp`;
    }, 700);
  }
  // Focus leaves a card: stop the fade-in timer and clear the backdrop with a short delay.
  // If another card focus follows immediately (card→card), previewItem cancels the clearing → no
  // flicker. If focus goes to the hero, the library tiles or the navigation, the clearing stands
  // → no backdrop behind the hero anymore (see the screenshot problem).
  // Couple the backdrop opacity to the hero visibility: at the very top (hero visible) off → no
  // conflict with the hero image; on scrolling down it fades in as soon as the hero leaves the
  // picture. This way Continue Watching/Up Next get the backdrop too, just only on scrolling.
  let bgOpacity = $state(0);
  function heroScrollFade(node) {
    let sc = node.parentElement;   // find the scrolling ancestor (App main area)
    while (sc && !(/(auto|scroll)/.test(getComputedStyle(sc).overflowY) && sc.scrollHeight > sc.clientHeight + 4)) sc = sc.parentElement;
    if (!sc) { bgOpacity = 1; return; }
    let raf = 0;
    const update = () => {
      raf = 0;
      if (!showHero || !heroItems.length) { bgOpacity = 1; return; }   // no hero → no conflict, show fully
      const heroH = sc.clientHeight * 0.44;   // corresponds to the hero height (h-[44vh])
      bgOpacity = Math.min(1, Math.max(0, sc.scrollTop / heroH));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    sc.addEventListener("scroll", onScroll, { passive: true });
    update();   // initial value immediately
    return () => { sc.removeEventListener("scroll", onScroll); if (raf) cancelAnimationFrame(raf); };
  }

  function cancelPreview() {
    clearTimeout(previewTimer);
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => { previewBackdrop = ""; }, 150);
  }

  // Build the featured list from the newest movies/series with a backdrop + start the rotation
  // Preloads the image of the next hero item → seamless switch without popping in.
  function preloadHero(index) {
    const next = heroItems[index];
    if (!next) return;
    const url = getHeroBackdrop(next);
    if (url) { const img = new Image(); img.src = url; }
  }

  // Exclude titles already in "Continue Watching" (no duplication); series also via SeriesId.
  function heroInProgressSet() {
    const inProgress = new Set();
    continueWatching.forEach(i => { inProgress.add(i.Id); if (i.SeriesId) inProgress.add(i.SeriesId); });
    return inProgress;
  }

  // Start the rotation for the already-set heroItems (shared by "For You" and the fallback).
  function startHeroRotation() {
    heroIndex = 0;
    prevHeroIndex = -1;
    heroBuilt = true;
    heroLoading = false;   // hero is ready → skeleton gone
    clearInterval(heroTimer);
    if (apiCache.dashboard) apiCache.dashboard.heroItems = heroItems;   // cache-proof: switching dashboards doesn't reload
    if (!reduceAnimations && heroItems.length > 1) {
      preloadHero(1);   // preload the next image
      heroTimer = setInterval(() => {
        prevHeroIndex = heroIndex;
        heroIndex = (heroIndex + 1) % heroItems.length;
        preloadHero((heroIndex + 1) % heroItems.length);
      }, 8000);
    }
  }

  // Take the "For You" pool (rating-sorted) into the hero. Shuffle slightly among the
  // top-rated so quality stays on top, but not always the same 5 in the same order.
  // false = pool too thin → the caller uses the new-additions fallback.
  function applyHeroPool(pool) {
    if (heroBuilt) return true;
    const inProgress = heroInProgressSet();
    const filtered = (pool || []).filter(i => i.BackdropImageTags?.length > 0 && !inProgress.has(i.Id));
    if (filtered.length < HERO_MIN) return false;
    heroItems = filtered.slice(0, 12).sort(() => Math.random() - 0.5).slice(0, 5);
    startHeroRotation();
    return true;
  }

  // New-additions fallback: newest movies/series with a backdrop, random. Kicks in when "For You"
  // had no/too thin a signal (new profile, empty genres) or the fetch failed.
  function buildHero() {
    if (heroBuilt || heroForYouPending) return;   // already built OR "For You" is still deciding
    const inProgress = heroInProgressSet();
    const pool = [...latestMovies, ...latestSeries]
      .filter(i => i.BackdropImageTags?.length > 0 && !inProgress.has(i.Id));
    if (pool.length === 0) return;   // no usable items yet → the next call tries again
    heroItems = pool.sort(() => Math.random() - 0.5).slice(0, 5);
    startHeroRotation();
  }

  const getAuthHeaders = () => authHeaders(session.token);
  const FIELDS = "PrimaryImageAspectRatio,Overview,BackdropImageTags";
  const ROW_LIMIT = 12;   // uniform row length: rows are teasers, the catalog is the library
  const HERO_MIN = 3;     // use the "For You" pool only from this many usable titles on, otherwise new-additions fallback
                          // (exceptions deliberate: hero = 5-item rotation, collections = curated, uncapped)

  // Clean NextUp of titles already in "Continue Watching" (by episode or series ID).
  function filterNextUp(raw) {
    const inProgress = new Set();
    continueWatching.forEach(i => { inProgress.add(i.Id); if (i.SeriesId) inProgress.add(i.SeriesId); });
    return raw.filter(i => !inProgress.has(i.Id) && !inProgress.has(i.SeriesId));
  }

  // After playback: fetch ONLY Resume + NextUp fresh and merge them into the cache — the
  // instant display from the cache stays, but the one row that actually changed is
  // correct again (progress/new title). No full reload, the hero stays put (no reshuffle).
  async function refreshResume() {
    try {
      const uId  = selectedUser.Id;
      const opts = { headers: getAuthHeaders() };
      const [rRes, rNext] = await Promise.all([
        fetch(`${session.serverUrl}/Users/${uId}/Items/Resume?Limit=${ROW_LIMIT}&Fields=${FIELDS}&EnableImageTypes=Primary,Backdrop,Thumb&EnableTotalRecordCount=false`, opts),
        fetch(`${session.serverUrl}/Shows/NextUp?UserId=${uId}&Limit=${ROW_LIMIT}&Fields=${FIELDS}&EnableImageTypes=Primary,Backdrop,Thumb&EnableTotalRecordCount=false`, opts),
      ]);
      continueWatching = (await rRes.json()).Items || [];
      const dNext = await rNext.json();
      nextUp = filterNextUp(Array.isArray(dNext) ? dNext : (dNext.Items || []));
      if (apiCache.dashboard) { apiCache.dashboard.continueWatching = continueWatching; apiCache.dashboard.nextUp = nextUp; }
      onResumeRefreshed?.();
    } catch { /* the flag stays set → the next dashboard visit tries again */ }
  }

  // Recommendations: seeds from recently watched items, then /Items/{id}/Similar.
  // Best practice (Netflix/Plex): right in the dashboard, no separate tab.
  async function loadRecommendations(uId, opts, fields) {
    try {
      // Fetch recently played movies/series as the hook
      const res = await fetch(
        `${session.serverUrl}/Users/${uId}/Items?SortBy=DatePlayed&SortOrder=Descending&Filters=IsPlayed` +
        `&IncludeItemTypes=Movie,Series&Recursive=true&Limit=4&Fields=${fields}`, opts
      );
      const seeds = (await res.json()).Items || [];

      // Up to two rows of similar titles (cached). Depending on the
      // setting, 1 or 2 are rendered — so switching feels instant without a reload.
      const rows = [];
      for (const seed of seeds.slice(0, 2)) {
        const sim = await fetch(`${session.serverUrl}/Items/${seed.Id}/Similar?userId=${uId}&limit=${ROW_LIMIT}&Fields=${fields}`, opts);
        const items = (await sim.json()).Items || [];
        if (items.length >= 4) rows.push({ seedTitle: seed.Name, items });
      }
      recommendations = rows;
      if (apiCache.dashboard) apiCache.dashboard.recommendations = rows;
    } catch { /* recommendations are optional */ }
  }

  // "For You" hero (variant A): derives the most frequent genres from recently watched and pulls
  // UNWATCHED, well-rated titles with a backdrop from them — instead of "newest additions, random".
  // Returns the candidate pool (rating-sorted). Empty = no signal / error → the caller
  // falls back to the previous new-additions logic so the hero never looks empty.
  // NOT wired up YET — step 2 switches buildHero over to it.
  async function loadHeroForYou(uId, opts) {
    try {
      // 1) Taste signal: recently watched movies/series WITH genres (a separate fetch, since FIELDS carries none).
      const seedRes = await fetch(
        `${session.serverUrl}/Users/${uId}/Items?SortBy=DatePlayed&SortOrder=Descending&Filters=IsPlayed` +
        `&IncludeItemTypes=Movie,Series&Recursive=true&Limit=25&Fields=Genres&EnableTotalRecordCount=false`, opts
      );
      const seeds = (await seedRes.json()).Items || [];

      // 2) Count genres weighted — recently watched (higher up in the DatePlayed list) counts a bit more.
      const counts = new Map();
      seeds.forEach((it, idx) => {
        const weight = 1 + (seeds.length - idx) / seeds.length;
        (it.Genres || []).forEach(g => counts.set(g, (counts.get(g) || 0) + weight));
      });
      if (counts.size === 0) return [];   // no signal (new profile) → fallback at the caller

      const topGenres = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([g]) => g);

      // 3) "For You" pool: unwatched, well-rated titles from these genres, with a backdrop.
      //    Genres= is pipe-separated (OR combination).
      const genreParam = topGenres.map(encodeURIComponent).join('|');
      const poolRes = await fetch(
        `${session.serverUrl}/Users/${uId}/Items?IncludeItemTypes=Movie,Series&Recursive=true` +
        `&Filters=IsUnplayed&Genres=${genreParam}&SortBy=CommunityRating&SortOrder=Descending` +
        `&Limit=40&Fields=${FIELDS}&EnableImageTypes=Backdrop,Primary,Logo&EnableTotalRecordCount=false`, opts
      );
      const pool = ((await poolRes.json()).Items || []).filter(i => i.BackdropImageTags?.length > 0);
      return pool;
    } catch {
      return [];   // error → new-additions fallback at the caller
    }
  }

  async function loadDashboardData() {
    // Fire-and-forget re-sync: picks up Played changes made outside the watchlist flows
    // (e.g. marked as watched via the context menu) so the row hides them reliably.
    refreshWatchlist();
    heroBuilt = false;   // rebuild per load
    // Cache hit: load from cache immediately, no network
    if (apiCache.dashboard) {
      ({ libraries, continueWatching, nextUp, latestMovies, latestSeries, recentlyWatched, recommendations } = apiCache.dashboard);
      recentlyWatched = recentlyWatched || [];
      recommendations = recommendations || [];
      collections     = apiCache.dashboard.collections || [];
      // Cache hit: take the previously built "For You" selection directly (instant, no network);
      // only if none is cached, build the new-additions fallback.
      if (apiCache.dashboard.heroItems?.length) { heroItems = apiCache.dashboard.heroItems; startHeroRotation(); }
      else buildHero();
      if (resumeStale) refreshResume();   // background refresh, the UI is already up from the cache
      return;
    }

    isLoading   = true;
    heroLoading = true;   // reserve the hero space from the first paint until the featured data is there
    try {
      const uId   = selectedUser.Id;
      const opts  = { headers: getAuthHeaders() };
      const fields = FIELDS;

      // Start all 5 fetches at once — no sequential waiting
      const pViews        = fetch(`${session.serverUrl}/Users/${uId}/Views`, opts);
      const pResume       = fetch(`${session.serverUrl}/Users/${uId}/Items/Resume?Limit=${ROW_LIMIT}&Fields=${fields}&EnableImageTypes=Primary,Backdrop,Thumb&EnableTotalRecordCount=false`, opts);
      const pNextUp       = fetch(`${session.serverUrl}/Shows/NextUp?UserId=${uId}&Limit=${ROW_LIMIT}&Fields=${fields}&EnableImageTypes=Primary,Backdrop,Thumb&EnableTotalRecordCount=false`, opts);
      const pLatestMovies = fetch(`${session.serverUrl}/Users/${uId}/Items/Latest?IncludeItemTypes=Movie&Limit=${ROW_LIMIT}&Fields=${fields}`, opts);
      const pLatestSeries = fetch(`${session.serverUrl}/Users/${uId}/Items/Latest?IncludeItemTypes=Series&Limit=${ROW_LIMIT}&Fields=${fields}`, opts);
      // History: recently watched movies/episodes. Fetch more (40), since series are then
      // collapsed to one entry each (buffer for a good mix).
      const pHistory      = fetch(`${session.serverUrl}/Users/${uId}/Items?SortBy=DatePlayed&SortOrder=Descending&Filters=IsPlayed&IncludeItemTypes=Movie,Episode&Recursive=true&Limit=40&Fields=${fields}&EnableTotalRecordCount=false`, opts);
      // Collections (BoxSets)
      const pCollections  = fetch(`${session.serverUrl}/Users/${uId}/Items?IncludeItemTypes=BoxSet&Recursive=true&SortBy=SortName&Fields=PrimaryImageAspectRatio&Limit=50&EnableTotalRecordCount=false`, opts);

      // Priority: Views + Resume → release the UI immediately
      const [resViews, resResume] = await Promise.all([pViews, pResume]);
      libraries        = (await resViews.json()).Items  || [];
      continueWatching = (await resResume.json()).Items || [];
      isLoading        = false;
      session.connectionLost = false;   // server reachable

      // Fill the cache early → sidebar navigation works immediately
      apiCache.dashboard = { libraries, continueWatching, nextUp: [], latestMovies: [], latestSeries: [], recentlyWatched: [], recommendations: [], collections: [], heroItems: [] };

      // Load collections independently
      pCollections.then(r => r.json()).then(d => {
        collections = (Array.isArray(d) ? d : (d.Items || [])).filter(c => c.ChildCount !== 0);
        apiCache.dashboard.collections = collections;
      }).catch(() => {});

      // Derive recommendations ("Because you watched X") from recently watched
      loadRecommendations(uId, opts, fields);

      // Kick off the "For You" hero (variant A) in parallel: it decides between the genre pool and
      // the new-additions fallback. Until then buildHero is blocked (heroForYouPending) — a bit more
      // skeleton time, but the better hero; the reserved space prevents shifting up.
      heroForYouPending = true;
      const pHeroForYou = loadHeroForYou(uId, opts)
        .then(pool => { heroForYouPending = false; if (!heroBuilt && !applyHeroPool(pool)) buildHero(); })
        .catch(() => { heroForYouPending = false; if (!heroBuilt) buildHero(); });

      // Load history + collapse by series
      pHistory.then(r => r.json()).then(async d => {
        let items = dedupeHistory(d.Items || []).slice(0, ROW_LIMIT);   // uniform row length; capping BEFORE the enrichment saves series lookups
        // Show series with a real year range like in the library ("2016 – 2019" / "2024 – today"):
        // load the real series info (year/status/EndDate) once for all series entries.
        const seriesIds = items.filter(i => i.Type === 'Series').map(i => i.Id);
        if (seriesIds.length) {
          try {
            const r2 = await fetch(`${session.serverUrl}/Users/${uId}/Items?Ids=${seriesIds.join(',')}&Fields=ProductionYear,Status,EndDate`, opts);
            const info = new Map(((await r2.json()).Items || []).map(s => [s.Id, s]));
            items = items.map(i => {
              const s = i.Type === 'Series' ? info.get(i.Id) : null;
              // Take the REAL series' UserData along: the pseudo-entries from dedupeHistory have
              // none — without it the watched badge stays blind for fully watched series.
              return s ? { ...i, ProductionYear: s.ProductionYear, Status: s.Status, EndDate: s.EndDate, UserData: s.UserData } : i;
            });
          } catch { /* enrichment optional — if it fails, only the title remains */ }
        }
        recentlyWatched = items;
        apiCache.dashboard.recentlyWatched = recentlyWatched;
      }).catch(() => {});

      // Update secondary sections independently — the fastest comes first
      // FIX: removed `|| d` (d would be the response object, not an array)
      // FIX: .catch(() => {}) so a single error doesn't block everything
      // /Items/Latest returns a DIRECT array (not { Items: [...] })!
      // Other endpoints return { Items, TotalRecordCount }. Handle both cases.
      pNextUp.then(r => r.json()).then(d => {
        const raw = Array.isArray(d) ? d : (d.Items || []);
        // Exclude in-progress titles (already in "Continue Watching") — like the Jellyfin app.
        nextUp = filterNextUp(raw);
        apiCache.dashboard.nextUp = nextUp;
      }).catch(() => {});

      // Process the latest fetches INDEPENDENTLY: each row fills immediately, and the hero is
      // built as soon as the FIRST usable data is there — not only when the slower
      // of the two fetches returns (that was the actual skeleton bottleneck).
      const pm = pLatestMovies.then(r => r.json()).catch(() => []);
      const ps = pLatestSeries.then(r => r.json()).catch(() => []);
      pm.then(d => {
        latestMovies = Array.isArray(d) ? d : (d.Items || []);
        apiCache.dashboard.latestMovies = latestMovies;
        buildHero();
      });
      ps.then(d => {
        latestSeries = Array.isArray(d) ? d : (d.Items || []);
        apiCache.dashboard.latestSeries = latestSeries;
        buildHero();
      });
      // Safety net: end the skeleton only once Latest AND "For You" have decided
      // (otherwise the placeholder would vanish while the For-You fetch is still running → gap/jump).
      Promise.all([pm, ps, pHeroForYou]).then(() => { heroLoading = false; });

    } catch (err) {
      console.error("Dashboard load failed:", err);
      isLoading   = false;
      heroLoading = false;
      session.connectionLost = true;   // server unreachable → banner
    }
  }

  // Collapse history by series: only the most recently watched episode per series
  // (the list is already sorted by date descending → the first is the newest).
  // Movies stay individual. Prevents "10× the same series" while binge-watching.
  function dedupeHistory(items) {
    const seenSeries = new Set();
    const out = [];
    for (const it of items) {
      let entry = it;
      if (it.Type === 'Episode' && it.SeriesId) {
        if (seenSeries.has(it.SeriesId)) continue;
        seenSeries.add(it.SeriesId);
        // History: show the series as ONE entry (not the individual episode). "Continue Watching"
        // already covers the specific episode; here only which series ran last matters.
        entry = {
          Id: it.SeriesId,
          Name: it.SeriesName,
          Type: 'Series',
          ImageTags: it.SeriesPrimaryImageTag ? { Primary: it.SeriesPrimaryImageTag } : undefined,
          PrimaryImageAspectRatio: 0.6667,
          ImageBlurHashes: it.ImageBlurHashes,
          // Carry the episode's INHERITED series backdrop along — the focus backdrop
          // preview (previewItem) builds its URL from BackdropImageTags/Parent*; without
          // these the preview silently keeps showing the previous title's backdrop.
          ParentBackdropItemId: it.ParentBackdropItemId ?? it.SeriesId,
          ParentBackdropImageTags: it.ParentBackdropImageTags,
        };
      }
      out.push(entry);
      if (out.length >= 16) break;
    }
    return out;
  }

  // History cards uniformly portrait: episodes use the series poster
  function getHistoryImageUrl(item) {
    if (item.Type === 'Episode' && item.SeriesId && item.SeriesPrimaryImageTag)
      return `${session.serverUrl}/Items/${item.SeriesId}/Images/Primary?tag=${item.SeriesPrimaryImageTag}&fillHeight=400&fillWidth=266&quality=80&format=webp`;
    if (item.ImageTags?.Primary)
      return `${session.serverUrl}/Items/${item.Id}/Images/Primary?tag=${item.ImageTags.Primary}&fillHeight=400&fillWidth=266&quality=80&format=webp`;
    return null;
  }

  function getItemImageUrl(item, format = 'portrait') {
    if (format === 'landscape') {
      // Like Jellyfin (preferThumb): prefer landscape artwork — own thumb, otherwise
      // series/parent thumb, then backdrop (episode → series), lastly the episode still.
      if (item.ImageTags?.Thumb)
        return `${session.serverUrl}/Items/${item.Id}/Images/Thumb?tag=${item.ImageTags.Thumb}&maxWidth=600&quality=80&format=webp`;
      if (item.ParentThumbItemId && item.ParentThumbImageTag)
        return `${session.serverUrl}/Items/${item.ParentThumbItemId}/Images/Thumb?tag=${item.ParentThumbImageTag}&maxWidth=600&quality=80&format=webp`;
      if (item.SeriesId && item.SeriesThumbImageTag)
        return `${session.serverUrl}/Items/${item.SeriesId}/Images/Thumb?tag=${item.SeriesThumbImageTag}&maxWidth=600&quality=80&format=webp`;
      if (item.BackdropImageTags?.length > 0)
        return `${session.serverUrl}/Items/${item.Id}/Images/Backdrop?tag=${item.BackdropImageTags[0]}&maxWidth=600&quality=80&format=webp`;
      if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.length > 0)
        return `${session.serverUrl}/Items/${item.ParentBackdropItemId}/Images/Backdrop?tag=${item.ParentBackdropImageTags[0]}&maxWidth=600&quality=80&format=webp`;
      if (item.ImageTags?.Primary)
        return `${session.serverUrl}/Items/${item.Id}/Images/Primary?tag=${item.ImageTags.Primary}&maxWidth=600&quality=80&format=webp`;
    } else {
      if (item.ImageTags?.Primary)
        return `${session.serverUrl}/Items/${item.Id}/Images/Primary?tag=${item.ImageTags.Primary}&fillHeight=400&fillWidth=266&quality=80&format=webp`;
    }
    return null;
  }

  function getItemTitle(item) {
    return (item.Type === 'Episode' && item.SeriesName) ? item.SeriesName : item.Name;
  }

  // Remaining time in minutes for "Continue Watching"
  function getRemainingMinutes(item) {
    if (!item.RunTimeTicks || !item.UserData?.PlaybackPositionTicks) return null;
    const remTicks = item.RunTimeTicks - item.UserData.PlaybackPositionTicks;
    const mins = Math.round(remTicks / 10000000 / 60);
    return mins > 0 ? mins : null;
  }

  // Hero backdrop in high resolution
  function getHeroBackdrop(item) {
    if (item?.BackdropImageTags?.length > 0)
      return `${session.serverUrl}/Items/${item.Id}/Images/Backdrop?tag=${item.BackdropImageTags[0]}&maxWidth=1920&quality=85&format=webp`;
    return null;
  }

  // Logo image (transparent title lettering) — if present, instead of the text title.
  // Looks more premium; one extra image, no extra effort on the data side.
  function getHeroLogo(item) {
    if (item.ImageTags?.Logo)
      return `${session.serverUrl}/Items/${item.Id}/Images/Logo?tag=${item.ImageTags.Logo}&maxHeight=130&quality=90&format=webp`;
    return null;
  }</script>

<div class="relative">
  <!-- Dashboard backdrop: backdrop of the focused title, pinned to the top of the viewport
       (sticky, not absolute — the dashboard scrolls in the App container). -mb-[100vh] cancels its
       own height again, so the content sits above it instead of sliding underneath. -->
  {#if dashboardBackdrop && previewBackdrop}
    <div {@attach heroScrollFade} style="opacity:{bgOpacity}" class="sticky top-0 h-screen w-full -mb-[100vh] z-0 pointer-events-none overflow-hidden">
      {#key previewBackdrop}
        <img src={previewBackdrop} alt="" class="w-full h-full object-cover preview-fade" />
      {/key}
      <div class="absolute inset-0 bg-gradient-to-r from-gray-900 via-gray-900/85 to-gray-900/40"></div>
      <div class="absolute inset-0 bg-gradient-to-t from-gray-900 via-transparent to-gray-900/60"></div>
    </div>
  {/if}
  <div class="relative z-10 px-10 pt-16 pb-20 flex flex-col gap-12">

  <!-- Reusable card snippets (instead of 8 nearly identical blocks) -->
  {#snippet landscapeCard(item)}
    {@const img = getItemImageUrl(item, 'landscape')}
    {@const prog = itemProgress(item)}
    {@const badge = itemBadge(item)}
    {@const rem = getRemainingMinutes(item)}
    {@const sub = getItemSubtitle(item, i18n.t.today)}
    <button onclick={() => onOpenDetails?.(item)} data-item-id={item.Id} {@attach longPress()} onlongpress={() => onOpenContext?.(item)}
      onfocus={() => previewItem(item)} onblur={cancelPreview}
      class="shrink-0 w-80 group flex flex-col focus:outline-none text-left scroll-mt-24 scroll-mx-4">
      <div class="aspect-video w-full bg-gray-800 rounded-lg overflow-hidden
                  border-4 border-transparent group-focus:border-white group-focus:scale-105
                  transition-transform duration-200 shadow-xl relative">
        {#if img}
          <img src={img} {@attach blurUp(itemBlurHash(item, 'Backdrop'))} alt={item.Name}
            class="w-full h-full object-cover" loading="lazy" />
        {/if}
        {#if badge}
          <div class="absolute top-2 left-2 z-10 min-w-[1.6rem] h-[1.6rem] px-1.5 rounded-full flex items-center justify-center bg-blue-600/90 text-white text-xs font-bold shadow-md pointer-events-none">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
        {/if}
        {#if prog > 0}
          <div class="absolute bottom-0 left-0 w-full h-1.5 bg-gray-900/80">
            <div class="h-full bg-blue-500" style="width:{prog}%"></div>
          </div>
        {/if}
        {#if rem}
          <div class="absolute top-2 right-2 bg-black/80 text-white text-xs font-bold px-2 py-1 rounded-md">
            {rem} {i18n.t.mins} {i18n.t.remaining}
          </div>
        {/if}
      </div>
      <div class="mt-3 flex flex-col w-full overflow-hidden">
        <span class="text-sm font-bold text-gray-200 group-focus:text-white truncate w-full">{getItemTitle(item)}</span>
        {#if sub}
          <span class="text-xs text-gray-400 group-focus:text-gray-300 truncate w-full mt-0.5">{sub}</span>
        {/if}
      </div>
    </button>
  {/snippet}

  {#snippet portraitCard(item, img, blur)}
    {@const prog = itemProgress(item)}
    {@const badge = itemBadge(item)}
    {@const sub = getItemSubtitle(item, i18n.t.today)}
    <button onclick={() => onOpenDetails?.(item)} data-item-id={item.Id} {@attach longPress()} onlongpress={() => onOpenContext?.(item)}
      onfocus={() => previewItem(item)} onblur={cancelPreview}
      class="shrink-0 w-48 group flex flex-col focus:outline-none text-left scroll-mt-24 scroll-mx-4">
      <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg overflow-hidden relative
                  border-4 border-transparent group-focus:border-white group-focus:scale-105
                  transition-transform duration-200 shadow-xl">
        {#if img}
          <img src={img} {@attach blurUp(blur)} alt={item.Name}
            class="w-full h-full object-cover" loading="lazy" />
        {/if}
        {#if badge}
          <div class="absolute top-2 left-2 z-10 min-w-[1.6rem] h-[1.6rem] px-1.5 rounded-full flex items-center justify-center bg-blue-600/90 text-white text-xs font-bold shadow-md pointer-events-none">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
        {/if}
        {#if prog > 0}
          <div class="absolute bottom-0 left-0 w-full h-1.5 bg-gray-900/80">
            <div class="h-full bg-blue-500" style="width:{prog}%"></div>
          </div>
        {/if}
      </div>
      <div class="mt-3 flex flex-col w-full overflow-hidden">
        <span class="text-sm font-bold text-gray-200 group-focus:text-white truncate w-full">{getItemTitle(item)}</span>
        {#if sub}
          <span class="text-xs text-gray-400 group-focus:text-gray-300 truncate w-full mt-0.5">{sub}</span>
        {/if}
      </div>
    </button>
  {/snippet}

  {#snippet collectionCard(col)}
    {@const img = getItemImageUrl(col)}
    <button onclick={() => onOpenCollection?.(col)} onfocus={() => previewItem(col)} onblur={cancelPreview}
      class="shrink-0 w-48 group flex flex-col focus:outline-none text-left scroll-mt-24 scroll-mx-4">
      <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg overflow-hidden relative
                  border-4 border-transparent group-focus:border-white group-focus:scale-105
                  transition-transform duration-200 shadow-xl">
        {#if img}
          <img src={img} {@attach blurUp(itemBlurHash(col))} alt={col.Name}
            class="w-full h-full object-cover" loading="lazy" />
        {:else}
          <div class="w-full h-full flex items-center justify-center text-gray-600">
            <svg class="w-14 h-14" fill="currentColor" viewBox="0 0 24 24"><path d="M4 6h16v2H4zm2-4h12v2H6zm-4 8h20v10a2 2 0 01-2 2H4a2 2 0 01-2-2V10z"/></svg>
          </div>
        {/if}
      </div>
      <span class="mt-3 text-sm font-bold text-gray-200 group-focus:text-white truncate w-full">{col.Name}</span>
    </button>
  {/snippet}

  <!-- Hero skeleton: reserves the banner height + hints at the title/text/button. ONE snippet for both
       loading phases (initial skeleton AND heroLoading) so nothing shifts up from the first paint. -->
  {#snippet heroSkeleton()}
    <div class="relative -mx-10 -mt-16 mb-2 h-[44vh] min-h-[320px] overflow-hidden bg-gradient-to-br from-gray-800/40 via-gray-900/70 to-gray-900">
      <div class="absolute inset-0 bg-gradient-to-t from-gray-900 via-gray-900/40 to-transparent"></div>
      <div class="absolute bottom-0 left-0 p-10 pb-8 max-w-3xl flex flex-col gap-3 {reduceAnimations ? '' : 'animate-pulse'}">
        <div class="h-14 w-80 max-w-[60%] bg-white/10 rounded-lg"></div>
        <div class="h-4 w-44 bg-white/10 rounded"></div>
        <div class="h-3.5 w-full max-w-xl bg-white/10 rounded"></div>
        <div class="h-3.5 w-2/3 max-w-md bg-white/10 rounded"></div>
        <div class="h-12 w-44 bg-white/10 rounded-xl mt-2"></div>
      </div>
    </div>
  {/snippet}


  {#if isLoading}
    <!-- Skeleton loader — mirrors the real layout: first the hero height (when active), then rows,
         so nothing jumps when loading finishes. -->
    {#if showHero}{@render heroSkeleton()}{/if}
    {#each [1, 2, 3] as _}
      <div>
        <div class="h-8 w-48 bg-gray-800 rounded animate-pulse mb-4"></div>
        <div class="flex gap-6 overflow-hidden">
          {#each skeletons as __}
            <div class="shrink-0 w-48 aspect-[2/3] bg-gray-800 rounded-lg animate-pulse"></div>
          {/each}
        </div>
      </div>
    {/each}

  {:else}

    <!-- HERO BANNER — rotating featured item -->
    {#if showHero && heroCurrent}
      <div transition:uiFade class="relative -mx-10 -mt-16 mb-2 h-[44vh] min-h-[320px] overflow-hidden bg-gray-900">
        <!-- Full-bleed backdrop (Netflix style): crossfade — the PREVIOUS image stays as a base,
             the new one fades in on top (no more dip-to-black). Blurhash → sharp. -->
        {#if prevHeroIndex >= 0 && prevHeroIndex !== heroIndex && heroItems[prevHeroIndex] && getHeroBackdrop(heroItems[prevHeroIndex])}
          <img src={getHeroBackdrop(heroItems[prevHeroIndex])} alt="" aria-hidden="true" decoding="async"
            class="absolute inset-0 w-full h-full object-cover object-center" />
        {/if}
        {#key heroCurrent?.Id}
          {#if heroCurrent && getHeroBackdrop(heroCurrent)}
            <img src={getHeroBackdrop(heroCurrent)} {@attach blurUp(itemBlurHash(heroCurrent, 'Backdrop'))} alt={heroCurrent.Name} fetchpriority="high" loading="eager" decoding="async"
              class="absolute inset-0 w-full h-full object-cover object-center hero-fade" />
          {/if}
        {/key}
        <!-- Gradients: left for text legibility, bottom for a seamless transition into the rows below -->
        <div class="absolute inset-0 bg-gradient-to-r from-gray-900 via-gray-900/50 to-transparent"></div>
        <div class="absolute inset-0 bg-gradient-to-t from-gray-900 via-gray-900/50 to-transparent"></div>

        <!-- Content -->
        <div class="absolute bottom-0 left-0 p-10 pb-8 max-w-3xl flex flex-col gap-3">
          {#if getHeroLogo(heroCurrent)}
            <img src={getHeroLogo(heroCurrent)} alt={getItemTitle(heroCurrent)}
              class="max-h-[130px] max-w-[60%] object-contain object-left drop-shadow-lg" />
          {:else}
            <h1 class="text-5xl font-bold text-white drop-shadow-lg">{getItemTitle(heroCurrent)}</h1>
          {/if}
          <div class="flex items-center gap-3 text-gray-300 font-semibold">
            {#if heroCurrent.ProductionYear}<span class="text-blue-400">{heroCurrent.ProductionYear}</span>{/if}
            {#if heroCurrent.CommunityRating}
              <span class="flex items-center gap-1 text-yellow-400">
                <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/></svg>
                {heroCurrent.CommunityRating.toFixed(1)}
              </span>
            {/if}
            {#if heroCurrent.CriticRating}
              <span class="flex items-center gap-1 text-red-400">• {heroCurrent.CriticRating}%</span>
            {/if}
          </div>
          {#if heroCurrent.Overview}
            <p class="text-gray-300 text-lg line-clamp-2 max-w-2xl drop-shadow">{heroCurrent.Overview}</p>
          {/if}
          <div class="flex items-center gap-4 mt-2">
            <button onclick={() => onOpenDetails?.(heroCurrent)} data-scroll-top
              class="bg-white hover:bg-gray-200 focus:bg-gray-200 text-black font-bold text-lg px-8 py-3 rounded-xl
                     focus:outline-none focus:ring-4 focus:ring-blue-500 transition-all flex items-center gap-2 shadow-lg">
              <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 20 20"><path d="M4 4l12 6-12 6z"/></svg>
              {i18n.t.play}
            </button>
            <!-- Dot indicators — only when it also rotates (with reduced motion: a static hero without dots) -->
            {#if !reduceAnimations && heroItems.length > 1}
              <div class="flex gap-2 ml-2">
                {#each heroItems as h, i (h.Id)}
                  <div class="h-2 rounded-full transition-all {i === heroIndex ? 'w-6 bg-white' : 'w-2 bg-white/40'}"></div>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      </div>
    {:else if showHero && heroLoading}
      {@render heroSkeleton()}
    {/if}

    <!-- LIBRARIES -->
    {#if showLibraries && libraries.length > 0}
      <div>
        <h2 class="text-2xl font-bold text-gray-400 mb-4 px-2">{i18n.t.myMedia}</h2>
        <div class="flex gap-6 overflow-x-auto hide-scrollbar py-4 px-2">
          {#each libraries as library (library.Id)}
            <button onclick={() => onOpenLibrary?.(library)}
              class="shrink-0 scroll-mt-24 scroll-mx-4 group flex flex-col items-center focus:outline-none">
              <div class="w-64 h-36 bg-gray-800 rounded-xl flex items-center justify-center
                          border-4 border-transparent group-focus:border-white group-focus:scale-105 group-hover:border-gray-400
                          transition-transform duration-200 shadow-lg overflow-hidden">
                {#if getItemImageUrl(library)}
                  <img src={getItemImageUrl(library)} {@attach blurUp(itemBlurHash(library))} alt={library.Name}
                    class="w-full h-full object-cover opacity-80 group-focus:opacity-100" loading="lazy" />
                {:else}
                  <span class="text-2xl text-gray-500 font-bold">{library.Name}</span>
                {/if}
              </div>
              <span class="mt-3 text-lg text-gray-300 group-focus:text-white">{library.Name}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- CONTINUE WATCHING -->
    {#if resumeRow.length > 0}
      <div>
        <h2 class="text-2xl font-bold text-white mb-4 px-2">{i18n.t.continueWatchingRow}</h2>
        <div class="flex gap-6 overflow-x-auto hide-scrollbar py-4 px-2">
          {#each resumeRow as item (item.Id)}
            {@render landscapeCard(item)}
          {/each}
        </div>
      </div>
    {/if}

    <!-- UP NEXT -->
    {#if showNextUp && nextUp.length > 0}
      <div>
        <h2 class="text-2xl font-bold text-white mb-4 px-2">{i18n.t.nextUp}</h2>
        <div class="flex gap-6 overflow-x-auto hide-scrollbar py-4 px-2">
          {#each nextUp as item (item.Id)}
            {@render landscapeCard(item)}
          {/each}
        </div>
      </div>
    {/if}

    <!-- WATCHLIST — the user-curated "watch later" playlist (see watchlist.svelte.js) -->
    {#if showWatchlist && watchlistDisplay.length > 0}
      <div>
        <h2 class="text-2xl font-bold text-white mb-4 px-2">{i18n.t.watchlist}</h2>
        <div class="flex gap-6 overflow-x-auto hide-scrollbar py-4 px-2">
          {#each watchlistDisplay as item (item.Id)}
            {@render portraitCard(item, item._imgUrl || getItemImageUrl(item), itemBlurHash(item))}
          {/each}
        </div>
      </div>
    {/if}

    <!-- RECENTLY WATCHED (history) -->
    {#if showHistory && recentlyWatched.length > 0}
      <div>
        <h2 class="text-2xl font-bold text-white mb-4 px-2">{i18n.t.recentlyWatched}</h2>
        <div class="flex gap-6 overflow-x-auto hide-scrollbar py-4 px-2">
          {#each recentlyWatched as item (item.Id)}
            {@render portraitCard(item, getHistoryImageUrl(item), itemBlurHash(item))}
          {/each}
        </div>
      </div>
    {/if}

    <!-- SHARED SUGGESTIONS ("For you both") — only with a shared profile set up -->
    {#if showSharedSuggestions && sharedSuggestions.length > 0}
      <div>
        <h2 class="text-2xl font-bold text-white mb-4 px-2">{i18n.t.sharedSuggestions}</h2>
        <div class="flex gap-6 overflow-x-auto hide-scrollbar py-4 px-2">
          {#each sharedSuggestions as item (item.Id)}
            {@render portraitCard(item, getItemImageUrl(item), itemBlurHash(item))}
          {/each}
        </div>
      </div>
    {/if}

    <!-- RECOMMENDATIONS: "Because you watched X" — personalized, hence near the top -->
    {#each (showRecommendations ? recommendations.slice(0, recommendationRows) : []) as rec}
      <div>
        <h2 class="text-2xl font-bold text-white mb-4 px-2">{i18n.t.becauseSeen.replace('{x}', rec.seedTitle)}</h2>
        <div class="flex gap-6 overflow-x-auto hide-scrollbar py-4 px-2">
          {#each rec.items as item (item.Id)}
            {@render portraitCard(item, getItemImageUrl(item), itemBlurHash(item))}
          {/each}
        </div>
      </div>
    {/each}

    <!-- RECENTLY ADDED MOVIES -->
    {#if showLatest && latestMovies.length > 0}
      <div>
        <h2 class="text-2xl font-bold text-white mb-4 px-2">{i18n.t.latestMovies}</h2>
        <div class="flex gap-6 overflow-x-auto hide-scrollbar py-4 px-2">
          {#each latestMovies as item (item.Id)}
            {@render portraitCard(item, getItemImageUrl(item), itemBlurHash(item))}
          {/each}
        </div>
      </div>
    {/if}

    <!-- RECENTLY ADDED SERIES -->
    {#if showLatest && latestSeries.length > 0}
      <div>
        <h2 class="text-2xl font-bold text-white mb-4 px-2">{i18n.t.latestSeries}</h2>
        <div class="flex gap-6 overflow-x-auto hide-scrollbar py-4 px-2">
          {#each latestSeries as item (item.Id)}
            {@render portraitCard(item, getItemImageUrl(item), itemBlurHash(item))}
          {/each}
        </div>
      </div>
    {/if}

    <!-- COLLECTIONS (BoxSets) — browse-oriented, hence at the bottom -->
    {#if showCollections && collections.length > 0}
      <div>
        <h2 class="text-2xl font-bold text-white mb-4 px-2">{i18n.t.collections}</h2>
        <div class="flex gap-6 overflow-x-auto hide-scrollbar py-4 px-2">
          {#each collections as col (col.Id)}
            {@render collectionCard(col)}
          {/each}
        </div>
      </div>
    {/if}

  {/if}
  </div>
</div>

<style>
  /* Backdrop preview: fade in gently instead of switching hard ({#key} remounts the <img>) */
  .preview-fade { animation: previewFadeIn 0.5s ease-out; }
  @keyframes previewFadeIn { from { opacity: 0; } to { opacity: 1; } }
  /* Deliberately NO scroll-snap on the rows: on D-pad devices only the focus scrolls
     (scrollIntoView) — proximity snapping pulled its position back phase-dependently
     and cut off the scaled border of the edge card (webOS/B4). */

  /* Gentle fade-in on the hero switch */
  .hero-fade { animation: heroFadeIn 1.2s ease; }
  @keyframes heroFadeIn { from { opacity: 0; } to { opacity: 1; } }
</style>
