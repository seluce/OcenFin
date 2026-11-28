<script>
  import { i18n, plural } from '../i18n.svelte.js';
  import { isBackKey, focusOnMount, authHeaders, setPlayed, setFavorite } from '../utils.js';
  import Dialog from './Dialog.svelte';
  import { session } from '../session.svelte.js';
  import { toggleWatchlist, inWatchlist } from '../watchlist.svelte.js';
  import { hasEarlierEpisodes, markEarlierPlayed } from '../playback.js';
  import { onMount, onDestroy, untrack } from 'svelte';

  let { item, userId, selectedUser, onChanged, onProgressChanged, onOpenDetails, onPlay, onAddToList, onAddToCollection, onPlayAll, onClose } = $props();

  // Play is the menu's first entry for anything that can be watched — the most common thing to do
  // with a card, and it was only reachable through the details page. A series or season plays its
  // next episode (App: playFromCard). "Resume" when the title itself has a resume point.
  const PLAYABLE = ['Movie', 'Episode', 'Series', 'Season', 'Video', 'MusicVideo'];
  const canPlay = PLAYABLE.includes(untrack(() => item?.Type));   // read once — it feeds {@attach}

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

  // Each action below changes the card optimistically and puts it back when the server did not take
  // it (setPlayed/setFavorite resolve to that — an error ANSWER counts as a refusal).

  async function toggleWatched() {
    if (!armed) return;
    const next = !played, hadResume = hasResume, was = item.UserData ? { ...item.UserData } : null;
    played = next;                         // toggle optimistically
    hasResume = false;
    // The server drops the position either way (resetProgress below relies on it, "mark earlier" writes it too, §168):
    // a started title marked watched showed its tick AND its bar until the list was asked again
    if (item.UserData) { item.UserData.Played = next; item.UserData.PlaybackPositionTicks = 0; }
    if (!(await setPlayed(item.Id, userId, next))) {
      played = !next; hasResume = hadResume;
      if (was) Object.assign(item.UserData, was);
    } else onProgressChanged?.();   // a series' episode leaves Continue watching, Up next moves on (§140)
    onChanged?.();                   // reload only AFTER the server write (otherwise a race: reload reads stale data)
  }
  async function toggleFavorite() {
    if (!armed) return;
    const next = !favorite;
    favorite = next;
    if (item.UserData) item.UserData.IsFavorite = next;
    if (!(await setFavorite(item.Id, userId, next))) {
      favorite = !next;
      if (item.UserData) item.UserData.IsFavorite = !next;
    }
    onChanged?.();
  }
  async function resetProgress() {
    if (!armed) return;
    const was = { hasResume, played, data: item.UserData ? { ...item.UserData } : null };
    hasResume = false; played = false;     // out of "Continue Watching"
    if (item.UserData) { item.UserData.Played = false; item.UserData.PlaybackPositionTicks = 0; }
    if (!(await setPlayed(item.Id, userId, false))) {
      hasResume = was.hasResume; played = was.played;
      if (was.data) Object.assign(item.UserData, was.data);
    } else onProgressChanged?.();
    onChanged?.();
  }
  // "Mark earlier episodes as watched" (playback.js). The entry reports in place what it did — how many,
  // or that everything before was watched already — and stays inert after that. If the list could not
  // be fetched or not one episode was taken, it goes back to its label, ready for another try.
  const canMarkEarlier = hasEarlierEpisodes(untrack(() => item));
  let earlier = $state(null);   // null | 'busy' | { n }
  async function markEarlier() {
    if (!armed || earlier) return;
    earlier = 'busy';
    try {
      const { found, done } = await markEarlierPlayed(item, { serverUrl: session.serverUrl, userId, headers: authHeaders() });
      earlier = found && !done.length ? null : { n: done.length };
      if (done.length) onProgressChanged?.();   // Next Up of that series has moved on
    } catch (e) { console.warn('mark earlier episodes:', e?.message || e); earlier = null; }
  }
  function openDetails() { if (!armed) return; onOpenDetails?.(item); onClose?.(); }
  function playAll()     { if (!armed) return; onPlayAll?.(item); onClose?.(); }
  function play()        { if (!armed) return; onPlay?.(item); }
  function addToList()   { if (!armed) return; onAddToList?.(item); onClose?.(); }
  function addToCollection() { if (!armed) return; onAddToCollection?.(item); onClose?.(); }
  // Show collection only if the profile has the right (like in Details/Player). Hide only on an explicit
  // false → a missing field stays visible, with the 403 fallback in AddToPicker.
  const canManageCollections = $derived(selectedUser?.Policy?.EnableCollectionManagement !== false);

  function handleKeyDown(e) {
    if (isBackKey(e)) { e.preventDefault(); e.stopPropagation(); onClose?.(); }
  }

  // Title: for episodes "Series · Episode title", otherwise the name
  let title = $derived(item?.SeriesName ? `${item.SeriesName} · ${item.Name}` : item?.Name);

  // The entries' icons (24×24 paths)
  const ICON = {
    play: 'M8 5v14l11-7z',
    info: 'M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z',
    watched: 'M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    earlier: 'M1.5 12.5l4.5 4.5 9-10M11 16.5l.5.5 9-10',
    heart: 'M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12z',
    bookmark: 'M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0111.186 0z',
    reset: 'M16.023 9.348h4.992v-.001M2.985 19.644v-4.992m0 0h4.992m-4.993 0l3.181 3.183a8.25 8.25 0 0013.803-3.7M4.031 9.865a8.25 8.25 0 0113.803-3.7l3.181 3.182m0-4.991v4.99',
    list: 'M3.75 6.75h10.5M3.75 12h10.5M3.75 17.25h6M18 14.25v6M15 17.25h6',
    folder: 'M12 10.5v6m3-3H9m4.06-7.19l-2.12-2.12a1.5 1.5 0 00-1.061-.44H4.5A2.25 2.25 0 002.25 6v12a2.25 2.25 0 002.25 2.25h15A2.25 2.25 0 0021.75 18V9a2.25 2.25 0 00-2.25-2.25h-5.379a1.5 1.5 0 01-1.06-.44z',
  };
  const takeFocus = focusOnMount();   // the first entry takes focus — see the snippet
</script>

<svelte:window onkeydowncapture={handleKeyDown} />

<!-- One menu entry (§142: eleven buttons spelled this out). `tint` colours the icon by state, `solid` = filled without
     an outline (play), `filled` = filled AND outlined (favourite, watchlist when set), `busy` dims it while it works.
     `focus` is the ONE attachment made in the script, never a factory called here: an attachment is rebuilt when its
     function changes, and building one runs it — a fresh focusOnMount() per label change would pull focus back. -->
{#snippet entry(onclick, label, d, { tint = 'text-gray-400', solid = false, filled = false, busy = false, focus = false } = {})}
  <button {onclick} {@attach focus}
    class="flex items-center gap-4 px-4 py-3.5 rounded-xl text-left text-white text-lg
           hover:bg-white/10 focus:bg-white/15 focus:outline-none transition-colors {busy ? 'opacity-60' : ''}">
    <svg class="w-6 h-6 shrink-0 {tint}" fill={solid || filled ? 'currentColor' : 'none'} stroke={solid ? 'none' : 'currentColor'} stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
      <path stroke-linecap="round" stroke-linejoin="round" {d}/>
    </svg>
    {label}
  </button>
{/snippet}

<!-- A click on the darkening closes it too (pointer only); Back is handled on the window, above. -->
<Dialog z="z-[90]" onBackdrop={onClose}>

  <div class="bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden ring-1 ring-white/10">
    <!-- Header -->
    <div class="px-6 pt-6 pb-4 border-b border-white/10">
      <p class="text-xs uppercase tracking-wider text-gray-400 font-bold mb-1">{i18n.t.options}</p>
      <h2 class="text-xl font-bold text-white line-clamp-2">{title}</h2>
    </div>

    <!-- Actions -->
    <div class="p-3 flex flex-col gap-1">
      {#if item?.Type === 'Playlist'}
        <!-- Playlist: only container-appropriate actions -->
        {@render entry(playAll, i18n.t.playAll, ICON.play, { solid: true, focus: takeFocus })}
        {@render entry(openDetails, i18n.t.openDetails, ICON.info)}
      {:else}
        {#if canPlay}
          {@render entry(play, hasResume ? i18n.t.resumePlay : i18n.t.play, ICON.play, { solid: true, focus: takeFocus })}
        {/if}
        {@render entry(toggleWatched, played ? i18n.t.markUnwatched : i18n.t.markWatched, ICON.watched,
          { tint: played ? 'text-green-400' : 'text-gray-400', focus: !canPlay && takeFocus })}
        {#if canMarkEarlier}
          {@render entry(markEarlier,
            earlier?.n > 0 ? plural('earlierMarked', earlier.n) : earlier?.n === 0 ? i18n.t.earlierAllWatched : i18n.t.markEarlierWatched,
            ICON.earlier, { tint: earlier?.n >= 0 ? 'text-green-400' : 'text-gray-400', busy: earlier === 'busy' })}
        {/if}
        {@render entry(toggleFavorite, favorite ? i18n.t.removeFavorite : i18n.t.addFavorite, ICON.heart,
          { tint: favorite ? 'text-red-500' : 'text-gray-400', filled: favorite })}
        {@render entry(() => toggleWatchlist(item), inWatchlist(item.Id) ? i18n.t.removeFromWatchlist : i18n.t.addToWatchlist, ICON.bookmark,
          { tint: inWatchlist(item.Id) ? 'text-blue-400' : 'text-gray-400', filled: inWatchlist(item.Id) })}
        {#if hasResume}
          {@render entry(resetProgress, i18n.t.resetProgress, ICON.reset)}
        {/if}
        {@render entry(addToList, i18n.t.addToPlaylist, ICON.list)}
        {#if canManageCollections}
          {@render entry(addToCollection, i18n.t.addToCollection, ICON.folder)}
        {/if}
        {@render entry(openDetails, i18n.t.openDetails, ICON.info)}
      {/if}
    </div>
  </div>
</Dialog>
