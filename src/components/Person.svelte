<script>
  import { i18n } from '../i18n.svelte.js';
  import { itemProgress, itemBlurHash, blurUp, longPress, authHeaders, focusOnMount } from '../utils.js';
  import { session } from '../session.svelte.js';

  let { person, selectedUser, onBack, onOpenDetails, onContextMenu } = $props();

  let fav       = $state(false);
  let items     = $state([]);
  let isLoading = $state(false);

  // Filmografie nach Typ gruppieren (nur Filme / Serien). Folgen werden bewusst weggelassen –
  // wer in Serie X mitspielt, taucht sonst in dutzenden Folgen auf und überlagert alles.
  let groups = $derived([
    { label: i18n.t.movies, items: items.filter(i => i.Type === 'Movie') },
    { label: i18n.t.series, items: items.filter(i => i.Type === 'Series') },
  ].filter(g => g.items.length > 0));

  const getAuthHeaders = () => authHeaders(session.token);

  // Eigener Bild-Helfer (Apps Variante): Portrait 2:3.
  function getItemImageUrl(item, format = 'portrait') {
    if (format === 'landscape') {
      if (item.ImageTags?.Primary)
        return `${session.serverUrl}/Items/${item.Id}/Images/Primary?tag=${item.ImageTags.Primary}&maxWidth=600&quality=80&format=webp`;
      if (item.SeriesId && item.SeriesThumbImageTag)
        return `${session.serverUrl}/Items/${item.SeriesId}/Images/Thumb?tag=${item.SeriesThumbImageTag}&maxWidth=600&quality=80&format=webp`;
      return null;
    }
    if (item.ImageTags?.Primary)
      return `${session.serverUrl}/Items/${item.Id}/Images/Primary?tag=${item.ImageTags.Primary}&fillHeight=400&fillWidth=266&quality=80&format=webp`;
    return null;
  }

  async function loadPerson() {
    fav       = !!person.UserData?.IsFavorite;
    items     = [];
    isLoading = true;
    // Person-Item separat holen → korrekter Favoritenstatus (aus Suche/Besetzung fehlt UserData oft)
    fetch(`${session.serverUrl}/Users/${selectedUser.Id}/Items/${person.Id}`, { headers: getAuthHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(p => { if (p) fav = !!p.UserData?.IsFavorite; })
      .catch(() => {});
    try {
      const res = await fetch(
        `${session.serverUrl}/Users/${selectedUser.Id}/Items?PersonIds=${person.Id}` +
        `&Recursive=true&IncludeItemTypes=Movie,Series&SortBy=PremiereDate&SortOrder=Descending` +
        `&Limit=100&Fields=PrimaryImageAspectRatio,SeriesName`,
        { headers: getAuthHeaders() }
      );
      if (res.ok) items = (await res.json()).Items || [];
    } catch { /* ignorieren */ }
    finally { isLoading = false; }
  }

  // Person als Favorit setzen/entfernen (optimistisch; bei Fehler zurückrollen)
  async function toggleFavorite() {
    const next = !fav;
    fav = next;
    try {
      await fetch(`${session.serverUrl}/Users/${selectedUser.Id}/FavoriteItems/${person.Id}`,
        { method: next ? 'POST' : 'DELETE', headers: getAuthHeaders() });
    } catch (e) { console.warn('[OcenFin] person favorite failed, rolled back:', e); fav = !next; }
  }

  // Lädt beim Mounten und wenn eine andere Person geöffnet wird.
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
    <svg class="w-10 h-10 text-blue-400" fill="currentColor" viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
    <div>
      <h1 class="text-4xl font-bold text-white">{person?.Name}</h1>
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
    {#each groups as group}
      <h2 class="text-2xl font-bold text-white mb-4 mt-2">{group.label}</h2>
      <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6 pr-4 mb-10">
        {#each group.items as item}
          <button onclick={() => onOpenDetails(item)}
            {@attach longPress()} onlongpress={() => onContextMenu(item)}
            class="group focus:outline-none text-left cv-auto">
            <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg overflow-hidden border-4 border-transparent group-focus:border-white shadow-xl relative">
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
            {#if item.Type === 'Episode'}
              <span class="text-xs text-gray-500 block truncate w-full">{item.Name}</span>
            {:else if item.ProductionYear}
              <span class="text-xs text-gray-500 block truncate w-full">{item.ProductionYear}</span>
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
