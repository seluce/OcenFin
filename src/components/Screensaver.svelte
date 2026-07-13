<script>
  import { i18n } from '../i18n.svelte.js';
  import { authHeaders } from '../utils.js';
  import { session } from '../session.svelte.js';
  import { onMount, onDestroy } from 'svelte';

  let {
    use24h    = true,            // time format (derived from the setting)
    mode      = 'clock',         // 'clock' | 'art'
    artSource = 'watched',       // 'watched' | 'unwatched' | 'random'
    brightness = 0.45,           // art-mode brightness (0.45 dimmed = OLED default)
    userId    = '',
    onDismiss,                   // callback prop (instead of a 'dismiss' event)
  } = $props();

  let timeString = $state(''), dateString = $state('');
  let clockTick, moveTimer, firstMove, artTimer, firstArtTimeout;
  let destroyed = false;

  function updateClock() {
    const now = new Date();
    const loc = i18n.lang === 'de' ? 'de-DE' : 'en-US';
    timeString = now.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit', hour12: !use24h });
    dateString = now.toLocaleDateString(loc, { weekday: 'long', day: 'numeric', month: 'long' });
  }

  // ── CLOCK MODE ─────────────────────────────────────────────────────────────
  // Don't glide, but fade out gently → move invisibly to a new spot → fade in.
  // OLED best practice: a static element must shift its pixels regularly
  // before burn-in threatens. A change every ~45 s protects reliably without disturbing
  // through too frequent blinking (pixel-shift logic like the TV's own screensavers).
  const CLOCK_FIRST_MOVE = 20000;   // first change after 20 s
  const CLOCK_INTERVAL   = 45000;   // then every 45 s
  let posX = $state(30), posY = $state(35), clockOn = $state(true);
  let clockMoveTimeout = null;   // the only timer not yet cleaned up in onDestroy
  function moveClock() {
    clockOn = false;                          // fade out
    clockMoveTimeout = setTimeout(() => {
      posX = 12 + Math.random() * 76;         // move invisibly to a new spot
      posY = 16 + Math.random() * 64;
      clockOn = true;                         // fade back in
    }, 1200);
  }

  // ── ART MODE ───────────────────────────────────────────────────────────────
  let artlist  = [];                          // [{ url, title }] — internal data (not in the template)
  let slots    = $state([{ url: '', title: '', logo: null }, { url: '', title: '', logo: null }]);  // two crossfade layers
  let front    = $state(0);                   // visible layer
  let artIdx   = 0;
  let artReady = $state(false);               // true → show backdrops instead of the clock fallback

  // Title logo (lettering) of the movie/series — like in the hero banner. maxHeight a bit larger for fullscreen.
  const logoUrl = (id, tag) => `${session.serverUrl}/Items/${id}/Images/Logo?tag=${tag}&maxHeight=240&quality=90&format=webp&ApiKey=${session.token}`;

  async function fetchBackdrops(filter) {
    const url = `${session.serverUrl}/Users/${userId}/Items?Recursive=true&IncludeItemTypes=Movie,Series`
              + `${filter}&SortBy=Random&Limit=80&Fields=BackdropImageTags&ImageTypeLimit=1`
              + `&EnableImageTypes=Backdrop,Logo&EnableTotalRecordCount=false`;
    const res = await fetch(url, { headers: authHeaders(session.token) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.Items || [])
      .filter(it => it.BackdropImageTags && it.BackdropImageTags.length)
      .map(it => ({
        id: it.Id,
        url: `${session.serverUrl}/Items/${it.Id}/Images/Backdrop/0?tag=${it.BackdropImageTags[0]}&maxWidth=1920&quality=85&format=webp&ApiKey=${session.token}`,
        title: it.Name || '',
        logo: it.ImageTags?.Logo ? logoUrl(it.Id, it.ImageTags.Logo) : null,
      }));
  }

  // Next Up = the next episode of ongoing series → for "current". Returns episodes; shown is the
  // SERIES backdrop (via SeriesId + inherited ParentBackdropImageTags) with the series title.
  async function fetchNextUp() {
    const url = `${session.serverUrl}/Shows/NextUp?UserId=${userId}&Limit=40&Fields=ParentBackdropImageTags`
              + `&ImageTypeLimit=1&EnableImageTypes=Backdrop,Logo&EnableTotalRecordCount=false`;
    const res = await fetch(url, { headers: authHeaders(session.token) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.Items || [])
      .filter(ep => ep.SeriesId && ep.ParentBackdropImageTags && ep.ParentBackdropImageTags.length)
      .map(ep => ({
        id: ep.SeriesId,
        url: `${session.serverUrl}/Items/${ep.SeriesId}/Images/Backdrop/0?tag=${ep.ParentBackdropImageTags[0]}&maxWidth=1920&quality=85&format=webp&ApiKey=${session.token}`,
        title: ep.SeriesName || ep.Name || '',
        logo: ep.ParentLogoImageTag ? logoUrl(ep.ParentLogoItemId || ep.SeriesId, ep.ParentLogoImageTag) : null,
      }));
  }

  // Fisher-Yates, in-place
  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  async function loadArt() {
    if (!session.serverUrl || !userId || !session.token) return;
    try {
      let list;
      if (artSource === 'watched') {
        // "Watched / current" = ongoing series (Next Up) + started titles (Resume) + fully
        // watched, merged. The order prioritizes the current, deduplicated by ID.
        const [nextUp, resuming, played] = await Promise.all([
          fetchNextUp(),
          fetchBackdrops('&Filters=IsResumable'),
          fetchBackdrops('&Filters=IsPlayed'),
        ]);
        // The order prioritizes the current; deduplication is done by the universal pass below.
        list = [...nextUp, ...resuming, ...played];
      } else if (artSource === 'unwatched') {
        list = await fetchBackdrops('&Filters=IsUnplayed');
      } else {
        list = await fetchBackdrops('');
      }
      // Deduplicate by ID across ALL sources: the same series / the same movie never appears
      // twice in the rotation (the first, higher-prioritized occurrence stays).
      const seen = new Set();
      list = list.filter(x => x.id && !seen.has(x.id) && seen.add(x.id));
      // Shuffle for a varied order. NO topping up with random titles — the selection
      // (watched/unwatched) is respected strictly; if it's empty → clock fallback.
      shuffle(list);
      artlist = list;
    } catch {
      artlist = [];
    }
  }

  function preload(u) { if (u) { const im = new Image(); im.src = u; } }

  // Put backdrop i into the hidden layer and fade that to the front (CSS opacity).
  function applyArt(i) {
    if (!artlist.length) return;
    const item = artlist[i % artlist.length];
    const back = front === 0 ? 1 : 0;
    slots[back] = item;   // deep reactivity: mutation is enough (no more "slots = slots" needed)
    front = back;
  }

  onMount(async () => {
    updateClock();
    clockTick = setInterval(updateClock, 1000);

    if (mode === 'art') {
      await loadArt();
      if (artlist.length) {
        // Preload the first backdrop and only then switch to art mode. Until then the clock shows
        // as a calm placeholder (no "bare title over black"); then the image from the cache
        // fades in immediately. This doesn't shorten the network time but makes it feel intentional.
        const startArt = () => {
          if (artReady || destroyed) return;
          clearTimeout(firstArtTimeout);
          applyArt(0);
          artIdx = 0;
          artReady = true;
          preload(artlist[1]?.url);
          const tick = () => {
            if (artIdx + 1 >= artlist.length) {
              // All backdrops shown once → reshuffle the repeat round so the
              // same order doesn't recur 1:1. Then make sure the just-shown image
              // doesn't land right back at position 0 (no immediate double).
              const lastShown = artlist[artIdx];
              shuffle(artlist);
              if (artlist.length > 1 && artlist[0] === lastShown) [artlist[0], artlist[1]] = [artlist[1], artlist[0]];
              artIdx = 0;
            } else {
              artIdx++;
            }
            applyArt(artIdx);
            preload(artlist[(artIdx + 1) % artlist.length]?.url);
            artTimer = setTimeout(tick, 30000 + Math.random() * 30000);   // 30–60 s
          };
          artTimer = setTimeout(tick, 30000 + Math.random() * 30000);
        };
        const pre = new Image();
        pre.onload = startArt;
        pre.onerror = startArt;          // start anyway – the DOM <img> retries
        pre.src = artlist[0].url;
        firstArtTimeout = setTimeout(startArt, 4000);   // safety net in case the preload hangs
        return;                          // the clock runs as a placeholder until the first image is there
      }
      // no backdrops available → clock fallback (below)
    }

    // Clock mode (also fallback)
    firstMove = setTimeout(moveClock, CLOCK_FIRST_MOVE);
    moveTimer = setInterval(moveClock, CLOCK_INTERVAL);
  });

  onDestroy(() => {
    destroyed = true;
    clearInterval(clockTick);
    clearInterval(moveTimer);
    clearTimeout(firstMove);
    clearTimeout(clockMoveTimeout);
    clearTimeout(artTimer);
    clearTimeout(firstArtTimeout);
  });

  function dismiss() { onDismiss?.(); }
  let useArt = $derived(mode === 'art' && artReady);

</script>

<!-- Black background protects OLED; in art mode strongly darkened backdrops in a crossfade. -->
<!-- Presentational full-screen overlay: it grabs focus and dismisses on ANY input (click/key/pointer);
     keyboard dismiss is already wired via onkeydown. It's an exit surface, not a control to navigate to. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="fixed inset-0 bg-black z-[700] cursor-none select-none overflow-hidden"
     onclick={dismiss} onkeydown={dismiss} onpointermove={(e) => { if (e.target === e.currentTarget) dismiss(); }} tabindex="-1">

  {#if useArt}
    <!-- Two layers for a smooth crossfade -->
    {#each slots as slot, i}
      <div class="absolute inset-0 ss-fade pointer-events-none" style="opacity:{front === i ? 1 : 0}">
        {#if slot.url}
          <img src={slot.url} alt="" class="w-full h-full object-cover" style="filter: brightness({brightness})" />
        {/if}
      </div>
    {/each}
    <!-- Darkening + gradient at the bottom (legibility + panel protection) -->
    <div class="absolute inset-0 pointer-events-none"
         style="background: linear-gradient(to top, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.3) 38%, rgba(0,0,0,0.55) 100%)"></div>
    <!-- Title + clock at the bottom -->
    <div class="absolute bottom-0 left-0 right-0 p-12 pointer-events-none ss-fade">
      {#if slots[front].logo}
        <img src={slots[front].logo} alt={slots[front].title} class="max-h-[18vh] max-w-[55%] object-contain object-left drop-shadow-lg" />
      {:else}
        <p class="text-white/90 font-semibold drop-shadow-lg" style="font-size: clamp(2rem, 4.5vw, 4rem)">{slots[front].title}</p>
      {/if}
      <p class="text-white/55 tabular-nums mt-2" style="font-size: clamp(1.2rem, 2vw, 2rem); letter-spacing:0.1em">{timeString} · {dateString}</p>
    </div>

  {:else}
    <!-- CLOCK MODE: fades away and reappears at a new spot -->
    <div class="absolute pointer-events-none ss-clock" style="left:{posX}%; top:{posY}%; opacity:{clockOn ? 1 : 0}">
      <p class="text-gray-300 font-thin tabular-nums text-center" style="font-size: clamp(3rem, 8vw, 7rem); letter-spacing:0.15em">{timeString}</p>
      <p class="text-gray-400 text-center text-2xl font-light mt-1 tracking-wider">{dateString}</p>
      <p class="text-gray-600 text-center text-sm mt-3 tracking-widest font-medium uppercase">OcenFin</p>
    </div>
  {/if}
</div>

<style>
  .ss-fade  { transition: opacity 2s ease-in-out; }
  .ss-clock { transform: translate(-50%, -50%); transition: opacity 1.1s ease-in-out; }
</style>
