<script>
  // Find a subtitle with the server's subtitle providers (OpenSubtitles plugin and the like) and have
  // the server download it next to the file. Jellyfin 12: GET /Items/{id}/RemoteSearch/Subtitles/
  // {lang} lists, POST …/{subtitleId} downloads and queues a refresh of the item — the new track turns
  // up in its MediaStreams a moment later, which the caller waits for (onDownloaded).
  // Both calls need the SubtitleManagement policy (admin or "allow subtitle management"); Details
  // only offers the entry to such profiles.
  import { i18n, LANGUAGES } from '../i18n.svelte.js';
  import { session } from '../session.svelte.js';
  import { authHeaders, focusOnMount, isBackKey, uiFade, dropTrapOnOutro } from '../utils.js';
  import { onMount } from 'svelte';

  let {
    item,                 // the title (Movie/Episode) — Id and Name
    initialLang = 'en',   // app language key (LANGUAGES[].key) to search first
    onClose,              // () => void
    onDownloaded,         // () => Promise<boolean> — true once the new track is on the title
  } = $props();

  // svelte-ignore state_referenced_locally
  let lang     = $state(LANGUAGES.some(l => l.key === initialLang) ? initialLang : 'en');
  let results  = $state([]);
  let status   = $state('idle');   // idle | searching | done | failed | downloading | applying | later
  let busyId   = $state(null);     // the result being downloaded
  let searchToken = 0;

  const code = (key) => LANGUAGES.find(l => l.key === key)?.codes[0] || 'eng';   // Jellyfin's ISO 639-2/B

  async function search(key) {
    lang = key;
    const my = ++searchToken;
    status = 'searching'; results = [];
    try {
      const res = await fetch(`${session.serverUrl}/Items/${item.Id}/RemoteSearch/Subtitles/${code(key)}?isPerfectMatch=false`,
        { headers: authHeaders(session.token) });
      if (my !== searchToken) return;
      if (!res.ok) { console.warn('[subtitles] search: HTTP', res.status); status = 'failed'; return; }
      const list = (await res.json()) || [];
      if (my !== searchToken) return;
      // Exact file matches first, then what most people downloaded.
      results = list.slice().sort((a, b) => (!!b.IsHashMatch - !!a.IsHashMatch)
        || ((b.DownloadCount || 0) - (a.DownloadCount || 0))).slice(0, 30);
      status = 'done';
    } catch (e) { if (my === searchToken) { console.warn('[subtitles] search failed', e); status = 'failed'; } }
  }

  async function download(r) {
    if (busyId) return;
    busyId = r.Id; status = 'downloading';
    try {
      const res = await fetch(`${session.serverUrl}/Items/${item.Id}/RemoteSearch/Subtitles/${encodeURIComponent(r.Id)}`,
        { method: 'POST', headers: authHeaders(session.token) });
      if (!res.ok) { console.warn('[subtitles] download: HTTP', res.status); status = 'failed'; busyId = null; return; }
    } catch (e) { console.warn('[subtitles] download failed', e); status = 'failed'; busyId = null; return; }
    // Downloaded; the server reads it in on its own schedule. Close once the track is there, or say
    // that it will turn up rather than pretending it failed.
    status = 'applying';
    const found = await onDownloaded?.();
    if (found) onClose?.();
    else { status = 'later'; busyId = null; }
  }

  function meta(r) {
    const parts = [r.ProviderName, r.Format?.toUpperCase()].filter(Boolean);
    if (r.CommunityRating) parts.push(`★ ${Number(r.CommunityRating).toFixed(1)}`);
    if (r.DownloadCount)   parts.push(`↓ ${r.DownloadCount.toLocaleString(i18n.lang)}`);
    return parts.join(' · ');
  }

  onMount(() => search(lang));
</script>

<div class="fixed inset-0 bg-black/90 z-[100] flex items-center justify-center p-8" role="dialog" tabindex="-1"
  transition:uiFade onoutrostart={dropTrapOnOutro}
  onkeydown={(e) => { if (isBackKey(e)) { e.stopPropagation(); onClose?.(); } }}>
  <div data-modal data-focus-trap
    class="bg-gray-800 border border-gray-700 rounded-2xl p-8 w-full max-w-3xl max-h-[85vh] flex flex-col gap-5 shadow-2xl">
    <div class="flex items-center justify-between gap-4">
      <div class="min-w-0">
        <h2 class="text-3xl text-white font-bold">{i18n.t.subtitleSearchTitle}</h2>
        <p class="text-gray-400 truncate">{item?.Name}</p>
      </div>
      <button onclick={() => onClose?.()}
        class="shrink-0 px-5 py-3 rounded-xl font-bold bg-gray-700 hover:bg-gray-600 focus:bg-gray-600 text-white
               focus:outline-none focus:ring-4 focus:ring-white transition-colors">{i18n.t.close}</button>
    </div>

    <!-- Language: the app's eight; the search runs again on every pick -->
    <div class="flex flex-wrap gap-2">
      {#each LANGUAGES as l (l.key)}
        <button onclick={() => search(l.key)} {@attach focusOnMount(l.key === lang)}
          class="px-4 py-2 rounded-lg text-sm font-bold focus:outline-none focus:ring-2 focus:ring-white transition-colors
                 {l.key === lang ? 'bg-blue-600 text-white' : 'bg-gray-900 text-gray-300 hover:bg-gray-700 focus:bg-gray-700'}">
          {l.name}
        </button>
      {/each}
    </div>

    <div class="flex-1 min-h-0 overflow-y-auto hide-scrollbar flex flex-col gap-2 [scroll-padding-top:1rem]">
      {#if status === 'searching'}
        <div class="py-10 flex justify-center"><div class="w-10 h-10 border-4 border-gray-600 border-t-blue-500 rounded-full animate-spin"></div></div>
      {:else if status === 'failed'}
        <p class="py-8 text-center text-red-400 font-semibold">{i18n.t.subtitleSearchFailed}</p>
      {:else if status === 'later'}
        <p class="py-8 text-center text-gray-300">{i18n.t.subtitleAddedLater}</p>
      {:else if status === 'done' && !results.length}
        <p class="py-8 text-center text-gray-400 max-w-xl mx-auto">{i18n.t.subtitleSearchNone}</p>
      {:else}
        {#each results as r (r.Id)}
          <button onclick={() => download(r)}
            class="text-left px-4 py-3 rounded-xl bg-gray-900 hover:bg-gray-700 focus:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-white
                   flex items-center gap-4 {busyId && busyId !== r.Id ? 'opacity-50' : ''}">
            <div class="flex-1 min-w-0">
              <div class="text-white font-semibold truncate">{r.Name || r.Id}</div>
              <div class="text-sm text-gray-400 truncate">{meta(r)}</div>
            </div>
            <div class="flex gap-1.5 shrink-0">
              {#if r.IsHashMatch}<span class="px-2 py-0.5 rounded bg-green-700/60 text-green-200 text-xs font-bold">{i18n.t.subtitleExactMatch}</span>{/if}
              {#if r.Forced}<span class="px-2 py-0.5 rounded bg-gray-700 text-gray-200 text-xs font-bold">{i18n.t.subtitleForced}</span>{/if}
              {#if r.HearingImpaired}<span class="px-2 py-0.5 rounded bg-gray-700 text-gray-200 text-xs font-bold">SDH</span>{/if}
              {#if r.MachineTranslated || r.AiTranslated}<span class="px-2 py-0.5 rounded bg-amber-800/60 text-amber-200 text-xs font-bold">{i18n.t.subtitleMachine}</span>{/if}
            </div>
            {#if busyId === r.Id}
              <div class="w-6 h-6 border-2 border-gray-500 border-t-blue-400 rounded-full animate-spin shrink-0"></div>
            {/if}
          </button>
        {/each}
      {/if}
    </div>

    {#if status === 'downloading' || status === 'applying'}
      <p class="text-blue-300 text-center font-semibold">{status === 'downloading' ? i18n.t.subtitleDownloading : i18n.t.subtitleApplying}</p>
    {/if}
  </div>
</div>
