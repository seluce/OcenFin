<script>
  import { i18n } from '../i18n.svelte.js';
  import { personImageUrl, authHeaders, blurUp, itemBlurHash, getItemImageUrlWithFallbacks as getItemImageUrl } from '../utils.js';
  import { session } from '../session.svelte.js';
  import { onMount, onDestroy, tick } from 'svelte';

  let { selectedUser, onOpenDetails, onOpenPerson } = $props();

  // This view stays mounted for the whole session (see App.svelte), so a trip into Details or a
  // person page comes back to the same query, the same results and the same per-person cache
  // instead of an empty field. Hiding is display:none, which drops focus and the scroll offset —
  // hence the same save/restore pair the library uses.
  let scrollEl;
  let savedScroll = 0;
  let lastFocusedId = null;
  function leaveTo(fn, item) {
    savedScroll   = scrollEl?.scrollTop || 0;
    lastFocusedId = item?.Id ?? null;
    fn?.(item);
  }

  // Called from App when the view is shown again after Details/a person page.
  export async function restoreView() {
    await tick();
    if (scrollEl) scrollEl.scrollTop = savedScroll;
    const card = lastFocusedId && scrollEl?.querySelector(`[data-item-id="${lastFocusedId}"]`);
    (card || searchInput)?.focus();
  }

  // Called from App when the view is opened FRESH from the menu. A search screen that reopens on
  // the query from two days ago reads as stale, so this is where everything is dropped — including
  // a debounce that may still be pending, which would otherwise fire into a discarded state.
  export function reset() {
    clearTimeout(searchTimeout);
    query = ''; results = []; people = []; isLoading = false;
    savedScroll = 0; lastFocusedId = null;
    searchToken++;                 // any response still in flight is discarded
    tick().then(() => searchInput?.focus());
  }

  let query   = $state("");
  let results = $state([]);
  let isLoading = $state(false);
  let searchTimeout;
  let searchInput;

  let searchHistory  = $state([]);
  const MAX_HISTORY  = 8;

  // FIX: only a single onMount — loads the history AND focuses the input field
  onMount(() => {
    if (searchInput) searchInput.focus();
    try {
      const hist = localStorage.getItem(`search_history_${selectedUser.Id}`);
      if (hist) searchHistory = JSON.parse(hist);
    } catch { }
  });

  onDestroy(() => clearTimeout(searchTimeout));

  function saveToHistory(term) {
    const trimmed = term.trim();
    if (trimmed.length < 2) return;
    searchHistory = searchHistory.filter(t => t.toLowerCase() !== trimmed.toLowerCase());
    searchHistory.unshift(trimmed);
    if (searchHistory.length > MAX_HISTORY) searchHistory.pop();
    searchHistory = [...searchHistory];
    localStorage.setItem(`search_history_${selectedUser.Id}`, JSON.stringify(searchHistory));
  }

  function clearHistory() {
    searchHistory = [];
    localStorage.removeItem(`search_history_${selectedUser.Id}`);
  }

  function useHistory(term) {
    query = term;
    clearTimeout(searchTimeout);
    isLoading = true;
    performSearch();
  }

  let movies   = $derived(results.filter(r => r.Type === 'Movie'));
  let series   = $derived(results.filter(r => r.Type === 'Series'));
  let episodes = $derived(results.filter(r => r.Type === 'Episode'));
  let people   = $state([]);

  const getAuthHeaders = () => authHeaders(session.token);

  // Stale guard (pattern like subtitleFetchToken in the Player): only the MOST RECENT search may accept
  // results. Without it an earlier, slow response can overwrite a later one —
  // you'd then see hits for the second-to-last search term.
  let searchToken = 0;
  const personHasTitles = new Map();   // personId → boolean; lives only as long as this view is mounted

  function onSearchInput() {
    clearTimeout(searchTimeout);
    if (query.trim().length < 2) { searchToken++; results = []; people = []; isLoading = false; return; }
    isLoading = true;
    searchTimeout = setTimeout(performSearch, 600);
  }

  async function performSearch() {
    const myToken = ++searchToken;
    try {
      // Search titles + people in parallel
      const [itemsRes, peopleRes] = await Promise.all([
        fetch(`${session.serverUrl}/Users/${selectedUser.Id}/Items?searchTerm=${encodeURIComponent(query)}&Recursive=true&IncludeItemTypes=Movie,Series,Episode&Limit=24&Fields=Overview,PrimaryImageAspectRatio&SortBy=SortName&EnableTotalRecordCount=false`,
          { headers: getAuthHeaders() }),
        fetch(`${session.serverUrl}/Persons?searchTerm=${encodeURIComponent(query)}&Limit=10&userId=${selectedUser.Id}&EnableTotalRecordCount=false`,
          { headers: getAuthHeaders() })
      ]);
      if (myToken !== searchToken) return;   // a new search meanwhile → discard this response
      if (itemsRes.ok) {
        const items = (await itemsRes.json()).Items || [];
        if (myToken !== searchToken) return;
        results = items;
      }

      // People: keep only those that actually appear in the library.
      // Jellyfin's /Persons also returns names that don't appear in any own title —
      // hence a quick count query per person (Limit=0 = only TotalRecordCount).
      // Cache the result per person (lifetime = the open search view): while typing,
      // consecutive debounced searches mostly return the same people —
      // without a cache that's a full query burst each time. The title search is independent
      // and always fresh; errors are deliberately NOT cached.
      if (peopleRes.ok) {
        const found = (await peopleRes.json()).Items || [];
        const checked = await Promise.all(found.map(async p => {
          if (personHasTitles.has(p.Id)) return personHasTitles.get(p.Id) ? p : null;
          try {
            const c = await fetch(
              `${session.serverUrl}/Users/${selectedUser.Id}/Items?PersonIds=${p.Id}&Recursive=true&IncludeItemTypes=Movie,Series&Limit=0`,
              { headers: getAuthHeaders() }
            );
            const has = c.ok ? ((await c.json()).TotalRecordCount || 0) > 0 : false;
            personHasTitles.set(p.Id, has);
            return has ? p : null;
          } catch { return null; }
        }));
        if (myToken !== searchToken) return;
        people = checked.filter(Boolean);
      }

      if (query.trim().length >= 2 && (results.length > 0 || people.length > 0)) saveToHistory(query);
    } catch (e) { console.error("search failed:", e); }
    // Only reset isLoading if we're still the current search — otherwise an
    // old response would clear the spinner of the already-running new search prematurely.
    finally     { if (myToken === searchToken) isLoading = false; }
  }


</script>

<div class="p-10 pt-16 h-full flex flex-col">

  <!-- SEARCH FIELD -->
  <div class="mb-8 relative shrink-0">
    <svg class="w-8 h-8 absolute left-6 top-1/2 -translate-y-1/2 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
    </svg>
    <input
      bind:this={searchInput}
      bind:value={query}
      oninput={onSearchInput}
      type="text"
      placeholder={i18n.t.searchPlaceholder}
      class="w-full bg-gray-800 text-white text-3xl pl-20 pr-6 py-6 rounded-2xl border-2 border-transparent
             focus:outline-none focus:border-white shadow-xl placeholder-gray-500 transition-colors"
    />
  </div>

  <!-- SEARCH HISTORY -->
  {#if query.trim().length < 2 && searchHistory.length > 0}
    <div class="mb-8 flex flex-col gap-4">
      <div class="px-2">
        <h2 class="text-xl font-bold text-gray-400 uppercase tracking-wider">{i18n.t.searchHistory}</h2>
      </div>
      <div class="flex flex-wrap gap-4 px-2">
        {#each searchHistory as term (term)}
          <button onclick={() => useHistory(term)}
            class="max-w-[22rem] truncate bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 text-gray-300 focus:text-white
                   px-6 py-3 rounded-full font-bold focus:outline-none focus:ring-4 focus:ring-blue-500 transition-all border border-gray-700">
            {term}
          </button>
        {/each}
        <!-- Clear history: as the LAST element of the pill row → reachable via D-pad to the right of the
             last term (previously top right in the header, which you couldn't reach). -->
        <button onclick={clearHistory}
          class="flex items-center gap-2 bg-gray-800 hover:bg-red-900/80 focus:bg-red-900/80 text-gray-400 hover:text-red-200 focus:text-red-200
                 px-6 py-3 rounded-full text-sm font-bold transition-all focus:outline-none focus:ring-4 focus:ring-red-500 border border-gray-700 shrink-0">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
          </svg>
          {i18n.t.clearHistory}
        </button>
      </div>
    </div>
  {/if}

  <!-- RESULTS -->
  {#if isLoading}
    <div class="flex-1 flex justify-center mt-20">
      <div class="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
    </div>

  {:else if results.length > 0 || people.length > 0}
    <div bind:this={scrollEl} class="flex flex-col gap-12 overflow-y-auto hide-scrollbar pb-32">

      {#if series.length > 0}
        <div>
          <h2 class="text-3xl font-bold text-white mb-6 px-2">{i18n.t.series}</h2>
          <div class="flex gap-6 overflow-x-auto hide-scrollbar pt-4 -mt-4 pb-4 px-2">
            {#each series as s (s.Id)}
              <button onclick={() => leaveTo(onOpenDetails, s)} data-item-id={s.Id} class="shrink-0 w-48 scroll-m-4 group focus:outline-none text-left">
                <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg overflow-hidden border-4 border-transparent group-focus:border-white group-focus:scale-105 transition-transform duration-200 shadow-xl">
                  {#if getItemImageUrl(s, 'portrait')}<img src={getItemImageUrl(s, 'portrait')} {@attach blurUp(itemBlurHash(s))} alt={s.Name} class="w-full h-full object-cover" loading="lazy" />{/if}
                </div>
                <div class="mt-3 flex flex-col w-full overflow-hidden">
                  <span class="text-sm font-bold text-gray-300 group-focus:text-white truncate">{s.Name}</span>
                  {#if s.ProductionYear}<span class="text-xs text-gray-400 truncate mt-0.5">{s.ProductionYear}</span>{/if}
                </div>
              </button>
            {/each}
          </div>
        </div>
      {/if}

      {#if movies.length > 0}
        <div>
          <h2 class="text-3xl font-bold text-white mb-6 px-2">{i18n.t.movies}</h2>
          <div class="flex gap-6 overflow-x-auto hide-scrollbar pt-4 -mt-4 pb-4 px-2">
            {#each movies as m (m.Id)}
              <button onclick={() => leaveTo(onOpenDetails, m)} data-item-id={m.Id} class="shrink-0 w-48 scroll-m-4 group focus:outline-none text-left">
                <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg overflow-hidden border-4 border-transparent group-focus:border-white group-focus:scale-105 transition-transform duration-200 shadow-xl">
                  {#if getItemImageUrl(m, 'portrait')}<img src={getItemImageUrl(m, 'portrait')} {@attach blurUp(itemBlurHash(m))} alt={m.Name} class="w-full h-full object-cover" loading="lazy" />{/if}
                </div>
                <div class="mt-3 flex flex-col w-full overflow-hidden">
                  <span class="text-sm font-bold text-gray-300 group-focus:text-white truncate">{m.Name}</span>
                  {#if m.ProductionYear}<span class="text-xs text-gray-400 truncate mt-0.5">{m.ProductionYear}</span>{/if}
                </div>
              </button>
            {/each}
          </div>
        </div>
      {/if}

      {#if episodes.length > 0}
        <div>
          <h2 class="text-3xl font-bold text-white mb-6 px-2">{i18n.t.episodes}</h2>
          <div class="flex gap-6 overflow-x-auto hide-scrollbar pt-4 -mt-4 pb-4 px-2">
            {#each episodes as ep (ep.Id)}
              <button onclick={() => leaveTo(onOpenDetails, ep)} data-item-id={ep.Id} class="shrink-0 w-80 scroll-m-4 group focus:outline-none text-left">
                <div class="aspect-video w-full bg-gray-800 rounded-lg overflow-hidden border-4 border-transparent group-focus:border-white group-focus:scale-105 transition-transform duration-200 shadow-xl">
                  {#if getItemImageUrl(ep, 'landscape')}<img src={getItemImageUrl(ep, 'landscape')} {@attach blurUp(itemBlurHash(ep))} alt={ep.Name} class="w-full h-full object-cover" loading="lazy" />{/if}
                </div>
                <div class="mt-3 flex flex-col w-full overflow-hidden">
                  <span class="text-sm font-bold text-gray-300 group-focus:text-white truncate">{ep.Name}</span>
                  <span class="text-xs text-gray-400 truncate mt-0.5">
                    {ep.SeriesName || ''}{#if ep.ParentIndexNumber !== undefined} · S{ep.ParentIndexNumber}:E{ep.IndexNumber || '?'}{/if}
                  </span>
                </div>
              </button>
            {/each}
          </div>
        </div>
      {/if}

      <!-- PEOPLE (at the very bottom) -->
      {#if people.length > 0}
        <div>
          <h2 class="text-3xl font-bold text-white mb-6 px-2">{i18n.t.people}</h2>
          <div class="flex gap-6 overflow-x-auto hide-scrollbar pt-4 -mt-4 pb-4 px-2">
            {#each people as p (p.Id)}
              <button onclick={() => leaveTo(onOpenPerson, p)} data-item-id={p.Id} class="shrink-0 w-40 scroll-m-4 group focus:outline-none text-center">
                <div class="aspect-square w-full bg-gray-800 rounded-full overflow-hidden border-4 border-transparent group-focus:border-white group-focus:scale-105 transition-transform duration-200 shadow-xl mx-auto">
                  {#if personImageUrl(session.serverUrl, p)}
                    <img src={personImageUrl(session.serverUrl, p)} {@attach blurUp(itemBlurHash(p))} alt={p.Name} class="w-full h-full object-cover" loading="lazy" />
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
        </div>
      {/if}

    </div>

  {:else if query.trim().length >= 2}
    <div class="flex-1 flex items-center justify-center">
      <p class="text-3xl text-gray-500 font-bold">{i18n.t.noResults}</p>
    </div>
  {/if}

</div>

