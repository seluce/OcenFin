<script>
  // Gemeinsamer Dialog: Titel zu einer Sammlung oder Wiedergabeliste hinzufügen.
  // Wird von Details und Player verwendet. Steuerung über die Prop `mode`
  // (null = geschlossen). Schließen meldet sich per 'close'-Event beim Eltern.
  import { t } from '../i18n.js';
  import { isBackKey, focusOnMount, dlog } from '../utils.js';
  import { createEventDispatcher } from 'svelte';

  export let mode = null;          // null | 'collection' | 'playlist'
  export let item = null;          // hinzuzufügender Titel
  export let serverUrl;
  export let selectedUser;
  export let getAuthHeaders;       // Funktion, liefert die Auth-Header

  const dispatch = createEventDispatcher();

  let items     = [];              // vorhandene Sammlungen/Wiedergabelisten
  let loading   = false;
  let newName   = '';
  let busy      = false;
  let msg       = '';
  let msgError  = false;       // true → Meldung als Fehler (rot) darstellen, sonst Erfolg (grün)
  let alreadyIn = new Set();       // Ziel-IDs, in denen der Titel schon ist (keine Duplikate)
  let childrenOf = {};             // Ziel-ID → enthaltene Titel (für Vorschau)

  // Bei jedem Öffnen frisch laden (Eltern setzt mode von null auf einen Wert)
  $: if (mode) loadList(mode);

  async function loadList(m) {
    items = []; newName = ''; msg = ''; msgError = false; loading = true; alreadyIn = new Set(); childrenOf = {};
    const type = m === 'collection' ? 'BoxSet' : 'Playlist';
    try {
      const res = await fetch(
        `${serverUrl}/Users/${selectedUser.Id}/Items?Recursive=true&IncludeItemTypes=${type}&SortBy=SortName&SortOrder=Ascending`,
        { headers: getAuthHeaders() }
      );
      if (res.ok) items = (await res.json()).Items || [];
    } catch { }
    // Inhalte jedes Ziels holen → Mitgliedschaft (keine Duplikate) + Vorschau, was drin ist
    await Promise.all(items.map(async (target) => {
      try {
        const url = m === 'collection'
          ? `${serverUrl}/Users/${selectedUser.Id}/Items?ParentId=${target.Id}&Fields=&Limit=300`
          : `${serverUrl}/Playlists/${target.Id}/Items?UserId=${selectedUser.Id}&Limit=300`;
        const r = await fetch(url, { headers: getAuthHeaders() });
        if (r.ok) {
          const kids = (await r.json()).Items || [];
          childrenOf[target.Id] = kids;
          if (item && kids.some(k => k.Id === item.Id)) alreadyIn.add(target.Id);
        }
      } catch { }
    }));
    childrenOf = childrenOf; alreadyIn = alreadyIn;   // Svelte-Reaktivität anstoßen
    loading = false;
  }

  function close() { dispatch('close'); }

  async function addTo(target) {
    if (!item || busy || alreadyIn.has(target.Id)) return;   // keine Duplikate
    busy = true;
    const url = mode === 'collection'
      ? `${serverUrl}/Collections/${target.Id}/Items?Ids=${item.Id}`
      : `${serverUrl}/Playlists/${target.Id}/Items?Ids=${item.Id}&UserId=${selectedUser.Id}`;
    try {
      const res = await fetch(url, { method: 'POST', headers: getAuthHeaders() });
      if (res.ok) {
        msg = `${$t.added}: ${target.Name}`; msgError = false;
        alreadyIn.add(target.Id); alreadyIn = alreadyIn;
        childrenOf[target.Id] = [...(childrenOf[target.Id] || []), { Id: item.Id, Name: item.Name }];
        childrenOf = childrenOf;
      } else {
        console.warn('[OcenFin] Hinzufügen fehlgeschlagen', mode, res.status, await res.text().catch(() => ''));
        msg = (mode === 'collection' && res.status === 403) ? $t.collectionPermissionDenied : $t.actionFailed; msgError = true;
      }
    } catch (e) { console.warn('[OcenFin] Hinzufügen-Fehler', mode, e); msg = $t.actionFailed; msgError = true; }
    busy = false;
  }

  async function createNew() {
    const name = newName.trim();
    if (!name || !item || busy) return;
    busy = true;
    const url = mode === 'collection'
      ? `${serverUrl}/Collections?Name=${encodeURIComponent(name)}&Ids=${item.Id}`
      : `${serverUrl}/Playlists?Name=${encodeURIComponent(name)}&Ids=${item.Id}&UserId=${selectedUser.Id}`;
    try {
      const res = await fetch(url, { method: 'POST', headers: getAuthHeaders() });
      if (res.ok) {
        msg = `${$t.created}: ${name}`; msgError = false;
        const created = await res.json().catch(() => null);
        const newTarget = { Id: created?.Id, Name: name };
        items = [newTarget, ...items];
        if (created?.Id) {
          alreadyIn.add(created.Id); alreadyIn = alreadyIn;
          childrenOf[created.Id] = [{ Id: item.Id, Name: item.Name }]; childrenOf = childrenOf;
        }
        newName = '';
        dispatch('created');   // Eltern können Mediatheken/Sidebar auffrischen
      } else {
        console.warn('[OcenFin] Erstellen fehlgeschlagen', mode, res.status, await res.text().catch(() => ''));
        msg = (mode === 'collection' && res.status === 403) ? $t.collectionPermissionDenied : $t.actionFailed; msgError = true;
      }
    } catch (e) { console.warn('[OcenFin] Erstellen-Fehler', mode, e); msg = $t.actionFailed; msgError = true; }
    busy = false;
  }

  function onKeydown(e) { if (isBackKey(e)) { e.stopPropagation(); close(); } }
</script>

{#if mode}
  <div data-focus-trap class="fixed inset-0 bg-black/90 z-[200] flex items-center justify-center p-8 animate-fade-in"
    on:keydown={onKeydown}>
    <div class="bg-gray-800 border border-gray-700 rounded-2xl w-full max-w-xl max-h-[85vh] overflow-y-auto hide-scrollbar shadow-2xl p-8 flex flex-col gap-5">
      <div class="flex justify-between items-center">
        <h2 class="text-3xl text-white font-bold">{mode === 'collection' ? $t.addToCollection : $t.addToPlaylist}</h2>
        <button on:click={close} use:focusOnMount
          class="text-gray-400 hover:text-white focus:text-white focus:outline-none focus:ring-4 focus:ring-white rounded-full p-2">
          <svg class="w-7 h-7" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>

      {#if msg}
        <div class="border rounded-lg px-4 py-3 font-semibold
          {msgError ? 'bg-red-600/20 border-red-600/40 text-red-300' : 'bg-green-600/20 border-green-600/40 text-green-300'}">{msg}</div>
      {/if}

      <!-- Neu erstellen -->
      <div class="flex gap-2">
        <input bind:value={newName} placeholder={$t.createNew}
          class="flex-1 bg-gray-900 text-white text-lg px-4 py-3 rounded-lg border border-gray-600 focus:outline-none focus:ring-2 focus:ring-white placeholder-gray-500"/>
        <button on:click={createNew} disabled={!newName.trim() || busy}
          class="bg-blue-600 hover:bg-blue-500 focus:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold px-6 py-3 rounded-lg focus:outline-none focus:ring-4 focus:ring-white transition-colors">
          {$t.create}
        </button>
      </div>

      <!-- Vorhandene -->
      {#if loading}
        <div class="text-gray-400 py-4 text-center">…</div>
      {:else if items.length}
        <div class="flex flex-col gap-1">
          {#each items as target (target.Id)}
            {@const has = alreadyIn.has(target.Id)}
            <button on:click={() => addTo(target)} disabled={busy || has}
              class="text-left px-4 py-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-white flex items-start gap-3
                     {has ? 'opacity-70 cursor-not-allowed' : 'text-gray-200 hover:bg-gray-700 focus:bg-gray-700'}">
              <svg class="w-5 h-5 shrink-0 mt-1 {has ? 'text-green-500' : 'text-gray-500'}" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                {#if has}<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>{:else}<path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>{/if}
              </svg>
              <div class="flex-1 min-w-0">
                <div class="text-lg truncate {has ? 'text-gray-300' : ''}">{target.Name}</div>
                {#if childrenOf[target.Id]?.length}
                  <div class="text-sm text-gray-500 truncate">{childrenOf[target.Id].map(c => c.Name).join(', ')}</div>
                {/if}
                {#if has}<div class="text-sm text-green-400">{$t.alreadyAdded}</div>{/if}
              </div>
            </button>
          {/each}
        </div>
      {:else}
        <div class="text-gray-500 py-2">{$t.noItems}</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .hide-scrollbar::-webkit-scrollbar { display: none; }
  .hide-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
</style>
