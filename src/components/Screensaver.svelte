<script>
  import { currentLang } from '../i18n.js';
  import { authHeaders } from '../utils.js';
  import { session } from '../session.svelte.js';
  import { onMount, onDestroy } from 'svelte';

  let {
    use24h    = true,            // Zeitformat (aus Einstellung abgeleitet)
    mode      = 'clock',         // 'clock' | 'art'
    artSource = 'watched',       // 'watched' | 'unwatched' | 'random'
    brightness = 0.45,           // Art-Mode-Helligkeit (0.45 gedimmt = OLED-Standard)
    userId    = '',
    onDismiss,                   // Callback-Prop (statt 'dismiss'-Event)
  } = $props();

  let timeString = $state(''), dateString = $state('');
  let clockTick, moveTimer, firstMove, artTimer, firstArtTimeout;
  let destroyed = false;

  function updateClock() {
    const now = new Date();
    const loc = $currentLang === 'de' ? 'de-DE' : 'en-US';
    timeString = now.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit', hour12: !use24h });
    dateString = now.toLocaleDateString(loc, { weekday: 'long', day: 'numeric', month: 'long' });
  }

  // ── UHR-MODUS ──────────────────────────────────────────────────────────────
  // Nicht gleiten, sondern sanft ausblenden → unsichtbar an neue Stelle → einblenden.
  // OLED-Best-Practice: ein statisches Element muss seine Pixel regelmäßig verschieben,
  // bevor Einbrennen droht. Ein Wechsel alle ~45 s schützt zuverlässig, ohne durch zu
  // häufiges Blinken zu stören (Pixel-Shift-Logik wie bei TV-eigenen Schonern).
  const CLOCK_FIRST_MOVE = 20000;   // erster Wechsel nach 20 s
  const CLOCK_INTERVAL   = 45000;   // danach alle 45 s
  let posX = $state(30), posY = $state(35), clockOn = $state(true);
  function moveClock() {
    clockOn = false;                          // ausblenden
    setTimeout(() => {
      posX = 12 + Math.random() * 76;         // unsichtbar an neue Stelle setzen
      posY = 16 + Math.random() * 64;
      clockOn = true;                         // wieder einblenden
    }, 1200);
  }

  // ── ART-MODUS ──────────────────────────────────────────────────────────────
  let artlist  = [];                          // [{ url, title }] — interne Daten (nicht im Template)
  let slots    = $state([{ url: '', title: '' }, { url: '', title: '' }]);  // zwei Crossfade-Ebenen
  let front    = $state(0);                   // sichtbare Ebene
  let artIdx   = 0;
  let artReady = $state(false);               // true → Backdrops anzeigen statt Uhr-Fallback

  async function fetchBackdrops(filter) {
    const url = `${session.serverUrl}/Users/${userId}/Items?Recursive=true&IncludeItemTypes=Movie,Series`
              + `${filter}&SortBy=Random&Limit=80&Fields=BackdropImageTags&ImageTypeLimit=1`
              + `&EnableImageTypes=Backdrop&EnableTotalRecordCount=false`;
    const res = await fetch(url, { headers: authHeaders(session.token) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.Items || [])
      .filter(it => it.BackdropImageTags && it.BackdropImageTags.length)
      .map(it => ({
        id: it.Id,
        url: `${session.serverUrl}/Items/${it.Id}/Images/Backdrop/0?tag=${it.BackdropImageTags[0]}&maxWidth=1920&quality=85&ApiKey=${session.token}`,
        title: it.Name || '',
      }));
  }

  // Next Up = nächste Folge laufender Serien → für "aktuell". Liefert Episoden; gezeigt wird das
  // SERIEN-Backdrop (über SeriesId + geerbte ParentBackdropImageTags) mit dem Serientitel.
  async function fetchNextUp() {
    const url = `${session.serverUrl}/Shows/NextUp?UserId=${userId}&Limit=40&Fields=ParentBackdropImageTags`
              + `&ImageTypeLimit=1&EnableImageTypes=Backdrop&EnableTotalRecordCount=false`;
    const res = await fetch(url, { headers: authHeaders(session.token) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.Items || [])
      .filter(ep => ep.SeriesId && ep.ParentBackdropImageTags && ep.ParentBackdropImageTags.length)
      .map(ep => ({
        id: ep.SeriesId,
        url: `${session.serverUrl}/Items/${ep.SeriesId}/Images/Backdrop/0?tag=${ep.ParentBackdropImageTags[0]}&maxWidth=1920&quality=85&ApiKey=${session.token}`,
        title: ep.SeriesName || ep.Name || '',
      }));
  }

  async function loadArt() {
    if (!session.serverUrl || !userId || !session.token) return;
    try {
      let list;
      if (artSource === 'watched') {
        // "Gesehen / aktuell" = laufende Serien (Next Up) + angefangene Titel (Resume) + komplett
        // Gesehenes, zusammengeführt. Reihenfolge priorisiert das Aktuelle, dedupliziert per Id.
        const [nextUp, resuming, played] = await Promise.all([
          fetchNextUp(),
          fetchBackdrops('&Filters=IsResumable'),
          fetchBackdrops('&Filters=IsPlayed'),
        ]);
        const seen = new Set(); list = [];
        for (const x of [...nextUp, ...resuming, ...played]) if (!seen.has(x.id)) { seen.add(x.id); list.push(x); }
      } else if (artSource === 'unwatched') {
        list = await fetchBackdrops('&Filters=IsUnplayed');
      } else {
        list = await fetchBackdrops('');
      }
      // mischen (Fisher-Yates) für abwechslungsreiche Reihenfolge. KEIN Auffüllen mit Zufallstiteln
      // mehr – die Auswahl (gesehen/ungesehen) wird strikt respektiert; ist sie leer → Uhr-Fallback.
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      artlist = list;
    } catch {
      artlist = [];
    }
  }

  function preload(u) { if (u) { const im = new Image(); im.src = u; } }

  // Backdrop i in die verdeckte Ebene legen und diese nach vorn blenden (CSS-Opacity).
  function applyArt(i) {
    if (!artlist.length) return;
    const item = artlist[i % artlist.length];
    const back = front === 0 ? 1 : 0;
    slots[back] = item;   // Deep Reactivity: Mutation reicht (kein "slots = slots" mehr nötig)
    front = back;
  }

  onMount(async () => {
    updateClock();
    clockTick = setInterval(updateClock, 1000);

    if (mode === 'art') {
      await loadArt();
      if (artlist.length) {
        // Erstes Backdrop vorladen und erst danach auf Art-Mode umschalten. Bis dahin zeigt sich die
        // Uhr als ruhiger Platzhalter (kein „nackter Titel über Schwarz"); dann blendet das Bild aus
        // dem Cache sofort ein. Das verkürzt nicht die Netzwerkzeit, lässt sie aber gewollt wirken.
        const startArt = () => {
          if (artReady || destroyed) return;
          clearTimeout(firstArtTimeout);
          applyArt(0);
          artIdx = 0;
          artReady = true;
          preload(artlist[1]?.url);
          const tick = () => {
            artIdx = (artIdx + 1) % artlist.length;
            applyArt(artIdx);
            preload(artlist[(artIdx + 1) % artlist.length]?.url);
            artTimer = setTimeout(tick, 30000 + Math.random() * 30000);   // 30–60 s
          };
          artTimer = setTimeout(tick, 30000 + Math.random() * 30000);
        };
        const pre = new Image();
        pre.onload = startArt;
        pre.onerror = startArt;          // trotzdem starten – das DOM-<img> versucht es erneut
        pre.src = artlist[0].url;
        firstArtTimeout = setTimeout(startArt, 4000);   // Sicherheitsnetz, falls der Preload hängt
        return;                          // Uhr läuft als Platzhalter, bis das erste Bild da ist
      }
      // keine Backdrops verfügbar → Uhr-Fallback (unten)
    }

    // Uhr-Modus (auch Fallback)
    firstMove = setTimeout(moveClock, CLOCK_FIRST_MOVE);
    moveTimer = setInterval(moveClock, CLOCK_INTERVAL);
  });

  onDestroy(() => {
    destroyed = true;
    clearInterval(clockTick);
    clearInterval(moveTimer);
    clearTimeout(firstMove);
    clearTimeout(artTimer);
    clearTimeout(firstArtTimeout);
  });

  function dismiss() { onDismiss?.(); }
  let useArt = $derived(mode === 'art' && artReady);
</script>

<!-- Schwarzer Grund schont OLED; im Art-Modus stark abgedunkelte Backdrops im Crossfade. -->
<div class="fixed inset-0 bg-black z-[500] cursor-none select-none overflow-hidden"
     onclick={dismiss} onkeydown={dismiss} onpointermove={(e) => { if (e.target === e.currentTarget) dismiss(); }} tabindex="-1">

  {#if useArt}
    <!-- Zwei Ebenen für sanftes Überblenden -->
    {#each slots as slot, i}
      <div class="absolute inset-0 ss-fade pointer-events-none" style="opacity:{front === i ? 1 : 0}">
        {#if slot.url}
          <img src={slot.url} alt="" class="w-full h-full object-cover" style="filter: brightness({brightness})" />
        {/if}
      </div>
    {/each}
    <!-- Abdunkelung + Verlauf unten (Lesbarkeit + Panelschutz) -->
    <div class="absolute inset-0 pointer-events-none"
         style="background: linear-gradient(to top, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.3) 38%, rgba(0,0,0,0.55) 100%)"></div>
    <!-- Titel + Uhr unten -->
    <div class="absolute bottom-0 left-0 right-0 p-12 pointer-events-none ss-fade">
      <p class="text-white/90 font-semibold drop-shadow-lg" style="font-size: clamp(2rem, 4.5vw, 4rem)">{slots[front].title}</p>
      <p class="text-white/55 tabular-nums mt-2" style="font-size: clamp(1.2rem, 2vw, 2rem); letter-spacing:0.1em">{timeString} · {dateString}</p>
    </div>

  {:else}
    <!-- UHR-MODUS: blendet weg und erscheint an neuer Stelle -->
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
