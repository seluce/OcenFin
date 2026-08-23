<script>
  import { i18n } from '../i18n.svelte.js';
  import { itemProgress, itemBadge, itemBlurHash, blurUp, longPress, authHeaders, focusOnMount, getItemImageUrl } from '../utils.js';
  import { session } from '../session.svelte.js';

  let { person, selectedUser, onBack, onOpenDetails, onContextMenu } = $props();

  let fav       = $state(false);
  let items     = $state([]);
  let isLoading = $state(false);

  // Group the filmography by type. Episodes are COLLAPSED per series into a single
  // "Series (N episodes)" tile — so guest stars (only credited on individual episodes,
  // not on the series) finally show up, without a main-cast actor drowning the page in
  // hundreds of episode tiles. A collapsed tile opens the series (see onOpenDetails).
  let groups = $derived.by(() => {
    const movies = items.filter(i => i.Type === 'Movie');
    const directSeries = items.filter(i => i.Type === 'Series');
    const directIds = new Set(directSeries.map(x => x.Id));
    const guest = new Map();   // SeriesId -> synthetic series tile
    for (const ep of items) {
      if (ep.Type !== 'Episode' || !ep.SeriesId) continue;
      if (directIds.has(ep.SeriesId)) continue;   // person is regular cast → series tile already shown
      const hit = guest.get(ep.SeriesId);
      if (hit) { hit._episodeCount++; continue; }
      guest.set(ep.SeriesId, {
        Id: ep.SeriesId, Type: 'Series', Name: ep.SeriesName || ep.Name,
        ImageTags: ep.SeriesPrimaryImageTag ? { Primary: ep.SeriesPrimaryImageTag } : undefined,
        ProductionYear: ep.SeriesProductionYear,
        _episodeCount: 1,
      });
    }
    return [
      { label: i18n.t.movies, items: movies },
      { label: i18n.t.series, items: [...directSeries, ...guest.values()] },
    ].filter(g => g.items.length > 0);
  });

  const getAuthHeaders = () => authHeaders(session.token);

  async function loadPerson() {
    // Opening a second person while the first is still loading would otherwise let the slower
    // response win and fill the view with the wrong filmography. loadedId is set synchronously
    // before this runs, so comparing against it identifies a superseded load. Same guard as in
    // Details/Library/Search.
    const myId = person.Id;
    fav       = !!person.UserData?.IsFavorite;
    items     = [];
    isLoading = true;
    // Fetch the person item separately → correct favorite status (from search/cast, UserData is often missing)
    fetch(`${session.serverUrl}/Users/${selectedUser.Id}/Items/${person.Id}`, { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(p => { if (p && myId === loadedId) fav = !!p.UserData?.IsFavorite; })
      .catch(() => {});
    // Two parallel fetches: main filmography (movies/series) and episodes (for guest roles),
    // so a long-running series' episodes can never crowd movies/series out of a single limit.
    const base = `${session.serverUrl}/Users/${selectedUser.Id}/Items?PersonIds=${person.Id}` +
      `&Recursive=true&SortBy=PremiereDate&SortOrder=Descending` +
      `&Fields=PrimaryImageAspectRatio,SeriesName&EnableTotalRecordCount=false`;
    try {
      const [mainRes, epRes] = await Promise.all([
        fetch(`${base}&IncludeItemTypes=Movie,Series&Limit=100`, { headers: getAuthHeaders() }),
        fetch(`${base}&IncludeItemTypes=Episode&Limit=200`, { headers: getAuthHeaders() }),
      ]);
      const main = mainRes.ok ? ((await mainRes.json()).Items || []) : [];
      const eps  = epRes.ok  ? ((await epRes.json()).Items  || []) : [];
      if (myId !== loadedId) return;   // superseded by a newer person
      items = [...main, ...eps];
    } catch { /* ignore */ }
    finally { if (myId === loadedId) isLoading = false; }
  }

  // Set/remove the person as a favorite (optimistic; roll back on error)
  async function toggleFavorite() {
    const next = !fav;
    fav = next;
    try {
      await fetch(`${session.serverUrl}/Users/${selectedUser.Id}/FavoriteItems/${person.Id}`,
        { method: next ? 'POST' : 'DELETE', headers: getAuthHeaders() });
    } catch (e) { console.warn('[OcenFin] person favorite failed, rolled back:', e); fav = !next; }
  }

  // Loads on mount and when a different person is opened.
  let loadedId = null;
  $effect(() => {
    if (person && person.Id !== loadedId) { loadedId = person.Id; loadPerson(); }
  });
</script>

<div class="p-10 pt-16 h-full overflow-y-auto hide-scrollbar">
  <div class="flex items-center gap-6 mb-8">
    <button onclick={onBack} {@attach focusOnMount()}
      class="bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 px-6 py-2 rounded-lg text-white font-bold focus:outline-none focus:ring-4 focus:ring-white">
      {i18n.t.back}
    </button>
    <button onclick={toggleFavorite} aria-label={i18n.t.favorites}
      class="w-12 h-12 rounded-lg focus:outline-none focus:ring-4 focus:ring-white transition-colors flex items-center justify-center
             {fav ? 'bg-red-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700 focus:bg-gray-700'}">
      <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M11.645 20.91l-.007-.003-.022-.012a15.247 15.247 0 01-.383-.218 25.18 25.18 0 01-4.244-3.17C4.688 15.36 2.25 12.174 2.25 8.25 2.25 5.322 4.714 3 7.688 3A5.5 5.5 0 0112 5.052 5.5 5.5 0 0116.313 3c2.973 0 5.437 2.322 5.437 5.25 0 3.925-2.438 7.111-4.739 9.256a25.175 25.175 0 01-4.244 3.17 15.247 15.247 0 01-.383.219l-.022.012-.007.004-.003.001a.752.752 0 01-.704 0z"/></svg>
    </button>
  </div>
  <div class="flex items-center gap-4 mb-10">
    <svg class="w-10 h-10 shrink-0 text-blue-400" fill="currentColor" viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
    <div class="min-w-0">
      <h1 class="text-4xl font-bold text-white truncate">{person?.Name}</h1>
      <p class="text-gray-400 mt-1">{i18n.t.appearsIn}</p>
    </div>
  </div>

  {#if isLoading}
    <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6 pr-4">
      {#each Array(12).fill(0) as _}
        <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg animate-pulse"></div>
      {/each}
    </div>
  {:else if groups.length > 0}
    {#each groups as group (group.label)}
      <h2 class="text-2xl font-bold text-white mb-4 mt-2">{group.label}</h2>
      <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6 pr-4 mb-10">
        {#each group.items as item (item.Id)}
              {@const badge = itemBadge(item)}
          <button onclick={() => onOpenDetails(item)}
            {@attach longPress()} onlongpress={() => onContextMenu(item)}
            class="group focus:outline-none text-left scroll-my-4">
            <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg overflow-hidden border-4 border-transparent group-focus:border-white group-focus:scale-105 transition-transform duration-200 shadow-xl relative">
                  {#if badge}
                    <div class="absolute top-2 left-2 z-10 min-w-[1.6rem] h-[1.6rem] px-1.5 rounded-full flex items-center justify-center bg-blue-600/90 text-white text-xs font-bold shadow-md pointer-events-none">
                      <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
                    </div>
                  {/if}
              {#if getItemImageUrl(item)}
                <img src={getItemImageUrl(item)} {@attach blurUp(itemBlurHash(item))} alt={item.Name} class="w-full h-full object-cover" loading="lazy" decoding="async"/>
              {/if}
              {#if itemProgress(item) > 0}
                <div class="absolute bottom-0 left-0 w-full h-1.5 bg-gray-900/80">
                  <div class="h-full bg-blue-500" style="width:{itemProgress(item)}%"></div>
                </div>
              {/if}
            </div>
            <span class="text-sm font-bold text-gray-300 group-focus:text-white block truncate w-full mt-2">
              {item.Type === 'Episode' && item.SeriesName ? item.SeriesName : item.Name}
            </span>
            {#if item._episodeCount}
              <span class="text-xs text-gray-400 block truncate w-full">{item._episodeCount} {i18n.t.episodes}</span>
            {:else if item.Type === 'Episode'}
              <span class="text-xs text-gray-400 block truncate w-full">{item.Name}</span>
            {:else if item.ProductionYear}
              <span class="text-xs text-gray-400 block truncate w-full">{item.ProductionYear}</span>
            {/if}
          </button>
        {/each}
      </div>
    {/each}
  {:else}
    <div class="flex items-center justify-center h-64">
      <p class="text-2xl text-gray-500 font-bold">{i18n.t.noItems}</p>
    </div>
  {/if}
</div>
