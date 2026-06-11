<script>
  import { t } from '../i18n.js';
  import { personImageUrl, authHeaders, blurUp, itemBlurHash } from '../utils.js';
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';

  export let serverUrl;
  export let activeToken;
  export let selectedUser;

  const dispatch = createEventDispatcher();

  let query   = "";
  let results = [];
  let isLoading = false;
  let searchTimeout;
  let searchInput;

  let searchHistory  = [];
  const MAX_HISTORY  = 8;

  // FIX: Nur ein einziges onMount — lädt Verlauf UND fokussiert das Eingabefeld
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

  $: movies   = results.filter(r => r.Type === 'Movie');
  $: series   = results.filter(r => r.Type === 'Series');
  $: episodes = results.filter(r => r.Type === 'Episode');
  let people  = [];

  const getAuthHeaders = () => authHeaders(activeToken);

  function onSearchInput() {
    clearTimeout(searchTimeout);
    if (query.trim().length < 2) { results = []; people = []; isLoading = false; return; }
    isLoading = true;
    searchTimeout = setTimeout(performSearch, 600);
  }

  async function performSearch() {
    try {
      // Titel + Personen parallel suchen
      const [itemsRes, peopleRes] = await Promise.all([
        fetch(`${serverUrl}/Users/${selectedUser.Id}/Items?searchTerm=${encodeURIComponent(query)}&Recursive=true&IncludeItemTypes=Movie,Series,Episode&Limit=24&Fields=Overview,PrimaryImageAspectRatio&SortBy=SortName`,
          { headers: getAuthHeaders() }),
        fetch(`${serverUrl}/Persons?searchTerm=${encodeURIComponent(query)}&Limit=10&userId=${selectedUser.Id}`,
          { headers: getAuthHeaders() })
      ]);
      if (itemsRes.ok) results = (await itemsRes.json()).Items || [];

      // Personen: nur behalten, die tatsächlich in der Mediathek vorkommen.
      // Jellyfins /Persons liefert auch Namen, die in keinem eigenen Titel mitspielen —
      // daher pro Person eine schnelle Zähl-Abfrage (Limit=0 = nur TotalRecordCount).
      if (peopleRes.ok) {
        const found = (await peopleRes.json()).Items || [];
        const checked = await Promise.all(found.map(async p => {
          try {
            const c = await fetch(
              `${serverUrl}/Users/${selectedUser.Id}/Items?PersonIds=${p.Id}&Recursive=true&IncludeItemTypes=Movie,Series&Limit=0`,
              { headers: getAuthHeaders() }
            );
            return ((await c.json()).TotalRecordCount || 0) > 0 ? p : null;
          } catch { return null; }
        }));
        people = checked.filter(Boolean);
      }

      if (query.trim().length >= 2 && (results.length > 0 || people.length > 0)) saveToHistory(query);
    } catch (e) { console.error("Suche fehlgeschlagen:", e); }
    finally     { isLoading = false; }
  }

  function getItemImageUrl(item, format = 'portrait') {
    if (format === 'landscape') {
      if (item.Type === 'Episode' && item.ImageTags?.Primary)
        return `${serverUrl}/Items/${item.Id}/Images/Primary?tag=${item.ImageTags.Primary}&maxWidth=600&quality=80&format=webp`;
      if (item.BackdropImageTags?.length > 0)
        return `${serverUrl}/Items/${item.Id}/Images/Backdrop?tag=${item.BackdropImageTags[0]}&maxWidth=600&quality=80&format=webp`;
    }
    if (item.ImageTags?.Primary)
      return `${serverUrl}/Items/${item.Id}/Images/Primary?tag=${item.ImageTags.Primary}&fillHeight=400&quality=80&format=webp`;
    if (item.SeriesPrimaryImageTag)
      return `${serverUrl}/Items/${item.SeriesId}/Images/Primary?tag=${item.SeriesPrimaryImageTag}&fillHeight=400&quality=80&format=webp`;
    return null;
  }
</script>

<div class="p-10 pt-16 h-full flex flex-col">

  <!-- SUCHFELD -->
  <div class="mb-8 relative shrink-0">
    <svg class="w-8 h-8 absolute left-6 top-1/2 -translate-y-1/2 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="3" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"/>
    </svg>
    <input
      bind:this={searchInput}
      bind:value={query}
      on:input={onSearchInput}
      type="text"
      placeholder={$t.searchPlaceholder}
      class="w-full bg-gray-800 text-white text-3xl pl-20 pr-6 py-6 rounded-2xl border-2 border-transparent
             focus:outline-none focus:border-white shadow-xl placeholder-gray-500 transition-colors"
    />
  </div>

  <!-- SUCHVERLAUF -->
  {#if query.trim().length < 2 && searchHistory.length > 0}
    <div class="mb-8 flex flex-col gap-4">
      <div class="flex justify-between items-center px-2">
        <h2 class="text-xl font-bold text-gray-400 uppercase tracking-wider">{$t.searchHistory}</h2>
        <button on:click={clearHistory}
          class="flex items-center gap-2 bg-gray-800 hover:bg-red-900/80 focus:bg-red-900/80 text-gray-400 hover:text-red-200 focus:text-red-200
                 px-4 py-2 rounded-lg text-sm font-bold transition-all focus:outline-none focus:ring-2 focus:ring-red-500">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
          </svg>
          {$t.clearHistory}
        </button>
      </div>
      <div class="flex flex-wrap gap-4 px-2">
        {#each searchHistory as term}
          <button on:click={() => useHistory(term)}
            class="bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 text-gray-300 focus:text-white
                   px-6 py-3 rounded-full font-bold focus:outline-none focus:ring-4 focus:ring-blue-500 transition-all border border-gray-700">
            {term}
          </button>
        {/each}
      </div>
    </div>
  {/if}

  <!-- ERGEBNISSE -->
  {#if isLoading}
    <div class="flex-1 flex justify-center mt-20">
      <div class="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
    </div>

  {:else if results.length > 0 || people.length > 0}
    <div class="flex flex-col gap-12 overflow-y-auto hide-scrollbar pb-32">

      {#if series.length > 0}
        <div>
          <h2 class="text-3xl font-bold text-white mb-6 px-2">{$t.series}</h2>
          <div class="flex gap-6 overflow-x-auto hide-scrollbar pb-4 px-2">
            {#each series as s}
              <button on:click={() => dispatch('openDetails', s)} class="shrink-0 w-48 group focus:outline-none text-left">
                <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg overflow-hidden border-4 border-transparent group-focus:border-white shadow-xl">
                  {#if getItemImageUrl(s, 'portrait')}<img src={getItemImageUrl(s, 'portrait')} use:blurUp={itemBlurHash(s)} alt={s.Name} class="w-full h-full object-cover" loading="lazy" />{/if}
                </div>
                <div class="mt-3 flex flex-col w-full overflow-hidden">
                  <span class="text-sm font-bold text-gray-300 group-focus:text-white truncate">{s.Name}</span>
                  {#if s.ProductionYear}<span class="text-xs text-gray-500 truncate mt-0.5">{s.ProductionYear}</span>{/if}
                </div>
              </button>
            {/each}
          </div>
        </div>
      {/if}

      {#if movies.length > 0}
        <div>
          <h2 class="text-3xl font-bold text-white mb-6 px-2">{$t.movies}</h2>
          <div class="flex gap-6 overflow-x-auto hide-scrollbar pb-4 px-2">
            {#each movies as m}
              <button on:click={() => dispatch('openDetails', m)} class="shrink-0 w-48 group focus:outline-none text-left">
                <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg overflow-hidden border-4 border-transparent group-focus:border-white shadow-xl">
                  {#if getItemImageUrl(m, 'portrait')}<img src={getItemImageUrl(m, 'portrait')} use:blurUp={itemBlurHash(m)} alt={m.Name} class="w-full h-full object-cover" loading="lazy" />{/if}
                </div>
                <div class="mt-3 flex flex-col w-full overflow-hidden">
                  <span class="text-sm font-bold text-gray-300 group-focus:text-white truncate">{m.Name}</span>
                  {#if m.ProductionYear}<span class="text-xs text-gray-500 truncate mt-0.5">{m.ProductionYear}</span>{/if}
                </div>
              </button>
            {/each}
          </div>
        </div>
      {/if}

      {#if episodes.length > 0}
        <div>
          <h2 class="text-3xl font-bold text-white mb-6 px-2">{$t.episodes}</h2>
          <div class="flex gap-6 overflow-x-auto hide-scrollbar pb-4 px-2">
            {#each episodes as ep}
              <button on:click={() => dispatch('openDetails', ep)} class="shrink-0 w-80 group focus:outline-none text-left">
                <div class="aspect-video w-full bg-gray-800 rounded-lg overflow-hidden border-4 border-transparent group-focus:border-white shadow-xl">
                  {#if getItemImageUrl(ep, 'landscape')}<img src={getItemImageUrl(ep, 'landscape')} use:blurUp={itemBlurHash(ep)} alt={ep.Name} class="w-full h-full object-cover" loading="lazy" />{/if}
                </div>
                <div class="mt-3 flex flex-col w-full overflow-hidden">
                  <span class="text-sm font-bold text-gray-300 group-focus:text-white truncate">{ep.Name}</span>
                  <span class="text-xs text-gray-500 truncate mt-0.5">
                    {ep.SeriesName || ''}{#if ep.ParentIndexNumber !== undefined} · S{ep.ParentIndexNumber}:E{ep.IndexNumber || '?'}{/if}
                  </span>
                </div>
              </button>
            {/each}
          </div>
        </div>
      {/if}

      <!-- PERSONEN (ganz unten) -->
      {#if people.length > 0}
        <div>
          <h2 class="text-3xl font-bold text-white mb-6 px-2">{$t.people}</h2>
          <div class="flex gap-6 overflow-x-auto hide-scrollbar pb-4 px-2">
            {#each people as p}
              <button on:click={() => dispatch('openPerson', p)} class="shrink-0 w-40 group focus:outline-none text-center">
                <div class="aspect-square w-full bg-gray-800 rounded-full overflow-hidden border-4 border-transparent group-focus:border-white shadow-xl mx-auto">
                  {#if personImageUrl(serverUrl, p)}
                    <img src={personImageUrl(serverUrl, p)} use:blurUp={itemBlurHash(p)} alt={p.Name} class="w-full h-full object-cover" loading="lazy" />
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
      <p class="text-3xl text-gray-500 font-bold">{$t.noResults}</p>
    </div>
  {/if}

</div>

<style>
  .hide-scrollbar::-webkit-scrollbar { display: none; }
  .hide-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
</style>
