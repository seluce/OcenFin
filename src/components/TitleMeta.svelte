<script>
  // A title's meta line — year (a series' years), length (a series' seasons, else the running time), age rating,
  // community and critic rating — in ONE place for the home banner, the library's info preview and the title page
  // (CODE-HEALTH §141). It was written out three times and had drifted apart: the banner gave a series its first year
  // only, no age rating and no length, smaller stars and the critics' score without the tomato.
  //
  // The caller sets the line's size, colour and spacing (`class`); icons and badge follow the text size (em).
  // Each item stays on one line (whitespace-nowrap): in the banner's line, which does not wrap, "5 seasons" broke in
  // two before the genres shrank. A separator stands before every item but the first; the age badge has none.
  //   lead   — snippet in place of the year (an episode page: its number and air date)
  //   extra  — snippet after the running time, inside its item (the title page: time left · ends at)
  //   genres — the banner names them at the end of the line; the preview and the title page show them below
  import { plural } from '../i18n.svelte.js';
  import { getItemSubtitle, runtimeLabel } from '../utils.js';

  let { item, class: cls = '', lead = null, extra = null, genres = null } = $props();

  let year   = $derived(!item ? '' : item.Type === 'Episode' ? (item.ProductionYear ? String(item.ProductionYear) : '')
                                  : getItemSubtitle(item));
  let length = $derived(!item ? '' : item.Type === 'Series' ? (item.ChildCount ? plural('seasonCount', item.ChildCount) : '')
                                  : runtimeLabel(item.RunTimeTicks));
  let genreLine = $derived((genres || []).slice(0, 3).join(' · '));
  // What the line starts with: everything after it gets its "•"
  let first = $derived(lead || year ? 'year' : length ? 'length' : item?.OfficialRating ? 'badge'
                     : item?.CommunityRating ? 'stars' : item?.CriticRating ? 'critics' : 'genres');
  const dot = (part) => first === part ? '' : '• ';
</script>

{#if item}
  <div class={cls}>
    {#if lead}{@render lead()}{:else if year}<span class="text-blue-400 whitespace-nowrap">{year}</span>{/if}
    {#if length}
      <span class="flex items-center gap-2 whitespace-nowrap">{dot('length')}{length}{#if extra && item.Type !== 'Series'}{@render extra()}{/if}</span>
    {/if}
    {#if item.OfficialRating}
      <span class="px-2 py-0.5 rounded border border-gray-400/80 bg-black/25 text-gray-100 text-[0.89em] font-bold leading-none whitespace-nowrap [text-shadow:none]">{item.OfficialRating}</span>
    {/if}
    {#if item.CommunityRating}
      <span class="flex items-center gap-1 text-gray-100 whitespace-nowrap">
        {dot('stars')}
        <svg class="w-[1.11em] h-[1.11em] shrink-0 text-yellow-400" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/>
        </svg>
        {item.CommunityRating.toFixed(1)}
      </span>
    {/if}
    {#if item.CriticRating}
      <span class="flex items-center gap-1 text-gray-100 whitespace-nowrap">
        {dot('critics')}
        <svg class="w-[1.11em] h-[1.11em] shrink-0" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="14" r="7.5" fill="#ef4444"/>
          <ellipse cx="9.5" cy="6.5" rx="2.5" ry="1.3" fill="#22c55e" transform="rotate(-25 9.5 6.5)"/>
          <ellipse cx="14.5" cy="6.5" rx="2.5" ry="1.3" fill="#22c55e" transform="rotate(25 14.5 6.5)"/>
          <rect x="11.3" y="4.5" width="1.4" height="3" rx="0.7" fill="#22c55e"/>
        </svg>
        {item.CriticRating}%
      </span>
    {/if}
    {#if genreLine}<span class="min-w-0 truncate font-normal">{dot('genres')}{genreLine}</span>{/if}
  </div>
{/if}
