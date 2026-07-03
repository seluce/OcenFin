<script>
  // Gemeinsamer Dialog: Titel zu einer Sammlung oder Wiedergabeliste hinzufügen.
  // Wird von Details und Player verwendet. Steuerung über die Prop `mode`
  // (null = geschlossen). Schließen meldet sich per 'close'-Event beim Eltern.
  import { i18n } from '../i18n.svelte.js';
  import { isBackKey, focusOnMount, dlog, uiFade, dropTrapOnOutro } from '../utils.js';
  import { session } from '../session.svelte.js';
  import { SvelteSet } from 'svelte/reactivity';

  let { mode = null, item = null, selectedUser, getAuthHeaders, onCreated, onClose } = $props();

  let items     = $state([]);              // vorhandene Sammlungen/Wiedergabelisten
  let loading   = $state(false);
  let newName   = $state('');
  let busy      = $state(false);
  let msg       = $state('');
  let msgError  = $state(false);       // true → Meldung als Fehler (rot) darstellen, sonst Erfolg (grün)
  let alreadyIn = new SvelteSet();         // reaktives Set: .add()/.clear() lösen Updates aus
  let childrenOf = $state({});             // Ziel-ID → enthaltene Titel (Deep Reactivity)

  // Bei jedem Öffnen frisch laden (Eltern setzt mode von null auf einen Wert)
  $effect(() => { if (mode) loadList(mode); });

  // Stale-Guard (Muster wie in Suche/Details): Schnelles Schließen + Wiederöffnen des Dialogs
  // kann zwei loadList-Läufe überlappen — nur der jüngste darf Liste/Spinner schreiben.
  let loadListToken = 0;

  async function loadList(m) {
    const myToken = ++loadListToken;
    items = []; newName = ''; msg = ''; msgError = false; loading = true; alreadyIn.clear(); childrenOf = {};
    const type = m === 'collection' ? 'BoxSet' : 'Playlist';
    try {
      const res = await fetch(
        `${session.serverUrl}/Users/${selectedUser.Id}/Items?Recursive=true&IncludeItemTypes=${type}&SortBy=SortName&SortOrder=Ascending&EnableTotalRecordCount=false`,
        { headers: getAuthHeaders() }
      );
      if (res.ok) { const d = await res.json(); if (myToken !== loadListToken) return; items = d.Items || []; }
    } catch { }
    if (myToken !== loadListToken) return;
    // Inhalte jedes Ziels holen → Mitgliedschaft (keine Duplikate) + Vorschau, was drin ist
    await Promise.all(items.map(async (target) => {
      try {
        const url = m === 'collection'
          ? `${session.serverUrl}/Users/${selectedUser.Id}/Items?ParentId=${target.Id}&Fields=&Limit=300&EnableTotalRecordCount=false`
          : `${session.serverUrl}/Playlists/${target.Id}/Items?UserId=${selectedUser.Id}&Limit=300`;
        const r = await fetch(url, { headers: getAuthHeaders() });
        if (r.ok) {
          const kids = (await r.json()).Items || [];
          childrenOf[target.Id] = kids;
          if (item && kids.some(k => k.Id === item.Id)) alreadyIn.add(target.Id);
        }
      } catch { }
    }));
    if (myToken === loadListToken) loading = false;
  }

  function close() { onClose?.(); }

  async function addTo(target) {
    if (!item || busy || alreadyIn.has(target.Id)) return;   // keine Duplikate
    busy = true;
    const url = mode === 'collection'
      ? `${session.serverUrl}/Collections/${target.Id}/Items?Ids=${item.Id}`
      : `${session.serverUrl}/Playlists/${target.Id}/Items?Ids=${item.Id}&UserId=${selectedUser.Id}`;
    try {
      const res = await fetch(url, { method: 'POST', headers: getAuthHeaders() });
      if (res.ok) {
        msg = `${i18n.t.added}: ${target.Name}`; msgError = false;
        alreadyIn.add(target.Id);
        childrenOf[target.Id] = [...(childrenOf[target.Id] || []), { Id: item.Id, Name: item.Name }];
      } else {
        console.warn('[OcenFin] add failed', mode, res.status, await res.text().catch(() => ''));
        msg = (mode === 'collection' && res.status === 403) ? i18n.t.collectionPermissionDenied : i18n.t.actionFailed; msgError = true;
      }
    } catch (e) { console.warn('[OcenFin] add error', mode, e); msg = i18n.t.actionFailed; msgError = true; }
    busy = false;
  }

  async function createNew() {
    const name = newName.trim();
    if (!name || !item || busy) return;
    busy = true;
    const url = mode === 'collection'
      ? `${session.serverUrl}/Collections?Name=${encodeURIComponent(name)}&Ids=${item.Id}`
      : `${session.serverUrl}/Playlists?Name=${encodeURIComponent(name)}&Ids=${item.Id}&UserId=${selectedUser.Id}`;
    try {
      const res = await fetch(url, { method: 'POST', headers: getAuthHeaders() });
      if (res.ok) {
        msg = `${i18n.t.created}: ${name}`; msgError = false;
        const created = await res.json().catch(() => null);
        const newTarget = { Id: created?.Id, Name: name };
        items = [newTarget, ...items];
        if (created?.Id) {
          alreadyIn.add(created.Id);
          childrenOf[created.Id] = [{ Id: item.Id, Name: item.Name }];
        }
        newName = '';
        onCreated?.();   // Eltern können Mediatheken/Sidebar auffrischen
      } else {
        console.warn('[OcenFin] create failed', mode, res.status, await res.text().catch(() => ''));
        msg = (mode === 'collection' && res.status === 403) ? i18n.t.collectionPermissionDenied : i18n.t.actionFailed; msgError = true;
      }
    } catch (e) { console.warn('[OcenFin] create error', mode, e); msg = i18n.t.actionFailed; msgError = true; }
    busy = false;
  }

  function onKeydown(e) { if (isBackKey(e)) { e.stopPropagation(); close(); } }
</script>

{#if mode}
  <div data-focus-trap transition:uiFade onoutrostart={dropTrapOnOutro} class="fixed inset-0 bg-black/90 z-[200] flex items-center justify-center p-8"
    onkeydown={onKeydown}>
    <div class="bg-gray-800 border border-gray-700 rounded-2xl w-full max-w-xl max-h-[85vh] overflow-y-auto hide-scrollbar shadow-2xl p-8 flex flex-col gap-5">
      <div class="flex justify-between items-center">
        <h2 class="text-3xl text-white font-bold">{mode === 'collection' ? i18n.t.addToCollection : i18n.t.addToPlaylist}</h2>
        <button onclick={close} {@attach focusOnMount()}
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
        <input bind:value={newName} placeholder={i18n.t.createNew} maxlength="100"
          class="flex-1 bg-gray-900 text-white text-lg px-4 py-3 rounded-lg border border-gray-600 focus:outline-none focus:ring-2 focus:ring-white placeholder-gray-500"/>
        <button onclick={createNew} disabled={!newName.trim() || busy}
          class="bg-blue-600 hover:bg-blue-500 focus:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold px-6 py-3 rounded-lg focus:outline-none focus:ring-4 focus:ring-white transition-colors">
          {i18n.t.create}
        </button>
      </div>

      <!-- Vorhandene -->
      {#if loading}
        <div class="text-gray-400 py-4 text-center">…</div>
      {:else if items.length}
        <div class="flex flex-col gap-1">
          {#each items as target (target.Id)}
            {@const has = alreadyIn.has(target.Id)}
            <button onclick={() => addTo(target)} disabled={busy || has}
              class="text-left px-4 py-3 rounded-lg focus:outline-none focus:ring-2 focus:ring-white flex items-start gap-3
                     {has ? 'opacity-70 cursor-not-allowed' : 'text-gray-200 hover:bg-gray-700 focus:bg-gray-700'}">
              <svg class="w-5 h-5 shrink-0 mt-1 {has ? 'text-green-500' : 'text-gray-500'}" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                {#if has}<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>{:else}<path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>{/if}
              </svg>
              <div class="flex-1 min-w-0">
                <div class="text-lg truncate {has ? 'text-gray-300' : ''}">{target.Name}</div>
                {#if childrenOf[target.Id]?.length}
                  <div class="text-sm text-gray-500 truncate">{childrenOf[target.Id].slice(0, 10).map(c => c.Name).join(', ')}</div>
                {/if}
                {#if has}<div class="text-sm text-green-400">{i18n.t.alreadyAdded}</div>{/if}
              </div>
            </button>
          {/each}
        </div>
      {:else}
        <div class="text-gray-500 py-2">{i18n.t.noItems}</div>
      {/if}
    </div>
  </div>
{/if}

