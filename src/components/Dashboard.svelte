<script>
  import { t } from '../i18n.js';
  import { itemProgress, connectionLost, longPress, authHeaders, blurUp, itemBlurHash, uiFade, serverUrl, activeToken } from '../utils.js';
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';

  export let selectedUser;
  export let apiCache;
  export let reduceAnimations = false;   // steuert Hero-Auto-Rotation
  export let showHero         = true;    // Hero-Banner anzeigen (Einstellung)
  export let showLibraries    = true;    // "Meine Mediatheken"-Zeile anzeigen
  export let showHistory      = true;    // "Zuletzt gesehen"-Zeile anzeigen
  export let showNextUp       = true;    // "Als Nächstes"-Zeile anzeigen
  export let showRecommendations = true; // "Weil du … gesehen hast"-Zeile anzeigen
  export let recommendationRows   = 1;    // 1 oder 2 Empfehlungs-Reihen
  export let showLatest       = true;    // "Zuletzt hinzugefügt" (Filme + Serien)
  export let showCollections  = true;    // "Sammlungen" (BoxSets)
  export let sharedSuggestions = [];      // "Für euch beide" — Titel, die zur gemeinsamen Vorliebe passen
  export let showSharedSuggestions = false; // Reihe anzeigen (nur wenn gemeinsames Profil eingerichtet)

  const dispatch = createEventDispatcher();

  let isLoading        = false;
  let libraries        = [];
  // An App melden, sobald die Mediatheken da sind (Cache-Hit oder Fetch) — speist die
  // Sidebar/Navigation reaktiv, ohne dass App separat fetchen muss (verhindert Race).
  $: if (libraries.length) dispatch('librariesLoaded', libraries);
  let continueWatching = [];
  let nextUp           = [];
  let latestMovies     = [];
  let latestSeries     = [];
  let recentlyWatched  = [];   // "Zuletzt gesehen" (Verlauf)
  let recommendations  = [];   // [{ seedTitle, items }] — "Weil du X gesehen hast"
  let collections      = [];   // BoxSets ("Sammlungen")

  // HERO-BANNER: rotierendes Featured-Item (Netflix-Stil)
  let heroItems  = [];
  let heroIndex  = 0;
  let heroTimer;
  let heroReady  = false;   // erst true, wenn das erste Backdrop dekodiert ist → kein Aufploppen
  $: heroCurrent = heroItems[heroIndex] || null;

  const skeletons = Array(6).fill(0);

  onMount(() => { loadDashboardData(); });
  onDestroy(() => clearInterval(heroTimer));

  // Featured-Liste aus neuesten Filmen/Serien mit Backdrop bauen + Rotation starten
  // Lädt das Bild des nächsten Hero-Items vorab → nahtloser Wechsel ohne Aufploppen.
  function preloadHero(index) {
    const next = heroItems[index];
    if (!next) return;
    const url = getHeroBackdrop(next);
    if (url) { const img = new Image(); img.src = url; }
  }

  function buildHero() {
    // Titel ausschließen, die bereits in "Weiterschauen" laufen (keine Dopplung).
    // Bei Serien auch über SeriesId, falls eine Folge der Serie angefangen wurde.
    const inProgress = new Set();
    continueWatching.forEach(i => { inProgress.add(i.Id); if (i.SeriesId) inProgress.add(i.SeriesId); });
    const pool = [...latestMovies, ...latestSeries]
      .filter(i => i.BackdropImageTags?.length > 0 && !inProgress.has(i.Id));
    // Maximal 5, gemischt
    heroItems = pool.sort(() => Math.random() - 0.5).slice(0, 5);
    heroIndex = 0;
    heroReady = false;
    clearInterval(heroTimer);
    // Erstes Backdrop vorladen → Hero erst einblenden, wenn es fertig ist (kein leeres Aufploppen).
    const firstUrl = getHeroBackdrop(heroItems[0]);
    if (firstUrl) {
      const img = new Image();
      img.onload = img.onerror = () => { heroReady = true; };
      img.src = firstUrl;
    } else {
      heroReady = true;
    }
    // Nur automatisch rotieren wenn Animationen erlaubt sind
    if (!reduceAnimations && heroItems.length > 1) {
      preloadHero(1);   // nächstes Bild schon laden
      heroTimer = setInterval(() => {
        heroIndex = (heroIndex + 1) % heroItems.length;
        preloadHero((heroIndex + 1) % heroItems.length);
      }, 8000);
    }
  }

  const getAuthHeaders = () => authHeaders($activeToken);

  // Empfehlungen: Seeds aus zuletzt gesehenen Items, dann /Items/{id}/Similar.
  // Best Practice (Netflix/Plex): direkt im Dashboard, kein eigener Tab.
  async function loadRecommendations(uId, opts, fields) {
    try {
      // Zuletzt gespielte Filme/Serien als Aufhänger holen
      const res = await fetch(
        `${$serverUrl}/Users/${uId}/Items?SortBy=DatePlayed&SortOrder=Descending&Filters=IsPlayed` +
        `&IncludeItemTypes=Movie,Series&Recursive=true&Limit=4&Fields=${fields}`, opts
      );
      const seeds = (await res.json()).Items || [];

      // Bis zu zwei Reihen ähnlicher Titel (gecacht). Gerendert wird je nach
      // Einstellung 1 oder 2 — so wirkt das Umschalten ohne Neuladen sofort.
      const rows = [];
      for (const seed of seeds.slice(0, 2)) {
        const sim = await fetch(`${$serverUrl}/Items/${seed.Id}/Similar?userId=${uId}&limit=12&Fields=${fields}`, opts);
        const items = (await sim.json()).Items || [];
        if (items.length >= 4) rows.push({ seedTitle: seed.Name, items });
      }
      recommendations = rows;
      if (apiCache.dashboard) apiCache.dashboard.recommendations = rows;
    } catch { /* Empfehlungen sind optional */ }
  }

  async function loadDashboardData() {
    // Cache-Hit: sofort aus Cache laden, kein Netzwerk
    if (apiCache.dashboard) {
      ({ libraries, continueWatching, nextUp, latestMovies, latestSeries, recentlyWatched, recommendations } = apiCache.dashboard);
      recentlyWatched = recentlyWatched || [];
      recommendations = recommendations || [];
      collections     = apiCache.dashboard.collections || [];
      buildHero();
      return;
    }

    isLoading = true;
    try {
      const uId   = selectedUser.Id;
      const opts  = { headers: getAuthHeaders() };
      const fields = "PrimaryImageAspectRatio,Overview,BackdropImageTags";

      // Alle 5 Fetches gleichzeitig starten — kein sequentielles Warten
      const pViews        = fetch(`${$serverUrl}/Users/${uId}/Views`, opts);
      const pResume       = fetch(`${$serverUrl}/Users/${uId}/Items/Resume?Limit=12&Fields=${fields}&EnableImageTypes=Primary,Backdrop,Thumb`, opts);
      const pNextUp       = fetch(`${$serverUrl}/Shows/NextUp?UserId=${uId}&Limit=6&Fields=${fields}&EnableImageTypes=Primary,Backdrop,Thumb`, opts);
      const pLatestMovies = fetch(`${$serverUrl}/Users/${uId}/Items/Latest?IncludeItemTypes=Movie&Limit=6&Fields=${fields}`, opts);
      const pLatestSeries = fetch(`${$serverUrl}/Users/${uId}/Items/Latest?IncludeItemTypes=Series&Limit=6&Fields=${fields}`, opts);
      // Verlauf: zuletzt gesehene Filme/Folgen. Mehr holen (40), da Serien danach
      // zu je einem Eintrag zusammengefasst werden (Puffer für eine gute Mischung).
      const pHistory      = fetch(`${$serverUrl}/Users/${uId}/Items?SortBy=DatePlayed&SortOrder=Descending&Filters=IsPlayed&IncludeItemTypes=Movie,Episode&Recursive=true&Limit=40&Fields=${fields}`, opts);
      // Sammlungen (BoxSets)
      const pCollections  = fetch(`${$serverUrl}/Users/${uId}/Items?IncludeItemTypes=BoxSet&Recursive=true&SortBy=SortName&Fields=PrimaryImageAspectRatio&Limit=50`, opts);

      // Priorität: Views + Resume → UI sofort freigeben
      const [resViews, resResume] = await Promise.all([pViews, pResume]);
      libraries        = (await resViews.json()).Items  || [];
      continueWatching = (await resResume.json()).Items || [];
      isLoading        = false;
      connectionLost.set(false);   // Server erreichbar

      // Cache früh befüllen → Sidebar-Navigation funktioniert sofort
      apiCache.dashboard = { libraries, continueWatching, nextUp: [], latestMovies: [], latestSeries: [], recentlyWatched: [], recommendations: [], collections: [] };

      // Sammlungen unabhängig laden
      pCollections.then(r => r.json()).then(d => {
        collections = (Array.isArray(d) ? d : (d.Items || [])).filter(c => c.ChildCount !== 0);
        apiCache.dashboard.collections = collections;
      }).catch(() => {});

      // Empfehlungen ("Weil du X gesehen hast") aus zuletzt Gesehenem ableiten
      loadRecommendations(uId, opts, fields);

      // Verlauf laden + nach Serie zusammenfassen
      pHistory.then(r => r.json()).then(d => {
        recentlyWatched = dedupeHistory(d.Items || []);
        apiCache.dashboard.recentlyWatched = recentlyWatched;
      }).catch(() => {});

      // Sekundäre Sektionen unabhängig aktualisieren — schnellste kommt zuerst
      // FIX: `|| d` entfernt (d wäre das Response-Objekt, nicht ein Array)
      // FIX: .catch(() => {}) damit ein einzelner Fehler nicht alles blockiert
      // /Items/Latest gibt ein DIREKTES Array zurück (nicht { Items: [...] })!
      // Andere Endpunkte geben { Items, TotalRecordCount }. Beide Fälle abfangen.
      pNextUp.then(r => r.json()).then(d => {
        nextUp = Array.isArray(d) ? d : (d.Items || []);
        apiCache.dashboard.nextUp = nextUp;
      }).catch(() => {});

      // Beide Latest-Fetches zusammen abwarten → Hero nur EINMAL bauen (statt zweimal)
      Promise.all([
        pLatestMovies.then(r => r.json()).catch(() => []),
        pLatestSeries.then(r => r.json()).catch(() => [])
      ]).then(([dm, ds]) => {
        latestMovies = Array.isArray(dm) ? dm : (dm.Items || []);
        latestSeries = Array.isArray(ds) ? ds : (ds.Items || []);
        apiCache.dashboard.latestMovies = latestMovies;
        apiCache.dashboard.latestSeries = latestSeries;
        buildHero();
      });

    } catch (err) {
      console.error("Dashboard load failed:", err);
      isLoading = false;
      connectionLost.set(true);   // Server nicht erreichbar → Banner
    }
  }

  // Verlauf nach Serie zusammenfassen: pro Serie nur die zuletzt gesehene Folge
  // (Liste ist bereits nach Datum absteigend → die erste ist die neueste).
  // Filme bleiben einzeln. Verhindert "10× dieselbe Serie" beim Binge-Watching.
  function dedupeHistory(items) {
    const seenSeries = new Set();
    const out = [];
    for (const it of items) {
      let entry = it;
      if (it.Type === 'Episode' && it.SeriesId) {
        if (seenSeries.has(it.SeriesId)) continue;
        seenSeries.add(it.SeriesId);
        // Verlauf: die Serie als EIN Eintrag zeigen (nicht die einzelne Folge). "Weiterschauen"
        // deckt die konkrete Folge schon ab; hier zählt nur, welche Serie zuletzt lief.
        entry = {
          Id: it.SeriesId,
          Name: it.SeriesName,
          Type: 'Series',
          ImageTags: it.SeriesPrimaryImageTag ? { Primary: it.SeriesPrimaryImageTag } : undefined,
          PrimaryImageAspectRatio: 0.6667,
          ImageBlurHashes: it.ImageBlurHashes,
        };
      }
      out.push(entry);
      if (out.length >= 16) break;
    }
    return out;
  }

  // Verlauf-Karten einheitlich Hochkant: Folgen nutzen das Serien-Poster
  function getHistoryImageUrl(item) {
    if (item.Type === 'Episode' && item.SeriesId && item.SeriesPrimaryImageTag)
      return `${$serverUrl}/Items/${item.SeriesId}/Images/Primary?tag=${item.SeriesPrimaryImageTag}&fillHeight=400&fillWidth=266&quality=80&format=webp`;
    if (item.ImageTags?.Primary)
      return `${$serverUrl}/Items/${item.Id}/Images/Primary?tag=${item.ImageTags.Primary}&fillHeight=400&fillWidth=266&quality=80&format=webp`;
    return null;
  }

  function getItemImageUrl(item, format = 'portrait') {
    if (format === 'landscape') {
      // Wie Jellyfin (preferThumb): Querformat-Artwork bevorzugen — eigenes Thumb, sonst
      // Serien-/Eltern-Thumb, dann Backdrop (Folge → Serie), zuletzt der Folgen-Still.
      if (item.ImageTags?.Thumb)
        return `${$serverUrl}/Items/${item.Id}/Images/Thumb?tag=${item.ImageTags.Thumb}&maxWidth=600&quality=80&format=webp`;
      if (item.ParentThumbItemId && item.ParentThumbImageTag)
        return `${$serverUrl}/Items/${item.ParentThumbItemId}/Images/Thumb?tag=${item.ParentThumbImageTag}&maxWidth=600&quality=80&format=webp`;
      if (item.SeriesId && item.SeriesThumbImageTag)
        return `${$serverUrl}/Items/${item.SeriesId}/Images/Thumb?tag=${item.SeriesThumbImageTag}&maxWidth=600&quality=80&format=webp`;
      if (item.BackdropImageTags?.length > 0)
        return `${$serverUrl}/Items/${item.Id}/Images/Backdrop?tag=${item.BackdropImageTags[0]}&maxWidth=600&quality=80&format=webp`;
      if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.length > 0)
        return `${$serverUrl}/Items/${item.ParentBackdropItemId}/Images/Backdrop?tag=${item.ParentBackdropImageTags[0]}&maxWidth=600&quality=80&format=webp`;
      if (item.ImageTags?.Primary)
        return `${$serverUrl}/Items/${item.Id}/Images/Primary?tag=${item.ImageTags.Primary}&maxWidth=600&quality=80&format=webp`;
    } else {
      if (item.ImageTags?.Primary)
        return `${$serverUrl}/Items/${item.Id}/Images/Primary?tag=${item.ImageTags.Primary}&fillHeight=400&fillWidth=266&quality=80&format=webp`;
    }
    return null;
  }

  function getItemTitle(item) {
    return (item.Type === 'Episode' && item.SeriesName) ? item.SeriesName : item.Name;
  }

  function getItemSubtitle(item) {
    if (item.Type === 'Episode') {
      const s = item.ParentIndexNumber ?? '?';
      const e = item.IndexNumber ?? '?';
      return `S${s}:E${e} – ${item.Name}`;
    }
    return item.ProductionYear?.toString() ?? '';
  }

  // Restzeit in Minuten für "Weiterschauen"
  function getRemainingMinutes(item) {
    if (!item.RunTimeTicks || !item.UserData?.PlaybackPositionTicks) return null;
    const remTicks = item.RunTimeTicks - item.UserData.PlaybackPositionTicks;
    const mins = Math.round(remTicks / 10000000 / 60);
    return mins > 0 ? mins : null;
  }

  // Hero-Backdrop in hoher Auflösung
  function getHeroBackdrop(item) {
    if (item?.BackdropImageTags?.length > 0)
      return `${$serverUrl}/Items/${item.Id}/Images/Backdrop?tag=${item.BackdropImageTags[0]}&maxWidth=1920&quality=85&format=webp`;
    return null;
  }

  // Logo-Bild (transparenter Titel-Schriftzug) — falls vorhanden, statt Text-Titel.
  // Wirkt hochwertiger; ein zusätzliches Bild, kein Mehraufwand bei den Daten.
  function getHeroLogo(item) {
    if (item.ImageTags?.Logo)
      return `${$serverUrl}/Items/${item.Id}/Images/Logo?tag=${item.ImageTags.Logo}&maxHeight=130&quality=90&format=webp`;
    return null;
  }</script>

<div class="px-10 pt-16 pb-20 flex flex-col gap-12">

  {#if isLoading}
    <!-- Skeleton-Loader -->
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

    <!-- HERO-BANNER — rotierendes Featured-Item -->
    {#if showHero && heroCurrent && heroReady}
      <div transition:uiFade class="relative -mx-10 -mt-16 mb-2 h-[44vh] min-h-[320px] overflow-hidden">
        <!-- Backdrop mit Verläufen -->
        {#each heroItems as h, i}
          {#if i === heroIndex && getHeroBackdrop(h)}
            <img src={getHeroBackdrop(h)} use:blurUp={itemBlurHash(h, 'Backdrop')} alt={h.Name} fetchpriority="high" loading="eager" decoding="async"
              class="absolute inset-0 w-full h-full object-cover hero-fade" />
          {/if}
        {/each}
        <div class="absolute inset-0 bg-gradient-to-t from-gray-900 via-gray-900/40 to-transparent"></div>
        <div class="absolute inset-0 bg-gradient-to-r from-gray-900 via-gray-900/30 to-transparent"></div>

        <!-- Inhalt -->
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
            <button on:click={() => dispatch('openDetails', heroCurrent)} data-scroll-top
              class="bg-white hover:bg-gray-200 focus:bg-gray-200 text-black font-bold text-lg px-8 py-3 rounded-xl
                     focus:outline-none focus:ring-4 focus:ring-blue-500 transition-all flex items-center gap-2 shadow-lg">
              <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 20 20"><path d="M4 4l12 6-12 6z"/></svg>
              {$t.play}
            </button>
            <!-- Punkt-Indikatoren -->
            {#if heroItems.length > 1}
              <div class="flex gap-2 ml-2">
                {#each heroItems as _, i}
                  <div class="h-2 rounded-full transition-all {i === heroIndex ? 'w-6 bg-white' : 'w-2 bg-white/40'}"></div>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      </div>
    {/if}

    <!-- MEDIATHEKEN -->
    {#if showLibraries && libraries.length > 0}
      <div>
        <h2 class="text-2xl font-bold text-gray-400 mb-4 px-2">{$t.myMedia}</h2>
        <div class="flex gap-6 overflow-x-auto hide-scrollbar py-4 px-2 snap-row">
          {#each libraries as library}
            <button on:click={() => dispatch('openLibrary', library)}
              class="shrink-0 group flex flex-col items-center focus:outline-none">
              <div class="w-64 h-36 bg-gray-800 rounded-xl flex items-center justify-center
                          border-4 border-transparent group-focus:border-white group-hover:border-gray-400
                          transition-all shadow-lg overflow-hidden">
                {#if getItemImageUrl(library)}
                  <img src={getItemImageUrl(library)} use:blurUp={itemBlurHash(library)} alt={library.Name}
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

    <!-- WEITERSCHAUEN -->
    {#if continueWatching.length > 0}
      <div>
        <h2 class="text-2xl font-bold text-white mb-4 px-2">{$t.continueWatchingRow}</h2>
        <div class="flex gap-6 overflow-x-auto hide-scrollbar py-4 px-2 snap-row">
          {#each continueWatching as item}
            <button on:click={() => dispatch('openDetails', item)} use:longPress on:longpress={() => dispatch('openContext', item)}
              class="shrink-0 w-80 group flex flex-col focus:outline-none text-left scroll-mt-24">
              <div class="aspect-video w-full bg-gray-800 rounded-lg overflow-hidden
                          border-4 border-transparent group-focus:border-white group-focus:scale-105
                          transition-all duration-200 shadow-xl relative">
                {#if getItemImageUrl(item, 'landscape')}
                  <img src={getItemImageUrl(item, 'landscape')} use:blurUp={itemBlurHash(item, 'Backdrop')} alt={item.Name}
                    class="w-full h-full object-cover" loading="lazy" />
                {/if}
                {#if itemProgress(item) > 0}
                  <div class="absolute bottom-0 left-0 w-full h-1.5 bg-gray-900/80">
                    <div class="h-full bg-blue-500" style="width:{itemProgress(item)}%"></div>
                  </div>
                {/if}
                {#if getRemainingMinutes(item)}
                  <div class="absolute top-2 right-2 bg-black/80 text-white text-xs font-bold px-2 py-1 rounded-md">
                    {getRemainingMinutes(item)} {$t.mins} {$t.remaining}
                  </div>
                {/if}
              </div>
              <div class="mt-3 flex flex-col w-full overflow-hidden">
                <span class="text-sm font-bold text-gray-200 group-focus:text-white truncate w-full">{getItemTitle(item)}</span>
                {#if getItemSubtitle(item)}
                  <span class="text-xs text-gray-400 group-focus:text-gray-300 truncate w-full mt-0.5">{getItemSubtitle(item)}</span>
                {/if}
              </div>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- ALS NÄCHSTES -->
    {#if showNextUp && nextUp.length > 0}
      <div>
        <h2 class="text-2xl font-bold text-white mb-4 px-2">{$t.nextUp}</h2>
        <div class="flex gap-6 overflow-x-auto hide-scrollbar py-4 px-2 snap-row">
          {#each nextUp as item}
            <button on:click={() => dispatch('openDetails', item)} use:longPress on:longpress={() => dispatch('openContext', item)}
              class="shrink-0 w-80 group flex flex-col focus:outline-none text-left scroll-mt-24">
              <div class="aspect-video w-full bg-gray-800 rounded-lg overflow-hidden
                          border-4 border-transparent group-focus:border-white group-focus:scale-105
                          transition-all duration-200 shadow-xl">
                {#if getItemImageUrl(item, 'landscape')}
                  <img src={getItemImageUrl(item, 'landscape')} use:blurUp={itemBlurHash(item, 'Backdrop')} alt={item.Name}
                    class="w-full h-full object-cover" loading="lazy" />
                {/if}
              </div>
              <div class="mt-3 flex flex-col w-full overflow-hidden">
                <span class="text-sm font-bold text-gray-200 group-focus:text-white truncate w-full">{getItemTitle(item)}</span>
                {#if getItemSubtitle(item)}
                  <span class="text-xs text-gray-400 group-focus:text-gray-300 truncate w-full mt-0.5">{getItemSubtitle(item)}</span>
                {/if}
              </div>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- ZULETZT GESEHEN (Verlauf) -->
    {#if showHistory && recentlyWatched.length > 0}
      <div>
        <h2 class="text-2xl font-bold text-white mb-4 px-2">{$t.recentlyWatched}</h2>
        <div class="flex gap-6 overflow-x-auto hide-scrollbar py-4 px-2 snap-row">
          {#each recentlyWatched as item}
            <button on:click={() => dispatch('openDetails', item)} use:longPress on:longpress={() => dispatch('openContext', item)}
              class="shrink-0 w-48 group flex flex-col focus:outline-none text-left scroll-mt-24 cv-card transition-transform duration-200 group-focus:scale-105">
              <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg overflow-hidden relative
                          border-4 border-transparent group-focus:border-white
                          transition-colors duration-200 shadow-xl">
                {#if getHistoryImageUrl(item)}
                  <img src={getHistoryImageUrl(item)} use:blurUp={itemBlurHash(item, 'Backdrop')} alt={item.Name}
                    class="w-full h-full object-cover" loading="lazy" />
                {/if}
                {#if itemProgress(item) > 0}
                  <div class="absolute bottom-0 left-0 w-full h-1.5 bg-gray-900/80">
                    <div class="h-full bg-blue-500" style="width:{itemProgress(item)}%"></div>
                  </div>
                {/if}
              </div>
              <div class="mt-3 flex flex-col w-full overflow-hidden">
                <span class="text-sm font-bold text-gray-200 group-focus:text-white truncate w-full">{getItemTitle(item)}</span>
                {#if getItemSubtitle(item)}
                  <span class="text-xs text-gray-400 group-focus:text-gray-300 truncate w-full mt-0.5">{getItemSubtitle(item)}</span>
                {/if}
              </div>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- GEMEINSAME VORSCHLÄGE ("Für euch beide") — nur bei eingerichtetem gemeinsamen Profil -->
    {#if showSharedSuggestions && sharedSuggestions.length > 0}
      <div>
        <h2 class="text-2xl font-bold text-white mb-4 px-2">{$t.sharedSuggestions}</h2>
        <div class="flex gap-6 overflow-x-auto hide-scrollbar py-4 px-2 snap-row">
          {#each sharedSuggestions as item}
            <button on:click={() => dispatch('openDetails', item)} use:longPress on:longpress={() => dispatch('openContext', item)}
              class="shrink-0 w-48 group flex flex-col focus:outline-none text-left scroll-mt-24 cv-card transition-transform duration-200 group-focus:scale-105">
              <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg overflow-hidden relative
                          border-4 border-transparent group-focus:border-white
                          transition-colors duration-200 shadow-xl">
                {#if getItemImageUrl(item)}
                  <img src={getItemImageUrl(item)} use:blurUp={itemBlurHash(item)} alt={item.Name}
                    class="w-full h-full object-cover" loading="lazy" />
                {/if}
              </div>
              <div class="mt-3 flex flex-col w-full overflow-hidden">
                <span class="text-sm font-bold text-gray-200 group-focus:text-white truncate w-full">{getItemTitle(item)}</span>
                {#if getItemSubtitle(item)}
                  <span class="text-xs text-gray-400 group-focus:text-gray-300 truncate w-full mt-0.5">{getItemSubtitle(item)}</span>
                {/if}
              </div>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- EMPFEHLUNGEN: "Weil du X gesehen hast" — personalisiert, daher weit oben -->
    {#each (showRecommendations ? recommendations.slice(0, recommendationRows) : []) as rec}
      <div>
        <h2 class="text-2xl font-bold text-white mb-4 px-2">{$t.becauseSeen.replace('{x}', rec.seedTitle)}</h2>
        <div class="flex gap-6 overflow-x-auto hide-scrollbar py-4 px-2 snap-row">
          {#each rec.items as item}
            <button on:click={() => dispatch('openDetails', item)} use:longPress on:longpress={() => dispatch('openContext', item)}
              class="shrink-0 w-48 group flex flex-col focus:outline-none text-left scroll-mt-24 cv-card transition-transform duration-200 group-focus:scale-105">
              <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg overflow-hidden relative
                          border-4 border-transparent group-focus:border-white
                          transition-colors duration-200 shadow-xl">
                {#if getItemImageUrl(item)}
                  <img src={getItemImageUrl(item)} use:blurUp={itemBlurHash(item)} alt={item.Name}
                    class="w-full h-full object-cover" loading="lazy" />
                {/if}
                {#if itemProgress(item) > 0}
                  <div class="absolute bottom-0 left-0 w-full h-1.5 bg-gray-900/80">
                    <div class="h-full bg-blue-500" style="width:{itemProgress(item)}%"></div>
                  </div>
                {/if}
              </div>
              <div class="mt-3 flex flex-col w-full overflow-hidden">
                <span class="text-sm font-bold text-gray-200 group-focus:text-white truncate w-full">{getItemTitle(item)}</span>
                {#if getItemSubtitle(item)}
                  <span class="text-xs text-gray-400 group-focus:text-gray-300 truncate w-full mt-0.5">{getItemSubtitle(item)}</span>
                {/if}
              </div>
            </button>
          {/each}
        </div>
      </div>
    {/each}

    <!-- ZULETZT HINZUGEFÜGTE FILME -->
    {#if showLatest && latestMovies.length > 0}
      <div>
        <h2 class="text-2xl font-bold text-white mb-4 px-2">{$t.latestMovies}</h2>
        <div class="flex gap-6 overflow-x-auto hide-scrollbar py-4 px-2 snap-row">
          {#each latestMovies as item}
            <button on:click={() => dispatch('openDetails', item)} use:longPress on:longpress={() => dispatch('openContext', item)}
              class="shrink-0 w-48 group flex flex-col focus:outline-none text-left scroll-mt-24 cv-card transition-transform duration-200 group-focus:scale-105">
              <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg overflow-hidden relative
                          border-4 border-transparent group-focus:border-white
                          transition-colors duration-200 shadow-xl">
                {#if getItemImageUrl(item)}
                  <img src={getItemImageUrl(item)} use:blurUp={itemBlurHash(item)} alt={item.Name}
                    class="w-full h-full object-cover" loading="lazy" />
                {/if}
                {#if itemProgress(item) > 0}
                  <div class="absolute bottom-0 left-0 w-full h-1.5 bg-gray-900/80">
                    <div class="h-full bg-blue-500" style="width:{itemProgress(item)}%"></div>
                  </div>
                {/if}
              </div>
              <div class="mt-3 flex flex-col w-full overflow-hidden">
                <span class="text-sm font-bold text-gray-200 group-focus:text-white truncate w-full">{getItemTitle(item)}</span>
                {#if getItemSubtitle(item)}
                  <span class="text-xs text-gray-400 group-focus:text-gray-300 truncate w-full mt-0.5">{getItemSubtitle(item)}</span>
                {/if}
              </div>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- ZULETZT HINZUGEFÜGTE SERIEN -->
    {#if showLatest && latestSeries.length > 0}
      <div>
        <h2 class="text-2xl font-bold text-white mb-4 px-2">{$t.latestSeries}</h2>
        <div class="flex gap-6 overflow-x-auto hide-scrollbar py-4 px-2 snap-row">
          {#each latestSeries as item}
            <button on:click={() => dispatch('openDetails', item)} use:longPress on:longpress={() => dispatch('openContext', item)}
              class="shrink-0 w-48 group flex flex-col focus:outline-none text-left scroll-mt-24 cv-card transition-transform duration-200 group-focus:scale-105">
              <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg overflow-hidden relative
                          border-4 border-transparent group-focus:border-white
                          transition-colors duration-200 shadow-xl">
                {#if getItemImageUrl(item)}
                  <img src={getItemImageUrl(item)} use:blurUp={itemBlurHash(item)} alt={item.Name}
                    class="w-full h-full object-cover" loading="lazy" />
                {/if}
                {#if itemProgress(item) > 0}
                  <div class="absolute bottom-0 left-0 w-full h-1.5 bg-gray-900/80">
                    <div class="h-full bg-blue-500" style="width:{itemProgress(item)}%"></div>
                  </div>
                {/if}
              </div>
              <div class="mt-3 flex flex-col w-full overflow-hidden">
                <span class="text-sm font-bold text-gray-200 group-focus:text-white truncate w-full">{getItemTitle(item)}</span>
                {#if getItemSubtitle(item)}
                  <span class="text-xs text-gray-400 group-focus:text-gray-300 truncate w-full mt-0.5">{getItemSubtitle(item)}</span>
                {/if}
              </div>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- SAMMLUNGEN (BoxSets) — browse-orientiert, daher unten -->
    {#if showCollections && collections.length > 0}
      <div>
        <h2 class="text-2xl font-bold text-white mb-4 px-2">{$t.collections}</h2>
        <div class="flex gap-6 overflow-x-auto hide-scrollbar py-4 px-2 snap-row">
          {#each collections as col}
            <button on:click={() => dispatch('openCollection', col)}
              class="shrink-0 w-48 group flex flex-col focus:outline-none text-left scroll-mt-24 cv-card transition-transform duration-200 group-focus:scale-105">
              <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg overflow-hidden relative
                          border-4 border-transparent group-focus:border-white
                          transition-colors duration-200 shadow-xl">
                {#if getItemImageUrl(col)}
                  <img src={getItemImageUrl(col)} use:blurUp={itemBlurHash(col)} alt={col.Name}
                    class="w-full h-full object-cover" loading="lazy" />
                {:else}
                  <div class="w-full h-full flex items-center justify-center text-gray-600">
                    <svg class="w-14 h-14" fill="currentColor" viewBox="0 0 24 24"><path d="M4 6h16v2H4zm2-4h12v2H6zm-4 8h20v10a2 2 0 01-2 2H4a2 2 0 01-2-2V10z"/></svg>
                  </div>
                {/if}
              </div>
              <span class="mt-3 text-sm font-bold text-gray-200 group-focus:text-white truncate w-full">{col.Name}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}

  {/if}
</div>

<style>
  .hide-scrollbar::-webkit-scrollbar { display: none; }
  .hide-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
  /* scroll-snap: horizontale Reihen rasten beim Blättern an Kartengrenzen ein (proximity = sanft) */
  .snap-row { scroll-snap-type: x proximity; scroll-padding-inline-start: 0.5rem; }
  .snap-row > * { scroll-snap-align: start; }

  /* content-visibility: überspringt Rendering für Karten außerhalb des sichtbaren
     Bereichs (horizontale Reihen). Spart Layout-Arbeit bei vielen Reihen/Karten. */
  .cv-card {
    content-visibility: auto;
    contain-intrinsic-size: 192px 290px;
  }

  /* Sanftes Einblenden beim Hero-Wechsel */
  .hero-fade { animation: heroFadeIn 1.2s ease; }
  @keyframes heroFadeIn { from { opacity: 0; } to { opacity: 1; } }
</style>
