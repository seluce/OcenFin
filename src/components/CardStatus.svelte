<script>
  // A card's status — always top right, in ONE place for the whole app (CODE-HEALTH §51): the time
  // left on a started title, else the unwatched episodes of a series (the Library's "Unwatched
  // episodes" option), else a green tick once everything is watched. In that order: a watched film
  // started again shows its time left. Top left stays free for labels such as "Next up".
  // It replaces three separate marks — a tick top left, an episode count and a time-left chip top
  // right in another shape — which a watched series showed all at once, plus a full progress bar.
  import { i18n } from '../i18n.svelte.js';

  let {
    item,
    remaining = 0,     // minutes left of a started title (the dashboard's Continue watching passes it)
    unplayed = false,  // show a series' or season's unwatched episodes
  } = $props();

  let open = $derived(unplayed && (item?.Type === 'Series' || item?.Type === 'Season')
    ? (item?.UserData?.UnplayedItemCount || 0) : 0);
</script>

{#if remaining > 0}
  <div class="pill bg-black/75 px-2">{remaining} {i18n.t.mins} {i18n.t.remaining}</div>
{:else if open > 0}
  <div class="pill bg-black/75 px-2">{open} {i18n.t.episodesLeft}</div>
{:else if item?.UserData?.Played}
  <!-- Green, like every other place that says watched — the details page's button, the card menu. -->
  <div class="pill bg-green-600/90 px-1.5">
    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
  </div>
{/if}

<style>
  /* One shape for all three: the tick is the same pill, just as wide as it is tall. */
  .pill {
    position: absolute; top: 0.5rem; right: 0.5rem; z-index: 10;
    height: 1.6rem; min-width: 1.6rem; border-radius: 9999px;
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-size: 0.75rem; line-height: 1rem; font-weight: 700; white-space: nowrap;
    box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1);
    pointer-events: none;
  }
</style>
