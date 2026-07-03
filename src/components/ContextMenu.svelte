<script>
  import { i18n } from '../i18n.svelte.js';
  import { isBackKey, focusOnMount, authHeaders } from '../utils.js';
  import { session } from '../session.svelte.js';
  import { onMount, onDestroy } from 'svelte';

  let { item, userId, onChanged, onOpenDetails, onAddToList, onClose } = $props();

  // Lokale (optimistische) Zustände — werden beim Klick sofort umgeschaltet, damit
  // Beschriftung/Icons im Menü die Änderung direkt zeigen. Initial aus dem Item.
  let played    = $state(!!item?.UserData?.Played);
  let favorite  = $state(!!item?.UserData?.IsFavorite);
  let hasResume = $state((item?.UserData?.PlaybackPositionTicks || 0) > 0
                  && item?.Type !== 'Series' && item?.Type !== 'Season');

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
    return authHeaders(session.token);
  }
  async function call(method, path) {
    try {
      await fetch(`${session.serverUrl}${path}`, { method, headers: headers() });
    } catch (e) {
      console.error('context action failed', e);
    }
  }

  async function toggleWatched() {
    if (!armed) return;
    const next = !played;
    played = next;                         // optimistisch umschalten
    if (next) hasResume = false;           // als gesehen → kein Fortsetzen mehr
    if (item.UserData) item.UserData.Played = next;
    await call(next ? 'POST' : 'DELETE', `/Users/${userId}/PlayedItems/${item.Id}`);
    onChanged?.();                   // ERST nach dem Server-Write neu laden (sonst Race: Reload liest veraltete Daten)
  }
  async function toggleFavorite() {
    if (!armed) return;
    const next = !favorite;
    favorite = next;
    if (item.UserData) item.UserData.IsFavorite = next;
    await call(next ? 'POST' : 'DELETE', `/Users/${userId}/FavoriteItems/${item.Id}`);
    onChanged?.();
  }
  async function resetProgress() {
    if (!armed) return;
    hasResume = false; played = false;     // raus aus "Weiterschauen"
    if (item.UserData) { item.UserData.Played = false; item.UserData.PlaybackPositionTicks = 0; }
    await call('DELETE', `/Users/${userId}/PlayedItems/${item.Id}`);
    onChanged?.();
  }
  function openDetails() { if (!armed) return; onOpenDetails?.(item); onClose?.(); }
  function addToList()   { if (!armed) return; onAddToList?.(item); onClose?.(); }

  function handleKeyDown(e) {
    if (isBackKey(e)) { e.preventDefault(); e.stopPropagation(); onClose?.(); }
  }

  // Titel: bei Folgen "Serie · Folgentitel", sonst der Name
  let title = $derived(item?.SeriesName ? `${item.SeriesName} · ${item.Name}` : item?.Name);
</script>

<svelte:window onkeydowncapture={handleKeyDown} />

<!-- Overlay -->
<div data-focus-trap class="fixed inset-0 z-[90] bg-black/70 backdrop-blur-sm flex items-center justify-center p-8"
     onclick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>

  <div class="bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden ring-1 ring-white/10">
    <!-- Kopf -->
    <div class="px-6 pt-6 pb-4 border-b border-white/10">
      <p class="text-xs uppercase tracking-wider text-gray-500 font-bold mb-1">{i18n.t.options}</p>
      <h2 class="text-xl font-bold text-white line-clamp-2">{title}</h2>
    </div>

    <!-- Aktionen -->
    <div class="p-3 flex flex-col gap-1">
      <button onclick={toggleWatched} {@attach focusOnMount()}
        class="flex items-center gap-4 px-4 py-3.5 rounded-xl text-left text-white text-lg
               hover:bg-white/10 focus:bg-white/15 focus:outline-none transition-colors disabled:opacity-50">
        <svg class="w-6 h-6 shrink-0 {played ? 'text-green-400' : 'text-gray-400'}" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
        {played ? i18n.t.markUnwatched : i18n.t.markWatched}
      </button>

      <button onclick={toggleFavorite}
        class="flex items-center gap-4 px-4 py-3.5 rounded-xl text-left text-white text-lg
               hover:bg-white/10 focus:bg-white/15 focus:outline-none transition-colors disabled:opacity-50">
        <svg class="w-6 h-6 shrink-0 {favorite ? 'text-red-500' : 'text-gray-400'}" fill={favorite ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z"/>
        </svg>
        {favorite ? i18n.t.removeFavorite : i18n.t.addFavorite}
      </button>

      {#if hasResume}
        <button onclick={resetProgress}
          class="flex items-center gap-4 px-4 py-3.5 rounded-xl text-left text-white text-lg
                 hover:bg-white/10 focus:bg-white/15 focus:outline-none transition-colors disabled:opacity-50">
          <svg class="w-6 h-6 shrink-0 text-gray-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99"/>
          </svg>
          {i18n.t.resetProgress}
        </button>
      {/if}

      <button onclick={addToList}
        class="flex items-center gap-4 px-4 py-3.5 rounded-xl text-left text-white text-lg
               hover:bg-white/10 focus:bg-white/15 focus:outline-none transition-colors disabled:opacity-50">
        <svg class="w-6 h-6 shrink-0 text-gray-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h10.5M3.75 12h10.5M3.75 17.25h6M18 14.25v6M15 17.25h6"/>
        </svg>
        {i18n.t.addToPlaylist}
      </button>

      <button onclick={openDetails}
        class="flex items-center gap-4 px-4 py-3.5 rounded-xl text-left text-white text-lg
               hover:bg-white/10 focus:bg-white/15 focus:outline-none transition-colors disabled:opacity-50">
        <svg class="w-6 h-6 shrink-0 text-gray-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z"/>
        </svg>
        {i18n.t.openDetails}
      </button>
    </div>
  </div>
</div>
