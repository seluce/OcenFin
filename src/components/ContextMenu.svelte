<script>
  import { t } from '../i18n.js';
  import { isBackKey, focusOnMount } from '../utils.js';
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';

  export let item;
  export let serverUrl;
  export let activeToken;
  export let userId;

  const dispatch = createEventDispatcher();

  let busy = false;

  // Lokale (optimistische) Zustände — werden beim Klick sofort umgeschaltet, damit
  // Beschriftung/Icons im Menü die Änderung direkt zeigen. Initial aus dem Item.
  let played    = !!item?.UserData?.Played;
  let favorite  = !!item?.UserData?.IsFavorite;
  let hasResume = (item?.UserData?.PlaybackPositionTicks || 0) > 0
                  && item?.Type !== 'Series' && item?.Type !== 'Season';

  // "Scharfschalten": Wird das Menü durch langes OK-Halten geöffnet, ist die Taste noch
  // gedrückt. Wir nehmen Eingaben ERST nach dem Loslassen an (keyup bzw. pointerup) —
  // egal wie lange gehalten wird —, damit die gehaltene Taste nicht den ersten Eintrag
  // auslöst. Kein Timer (zu langes Halten würde sonst doch durchrutschen).
  let armed = false;
  function arm() { armed = true; }
  onMount(() => {
    window.addEventListener('keyup', arm);
    window.addEventListener('pointerup', arm);
  });
  onDestroy(() => {
    window.removeEventListener('keyup', arm);
    window.removeEventListener('pointerup', arm);
  });

  function headers() {
    return { "Authorization": `MediaBrowser Token="${activeToken}"`, "Content-Type": "application/json" };
  }
  async function call(method, path) {
    busy = true;
    try {
      await fetch(`${serverUrl}${path}`, { method, headers: headers() });
    } catch (e) {
      console.error('context action failed', e);
    }
    busy = false;
  }

  async function toggleWatched() {
    if (!armed) return;
    const next = !played;
    played = next;                         // optimistisch umschalten
    if (next) hasResume = false;           // als gesehen → kein Fortsetzen mehr
    if (item.UserData) item.UserData.Played = next;
    dispatch('changed');                   // Liste im Hintergrund aktualisieren (NICHT schließen)
    await call(next ? 'POST' : 'DELETE', `/Users/${userId}/PlayedItems/${item.Id}`);
  }
  async function toggleFavorite() {
    if (!armed) return;
    const next = !favorite;
    favorite = next;
    if (item.UserData) item.UserData.IsFavorite = next;
    dispatch('changed');
    await call(next ? 'POST' : 'DELETE', `/Users/${userId}/FavoriteItems/${item.Id}`);
  }
  async function resetProgress() {
    if (!armed) return;
    hasResume = false; played = false;     // raus aus "Weiterschauen"
    if (item.UserData) { item.UserData.Played = false; item.UserData.PlaybackPositionTicks = 0; }
    dispatch('changed');
    await call('DELETE', `/Users/${userId}/PlayedItems/${item.Id}`);
  }
  function openDetails() { if (!armed) return; dispatch('openDetails', item); dispatch('close'); }

  function handleKeyDown(e) {
    if (isBackKey(e)) { e.preventDefault(); e.stopPropagation(); dispatch('close'); }
  }

  // Titel: bei Folgen "Serie · Folgentitel", sonst der Name
  $: title = item?.SeriesName ? `${item.SeriesName} · ${item.Name}` : item?.Name;
</script>

<svelte:window on:keydown|capture={handleKeyDown} />

<!-- Overlay -->
<div data-focus-trap class="fixed inset-0 z-[90] bg-black/70 backdrop-blur-sm flex items-center justify-center p-8"
     on:click|self={() => dispatch('close')}>

  <div class="bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden ring-1 ring-white/10">
    <!-- Kopf -->
    <div class="px-6 pt-6 pb-4 border-b border-white/10">
      <p class="text-xs uppercase tracking-wider text-gray-500 font-bold mb-1">{$t.options}</p>
      <h2 class="text-xl font-bold text-white line-clamp-2">{title}</h2>
    </div>

    <!-- Aktionen -->
    <div class="p-3 flex flex-col gap-1">
      <button on:click={toggleWatched} use:focusOnMount
        class="flex items-center gap-4 px-4 py-3.5 rounded-xl text-left text-white text-lg
               hover:bg-white/10 focus:bg-white/15 focus:outline-none transition-colors disabled:opacity-50">
        <svg class="w-6 h-6 shrink-0 {played ? 'text-green-400' : 'text-gray-400'}" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
        {played ? $t.markUnwatched : $t.markWatched}
      </button>

      <button on:click={toggleFavorite}
        class="flex items-center gap-4 px-4 py-3.5 rounded-xl text-left text-white text-lg
               hover:bg-white/10 focus:bg-white/15 focus:outline-none transition-colors disabled:opacity-50">
        <svg class="w-6 h-6 shrink-0 {favorite ? 'text-red-500' : 'text-gray-400'}" fill={favorite ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z"/>
        </svg>
        {favorite ? $t.removeFavorite : $t.addFavorite}
      </button>

      {#if hasResume}
        <button on:click={resetProgress}
          class="flex items-center gap-4 px-4 py-3.5 rounded-xl text-left text-white text-lg
                 hover:bg-white/10 focus:bg-white/15 focus:outline-none transition-colors disabled:opacity-50">
          <svg class="w-6 h-6 shrink-0 text-gray-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"/>
          </svg>
          {$t.resetProgress}
        </button>
      {/if}

      <button on:click={openDetails}
        class="flex items-center gap-4 px-4 py-3.5 rounded-xl text-left text-white text-lg
               hover:bg-white/10 focus:bg-white/15 focus:outline-none transition-colors disabled:opacity-50">
        <svg class="w-6 h-6 shrink-0 text-gray-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z"/>
        </svg>
        {$t.openDetails}
      </button>
    </div>
  </div>
</div>
