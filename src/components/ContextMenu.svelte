<script>
  import { i18n } from '../i18n.svelte.js';
  import { isBackKey, focusOnMount, authHeaders } from '../utils.js';
  import { session } from '../session.svelte.js';
  import { toggleWatchlist, inWatchlist } from '../watchlist.svelte.js';
  import { onMount, onDestroy, untrack } from 'svelte';

  let { item, userId, selectedUser, onChanged, onOpenDetails, onAddToList, onAddToCollection, onClose } = $props();

  // Local (optimistic) states — toggled immediately on click so the
  // label/icons in the menu show the change directly. Initialized from the item.
  let played    = $state(untrack(() => !!item?.UserData?.Played));
  let favorite  = $state(untrack(() => !!item?.UserData?.IsFavorite));
  let hasResume = $state(untrack(() => (item?.UserData?.PlaybackPositionTicks || 0) > 0
                  && item?.Type !== 'Series' && item?.Type !== 'Season'));

  // "Arming": if the menu is opened by holding OK long, the key is still
  // pressed. We only accept input AFTER release (keyup or pointerup) —
  // no matter how long it's held — so the held key doesn't trigger the first entry.
  // No timer (holding too long would otherwise still slip through).
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
    played = next;                         // toggle optimistically
    if (next) hasResume = false;           // marked as watched → no more resume
    if (item.UserData) item.UserData.Played = next;
    await call(next ? 'POST' : 'DELETE', `/Users/${userId}/PlayedItems/${item.Id}`);
    onChanged?.();                   // reload only AFTER the server write (otherwise a race: reload reads stale data)
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
    hasResume = false; played = false;     // out of "Continue Watching"
    if (item.UserData) { item.UserData.Played = false; item.UserData.PlaybackPositionTicks = 0; }
    await call('DELETE', `/Users/${userId}/PlayedItems/${item.Id}`);
    onChanged?.();
  }
  function openDetails() { if (!armed) return; onOpenDetails?.(item); onClose?.(); }
  function addToList()   { if (!armed) return; onAddToList?.(item); onClose?.(); }
  function addToCollection() { if (!armed) return; onAddToCollection?.(item); onClose?.(); }
  // Show collection only if the profile has the right (like in Details/Player). Hide only on an explicit
  // false → missing field/older server: visible + 403 fallback in AddToPicker.
  const canManageCollections = $derived(selectedUser?.Policy?.EnableCollectionManagement !== false);

  function handleKeyDown(e) {
    if (isBackKey(e)) { e.preventDefault(); e.stopPropagation(); onClose?.(); }
  }

  // Title: for episodes "Series · Episode title", otherwise the name
  let title = $derived(item?.SeriesName ? `${item.SeriesName} · ${item.Name}` : item?.Name);
</script>

<svelte:window onkeydowncapture={handleKeyDown} />

<!-- Overlay: backdrop click-to-close is a pointer-only convenience; keyboard/remote users close via
     the back key or by picking an action. A role/key handler on the backdrop would fight the focus trap. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div data-focus-trap class="fixed inset-0 z-[90] bg-black/70 backdrop-blur-sm flex items-center justify-center p-8"
     onclick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>

  <div class="bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden ring-1 ring-white/10">
    <!-- Header -->
    <div class="px-6 pt-6 pb-4 border-b border-white/10">
      <p class="text-xs uppercase tracking-wider text-gray-500 font-bold mb-1">{i18n.t.options}</p>
      <h2 class="text-xl font-bold text-white line-clamp-2">{title}</h2>
    </div>

    <!-- Actions -->
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

      <button onclick={() => toggleWatchlist(item)}
        class="flex items-center gap-4 px-4 py-3.5 rounded-xl text-left text-white text-lg
               hover:bg-white/10 focus:bg-white/15 focus:outline-none transition-colors disabled:opacity-50">
        <svg class="w-6 h-6 shrink-0 {inWatchlist(item.Id) ? 'text-blue-400' : 'text-gray-400'}" fill={inWatchlist(item.Id) ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0z"/>
        </svg>
        {inWatchlist(item.Id) ? i18n.t.removeFromWatchlist : i18n.t.addToWatchlist}
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

      {#if canManageCollections}
        <button onclick={addToCollection}
          class="flex items-center gap-4 px-4 py-3.5 rounded-xl text-left text-white text-lg
                 hover:bg-white/10 focus:bg-white/15 focus:outline-none transition-colors disabled:opacity-50">
          <svg class="w-6 h-6 shrink-0 text-gray-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" d="M12 10.5v6m3-3H9m4.06-7.19l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z"/>
          </svg>
          {i18n.t.addToCollection}
        </button>
      {/if}

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
