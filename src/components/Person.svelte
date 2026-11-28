<script module>
  // The page as it was left (§164), for ONE person — the last: Back from a title shows it at once and asks again
  // behind it, where up to a dozen requests (a person with many titles and episodes) stood between Back and the page.
  // Raw server data, keyed by server, profile and person.
  let kept = null;   // { key, info, items, seriesOf, fav }
</script>

<script>
  import { i18n, plural } from '../i18n.svelte.js';
  import { dlog, authHeaders, getItemSubtitle, setFavorite, personImageUrl, blurUp, itemBlurHash, clampWatch, makeFocusReturn } from '../utils.js';
  import { session } from '../session.svelte.js';
  import PosterCard from './PosterCard.svelte';
  import TextDialog from './TextDialog.svelte';
  import ShareDialog from './ShareDialog.svelte';
  import { tick, untrack } from 'svelte';

  // focusItemId: the title to land on after the parent brought us back from a detail page. Passed
  // in rather than resolved here, because this view unmounts — the memory lives in App.svelte.
  // While one is pending the Back button does NOT grab focus on mount, or it would win the race
  // against the card, which only exists once the filmography has loaded.
  let { person, selectedUser, focusItemId = null, focusScrollTop = 0,
        onBack, onOpenDetails, onContextMenu } = $props();
  let backBtn;   // bind:this → the landing when a person has no titles at all
  let scrollEl;  // own scroll container — unmounts with the view, so App remembers the offset

  let fav       = $state(false);
  let info      = $state(null);   // the person as /Items/{id} has it: photo, life data, biography
  let items     = $state([]);
  let seriesOf  = $state({});     // guest series as the server has them, by Id (their watched state)
  let isLoading = $state(false);

  // How far each list reaches (§163, §164). A series' regular cast is credited on EVERY episode (TMDb), so 200
  // episodes could all be a long-running series' own — dropped below, its tile stands there already — and older guest
  // roles fell off the end; films/series carry every role (music, writing, directing), past 100 for a film composer in
  // a big library. ONE request each with the higher limit, not pages: the page waits for all of it anyway, and pages
  // one after another cost a round trip each (450 episodes: 379 instead of 165 ms at 100 ms latency). A person with
  // fewer credits gets the very same answer as before.
  const MAIN_MAX = 500, EP_MAX = 1000;

  // Group the filmography by type. Episodes are COLLAPSED per series into a single
  // "Series (N episodes)" tile — so guest stars (only credited on individual episodes,
  // not on the series) finally show up, without a main-cast actor drowning the page in
  // hundreds of episode tiles. A collapsed tile opens the series (see onOpenDetails).
  // SeriesId → { the tile's data from its first episode, the count } for every series the person is a guest in
  let guest = $derived.by(() => {
    const directIds = new Set(items.filter(i => i.Type === 'Series').map(x => x.Id));
    const map = new Map();
    for (const ep of items) {
      if (ep.Type !== 'Episode' || !ep.SeriesId) continue;
      if (directIds.has(ep.SeriesId)) continue;   // person is regular cast → series tile already shown
      const hit = map.get(ep.SeriesId);
      if (hit) hit.count++;
      else map.set(ep.SeriesId, { ep, count: 1 });
    }
    return map;
  });
  let groups = $derived.by(() => {
    const tiles = [...guest].map(([id, { ep, count }]) => seriesOf[id]
      ? { ...seriesOf[id], _episodeCount: count }
      : { Id: id, Type: 'Series', Name: ep.SeriesName || ep.Name,
          ImageTags: ep.SeriesPrimaryImageTag ? { Primary: ep.SeriesPrimaryImageTag } : undefined, _episodeCount: count });
    return [
      { label: i18n.t.movies, items: items.filter(i => i.Type === 'Movie') },
      { label: i18n.t.series, items: [...items.filter(i => i.Type === 'Series'), ...tiles] },
    ].filter(g => g.items.length > 0);
  });

  // Born and died, from what /Items/{id} carries for a person (TMDb's data): PremiereDate is the birthday, EndDate the
  // day of death, ProductionLocations[0] the place of birth. In UTC: the dates are midnight UTC, and local time west of
  // Greenwich showed the day before (as Details' episode date). The age goes beside the birthday while alive, beside
  // the day of death after; none where it comes out impossible (a placeholder date).
  let life = $derived.by(() => {
    const day = (s) => { const d = s ? new Date(s) : null; return d && !isNaN(d) && d.getUTCFullYear() > 1800 ? d : null; };
    const born = day(info?.PremiereDate), died = day(info?.EndDate);
    const place = info?.ProductionLocations?.[0] || '';
    const date = (d) => d.toLocaleDateString(i18n.lang, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
    const age = (to) => {
      if (!born) return '';
      let n = to.getUTCFullYear() - born.getUTCFullYear();
      if (to.getUTCMonth() * 32 + to.getUTCDate() < born.getUTCMonth() * 32 + born.getUTCDate()) n--;
      return n >= 0 && n < 130 ? ` (${plural('ageYears', n)})` : '';
    };
    const now = new Date(), today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const rows = [];
    if (born || place) rows.push({ label: i18n.t.personBorn,
      value: [born ? date(born) + (died ? '' : age(today)) : '', place].filter(Boolean).join(' · ') });
    if (died) rows.push({ label: i18n.t.personDied, value: date(died) + age(died) });
    return rows;
  });

  // The photo the cast card or the search showed (same address, so it comes from the cache), else the one
  // /Items/{id} names
  let photo = $derived(personImageUrl(session.serverUrl, person) || (info && personImageUrl(session.serverUrl, info)));

  // The biography stays clamped to three lines; where that cuts it, it is a button and OK shows all of it — the title
  // page's plot does the same (TextDialog, §136).
  let bioClamped = $state(false);
  let showBio    = $state(false);
  let bioBtn     = $state();
  const bioFocus = makeFocusReturn();
  $effect(() => { if (!showBio && bioFocus.pending) bioFocus.restore(); });

  // Share (§164): a QR code of the person's public page, as the title page has one — IMDb (prefered there too), else
  // TMDb, else the name to look up. Jellyfin's TMDb data brings both ids with the person.
  let showShare   = $state(false);
  let shareBtn    = $state();
  let shareTarget = $state(null);
  const shareFocus = makeFocusReturn();
  $effect(() => { if (!showShare && shareFocus.pending) shareFocus.restore(); });
  function openShare() {
    shareFocus.capture(shareBtn);
    const ids = (info || person)?.ProviderIds || {};
    shareTarget = ids.Imdb ? `https://www.imdb.com/name/${ids.Imdb}/`
      : ids.Tmdb ? `https://www.themoviedb.org/person/${ids.Tmdb}` : (person.Name || '');
    dlog('[share] person →', shareTarget);
    showShare = true;
  }

  const keyOf = () => `${session.serverUrl}|${selectedUser.Id}|${person.Id}`;


  async function loadPerson() {
    // Opening a second person while the first is still loading would otherwise let the slower
    // response win and fill the view with the wrong filmography. loadedId is set synchronously
    // before this runs, so comparing against it identifies a superseded load. Same guard as in
    // Details/Library/Search.
    const myId = person.Id, key = keyOf(), edits = favEdits;
    // The page as it was left, if it is this person's: on screen and focused at once, the requests below only bring it
    // up to date — the keyed cards stay, and so does the focus.
    const hit = kept?.key === key ? kept : null;
    fav       = hit ? hit.fav : !!person.UserData?.IsFavorite;
    info      = hit?.info ?? null;
    items     = hit?.items ?? [];
    seriesOf  = hit?.seriesOf ?? {};
    showBio   = false;
    showShare = false;
    isLoading = !hit;
    if (hit) land();
    const auth = { headers: authHeaders() };
    const json = (r) => r.ok ? r.json() : null;
    // The person itself: /Items/{id} carries every field — the favourite status (from search and the cast, UserData is
    // often missing), the photo, the life data, the biography, the ids to share. Awaited together with the filmography,
    // so the head of the page is complete when the grids go up and nothing below moves once a card has focus.
    const personReq = fetch(`${session.serverUrl}/Items/${person.Id}?UserId=${selectedUser.Id}`, auth).then(json).catch(() => null);
    // Two lists in parallel: films/series, and the episodes (for guest roles), so a long-running series' episodes can
    // never crowd films and series out of a single limit.
    const base = `${session.serverUrl}/Items?UserId=${selectedUser.Id}&PersonIds=${person.Id}` +
      `&Recursive=true&SortBy=PremiereDate&SortOrder=Descending&ImageTypeLimit=1&EnableTotalRecordCount=false`;
    try {
      const [main, eps, p] = await Promise.all([
        fetch(`${base}&IncludeItemTypes=Movie,Series&Limit=${MAIN_MAX}`, auth).then(json),
        fetch(`${base}&IncludeItemTypes=Episode&Limit=${EP_MAX}`, auth).then(json),
        personReq,
      ]);
      if (myId !== loadedId) return;   // superseded by a newer person
      const fresh = [...(main?.Items || []), ...(eps?.Items || [])];
      if (p) { info = p; if (favEdits === edits) fav = !!p.UserData?.IsFavorite; }
      items = fresh;
      kept = { key, info: p || hit?.info || null, items: fresh, seriesOf: hit?.seriesOf || {}, fav };
    } catch {
      // No filmography — the person's own data may still have come (personReq never rejects). A page that was kept
      // stays as it was.
      const p = await personReq;
      if (p && myId === loadedId) { info = p; if (favEdits === edits) fav = !!p.UserData?.IsFavorite; }
    }
    finally { if (myId === loadedId) isLoading = false; }
    if (myId !== loadedId) return;
    loadGuestSeries(myId, [...guest.keys()], key);
    if (!hit) land();
  }

  // Same landing as favourites and collections: the title we came back from, failing that the
  // first one, and only for a person with no titles the Back button — which holds focus while the
  // skeletons are up, since nothing else there can. The remembered offset applies only on a
  // return; on a fresh open it belongs to some earlier view and would jump this one.
  async function land() {
    const myId = loadedId;
    await tick();
    if (myId !== loadedId) return;
    const card = (focusItemId && scrollEl?.querySelector(`[data-item-id="${focusItemId}"]`))
              || scrollEl?.querySelector('[data-item-id]');
    if (scrollEl && focusItemId) scrollEl.scrollTop = focusScrollTop;
    (card || backBtn)?.focus();
  }

  // The guest series as the server has them (§163). Their tile is put together from episodes, which name the series
  // and its poster but not whether it is watched, so it never had the tick a series the person is regular cast of has.
  // Asked by Ids once the page is up, 100 at a time (the length of the address); the answer replaces the tile's data
  // in place — the keyed card stays, and so does the focus. A series not in the answer keeps its tile as it was.
  async function loadGuestSeries(myId, ids, key) {
    if (!ids.length) return;
    const found = {};
    const asks = [];
    for (let i = 0; i < ids.length; i += 100) {
      asks.push(fetch(`${session.serverUrl}/Items?UserId=${selectedUser.Id}&Ids=${ids.slice(i, i + 100).join(',')}` +
        `&ImageTypeLimit=1&EnableTotalRecordCount=false`, { headers: authHeaders() })
        .then(r => r.ok ? r.json() : null)
        .then(d => { for (const s of d?.Items || []) if (s.Type === 'Series') found[s.Id] = s; })
        .catch(() => {}));
    }
    await Promise.all(asks);
    if (myId !== loadedId || !Object.keys(found).length) return;
    seriesOf = found;
    if (kept?.key === key) kept.seriesOf = found;
  }

  // Set/remove the person as a favorite (optimistic; roll back on error). A press while the page loads — a kept page
  // takes presses at once — outranks the answer that load brings (asked before the press).
  let favEdits = 0;
  async function toggleFavorite() {
    favEdits++;
    const next = !fav;
    fav = next;
    if (!(await setFavorite(person.Id, selectedUser.Id, next))) fav = !next;
    if (kept?.key === keyOf()) kept.fav = fav;
  }

  // Loads on mount and when a different person is opened.
  let loadedId = null;
  $effect(() => {
    if (person && person.Id !== loadedId) { loadedId = person.Id; loadPerson(); }
  });
  // Back takes the focus on mount only when no card is to get it. Read ONCE: as the expression
  // focusOnMount(!focusItemId) the attachment was rebuilt whenever the prop changed — and building
  // one runs it, so a later prop change could put focus on Back after a card had it
  // (CLAUDE.md: never feed {@attach} a value that flips).
  function focusBackOnMount(node) { if (!untrack(() => focusItemId)) node.focus(); }
</script>

<div bind:this={scrollEl} class="p-10 pt-16 h-full overflow-y-auto hide-scrollbar ambient">

  <!-- Label under the poster; the card itself is shared (PosterCard). -->
  {#snippet cardCaption(item)}
    <span class="text-sm font-bold text-gray-300 group-focus:text-white block truncate w-full mt-2">
      {item.Type === 'Episode' && item.SeriesName ? item.SeriesName : item.Name}
    </span>
    {#if item._episodeCount}
      <span class="text-xs text-gray-400 block truncate w-full">{plural('episodeCount', item._episodeCount)}</span>
    {:else if item.Type === 'Episode'}
      <span class="text-xs text-gray-400 block truncate w-full">{item.Name}</span>
    {:else if getItemSubtitle(item)}
      <span class="text-xs text-gray-400 block truncate w-full">{getItemSubtitle(item)}</span>
    {/if}
  {/snippet}
  <div class="flex items-center gap-6 mb-8">
    <button onclick={onBack} bind:this={backBtn} {@attach focusBackOnMount}
      class="bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 px-6 py-2 rounded-lg text-white font-bold focus:outline-none focus:ring-4 focus:ring-white">
      {i18n.t.back}
    </button>
    <button onclick={toggleFavorite} aria-label={i18n.t.favorites}
      class="w-12 h-12 rounded-lg focus:outline-none focus:ring-4 focus:ring-white transition-colors flex items-center justify-center
             {fav ? 'bg-red-600 text-white' : 'bg-gray-800 text-gray-400 hover:bg-gray-700 focus:bg-gray-700'}">
      <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 24 24"><path d="M11.645 20.91l-.007-.003-.022-.012a15.247 15.247 0 01-.383-.218 25.18 25.18 0 01-4.244-3.17C4.688 15.36 2.25 12.174 2.25 8.25 2.25 5.322 4.714 3 7.688 3A5.5 5.5 0 0112 5.052 5.5 5.5 0 0116.313 3c2.973 0 5.437 2.322 5.437 5.25 0 3.925-2.438 7.111-4.739 9.256a25.175 25.175 0 01-4.244 3.17 15.247 15.247 0 01-.383.219l-.022.012-.007.004-.003.001a.752.752 0 01-.704 0z"/></svg>
    </button>
    <button bind:this={shareBtn} onclick={openShare} aria-label={i18n.t.share}
      class="w-12 h-12 rounded-lg bg-gray-800 text-gray-400 hover:bg-gray-700 focus:bg-gray-700 focus:text-white focus:outline-none focus:ring-4 focus:ring-white flex items-center justify-center">
      <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"/></svg>
    </button>
  </div>
  <!-- Photo, name and life data; the biography below them, starting at the grid's left edge — beside the photo it
       began over the second card, and ▼ from it landed there. The photo as round as the person card that led here. -->
  <div class="flex items-center gap-8 {info?.Overview ? 'mb-5' : 'mb-10'}">
    <div class="w-40 h-40 shrink-0 rounded-full overflow-hidden bg-gray-800 shadow-xl">
      {#if photo}
        <img src={photo} {@attach blurUp(itemBlurHash(person))} alt={person.Name} class="w-full h-full object-cover" decoding="async"/>
      {:else}
        <div class="w-full h-full flex items-center justify-center text-gray-600">
          <svg class="w-[40%] h-[40%]" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
        </div>
      {/if}
    </div>
    <div class="min-w-0 flex-1">
      <h1 class="text-4xl leading-[1.3] -my-[0.0944em] font-bold text-white truncate">{person?.Name}</h1>
      {#if life.length}
        <div class="flex flex-col gap-1 mt-3 text-lg text-gray-200">
          {#each life as row (row.label)}<span><span class="text-gray-400">{row.label}</span> {row.value}</span>{/each}
        </div>
      {/if}
    </div>
  </div>
  {#if info?.Overview}
    <!-- The padding sits outside the text (negative margins): it wraps and clamps like a plain paragraph, and the focus
         ring gets room around it. Not cut → disabled, out of the D-pad's way. -->
    <button bind:this={bioBtn} disabled={!bioClamped}
      onclick={() => { bioFocus.capture(bioBtn); showBio = true; }}
      class="block max-w-[57.5rem] text-left -mx-3 px-3 py-2 mb-8 rounded-xl focus:outline-none focus:ring-4 focus:ring-white">
      <span {@attach clampWatch(info.Overview, (cut) => bioClamped = cut)} class="text-lg text-gray-300 line-clamp-3 leading-relaxed">{info.Overview}</span>
    </button>
  {/if}

  {#if isLoading}
    <div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6 pr-4">
      {#each Array(12).fill(0) as _}
        <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg animate-pulse"></div>
      {/each}
    </div>
  {:else if groups.length > 0}
    {#each groups as group (group.label)}
      <h2 class="text-2xl font-bold text-white mb-4 mt-2">{group.label}</h2>
      <div data-focus-grid class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-6 pr-4 mb-10">
        {#each group.items as item (item.Id)}
          <PosterCard {item} {onOpenDetails} {onContextMenu} caption={cardCaption} />
        {/each}
      </div>
    {/each}
  {:else}
    <div class="flex items-center justify-center h-64">
      <p class="text-2xl text-gray-500 font-bold">{i18n.t.noItems}</p>
    </div>
  {/if}
</div>

{#if showBio && info?.Overview}
  <TextDialog title={person.Name} text={info.Overview} onClose={() => showBio = false} />
{/if}

{#if showShare}
  <ShareDialog target={shareTarget} hint={i18n.t.sharePersonHint} onClose={() => showShare = false}>
    <p class="text-white font-bold text-center break-words">{person.Name}</p>
  </ShareDialog>
{/if}
