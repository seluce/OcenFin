<script>
  // The round person card — the title page's cast, the search's people and favourite people (§142). It was written out
  // three times, like the poster card before PosterCard (§31). The caller sets the width (`class`) and what OK does;
  // `caption` adds the part played under the name (the cast). Carries `data-item-id`, which the focus return reads.
  import { personImageUrl, blurUp, itemBlurHash } from '../utils.js';
  import { session } from '../session.svelte.js';

  let { person, onclick, caption = '', class: cls = '' } = $props();
  let img = $derived(personImageUrl(session.serverUrl, person));
</script>

<button {onclick} data-item-id={person.Id} class="{cls} group isolate focus:outline-none text-center">
  <div class="aspect-square w-full bg-gray-800 rounded-full overflow-hidden border-4 border-transparent group-focus:border-white scale-100 group-focus:scale-105 group-focus:focus-glow transition-transform duration-200 shadow-xl mx-auto">
    {#if img}
      <img src={img} {@attach blurUp(itemBlurHash(person))} alt={person.Name} class="w-full h-full object-cover" loading="lazy" decoding="async"/>
    {:else}
      <div class="w-full h-full flex items-center justify-center text-gray-600">
        <svg class="w-[40%] h-[40%]" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
      </div>
    {/if}
  </div>
  <span class="mt-3 text-sm font-bold text-gray-300 group-focus:text-white truncate w-full block">{person.Name}</span>
  {#if caption}<span class="text-xs text-gray-400 truncate w-full block">{caption}</span>{/if}
</button>
