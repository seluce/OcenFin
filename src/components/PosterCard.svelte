<script>
  // The poster card of the three grid views — a collection/playlist, favourites, and a person's
  // filmography. It was written out three times, byte for byte: badge, BlurHash placeholder,
  // progress bar and the whole focus treatment. Keeping it in one place also makes a rule
  // structural that used to depend on remembering it — every card that can open Details or a
  // context menu carries `data-item-id` (CLAUDE.md), which the entire focus-restore architecture
  // reads. A new call site cannot forget it any more.
  //
  // Deliberately NOT used by the dashboard, the library or search: their cards have other shapes
  // (landscape, round, three different widths) and their own behaviour — the library's backdrop
  // preview on focus, for one. Pulling those in here would produce a component of flags, not a card.
  //
  // `caption` is a snippet so each view keeps its own labelling. It renders INSIDE the button, so
  // `group-focus:` in those spans still refers to this card.
  import { itemProgress, itemBadge, itemBlurHash, blurUp, longPress, getItemImageUrl } from '../utils.js';

  let { item, onOpenDetails, onContextMenu, caption } = $props();
  let badge = $derived(itemBadge(item));
</script>

<button onclick={() => onOpenDetails(item)} data-item-id={item.Id}
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
  {@render caption(item)}
</button>
