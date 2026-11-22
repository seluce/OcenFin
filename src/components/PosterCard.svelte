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
  import { itemBlurHash, blurUp, longPress, getItemImageUrl } from '../utils.js';
  import CardStatus from './CardStatus.svelte';

  let { item, onOpenDetails, onContextMenu, caption } = $props();
</script>

<button onclick={() => onOpenDetails(item)} data-item-id={item.Id}
  {@attach longPress()} onlongpress={() => onContextMenu(item)}
  class="group isolate focus:outline-none text-left scroll-my-4">
  <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg overflow-hidden border-4 border-transparent group-focus:border-white scale-100 group-focus:scale-105 group-focus:focus-glow transition-transform duration-200 shadow-xl relative">
    <CardStatus {item} />
    {#if getItemImageUrl(item)}
      <img src={getItemImageUrl(item)} {@attach blurUp(itemBlurHash(item))} alt={item.Name} class="w-full h-full object-cover" loading="lazy" decoding="async"/>
    {/if}
  </div>
  {@render caption(item)}
</button>
