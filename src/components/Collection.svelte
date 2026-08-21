<script>
  import { i18n } from '../i18n.svelte.js';
  import { itemProgress, itemBadge, itemBlurHash, blurUp, longPress, authHeaders, focusOnMount, getItemImageUrl } from '../utils.js';
  import { buildPlayQueue } from '../playback.js';
  import { session } from '../session.svelte.js';

  let {
    collection, selectedUser,
    onBack, onOpenDetails, onContextMenu, onPlayVideo, onPlayQueue,
    onChildCountChanged, onPlaylistRenamed, onPlaylistDeleted,
  } = $props();

  let items     = $state([]);
  let isLoading = $state(false);
  let name      = $state('');

  // Playlist management
  let playlistEditMode     = $state(false);   // edit mode (remove/reorder)
  let confirmDeletePlaylist = $state(false);
  let renamingPlaylist     = $state(false);
  let renameValue          = $state('');
  let renameError          = $state(false);

  const getAuthHeaders = () => authHeaders(session.token);

  // Random playback from a collection/playlist — counterpart to the series shuffle in the details.
  // Movies/episodes play directly. If the pick lands on a series/season (normal in BoxSets),
  // a random episode is drawn from it (specials/season 0 excluded), because a
  // series itself isn't playable. Uniformly distributed, incl. already watched (comfort rewatch).
  async function playRandom() {
    if (!items.length) return;
    const pick = items[Math.floor(Math.random() * items.length)];
    if (pick.Type === 'Series' || pick.Type === 'Season') {
      try {
        const url = `${session.serverUrl}/Users/${selectedUser.Id}/Items?ParentId=${pick.Id}`
          + `&IncludeItemTypes=Episode${pick.Type === 'Series' ? '&Recursive=true' : ''}&EnableTotalRecordCount=false`;
        const res  = await fetch(url, { headers: getAuthHeaders() });
        const data = await res.json();
        let pool = (data.Items || []).filter(e => e.Type === 'Episode');
        if (pick.Type === 'Series') pool = pool.filter(e => e.ParentIndexNumber !== 0);
        if (!pool.length) return;
        onPlayVideo?.({ item: pool[Math.floor(Math.random() * pool.length)], audioIndex: -1, subtitleIndex: -1 });
      } catch (e) { console.error(e); }
    } else {
      onPlayVideo?.({ item: pick, audioIndex: -1, subtitleIndex: -1 });
    }
  }

  // "Play all": resolve the elements in list order into a flat queue.
  // Series/seasons are expanded into their episodes (without specials, in season/episode
  // order) — the same resolution as the random button, just ordered instead of drawn.
  // Playback with advancing is handled by App (playQueue) + Player (queueNext).
  let buildingQueue = $state(false);   // spinner in the button while series are being resolved
  async function playAll() {
    if (!items.length || buildingQueue) return;
    buildingQueue = true;
    let queue = [];
    try { queue = await buildPlayQueue(items, { serverUrl: session.serverUrl, userId: selectedUser.Id, headers: getAuthHeaders() }); }
    finally { buildingQueue = false; }
    if (queue.length) onPlayQueue?.(queue);
  }

  // Label for an episode: "S1 · E5 · Title"
  function episodeLabel(item) {
    const s = item.ParentIndexNumber, e = item.IndexNumber;
    const code = (s != null && e != null) ? `S${s} · E${e}` : (e != null ? `E${e}` : '');
    return [code, item.Name].filter(Boolean).join(' · ');
  }

  async function loadCollection() {
    // Guard against a superseded load: opening a second collection while the first is still
    // fetching would otherwise show the slower response's items under the newer title.
    // loadedId is set synchronously before this call. Same guard as in Details/Library/Search.
    const myId = collection.Id;
    name      = collection.Name;
    items     = [];
    isLoading = true;
    playlistEditMode = false; confirmDeletePlaylist = false; renamingPlaylist = false;
    // Playlists via their own endpoint (reliable + in list order),
    // collections/BoxSets via ParentId.
    const url = collection.Type === 'Playlist'
      ? `${session.serverUrl}/Playlists/${collection.Id}/Items?UserId=${selectedUser.Id}&Fields=PrimaryImageAspectRatio&Limit=300&EnableTotalRecordCount=false`
      : `${session.serverUrl}/Users/${selectedUser.Id}/Items?ParentId=${collection.Id}&SortBy=SortName&Fields=PrimaryImageAspectRatio&Limit=100&EnableTotalRecordCount=false`;
    try {
      const res = await fetch(url, { headers: getAuthHeaders() });
      const loaded = res.ok ? ((await res.json()).Items || []) : null;
      if (myId !== loadedId) return;   // superseded by a newer collection
      if (loaded) items = loaded;
    } catch { /* ignore */ }
    finally { if (myId === loadedId) isLoading = false; }
  }

  // Reorder: optimistically local, then confirm server-side.
  async function movePlaylistItem(fromIndex, toIndex) {
    if (toIndex < 0 || toIndex >= items.length) return;
    const item = items[fromIndex];
    if (!item?.PlaylistItemId) return;
    const arr = [...items];
    const [moved] = arr.splice(fromIndex, 1);
    arr.splice(toIndex, 0, moved);
    items = arr;
    try {
      const res = await fetch(`${session.serverUrl}/Playlists/${collection.Id}/Items/${item.PlaylistItemId}/Move/${toIndex}`,
        { method: 'POST', headers: getAuthHeaders() });
      if (!res.ok) console.warn('[OcenFin] move failed', res.status);
    } catch (e) { console.warn('[OcenFin] move error', e); }
  }

  async function removePlaylistItem(item) {
    if (!item?.PlaylistItemId) return;
    items = items.filter(i => i.PlaylistItemId !== item.PlaylistItemId);
    onChildCountChanged?.(collection.Id, items.length);   // carry the overview tile (ChildCount) along
    try {
      const res = await fetch(`${session.serverUrl}/Playlists/${collection.Id}/Items?EntryIds=${item.PlaylistItemId}`,
        { method: 'DELETE', headers: getAuthHeaders() });
      if (!res.ok) console.warn('[OcenFin] remove failed', res.status);
    } catch (e) { console.warn('[OcenFin] remove error', e); }
  }

  // Delete the whole playlist (inline confirmation in edit mode).
  async function deletePlaylist() {
    if (collection.Type !== 'Playlist') return;
    try {
      const res = await fetch(`${session.serverUrl}/Items/${collection.Id}`, { method: 'DELETE', headers: getAuthHeaders() });
      if (!res.ok) { console.warn('[OcenFin] playlist delete failed', res.status); return; }
    } catch (e) { console.warn('[OcenFin] playlist delete error', e); return; }
    confirmDeletePlaylist = false;
    playlistEditMode      = false;
    onPlaylistDeleted?.(collection.Id);   // App: remove from the grid, reload the sidebar, navigation
  }

  function startRename() {
    renameValue           = name;
    confirmDeletePlaylist = false;
    renameError           = false;
    renamingPlaylist      = true;
  }
  async function savePlaylistName() {
    const newName = renameValue.trim();
    if (!newName) { renameError = true; return; }
    if (newName === name) { renamingPlaylist = false; return; }
    renameError = false;
    try {
      // Playlist's own update endpoint: uses the user's ownership rights (no admin right needed).
      const res = await fetch(`${session.serverUrl}/Playlists/${collection.Id}`, {
        method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ Name: newName })
      });
      if (!res.ok) { console.warn('[OcenFin] rename failed', res.status); renameError = true; return; }
    } catch (e) { console.warn('[OcenFin] rename error', e); renameError = true; return; }
    name = newName;
    renamingPlaylist = false;
    onPlaylistRenamed?.(collection.Id, newName);   // App: update the grid tile + sidebar
  }

  // Back key: first unwind the edit states, then (false) → App navigates back.
  export function handleBackKey() {
    if (renamingPlaylist)      { renamingPlaylist = false;      return true; }
    if (confirmDeletePlaylist) { confirmDeletePlaylist = false; return true; }
    if (playlistEditMode)      { playlistEditMode = false;      return true; }
    return false;
  }

  // Loads on mount and when a different collection/playlist is opened.
  let loadedId = null;
  $effect(() => {
    if (collection && collection.Id !== loadedId) { loadedId = collection.Id; loadCollection(); }
  });
</script>

<div class="p-10 pt-16 h-full overflow-y-auto hide-scrollbar">
  <div class="flex items-center gap-6 mb-8">
    <button onclick={onBack} {@attach focusOnMount()}
      class="bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 px-6 py-2 rounded-lg text-white font-bold focus:outline-none focus:ring-4 focus:ring-white">
      {i18n.t.back}
    </button>
  </div>
  <!-- Title row: the name is truncated with "…" when too long (min-w-0 + truncate), icon and
       buttons are shrink-0 — so Random/Edit ALWAYS stay visible, no matter how long
       the playlist/collection name is (otherwise they'd be pushed out of view). -->
  <div class="flex items-center gap-4 mb-10">
    <svg class="w-10 h-10 shrink-0 text-blue-400" fill="currentColor" viewBox="0 0 24 24"><path d="M4 6h16v2H4zm2-4h12v2H6zm-4 8h20v10a2 2 0 01-2 2H4a2 2 0 01-2-2V10z"/></svg>
    <h1 class="text-4xl font-bold text-white min-w-0 truncate">{name === 'Watchlist' ? i18n.t.watchlist : name}</h1>
    {#if items.length > 0 && !playlistEditMode}
      <button onclick={playAll}
        class="ml-4 shrink-0 bg-blue-600 hover:bg-blue-500 focus:bg-blue-500 text-white font-bold px-6 py-3 rounded-xl
               focus:outline-none focus:ring-4 focus:ring-white transition-colors flex items-center gap-2">
        {#if buildingQueue}
          <div class="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
        {:else}
          <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
        {/if}
        {i18n.t.playAll}
      </button>
      <button onclick={playRandom}
        class="shrink-0 bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 text-white font-bold px-6 py-3 rounded-xl
               focus:outline-none focus:ring-4 focus:ring-blue-500 transition-colors flex items-center gap-2">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
          <polyline points="16 3 21 3 21 8"/>
          <line x1="4" y1="20" x2="21" y2="3"/>
          <polyline points="21 16 21 21 16 21"/>
          <line x1="15" y1="15" x2="21" y2="21"/>
          <line x1="4" y1="4" x2="9" y2="9"/>
        </svg>
        {i18n.t.shuffle}
      </button>
    {/if}
    {#if collection?.Type === 'Playlist'}
      <button onclick={() => { playlistEditMode = !playlistEditMode; confirmDeletePlaylist = false; renamingPlaylist = false; }}
        class="shrink-0 px-6 py-3 rounded-xl font-bold focus:outline-none focus:ring-4 focus:ring-white transition-colors
               {playlistEditMode ? 'bg-blue-600 text-white' : 'bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 text-white'}">
        {playlistEditMode ? i18n.t.done : i18n.t.edit}
      </button>
    {/if}
  </div>

  {#if isLoading}
    <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6 pr-4">
      {#each Array(12).fill(0) as _}
        <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg animate-pulse"></div>
      {/each}
    </div>
  {:else if playlistEditMode}
    <div class="flex flex-col gap-2 pr-4 max-w-4xl">
      {#if items.length > 0}
        {#each items as item, i (item.PlaylistItemId)}
          <div class="flex items-center gap-4 bg-gray-800/60 rounded-xl p-3">
            <div class="w-14 h-20 shrink-0 bg-gray-900 rounded-lg overflow-hidden">
              {#if getItemImageUrl(item)}<img src={getItemImageUrl(item)} {@attach blurUp(itemBlurHash(item))} alt={item.Name} class="w-full h-full object-cover" loading="lazy" decoding="async"/>{/if}
            </div>
            <div class="flex-1 min-w-0">
              {#if item.Type === 'Episode'}
                <div class="text-lg font-bold text-white truncate">{item.SeriesName || item.Name}</div>
                <div class="text-sm text-gray-400 truncate">{episodeLabel(item)}</div>
              {:else}
                <div class="text-lg font-bold text-white truncate">{item.Name}</div>
                {#if item.ProductionYear}<div class="text-sm text-gray-400">{item.ProductionYear}</div>{/if}
              {/if}
            </div>
            <button onclick={() => movePlaylistItem(i, i - 1)} disabled={i === 0} title={i18n.t.moveUp} aria-label={i18n.t.moveUp}
              class="p-3 rounded-lg text-gray-300 hover:bg-gray-700 focus:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-white disabled:opacity-30 disabled:cursor-not-allowed">
              <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7"/></svg>
            </button>
            <button onclick={() => movePlaylistItem(i, i + 1)} disabled={i === items.length - 1} title={i18n.t.moveDown} aria-label={i18n.t.moveDown}
              class="p-3 rounded-lg text-gray-300 hover:bg-gray-700 focus:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-white disabled:opacity-30 disabled:cursor-not-allowed">
              <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
            </button>
            <button onclick={() => removePlaylistItem(item)} title={i18n.t.remove} aria-label={i18n.t.remove}
              class="p-3 rounded-lg text-red-400 hover:bg-red-900/40 focus:bg-red-900/40 focus:outline-none focus:ring-2 focus:ring-red-500">
              <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 7h12M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-7 0v12a1 1 0 001 1h6a1 1 0 001-1V7"/></svg>
            </button>
          </div>
        {/each}
      {:else}
        <p class="text-gray-500 font-bold py-6 text-center">{i18n.t.noItems}</p>
      {/if}

      <!-- Manage playlist: rename / delete (reachable even with an empty list) -->
      <div class="mt-4 border-t border-gray-700/70 pt-4">
        {#if renamingPlaylist}
          <div class="flex flex-col gap-2">
            <div class="flex items-center gap-3 flex-wrap">
              <input
                bind:value={renameValue}
                {@attach focusOnMount()}
                maxlength="100"
                oninput={() => renameError = false}
                onkeydown={(e) => { if (e.key === 'Enter') savePlaylistName(); }}
                class="flex-1 min-w-[220px] bg-gray-900 text-white text-lg px-4 py-3 rounded-lg border border-gray-600
                       focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
              <button onclick={savePlaylistName}
                class="px-6 py-3 rounded-lg font-bold bg-blue-600 hover:bg-blue-500 focus:bg-blue-500 text-white focus:outline-none focus:ring-4 focus:ring-white transition-colors">
                {i18n.t.save}
              </button>
              <button onclick={() => renamingPlaylist = false}
                class="px-6 py-3 rounded-lg font-bold bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 text-white focus:outline-none focus:ring-4 focus:ring-white transition-colors">
                {i18n.t.cancel}
              </button>
            </div>
            {#if renameError}
              <p class="text-red-400 text-sm font-semibold">{i18n.t.actionFailed}</p>
            {/if}
          </div>
        {:else if confirmDeletePlaylist}
          <div class="flex items-center gap-4 flex-wrap">
            <span class="text-gray-200 font-semibold">{i18n.t.deletePlaylistConfirm}</span>
            <button onclick={deletePlaylist}
              class="px-6 py-3 rounded-lg font-bold bg-red-600 hover:bg-red-500 focus:bg-red-500 text-white focus:outline-none focus:ring-4 focus:ring-white transition-colors">
              {i18n.t.deletePlaylist}
            </button>
            <button onclick={() => confirmDeletePlaylist = false} {@attach focusOnMount()}
              class="px-6 py-3 rounded-lg font-bold bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 text-white focus:outline-none focus:ring-4 focus:ring-white transition-colors">
              {i18n.t.cancel}
            </button>
          </div>
        {:else}
          <div class="flex items-center gap-3 flex-wrap">
            <button onclick={startRename}
              class="flex items-center gap-3 px-6 py-3 rounded-lg font-bold bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 text-white focus:outline-none focus:ring-4 focus:ring-white transition-colors">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
              {i18n.t.renamePlaylist}
            </button>
            <button onclick={() => confirmDeletePlaylist = true}
              class="flex items-center gap-3 px-6 py-3 rounded-lg font-bold bg-red-900/40 hover:bg-red-900/60 focus:bg-red-900/60 text-red-300 hover:text-white focus:text-white focus:outline-none focus:ring-4 focus:ring-red-500 transition-colors">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 7h12M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-7 0v12a1 1 0 001 1h6a1 1 0 001-1V7"/></svg>
              {i18n.t.deletePlaylist}
            </button>
          </div>
        {/if}
      </div>
    </div>
  {:else if items.length > 0}
    {@const groups = [
      { label: i18n.t.movies,   items: items.filter(i => i.Type === 'Movie') },
      { label: i18n.t.series,   items: items.filter(i => i.Type === 'Series') },
      { label: i18n.t.episodes, items: items.filter(i => i.Type === 'Episode') },
      { label: '',          items: items.filter(i => !['Movie', 'Series', 'Episode'].includes(i.Type)) }
    ].filter(g => g.items.length)}
    <div class="flex flex-col gap-10 pr-4">
      {#each groups as group (group.label)}
        <div>
          {#if group.label}
            <h2 class="text-3xl font-bold text-white mb-6 px-2">{group.label}</h2>
          {/if}
          <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
            {#each group.items as item (item.PlaylistItemId ?? item.Id)}
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
                {#if item.Type === 'Episode'}
                  <span class="text-sm font-bold text-gray-300 group-focus:text-white block truncate w-full mt-2">{item.SeriesName || item.Name}</span>
                  <span class="text-xs text-gray-500 block truncate w-full">{episodeLabel(item)}</span>
                {:else}
                  <span class="text-sm font-bold text-gray-300 group-focus:text-white block truncate w-full mt-2">{item.Name}</span>
                  {#if item.ProductionYear}<span class="text-xs text-gray-500 block truncate w-full">{item.ProductionYear}</span>{/if}
                {/if}
              </button>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <div class="flex items-center justify-center h-64">
      <p class="text-2xl text-gray-500 font-bold">{i18n.t.noItems}</p>
    </div>
  {/if}
</div>
