<script>
  import { i18n } from '../i18n.svelte.js';
  import { itemProgress, itemBadge, getItemSubtitle, personImageUrl, itemBlurHash, blurUp, longPress, authHeaders, dlog, getItemImageUrl } from '../utils.js';
  import { session } from '../session.svelte.js';
  import { tick } from 'svelte';

  let { selectedUser, reloadKey = 0, onOpenDetails, onContextMenu, onOpenPerson, onFocusFallback } = $props();

  let favoriteItems      = $state([]);
  let isLoadingFavorites = $state(false);
  let favoritesGrid = $state();

  // Grouping like in search: movies / series / seasons / collections (empty groups are dropped in the template)
  let favGroups = $derived([
    { key: 'movies',      label: i18n.t.movies,      items: favoriteItems.filter(i => i.Type === 'Movie'  && i.UserData?.IsFavorite) },
    { key: 'series',      label: i18n.t.series,      items: favoriteItems.filter(i => i.Type === 'Series' && i.UserData?.IsFavorite) },
    { key: 'seasons',     label: i18n.t.seasons,     items: favoriteItems.filter(i => i.Type === 'Season' && i.UserData?.IsFavorite) },
    { key: 'collections', label: i18n.t.collections, items: favoriteItems.filter(i => i.Type === 'BoxSet' && i.UserData?.IsFavorite) },
  ]);
  // People separately (round cards, their own section)
  let favPersons = $derived(favoriteItems.filter(i => i.Type === 'Person'));
  // Episodes separately (landscape cards, their own section) — sorted by series → season → episode
  // so episodes of the same series stay together.
  let favEpisodes = $derived(
    favoriteItems
      .filter(i => i.Type === 'Episode' && i.UserData?.IsFavorite)
      .sort((a, b) =>
        (a.SeriesName || '').localeCompare(b.SeriesName || '') ||
        ((a.ParentIndexNumber ?? 0) - (b.ParentIndexNumber ?? 0)) ||
        ((a.IndexNumber ?? 0) - (b.IndexNumber ?? 0))
      )
  );

  const getAuthHeaders = () => authHeaders(session.token);

  async function loadFavorites() {
    isLoadingFavorites = true;
    favoriteItems = [];
    try {
      // People are NOT library items → the /Items query (Recursive) never returns them.
      // Instead the dedicated /Persons endpoint with the IsFavorite filter (UserId for the context).
      const [contentRes, personRes] = await Promise.all([
        fetch(
          `${session.serverUrl}/Users/${selectedUser.Id}/Items?Filters=IsFavorite&Recursive=true` +
          `&IncludeItemTypes=Movie,Series,BoxSet,Season,Episode&SortBy=SortName&SortOrder=Ascending` +
          `&Fields=PrimaryImageAspectRatio,ProductionYear,UserData,SeriesName,ParentIndexNumber,IndexNumber,SeriesId&EnableImageTypes=Primary,Backdrop,Thumb&EnableTotalRecordCount=false`,
          { headers: getAuthHeaders() }
        ),
        fetch(
          `${session.serverUrl}/Persons?UserId=${selectedUser.Id}&IsFavorite=true&SortBy=SortName&SortOrder=Ascending&Fields=PrimaryImageAspectRatio&EnableTotalRecordCount=false`,
          { headers: getAuthHeaders() }
        ),
      ]);
      const content = contentRes.ok ? ((await contentRes.json()).Items || []) : [];
      const persons = personRes.ok  ? ((await personRes.json()).Items  || []).map(p => ({ ...p, Type: 'Person' })) : [];
      dlog('[OcenFin] favorites:', content.length, 'titles,', persons.length, 'persons');
      favoriteItems = [...content, ...persons];
    } catch (e) { dlog('[OcenFin] favorites error:', e?.message); }
    finally { isLoadingFavorites = false; }
    await tick();
    const card = favoritesGrid?.querySelector('button');
    if (card) card.focus(); else onFocusFallback?.();
  }

  // Loads on mount and whenever the parent reload key changes (e.g. after a favorite change in the details).
  let loadedKey = -1;
  $effect(() => {
    if (reloadKey !== loadedKey) { loadedKey = reloadKey; loadFavorites(); }
  });
</script>

<div class="p-10 pt-16 h-full overflow-y-auto hide-scrollbar">
  <div class="flex items-center gap-4 mb-10">
    <svg class="w-10 h-10 text-blue-400" fill="currentColor" viewBox="0 0 24 24"><path d="M11.645 20.91l-.007-.003-.022-.012a15.247 15.247 0 01-.383-.218 25.18 25.18 0 01-4.244-3.17C4.688 15.36 2.25 12.174 2.25 8.25 2.25 5.322 4.714 3 7.688 3A5.5 5.5 0 0112 5.052 5.5 5.5 0 0116.313 3c2.973 0 5.437 2.322 5.437 5.25 0 3.925-2.438 7.111-4.739 9.256a25.175 25.175 0 01-4.244 3.17 15.247 15.247 0 01-.383.219l-.022.012-.007.004-.003.001a.752.752 0 01-.704 0z"/></svg>
    <h1 class="text-4xl font-bold text-white">{i18n.t.favorites}</h1>
  </div>

  <!-- Empty state: no favorites yet — a friendly hint instead of a blank page -->
  {#if !isLoadingFavorites && favoriteItems.length === 0}
    <div class="flex flex-col items-center justify-center py-24 text-center">
      <svg class="w-16 h-16 text-gray-700 mb-4" fill="none" stroke="currentColor" stroke-width="1.5" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z"/></svg>
      <p class="text-xl text-gray-400 font-bold">{i18n.t.noFavorites}</p>
    </div>
  {/if}
  {#if isLoadingFavorites}
    <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6 pr-4">
      {#each Array(12).fill(0) as _}
        <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg animate-pulse"></div>
      {/each}
    </div>
  {:else if favoriteItems.length > 0}
    <div bind:this={favoritesGrid}>
      {#each favGroups as group (group.key)}
        {#if group.items.length > 0}
          <h2 class="text-3xl font-bold text-white mb-6 px-2">{group.label}</h2>
          <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6 pr-4 mb-12">
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
                <span class="text-sm font-bold text-gray-300 group-focus:text-white block truncate w-full mt-2">{item.Type === 'Season' ? (item.SeriesName || item.Name) : item.Name}</span>
                {#if item.Type === 'Season'}
                  <span class="text-xs text-gray-500 block truncate w-full">{item.Name}</span>
                {:else if item.ProductionYear}
                  <span class="text-xs text-gray-500 block truncate w-full">{item.ProductionYear}</span>
                {/if}
              </button>
            {/each}
          </div>
        {/if}
      {/each}

      {#if favEpisodes.length > 0}
        <h2 class="text-3xl font-bold text-white mb-6 px-2">{i18n.t.episodes}</h2>
        <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6 pr-4 mb-12">
          {#each favEpisodes as item (item.Id)}
            <button onclick={() => onOpenDetails(item)}
              {@attach longPress()} onlongpress={() => onContextMenu(item)}
              class="group focus:outline-none text-left scroll-my-4">
              <div class="aspect-video w-full bg-gray-800 rounded-lg overflow-hidden border-4 border-transparent group-focus:border-white group-focus:scale-105 transition-transform duration-200 shadow-xl relative">
                {#if getItemImageUrl(item, 'landscape')}
                  <img src={getItemImageUrl(item, 'landscape')} {@attach blurUp(itemBlurHash(item))} alt={item.Name} class="w-full h-full object-cover" loading="lazy" decoding="async"/>
                {/if}
                {#if itemProgress(item) > 0}
                  <div class="absolute bottom-0 left-0 w-full h-1.5 bg-gray-900/80">
                    <div class="h-full bg-blue-500" style="width:{itemProgress(item)}%"></div>
                  </div>
                {/if}
              </div>
              <span class="text-sm font-bold text-gray-300 group-focus:text-white block truncate w-full mt-2">{item.SeriesName || item.Name}</span>
              <span class="text-xs text-gray-500 block truncate w-full">{getItemSubtitle(item, i18n.t.today)}</span>
            </button>
          {/each}
        </div>
      {/if}

      {#if favPersons.length > 0}
        <h2 class="text-3xl font-bold text-white mb-6 px-2">{i18n.t.people}</h2>
        <div class="grid grid-cols-3 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-6 pr-4 mb-12">
          {#each favPersons as p (p.Id)}
            <button onclick={() => onOpenPerson(p)} class="group focus:outline-none text-center scroll-my-4">
              <div class="aspect-square w-full bg-gray-800 rounded-full overflow-hidden border-4 border-transparent group-focus:border-white group-focus:scale-105 transition-transform duration-200 shadow-xl">
                {#if personImageUrl(session.serverUrl, p)}
                  <img src={personImageUrl(session.serverUrl, p)} {@attach blurUp(itemBlurHash(p))} alt={p.Name} class="w-full h-full object-cover" loading="lazy" decoding="async"/>
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
      {/if}
    </div>
  {/if}
</div>
