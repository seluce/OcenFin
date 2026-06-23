<script>
  import { t } from '../i18n.js';
  import { itemProgress, itemBlurHash, blurUp, longPress, authHeaders, focusOnMount } from '../utils.js';
  import { session } from '../session.svelte.js';

  let {
    collection, selectedUser,
    onBack, onOpenDetails, onContextMenu,
    onChildCountChanged, onPlaylistRenamed, onPlaylistDeleted,
  } = $props();

  let items     = $state([]);
  let isLoading = $state(false);
  let name      = $state('');

  // Wiedergabelisten-Verwaltung
  let playlistEditMode     = $state(false);   // Bearbeiten-Modus (Entfernen/Umsortieren)
  let confirmDeletePlaylist = $state(false);
  let renamingPlaylist     = $state(false);
  let renameValue          = $state('');
  let renameError          = $state(false);

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

  // Beschriftung für eine Folge: "S1 · E5 · Titel"
  function episodeLabel(item) {
    const s = item.ParentIndexNumber, e = item.IndexNumber;
    const code = (s != null && e != null) ? `S${s} · E${e}` : (e != null ? `E${e}` : '');
    return [code, item.Name].filter(Boolean).join(' · ');
  }

  async function loadCollection() {
    name      = collection.Name;
    items     = [];
    isLoading = true;
    playlistEditMode = false; confirmDeletePlaylist = false; renamingPlaylist = false;
    // Wiedergabelisten über ihren eigenen Endpunkt (zuverlässig + in Listen-Reihenfolge),
    // Sammlungen/BoxSets über ParentId.
    const url = collection.Type === 'Playlist'
      ? `${session.serverUrl}/Playlists/${collection.Id}/Items?UserId=${selectedUser.Id}&Fields=PrimaryImageAspectRatio&Limit=300`
      : `${session.serverUrl}/Users/${selectedUser.Id}/Items?ParentId=${collection.Id}&SortBy=SortName&Fields=PrimaryImageAspectRatio&Limit=100`;
    try {
      const res = await fetch(url, { headers: getAuthHeaders() });
      if (res.ok) items = (await res.json()).Items || [];
    } catch { /* ignorieren */ }
    finally { isLoading = false; }
  }

  // Umsortieren: optimistisch lokal, dann serverseitig bestätigen.
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
    onChildCountChanged?.(collection.Id, items.length);   // Übersichts-Kachel (ChildCount) mitziehen
    try {
      const res = await fetch(`${session.serverUrl}/Playlists/${collection.Id}/Items?EntryIds=${item.PlaylistItemId}`,
        { method: 'DELETE', headers: getAuthHeaders() });
      if (!res.ok) console.warn('[OcenFin] remove failed', res.status);
    } catch (e) { console.warn('[OcenFin] remove error', e); }
  }

  // Ganze Wiedergabeliste löschen (Inline-Sicherheitsabfrage im Bearbeiten-Modus).
  async function deletePlaylist() {
    if (collection.Type !== 'Playlist') return;
    try {
      const res = await fetch(`${session.serverUrl}/Items/${collection.Id}`, { method: 'DELETE', headers: getAuthHeaders() });
      if (!res.ok) { console.warn('[OcenFin] playlist delete failed', res.status); return; }
    } catch (e) { console.warn('[OcenFin] playlist delete error', e); return; }
    confirmDeletePlaylist = false;
    playlistEditMode      = false;
    onPlaylistDeleted?.(collection.Id);   // App: aus Grid entfernen, Sidebar neu laden, Navigation
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
      // Playlist-eigener Update-Endpunkt: nutzt die Besitzrechte des Nutzers (kein Admin-Recht nötig).
      const res = await fetch(`${session.serverUrl}/Playlists/${collection.Id}`, {
        method: 'POST', headers: getAuthHeaders(), body: JSON.stringify({ Name: newName })
      });
      if (!res.ok) { console.warn('[OcenFin] rename failed', res.status); renameError = true; return; }
    } catch (e) { console.warn('[OcenFin] rename error', e); renameError = true; return; }
    name = newName;
    renamingPlaylist = false;
    onPlaylistRenamed?.(collection.Id, newName);   // App: Grid-Kachel + Sidebar aktualisieren
  }

  // Zurück-Taste: erst Edit-Zustände abwickeln, dann (false) → App navigiert zurück.
  export function handleBackKey() {
    if (renamingPlaylist)      { renamingPlaylist = false;      return true; }
    if (confirmDeletePlaylist) { confirmDeletePlaylist = false; return true; }
    if (playlistEditMode)      { playlistEditMode = false;      return true; }
    return false;
  }

  // Lädt beim Mounten und wenn eine andere Sammlung/Playlist geöffnet wird.
  let loadedId = null;
  $effect(() => {
    if (collection && collection.Id !== loadedId) { loadedId = collection.Id; loadCollection(); }
  });
</script>

<div class="p-10 pt-16 h-full overflow-y-auto hide-scrollbar">
  <div class="flex items-center gap-6 mb-8">
    <button onclick={onBack} {@attach focusOnMount()}
      class="bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 px-6 py-2 rounded-lg text-white font-bold focus:outline-none focus:ring-4 focus:ring-white">
      {$t.back}
    </button>
    {#if collection?.Type === 'Playlist'}
      <button onclick={() => { playlistEditMode = !playlistEditMode; confirmDeletePlaylist = false; renamingPlaylist = false; }}
        class="ml-auto px-6 py-2 rounded-lg font-bold focus:outline-none focus:ring-4 focus:ring-white transition-colors
               {playlistEditMode ? 'bg-blue-600 text-white' : 'bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 text-white'}">
        {playlistEditMode ? $t.done : $t.edit}
      </button>
    {/if}
  </div>
  <div class="flex items-center gap-4 mb-10">
    <svg class="w-10 h-10 text-blue-400" fill="currentColor" viewBox="0 0 24 24"><path d="M4 6h16v2H4zm2-4h12v2H6zm-4 8h20v10a2 2 0 01-2 2H4a2 2 0 01-2-2V10z"/></svg>
    <h1 class="text-4xl font-bold text-white">{name}</h1>
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
              {#if getItemImageUrl(item)}<img src={getItemImageUrl(item)} {@attach blurUp(itemBlurHash(item))} alt={item.Name} class="w-full h-full object-cover"/>{/if}
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
            <button onclick={() => movePlaylistItem(i, i - 1)} disabled={i === 0} title={$t.moveUp} aria-label={$t.moveUp}
              class="p-3 rounded-lg text-gray-300 hover:bg-gray-700 focus:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-white disabled:opacity-30 disabled:cursor-not-allowed">
              <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M5 15l7-7 7 7"/></svg>
            </button>
            <button onclick={() => movePlaylistItem(i, i + 1)} disabled={i === items.length - 1} title={$t.moveDown} aria-label={$t.moveDown}
              class="p-3 rounded-lg text-gray-300 hover:bg-gray-700 focus:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-white disabled:opacity-30 disabled:cursor-not-allowed">
              <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
            </button>
            <button onclick={() => removePlaylistItem(item)} title={$t.remove} aria-label={$t.remove}
              class="p-3 rounded-lg text-red-400 hover:bg-red-900/40 focus:bg-red-900/40 focus:outline-none focus:ring-2 focus:ring-red-500">
              <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 7h12M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-7 0v12a1 1 0 001 1h6a1 1 0 001-1V7"/></svg>
            </button>
          </div>
        {/each}
      {:else}
        <p class="text-gray-500 font-bold py-6 text-center">{$t.noItems}</p>
      {/if}

      <!-- Playlist verwalten: Umbenennen / Löschen (auch bei leerer Liste erreichbar) -->
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
                {$t.save}
              </button>
              <button onclick={() => renamingPlaylist = false}
                class="px-6 py-3 rounded-lg font-bold bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 text-white focus:outline-none focus:ring-4 focus:ring-white transition-colors">
                {$t.cancel}
              </button>
            </div>
            {#if renameError}
              <p class="text-red-400 text-sm font-semibold">{$t.actionFailed}</p>
            {/if}
          </div>
        {:else if confirmDeletePlaylist}
          <div class="flex items-center gap-4 flex-wrap">
            <span class="text-gray-200 font-semibold">{$t.deletePlaylistConfirm}</span>
            <button onclick={deletePlaylist}
              class="px-6 py-3 rounded-lg font-bold bg-red-600 hover:bg-red-500 focus:bg-red-500 text-white focus:outline-none focus:ring-4 focus:ring-white transition-colors">
              {$t.deletePlaylist}
            </button>
            <button onclick={() => confirmDeletePlaylist = false} {@attach focusOnMount()}
              class="px-6 py-3 rounded-lg font-bold bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 text-white focus:outline-none focus:ring-4 focus:ring-white transition-colors">
              {$t.cancel}
            </button>
          </div>
        {:else}
          <div class="flex items-center gap-3 flex-wrap">
            <button onclick={startRename}
              class="flex items-center gap-3 px-6 py-3 rounded-lg font-bold bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 text-white focus:outline-none focus:ring-4 focus:ring-white transition-colors">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
              {$t.renamePlaylist}
            </button>
            <button onclick={() => confirmDeletePlaylist = true}
              class="flex items-center gap-3 px-6 py-3 rounded-lg font-bold bg-red-900/40 hover:bg-red-900/60 focus:bg-red-900/60 text-red-300 hover:text-white focus:text-white focus:outline-none focus:ring-4 focus:ring-red-500 transition-colors">
              <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 7h12M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-7 0v12a1 1 0 001 1h6a1 1 0 001-1V7"/></svg>
              {$t.deletePlaylist}
            </button>
          </div>
        {/if}
      </div>
    </div>
  {:else if items.length > 0}
    {@const groups = [
      { label: $t.movies,   items: items.filter(i => i.Type === 'Movie') },
      { label: $t.series,   items: items.filter(i => i.Type === 'Series') },
      { label: $t.episodes, items: items.filter(i => i.Type === 'Episode') },
      { label: '',          items: items.filter(i => !['Movie', 'Series', 'Episode'].includes(i.Type)) }
    ].filter(g => g.items.length)}
    <div class="flex flex-col gap-10 pr-4">
      {#each groups as group}
        <div>
          {#if groups.length > 1 && group.label}
            <h2 class="text-2xl font-bold text-gray-400 mb-4">{group.label}</h2>
          {/if}
          <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6">
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
      <p class="text-2xl text-gray-500 font-bold">{$t.noItems}</p>
    </div>
  {/if}
</div>
