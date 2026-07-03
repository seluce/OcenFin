<script>
  // Mediathek-/Grid-Ansicht — aus App.svelte extrahiert. Besitzt den kompletten Grid-State
  // (Laden, Filter inkl. Genre/FSK, Sortierung + A-Z mit Offset-Sprung, bidirektionales Infinite-
  // Scroll, eigener View-Cache, Backdrop-Vorschau). App koordiniert nur Navigation/Details/Sort-
  // Persistenz und reicht via Props/Callbacks rein (Muster wie Collection/Favorites).
  import { tick } from 'svelte';
  import { session } from '../session.svelte.js';
  import { i18n } from '../i18n.svelte.js';
  import { itemProgress, getItemSubtitle, getItemImageUrl, blurUp, itemBlurHash, longPress,
           focusOnMount, isBackKey, makeFocusReturn, authHeaders, uiFade, dropTrapOnOutro } from '../utils.js';

  let {
    selectedUser,
    library = null,            // { Id, Name } — welche Bibliothek anzeigen (von App)
    reloadKey = 0,             // hochzählen → View-Cache verwerfen + neu laden
    focusFirstOnLoad = false,  // beim Öffnen aus dem Menü: erste Karte fokussieren (nicht "Zufällig")
    sharedReady = false,       // App-Ebene: gemeinsames Profil aktiv? (zeigt den "Gemeinsam schauen"-Schalter)
    partnerPlayedIds = null,   // Set der von BEIDEN gesehenen IDs (App lädt, Library filtert)
    librarySorts = {},         // pro Bibliothek gemerkte Sortierung
    displaySettings = {},      // backdropPreview, episodeCount
    onOpenDetails,             // (item) => void
    onContextMenu,             // (item) => void
    onSortPersist,             // (libId, sort) => void — App speichert ins Profil
    onSharedWatchToggle,       // (on: boolean) => void — App lädt/verwirft Partner-IDs
  } = $props();

  const libraryItemLimit = 50;

  // ── Grid-State ──────────────────────────────────────────────
  let currentItems        = $state([]);
  let currentLibraryName  = $state('');
  let currentLibraryId    = $state(null);
  let totalLibraryItems   = $state(0);
  let isFetchingMore      = $state(false);
  let isFetchingPrev      = $state(false);
  let isLoading           = $state(false);
  let firstLoadedIndex    = $state(0);

  // ── A-Z ─────────────────────────────────────────────────────
  let activeLetter  = $state('#');
  let currentLetter = $state('');
  const alphabet = ['#','A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z'];
  let libraryScrollContainer;
  let libraryGrid;

  let jumpLetterOverlay = $state('');
  let jumpOverlayTimer;
  function showJumpLetter(letter) {
    jumpLetterOverlay = letter;
    clearTimeout(jumpOverlayTimer);
    jumpOverlayTimer = setTimeout(() => { jumpLetterOverlay = ''; }, 800);
  }

  // ── Backdrop-Vorschau (700ms nach Fokus auf einer Karte) ────
  let previewBackdrop = $state('');
  let previewTimer;
  function previewItem(item) {
    if (!displaySettings.backdropPreview) return;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      const tag  = item.BackdropImageTags?.[0];
      const pTag = item.ParentBackdropImageTags?.[0];
      if (tag)       previewBackdrop = `${session.serverUrl}/Items/${item.Id}/Images/Backdrop?tag=${tag}&maxWidth=1280&quality=70&format=webp`;
      else if (pTag) previewBackdrop = `${session.serverUrl}/Items/${item.ParentBackdropItemId}/Images/Backdrop?tag=${pTag}&maxWidth=1280&quality=70&format=webp`;
    }, 700);
  }
  function cancelPreview() { clearTimeout(previewTimer); }

  // ── Filter ──────────────────────────────────────────────────
  let showFilterMenu  = $state(false);
  let activeFilters   = $state({ isFavorite: false, isPlayed: false, isNotPlayed: false });
  let availableGenres = $state([]);
  let selectedGenres  = $state([]);
  let selectedFsk     = $state([]);
  const fskOptions    = ['0','6','12','16','18'];
  let hasFilters = $derived(activeFilters.isFavorite || activeFilters.isPlayed || activeFilters.isNotPlayed
                  || selectedGenres.length > 0 || selectedFsk.length > 0);

  // ── Sortierung ──────────────────────────────────────────────
  let showSortMenu = $state(false);
  let currentSort  = $state({ by: 'SortName', order: 'Ascending' });
  const sortOptions = [
    { by: 'SortName',        order: 'Ascending',  key: 'sortName' },
    { by: 'DateCreated',     order: 'Descending', key: 'sortDateAdded' },
    { by: 'PremiereDate',    order: 'Descending', key: 'sortReleaseYear' },
    { by: 'CommunityRating', order: 'Descending', key: 'sortRating' },
    { by: 'Random',          order: 'Ascending',  key: 'sortRandom' },
  ];
  let showLetterBar = $derived(currentSort.by === 'SortName');
  const sortFilterFocus = makeFocusReturn();   // Auslöser-Button für Fokus-Rückgabe nach Schließen
  $effect(() => { if (!showSortMenu && !showFilterMenu && sortFilterFocus.pending) sortFilterFocus.restore(); });

  // ── Gemeinsam schauen ───────────────────────────────────────
  let sharedWatchMode = $state(false);
  let visibleLibraryItems = $derived((sharedWatchMode && partnerPlayedIds)
                           ? currentItems.filter(i => !partnerPlayedIds.has(i.Id))
                           : currentItems);
  function toggleSharedWatch() {
    sharedWatchMode = !sharedWatchMode;
    onSharedWatchToggle?.(sharedWatchMode);
  }

  // ── View-Cache (eigener LRU, höchstens 5 Bibliotheken) ──────
  const MAX_CACHED_VIEWS = 5;
  let viewCache = {};
  function cacheLibraryView(libraryId, data) {
    delete viewCache[libraryId];
    const keys = Object.keys(viewCache);
    if (keys.length >= MAX_CACHED_VIEWS) delete viewCache[keys[0]];
    viewCache[libraryId] = data;
  }

  function currentlyHasFilters() {
    return activeFilters.isFavorite || activeFilters.isPlayed || activeFilters.isNotPlayed
           || selectedGenres.length > 0 || selectedFsk.length > 0;
  }
  function currentlyDefaultSort() {
    return currentSort.by === 'SortName' && currentSort.order === 'Ascending';
  }
  function isCacheableView() {
    return !currentLetter && !currentlyHasFilters() && currentlyDefaultSort();
  }

  const authOpts = () => ({ headers: authHeaders(session.token) });

  // ── Laden ───────────────────────────────────────────────────
  async function loadGenres(libraryId) {
    try {
      const res = await fetch(`${session.serverUrl}/Genres?ParentId=${libraryId}&UserId=${selectedUser.Id}&EnableTotalRecordCount=false`, authOpts());
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
    for (const g of selectedGenres) q += `&Genres=${encodeURIComponent(g)}`;
    if (selectedFsk.length) {
      const ratings = selectedFsk.map(v => `FSK ${v}`).join('|');
      q += `&OfficialRatings=${encodeURIComponent(ratings)}`;
    }
    return q;
  }

  function reloadCurrent() {
    loadLibraryItems({ Id: currentLibraryId, Name: currentLibraryName }, currentLetter || null);
  }

  function toggleFilter(key) {
    activeFilters[key] = !activeFilters[key];
    if (key === 'isPlayed'    && activeFilters.isPlayed)    activeFilters.isNotPlayed = false;
    if (key === 'isNotPlayed' && activeFilters.isNotPlayed) activeFilters.isPlayed    = false;
    activeFilters = { ...activeFilters };
    if (!showFilterMenu) reloadCurrent();   // Chip-Leiste: sofort. Im Menü: gesammelt beim Schließen.
  }
  function toggleGenre(name) {
    selectedGenres = selectedGenres.includes(name)
      ? selectedGenres.filter(g => g !== name) : [...selectedGenres, name];
    if (!showFilterMenu) reloadCurrent();
  }
  function toggleFsk(age) {
    selectedFsk = selectedFsk.includes(age)
      ? selectedFsk.filter(v => v !== age) : [...selectedFsk, age];
    if (!showFilterMenu) reloadCurrent();
  }

  // Filter-Menü: Änderungen werden gesammelt und EINMAL beim Schließen angewendet — statt
  // pro Chip-Tap ein kompletter Reload (3 Genres antippen = 3 Fetches, alle bis auf den
  // letzten verworfen). Snapshot beim Öffnen; nur bei tatsächlicher Änderung neu laden.
  let filterMenuSnapshot = '';
  const filterStateKey = () => JSON.stringify([activeFilters, selectedGenres, selectedFsk]);
  function openFilterMenu(e) {
    sortFilterFocus.capture(e.currentTarget);
    filterMenuSnapshot = filterStateKey();
    showFilterMenu = true;
  }
  function closeFilterMenu() {
    showFilterMenu = false;
    if (filterStateKey() !== filterMenuSnapshot) reloadCurrent();
  }

  function setSort(option) {
    if (currentSort.by === option.by && option.by !== 'Random') {
      currentSort = { by: option.by, order: currentSort.order === 'Ascending' ? 'Descending' : 'Ascending' };
    } else {
      currentSort = { by: option.by, order: option.order };
    }
    showSortMenu = false;
    if (currentSort.by !== 'SortName') { currentLetter = ''; activeLetter = '#'; }
    if (currentLibraryId) onSortPersist?.(currentLibraryId, { ...currentSort });
    loadLibraryItems({ Id: currentLibraryId, Name: currentLibraryName }, null);
  }

  // Index des ersten Titels eines Buchstabens in der (gefilterten) Gesamtliste – per Count-Abfrage.
  async function letterStartIndex(libraryId, letter) {
    if (!letter || letter === '#') return 0;
    let q;
    if (currentSort.order === 'Ascending') {
      q = `&NameLessThan=${encodeURIComponent(letter)}`;
    } else {
      const next = String.fromCharCode(letter.charCodeAt(0) + 1);
      q = `&NameStartsWithOrGreater=${encodeURIComponent(next)}`;
    }
    const url = `${session.serverUrl}/Users/${selectedUser.Id}/Items?ParentId=${libraryId}&Limit=1&StartIndex=0${q}${getFilterQuery()}`;
    try {
      const res = await fetch(url, authOpts());
      if (res.ok) return (await res.json()).TotalRecordCount || 0;
    } catch {}
    return 0;
  }

  // Stale-Guard (Muster wie subtitleFetchToken im Player): Beim schnellen Durchschalten von
  // Sortierung/Filter/Bibliothek dürfen nur Antworten der JÜNGSTEN Anfrage übernommen werden —
  // sonst überschreibt eine langsame alte Antwort die neue Liste. Gilt auch für die
  // Infinite-Scroll-Blöcke: ein überholter Append würde die Liste korrumpieren.
  let loadToken = 0;

  async function loadLibraryItems(lib, letter = null) {
    const myToken = ++loadToken;
    if (currentLibraryId !== lib.Id) {
      activeFilters   = { isFavorite: false, isPlayed: false, isNotPlayed: false };
      selectedGenres  = [];
      selectedFsk     = [];
      currentSort     = librarySorts[lib.Id] ? { ...librarySorts[lib.Id] } : { by: 'SortName', order: 'Ascending' };
      previewBackdrop = '';
      clearTimeout(previewTimer);
      loadGenres(lib.Id);
    }
    currentLibraryName = lib.Name;
    currentLibraryId   = lib.Id;

    if (letter !== null) {
      currentLetter = letter === '#' ? '' : letter;
      activeLetter  = letter;
      if (libraryScrollContainer) libraryScrollContainer.scrollTop = 0;
    } else {
      currentLetter = '';
      activeLetter  = '#';
    }

    if (isCacheableView() && viewCache[lib.Id] && letter === null) {
      currentItems      = viewCache[lib.Id].items;
      totalLibraryItems = viewCache[lib.Id].total;
      firstLoadedIndex  = 0;
      return;
    }

    isLoading    = true;
    currentItems = [];

    const startIndex = letter !== null ? await letterStartIndex(lib.Id, letter) : 0;
    if (myToken !== loadToken) return;   // während der Count-Abfrage kam eine neuere Anfrage
    firstLoadedIndex = startIndex;

    let url = `${session.serverUrl}/Users/${selectedUser.Id}/Items?ParentId=${lib.Id}&Fields=PrimaryImageAspectRatio,EndDate,Status,ChildCount,RecursiveItemCount,BackdropImageTags&SortBy=${currentSort.by}&SortOrder=${currentSort.order}&Limit=${libraryItemLimit}&StartIndex=${startIndex}`;
    url += getFilterQuery();

    try {
      const res = await fetch(url, authOpts());
      if (myToken !== loadToken) return;   // überholte Antwort verwerfen
      if (res.ok) {
        const data        = await res.json();
        if (myToken !== loadToken) return;
        currentItems      = data.Items || [];
        totalLibraryItems = data.TotalRecordCount || 0;
        if (isCacheableView()) cacheLibraryView(lib.Id, { items: currentItems, total: totalLibraryItems });
      }
      session.connectionLost = false;
    } catch { if (myToken === loadToken) session.connectionLost = true; }
    // Spinner nur löschen, wenn wir noch aktuell sind — sonst killt eine alte Antwort das Skelett der neuen.
    finally { if (myToken === loadToken) isLoading = false; }
  }

  async function loadMoreLibraryItems() {
    if (isFetchingMore || firstLoadedIndex + currentItems.length >= totalLibraryItems || !currentLibraryId) return;
    isFetchingMore = true;
    const myToken = loadToken;   // gehört zur AKTUELLEN Liste — nach einem Reload nicht mehr anhängen
    const start = firstLoadedIndex + currentItems.length;
    let url = `${session.serverUrl}/Users/${selectedUser.Id}/Items?ParentId=${currentLibraryId}&Fields=PrimaryImageAspectRatio,EndDate,Status,ChildCount,RecursiveItemCount,BackdropImageTags&SortBy=${currentSort.by}&SortOrder=${currentSort.order}&Limit=${libraryItemLimit}&StartIndex=${start}`;
    url += getFilterQuery();
    try {
      const res = await fetch(url, authOpts());
      if (res.ok && myToken === loadToken) {
        const data   = await res.json();
        if (myToken !== loadToken) return;
        currentItems = [...currentItems, ...(data.Items || [])];
        if (isCacheableView()) cacheLibraryView(currentLibraryId, { items: currentItems, total: totalLibraryItems });
      }
    } catch { } finally { isFetchingMore = false; }
  }

  // Aufwärts nachladen: Block VOR dem Fenster holen und voranstellen; Scroll um Höhenzuwachs korrigieren.
  async function loadPreviousLibraryItems() {
    if (isFetchingPrev || firstLoadedIndex <= 0 || !currentLibraryId) return;
    isFetchingPrev = true;
    const myToken = loadToken;   // gehört zur AKTUELLEN Liste — nach einem Reload nicht mehr voranstellen
    const newStart = Math.max(0, firstLoadedIndex - libraryItemLimit);
    const count    = firstLoadedIndex - newStart;
    const url = `${session.serverUrl}/Users/${selectedUser.Id}/Items?ParentId=${currentLibraryId}&Fields=PrimaryImageAspectRatio,EndDate,Status,ChildCount,RecursiveItemCount,BackdropImageTags&SortBy=${currentSort.by}&SortOrder=${currentSort.order}&Limit=${count}&StartIndex=${newStart}${getFilterQuery()}`;
    try {
      const res = await fetch(url, authOpts());
      if (res.ok && myToken === loadToken) {
        const items  = (await res.json()).Items || [];
        if (myToken !== loadToken) return;
        const before = libraryScrollContainer ? libraryScrollContainer.scrollHeight : 0;
        currentItems     = [...items, ...currentItems];
        firstLoadedIndex = newStart;
        await tick();
        if (libraryScrollContainer) libraryScrollContainer.scrollTop += libraryScrollContainer.scrollHeight - before;
      }
    } catch { } finally { isFetchingPrev = false; }
  }

  async function playRandomItem() {
    if (!currentLibraryId) return;
    try {
      const res = await fetch(
        `${session.serverUrl}/Users/${selectedUser.Id}/Items?ParentId=${currentLibraryId}` +
        `&SortBy=Random&Limit=1&Recursive=true&IncludeItemTypes=Movie,Series&Fields=Overview`,
        authOpts()
      );
      if (res.ok) {
        const data = await res.json();
        if (data.Items?.length) onOpenDetails?.(data.Items[0]);
      }
    } catch { }
  }

  // ── Infinite-Scroll-Attachments ─────────────────────────────
  function infiniteScroll(node) {
    const obs = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) loadMoreLibraryItems(); },
      { rootMargin: '2000px' }
    );
    obs.observe(node);
    return () => obs.disconnect();
  }
  function infiniteScrollUp(node) {
    const obs = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting) loadPreviousLibraryItems(); },
      { rootMargin: '1000px' }
    );
    obs.observe(node);
    return () => obs.disconnect();
  }

  // A-Z-Anzeige beim Scrollen mitführen (oberste sichtbare Karte bestimmt den aktiven Buchstaben).
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

  // ── Details öffnen: Scroll/Fokus merken, dann an App ────────
  let savedScroll  = 0;
  let lastFocusedId = null;
  function openDetails(item) {
    savedScroll   = libraryScrollContainer?.scrollTop || 0;
    lastFocusedId = item.Id;
    onOpenDetails?.(item);
  }

  // ── Von App via bind:this aufrufbar ─────────────────────────
  export async function restoreView() {
    await tick();
    if (libraryScrollContainer) libraryScrollContainer.scrollTop = savedScroll;
    if (lastFocusedId && libraryGrid) {
      const btn = libraryGrid.querySelector(`[data-item-id="${lastFocusedId}"]`);
      if (btn) btn.focus();
    }
  }
  export function removeItem(id) { currentItems = currentItems.filter(i => i.Id !== id); }
  export function updateChildCount(id, count) {
    const gi = currentItems.find(x => x.Id === id);
    if (gi) { gi.ChildCount = count; currentItems = [...currentItems]; }
  }
  export function renamePlaylist(id, name) {
    const gi = currentItems.find(x => x.Id === id);
    if (gi) { gi.Name = name; currentItems = [...currentItems]; }
  }
  export function matchesStatusFilters(item) {
    if (activeFilters.isFavorite  && !item.UserData?.IsFavorite) return false;
    if (activeFilters.isPlayed    && !item.UserData?.Played)     return false;
    if (activeFilters.isNotPlayed &&  item.UserData?.Played)     return false;
    return true;
  }

  // ── Laden bei Bibliothekswechsel / reloadKey ────────────────
  let appliedKey = -1;
  async function focusFirstCard() {
    await tick();
    const card = libraryGrid?.querySelector('button');
    if (card) card.focus();
  }
  $effect(() => {
    const lib = library;
    const rk  = reloadKey;
    if (!lib) return;
    const newLib = lib.Id !== currentLibraryId;
    const newKey = rk !== appliedKey;
    if (!newLib && !newKey) return;
    appliedKey = rk;
    if (newKey && !newLib) viewCache = {};            // Daten geändert → Cache verwerfen
    const ff = focusFirstOnLoad;
    loadLibraryItems(lib, newLib ? null : (currentLetter || null)).then(() => {
      if (newLib && ff) focusFirstCard();
    });
  });

  // Gemeinsames Profil weg → "Gemeinsam schauen" aus (Schalter blendet ohnehin aus).
  $effect(() => { if (!sharedReady) sharedWatchMode = false; });
</script>

<div class="flex h-full w-full relative">

  <!-- Backdrop-Vorschau -->
  {#if previewBackdrop}
    <div class="absolute inset-0 z-0 pointer-events-none">
      {#key previewBackdrop}
        <img src={previewBackdrop} alt="" class="w-full h-full object-cover preview-fade" />
      {/key}
      <div class="absolute inset-0 bg-gradient-to-r from-gray-900 via-gray-900/85 to-gray-900/40"></div>
      <div class="absolute inset-0 bg-gradient-to-t from-gray-900 via-transparent to-gray-900/60"></div>
    </div>
  {/if}

  <!-- A-Z Sprung-Vorschau -->
  {#if jumpLetterOverlay}
    <div class="absolute inset-0 z-30 flex items-center justify-center pointer-events-none">
      <div class="bg-black/70 backdrop-blur-md rounded-3xl w-40 h-40 flex items-center justify-center jump-overlay">
        <span class="text-8xl font-bold text-white">{jumpLetterOverlay}</span>
      </div>
    </div>
  {/if}

  <div bind:this={libraryScrollContainer} onscroll={handleLibraryScroll}
    class="flex-1 p-10 pt-16 overflow-y-auto hide-scrollbar relative z-10">

    <div class="flex justify-between items-center mb-10 pr-6">
      <h1 class="text-4xl font-bold text-white">
        {currentLibraryName}
        <span class="text-xl text-gray-500 font-normal">({totalLibraryItems})</span>
      </h1>
      <div class="flex items-center gap-3">
        <button onclick={playRandomItem}
          class="flex items-center gap-3 bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 px-6 py-3 rounded-xl text-white font-bold
                 focus:outline-none focus:ring-4 focus:ring-white transition-all shadow-lg border border-gray-700 focus:scale-105"
          title={i18n.t.shuffle}>
          <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M4 4h4l12 16h4M4 20h4l3-4m4-9l2-3h3M20 4v4m0 12v-4"/>
          </svg>
          {i18n.t.shuffle}
        </button>
        <button onclick={(e) => { sortFilterFocus.capture(e.currentTarget); showSortMenu = true; }}
          class="flex items-center gap-3 bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 px-6 py-3 rounded-xl text-white font-bold
                 focus:outline-none focus:ring-4 focus:ring-white transition-all shadow-lg border border-gray-700 focus:scale-105"
          title={i18n.t.sortBy}>
          <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 4h13M3 8h9M3 12h5m4 4l4 4m0 0l4-4m-4 4V8"/>
          </svg>
          {i18n.t.sortBy}
        </button>
        <button onclick={openFilterMenu}
          class="flex items-center gap-3 bg-gray-800 hover:bg-gray-700 px-6 py-3 rounded-xl text-white font-bold
                 focus:outline-none focus:ring-4 focus:ring-white transition-all shadow-lg border border-gray-700 focus:scale-105">
          <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z"/>
          </svg>
          {i18n.t.filter}
          {#if hasFilters}<span class="bg-blue-600 text-white text-xs px-2 py-1 rounded-full ml-1 font-bold">{i18n.t.filterActive}</span>{/if}
        </button>
        {#if sharedReady}
          <button onclick={toggleSharedWatch}
            class="flex items-center gap-3 px-6 py-3 rounded-xl font-bold focus:outline-none focus:ring-4 focus:ring-white transition-all shadow-lg border focus:scale-105
                   {sharedWatchMode ? 'bg-blue-600 border-blue-400 text-white' : 'bg-gray-800 hover:bg-gray-700 border-gray-700 text-white'}"
            title={i18n.t.watchTogether}>
            <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-1.13a4 4 0 10-4-4 4 4 0 004 4zm6 0a3 3 0 10-2.5-1.34M5 11a3 3 0 102.5-1.34"/>
            </svg>
            {i18n.t.watchTogether}
          </button>
        {/if}
      </div>
    </div>

    <!-- Schnellfilter-Chips: Favoriten + Sortierung -->
    <div class="flex gap-3 mb-6 px-2 py-3 overflow-x-auto hide-scrollbar">
      <button onclick={() => toggleFilter('isFavorite')}
        class="shrink-0 flex items-center gap-2 px-5 py-2.5 rounded-full font-bold text-sm whitespace-nowrap
               focus:outline-none focus:ring-4 focus:ring-white transition-all focus:scale-105
               {activeFilters.isFavorite ? 'bg-red-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}">
        <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
        {i18n.t.filterFavorites}
      </button>
      {#each sortOptions as opt}
        <button onclick={() => setSort(opt)}
          class="shrink-0 flex items-center gap-1.5 px-5 py-2.5 rounded-full font-bold text-sm whitespace-nowrap
                 focus:outline-none focus:ring-4 focus:ring-white transition-all focus:scale-105
                 {currentSort.by === opt.by ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-300 hover:bg-gray-700'}">
          {i18n.t[opt.key]}
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

    {#if firstLoadedIndex > 0 && !isLoading}
      <div {@attach infiniteScrollUp} class="h-2 w-full"></div>
    {/if}

    <div bind:this={libraryGrid}
      class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6 pr-4">
      {#if isLoading}
        {#each Array(14).fill(0) as _}
          <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg animate-pulse"></div>
        {/each}
      {:else}
        {#each visibleLibraryItems as item (item.Id)}
          <button onclick={() => openDetails(item)} data-item-id={item.Id}
            onfocus={() => previewItem(item)} onblur={cancelPreview}
            {@attach longPress()} onlongpress={() => onContextMenu?.(item)}
            class="group focus:outline-none text-left cv-auto">
            <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg overflow-hidden border-4 border-transparent group-focus:border-white shadow-xl relative">
              {#if item.Type === 'Playlist' && item.ChildCount === 0}
                <div class="w-full h-full flex items-center justify-center text-gray-600">
                  <svg class="w-16 h-16" fill="currentColor" viewBox="0 0 24 24"><path d="M4 6h16v2H4zm2-4h12v2H6zm-4 8h20v10a2 2 0 01-2 2H4a2 2 0 01-2-2V10z"/></svg>
                </div>
              {:else if getItemImageUrl(item)}
                <img src={getItemImageUrl(item)} {@attach blurUp(itemBlurHash(item))} alt={item.Name} class="w-full h-full object-cover" loading="lazy" decoding="async"/>
              {/if}
              {#if displaySettings.episodeCount && item.Type === 'Series' && item.RecursiveItemCount}
                <div class="absolute top-2 right-2 bg-black/80 text-white text-xs font-bold px-2 py-1 rounded-md">
                  {item.RecursiveItemCount} {i18n.t.episodes}
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
              <span class="text-xs text-gray-500 group-focus:text-gray-400 block truncate w-full mt-0.5">{getItemSubtitle(item, i18n.t.today)}</span>
            </div>
          </button>
        {/each}
      {/if}
    </div>

    {#if sharedWatchMode && !isLoading && currentItems.length > 0 && visibleLibraryItems.length === 0}
      <div class="text-center text-gray-400 py-24 text-lg">{i18n.t.watchTogetherEmpty}</div>
    {/if}

    {#if currentItems.length > 0 && firstLoadedIndex + currentItems.length < totalLibraryItems}
      <div {@attach infiniteScroll} class="w-full flex justify-center items-center py-12 mt-8" style="min-height:6rem">
        {#if isFetchingMore}
          <div class="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
        {/if}
      </div>
    {/if}
  </div>

  <!-- A-Z (nur bei Namenssortierung) -->
  {#if showLetterBar}
  <div data-hbar class="w-16 shrink-0 bg-gradient-to-l from-gray-950/85 via-gray-950/55 to-transparent backdrop-blur-sm flex flex-col items-center justify-between py-6 overflow-y-auto hide-scrollbar z-10">
    {#each alphabet as letter}
      <button
        onclick={() => { showJumpLetter(letter); loadLibraryItems({ Id: currentLibraryId, Name: currentLibraryName }, letter); }}
        onfocus={() => showJumpLetter(letter)}
        data-hbar-current={activeLetter === letter ? '' : null}
        class="w-10 h-10 flex items-center justify-center rounded-full text-sm font-bold drop-shadow
               focus:outline-none focus:ring-4 focus:ring-white transition-all transform focus:scale-125
               {activeLetter === letter ? 'text-white bg-blue-600 shadow-lg scale-110' : 'text-gray-300/80 hover:text-white hover:bg-white/10'}"
      >{letter}</button>
    {/each}
  </div>
  {/if}
</div>

<!-- SORTIER-MENÜ -->
{#if showSortMenu}
  <div data-focus-trap transition:uiFade onoutrostart={dropTrapOnOutro} class="fixed inset-0 bg-black/90 z-[100] flex items-center justify-center p-8"
    onkeydown={(e) => { if (isBackKey(e)) { e.stopPropagation(); showSortMenu = false; } }}>
    <div class="bg-gray-800 border border-gray-700 p-10 rounded-2xl w-full max-w-xl flex flex-col gap-4 shadow-2xl">
      <div class="flex justify-between items-center mb-2">
        <h2 class="text-4xl text-white font-bold">{i18n.t.sortBy}</h2>
        <button onclick={() => showSortMenu = false} {@attach focusOnMount()}
          class="text-gray-400 hover:text-white focus:text-white focus:outline-none focus:ring-4 focus:ring-white rounded-full p-2">
          <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>
      {#each sortOptions as opt}
        <button onclick={() => setSort(opt)}
          class="w-full text-left p-5 text-xl font-bold rounded-xl transition-colors flex items-center justify-between
                 focus:outline-none focus:ring-4 focus:ring-white
                 {currentSort.by === opt.by ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-200 hover:bg-blue-600 focus:bg-blue-600'}">
          <span>{i18n.t[opt.key]}</span>
          {#if currentSort.by === opt.by}
            {#if opt.by === 'Random'}
              <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
            {:else}
              <span class="flex items-center gap-1 text-sm">
                {currentSort.order === 'Ascending' ? i18n.t.sortAsc : i18n.t.sortDesc}
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

<!-- FILTER-MENÜ -->
{#if showFilterMenu}
  <div data-focus-trap transition:uiFade onoutrostart={dropTrapOnOutro} class="fixed inset-0 bg-black/90 z-[100] flex items-center justify-center p-8"
    onkeydown={(e) => { if (isBackKey(e)) { e.stopPropagation(); closeFilterMenu(); } }}>
    <div class="bg-gray-800 border border-gray-700 rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl">

      <div class="flex justify-between items-center p-8 pb-4 shrink-0">
        <h2 class="text-4xl text-white font-bold">{i18n.t.filter}</h2>
        <button onclick={closeFilterMenu} {@attach focusOnMount()}
          class="text-gray-400 hover:text-white focus:text-white focus:outline-none focus:ring-4 focus:ring-white rounded-full p-2">
          <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
          </svg>
        </button>
      </div>

      <div class="flex-1 overflow-y-auto hide-scrollbar px-8 flex flex-col gap-6">

        <div class="flex flex-col gap-3">
          <h3 class="text-lg font-bold text-gray-400 uppercase tracking-wider">{i18n.t.status}</h3>
          <div class="flex flex-wrap gap-3">
            {#each [['isFavorite', i18n.t.filterFavorites],['isNotPlayed', i18n.t.filterUnplayed],['isPlayed', i18n.t.filterPlayed]] as [key, label]}
              <button onclick={() => toggleFilter(key)}
                class="px-5 py-2 rounded-full font-bold text-lg border-2 transition-all focus:outline-none focus:ring-4 focus:ring-white
                       {activeFilters[key] ? 'bg-blue-600 border-blue-400 text-white' : 'bg-gray-900 border-gray-700 text-gray-400 hover:bg-gray-700 hover:text-white'}">
                {label}
              </button>
            {/each}
          </div>
        </div>

        <div class="flex flex-col gap-3">
          <h3 class="text-lg font-bold text-gray-400 uppercase tracking-wider">{i18n.t.ageRating}</h3>
          <div class="flex flex-wrap gap-3">
            {#each fskOptions as age}
              <button onclick={() => toggleFsk(age)}
                class="px-5 py-2 rounded-full font-bold text-lg border-2 transition-all focus:outline-none focus:ring-4 focus:ring-white
                       {selectedFsk.includes(age) ? 'bg-red-700 border-red-500 text-white' : 'bg-gray-900 border-gray-700 text-gray-400 hover:bg-gray-700 hover:text-white'}">
                FSK {age}
              </button>
            {/each}
          </div>
        </div>

        {#if availableGenres.length > 0}
          <div class="flex flex-col gap-3 pb-2">
            <h3 class="text-lg font-bold text-gray-400 uppercase tracking-wider">{i18n.t.genres}</h3>
            <div class="flex flex-wrap gap-3">
              {#each availableGenres as genre (genre)}
                <button onclick={() => toggleGenre(genre.Name)}
                  class="px-5 py-2 rounded-full font-bold text-lg border-2 transition-all focus:outline-none focus:ring-4 focus:ring-white
                         {selectedGenres.includes(genre.Name) ? 'bg-blue-600 border-blue-400 text-white' : 'bg-gray-900 border-gray-700 text-gray-400 hover:bg-gray-700 hover:text-white'}">
                  {genre.Name}
                </button>
              {/each}
            </div>
          </div>
        {/if}

      </div>

      <div class="p-8 pt-4 shrink-0">
        <button onclick={closeFilterMenu}
          class="w-full bg-gray-700 hover:bg-gray-600 text-white font-bold text-xl py-5 rounded-xl
                 focus:outline-none focus:ring-4 focus:ring-white transition-colors">
          {i18n.t.filterClose}
        </button>
      </div>

    </div>
  </div>
{/if}

<style>
  /* Bei der Extraktion aus App.svelte verloren gegangen (Klassen blieben im Markup, die
     Regeln nicht) — hier rekonstruiert. Komponenten-spezifisch, daher lokal statt app.css. */
  /* Backdrop-Vorschau: sanft einblenden statt hart umschalten ({#key} remountet das <img>) */
  .preview-fade { animation: previewFadeIn 0.5s ease-out; }
  @keyframes previewFadeIn { from { opacity: 0; } to { opacity: 1; } }

  /* A-Z-Sprung-Overlay: kurzes Aufpoppen (Skalierung + Einblenden) */
  .jump-overlay { animation: jumpPop 0.18s ease-out; }
  @keyframes jumpPop { from { opacity: 0; transform: scale(0.85); } to { opacity: 1; transform: scale(1); } }
</style>
