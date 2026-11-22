<script>
  import { i18n } from '../i18n.svelte.js';
  import { authHeaders, timeOfDay } from '../utils.js';
  import { session } from '../session.svelte.js';
  import { watchlist } from '../watchlist.svelte.js';
  import { onMount, onDestroy } from 'svelte';

  let {
    use24h    = true,            // time format (derived from the setting)
    mode      = 'clock',         // 'clock' | 'art'
    artSource = 'random',        // 'random' | 'favorites' | 'watched' | 'unwatched'
    brightness = 0.45,           // art-mode brightness (0.45 dimmed = OLED default)
    userId    = '',
    onDismiss,                   // callback prop
  } = $props();

  let timeString = $state(''), dateString = $state('');
  let clockTick, moveTimer, firstMove, artTimer, firstArtTimeout, artWaitCap;
  let destroyed = false;

  function updateClock() {
    const now = new Date();
    // The app language IS a valid BCP-47 tag — Chromium 120 ships full ICU, so 'fr', 'pl', 'pt'
    // etc. all format correctly. The old de/en special-case gave six of eight languages English dates.
    const loc = i18n.lang || 'en';
    timeString = timeOfDay(now, use24h);
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
  let clockMoveTimeout = null;   // chained from moveClock; cleared in onDestroy like all the others
  function moveClock() {
    clockOn = false;                          // fade out
    clockMoveTimeout = setTimeout(() => {
      posX = 12 + Math.random() * 76;         // move invisibly to a new spot
      posY = 16 + Math.random() * 64;
      clockOn = true;                         // fade back in
    }, 1200);
  }

  // ── ART MODE ───────────────────────────────────────────────────────────────
  let artlist  = [];                          // [{ id, url, title, logo }] — internal data (not in the template)
  let ownPick  = null, fill = [], fillAt = 0;  // a ONE-title selection and the random titles it alternates with (loadArt)
  let slots    = $state([{ url: '', title: '', logo: null }, { url: '', title: '', logo: null }]);  // two crossfade layers
  let front    = $state(0);                   // visible layer
  let artIdx   = 0;
  let artReady = $state(false);               // true → show backdrops instead of the clock fallback
  // Gallery: BLACK while the list and the first picture load, then the picture fades in — no clock flashing up
  // first and giving way a moment later (CODE-HEALTH §114). The clock only when there is nothing to show, or
  // when the server has not delivered within ART_WAIT_CAP (a hanging request must not leave the screen empty
  // for good); should the pictures still arrive after that, the gallery takes over.
  let clockFallback = $state(false);          // art mode: true once the clock stands in (see startClock)
  const ART_WAIT_CAP = 5000;

  // Title logo (lettering) of the movie/series — like in the hero banner. maxHeight a bit larger for fullscreen.
  const logoUrl = (id, tag) => `${session.serverUrl}/Items/${id}/Images/Logo?tag=${tag}&maxHeight=240&quality=90&format=webp&ApiKey=${session.token}`;

  async function fetchBackdrops(filter) {
    const url = `${session.serverUrl}/Items?UserId=${userId}&Recursive=true&IncludeItemTypes=Movie,Series`
              + `${filter}&SortBy=Random&Limit=80&ImageTypeLimit=1`
              + `&EnableImageTypes=Backdrop,Logo&EnableTotalRecordCount=false`;
    const res = await fetch(url, { headers: authHeaders() });
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
    const url = `${session.serverUrl}/Shows/NextUp?UserId=${userId}&Limit=40`
              + `&ImageTypeLimit=1&EnableImageTypes=Backdrop,Logo&EnableTotalRecordCount=false`;
    const res = await fetch(url, { headers: authHeaders() });
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

  // Favourites + watchlist = the profile's own picks. The watchlist holds episodes (a series is added as one), so its
  // SERIES is shown, as with Next Up; one query for those IDs brings backdrop and logo the same way as the rest.
  async function fetchPicks() {
    const ids = [...new Set(watchlist.items.map(it => it.SeriesId || it.Id).filter(Boolean))];
    shuffle(ids);
    const [favorites, listed] = await Promise.all([
      fetchBackdrops('&Filters=IsFavorite'),
      ids.length ? fetchBackdrops(`&Ids=${ids.slice(0, 80).join(',')}`) : [],
    ]);
    return [...favorites, ...listed];
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
      let list, random = artSource === 'random';
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
      } else if (artSource === 'favorites') {
        list = await fetchPicks();
      } else {
        list = await fetchBackdrops('');
      }
      // Nothing in the chosen selection (no favourites yet, nothing watched yet, everything watched) → random titles
      // instead of the clock: whoever chose the gallery wants pictures (§115). A SHORT list is not topped up, though —
      // except a single title, below.
      if (!list.length && !random) { list = await fetchBackdrops(''); random = true; }
      // Deduplicate by ID across ALL sources: the same series / the same movie never appears
      // twice in the rotation (the first, higher-prioritized occurrence stays).
      const seen = new Set();
      list = list.filter(x => x.id && !seen.has(x.id) && seen.add(x.id));
      // Shuffle for a varied order. NO topping up with random titles — a selection of two or more is respected
      // strictly; the clock only when the library has no backdrops at all (or the request failed).
      shuffle(list);
      // ONE title cannot change the picture, and a picture standing still for hours is what a screen saver is there to
      // prevent (§116). It alternates with random titles then, a fresh one each round (newRound). Nothing to alternate
      // with (the library has this one backdrop) → the clock, which moves.
      if (list.length === 1) {
        fill = random ? [] : (await fetchBackdrops('')).filter(x => x.id !== list[0].id);
        if (fill.length) { ownPick = list[0]; list = [ownPick, fill[0]]; }
        else list = [];
      }
      artlist = list;
    } catch {
      artlist = [];
    }
  }

  function preload(u) { if (u) { const im = new Image(); im.src = u; } }

  // The next round. A one-title selection: that title, then the next random one — strictly alternating. Otherwise all
  // of them reshuffled, so one order does not recur 1:1, and never starting with the picture on screen.
  function newRound(shown) {
    if (ownPick) { fillAt = (fillAt + 1) % fill.length; artlist = [ownPick, fill[fillAt]]; return; }
    shuffle(artlist);
    if (artlist.length > 1 && artlist[0] === shown) [artlist[0], artlist[1]] = [artlist[1], artlist[0]];
  }

  // Put backdrop i into the hidden layer and fade that to the front (CSS opacity).
  function applyArt(i) {
    if (!artlist.length) return;
    const item = artlist[i % artlist.length];
    const back = front === 0 ? 1 : 0;
    slots[back] = item;   // deep reactivity: mutation is enough
    front = back;
  }

  function startClock() {
    if (destroyed || firstMove) return;
    clockFallback = true;
    firstMove = setTimeout(moveClock, CLOCK_FIRST_MOVE);
    moveTimer = setInterval(moveClock, CLOCK_INTERVAL);
  }
  function stopClock() {
    clearTimeout(firstMove); clearInterval(moveTimer); clearTimeout(clockMoveTimeout);
    firstMove = moveTimer = clockMoveTimeout = null;
  }

  onMount(async () => {
    updateClock();
    clockTick = setInterval(updateClock, 1000);

    if (mode === 'art') {
      artWaitCap = setTimeout(() => { if (!artReady) startClock(); }, ART_WAIT_CAP);
      await loadArt();
      // Dismissed while the list was loading? Then onDestroy has ALREADY run and cleared timer
      // handles that don't exist yet — everything created below would live forever. The art path
      // guards itself via `destroyed` inside startArt, but the clock FALLBACK below would start an
      // eternal 45 s interval on a dead component. One leaked interval per too-quick dismissal,
      // accumulating over weeks of use.
      if (destroyed) return;
      if (artlist.length) {
        // Preload the first backdrop and only then switch to art mode — picture and title appear together
        // (no "bare title over black"), the picture from the cache. Until then the screen stays black.
        const startArt = () => {
          if (artReady || destroyed) return;
          clearTimeout(firstArtTimeout);
          clearTimeout(artWaitCap);
          stopClock();                 // the cap may have put the clock up meanwhile
          // Show picture i and line up the next: on a round's last picture the next round is drawn NOW, so the preload
          // fetches the picture that really comes next (it used to fetch the old round's first, then reshuffle).
          const show = (i) => {
            applyArt(i);
            artIdx = i;
            if (artIdx + 1 >= artlist.length) { newRound(artlist[artIdx]); artIdx = -1; }
            preload(artlist[artIdx + 1]?.url);
          };
          show(0);
          artReady = true;
          const tick = () => {
            show(artIdx + 1);
            artTimer = setTimeout(tick, 30000 + Math.random() * 30000);   // 30–60 s
          };
          artTimer = setTimeout(tick, 30000 + Math.random() * 30000);
        };
        const pre = new Image();
        pre.onload = startArt;
        pre.onerror = startArt;          // start anyway – the DOM <img> retries
        pre.src = artlist[0].url;
        firstArtTimeout = setTimeout(startArt, 4000);   // safety net in case the preload hangs
        return;                          // black until the first image is there
      }
      // no backdrops, or one with nothing to alternate with (loadArt) → clock fallback (below)
      clearTimeout(artWaitCap);
    }

    // Clock mode (also fallback)
    startClock();
  });

  onDestroy(() => {
    destroyed = true;
    clearInterval(clockTick);
    clearInterval(moveTimer);
    clearTimeout(firstMove);
    clearTimeout(clockMoveTimeout);
    clearTimeout(artTimer);
    clearTimeout(firstArtTimeout);
    clearTimeout(artWaitCap);
  });

  function dismiss() { onDismiss?.(); }
  let useArt = $derived(mode === 'art' && artReady);

</script>

<!-- Black background protects OLED; in art mode strongly darkened backdrops in a crossfade. -->
<!-- Presentational full-screen overlay. It deliberately takes NO focus (tabindex="-1", no focus()
     call anywhere in this file), and that is what makes waking up seamless: focus stays on whatever
     was underneath and is still there afterwards. Keys are therefore NOT dismissed by the onkeydown
     below — without focus inside the overlay nothing targets it — but by resetActivity() on
     <svelte:window> in App, which every key press reaches. The handlers here cover pointer input and
     are kept as a local belt-and-braces. Do not "fix" the missing focus() call: it would take focus
     away from the view underneath and hand it back nowhere. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="fixed inset-0 bg-black z-[700] cursor-none select-none overflow-hidden"
     onclick={dismiss} onkeydown={dismiss} onpointermove={(e) => { if (e.target === e.currentTarget) dismiss(); }} tabindex="-1">

  {#if useArt}
    <!-- The gallery fades in from black once (ss-in: opacity only, on the compositor); then two layers crossfade. -->
    <div class="absolute inset-0 ss-in">
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
    </div>

  {:else if mode !== 'art' || clockFallback}
    <!-- CLOCK MODE: fades away and reappears at a new spot -->
    <div class="absolute pointer-events-none ss-clock" style="left:{posX}%; top:{posY}%; opacity:{clockOn ? 1 : 0}">
      <p class="text-gray-300 font-thin tabular-nums text-center" style="font-size: clamp(3rem, 8vw, 7rem); letter-spacing:0.15em">{timeString}</p>
      <p class="text-gray-400 text-center text-2xl font-light mt-1 tracking-wider">{dateString}</p>
      <p class="text-gray-600 text-center text-sm mt-3 tracking-widest font-medium">OCENFIN</p>   <!-- not `uppercase`: Turkish would write OCENFİN -->
    </div>
  {/if}
</div>

<style>
  .ss-fade  { transition: opacity 2s ease-in-out; }
  .ss-clock { transform: translate(-50%, -50%); transition: opacity 1.1s ease-in-out; }
  /* "Reduce animations" zeroes it (App) — then the gallery is simply there, which is its end state anyway. */
  .ss-in    { animation: ss-in 1.2s ease-out; }
  @keyframes ss-in { from { opacity: 0; } to { opacity: 1; } }
</style>
