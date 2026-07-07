<script>
  import { i18n } from '../i18n.svelte.js';
  import { itemProgress, itemBadge, longPress, authHeaders, blurUp, itemBlurHash, uiFade, getItemSubtitle } from '../utils.js';
  import { session } from '../session.svelte.js';
  import { onMount, onDestroy } from 'svelte';

  let {
    selectedUser,
    apiCache,
    reduceAnimations = false,   // steuert Hero-Auto-Rotation
    showHero         = true,    // Hero-Banner anzeigen (Einstellung)
    dashboardBackdrop = true,   // Backdrop des fokussierten Titels hinter dem Dashboard (Opt-out)
    showLibraries    = true,    // "Meine Mediatheken"-Zeile anzeigen
    showHistory      = true,    // "Zuletzt gesehen"-Zeile anzeigen
    showNextUp       = true,    // "Als Nächstes"-Zeile anzeigen
    showRecommendations = true, // "Weil du … gesehen hast"-Zeile anzeigen
    recommendationRows   = 1,   // 1 oder 2 Empfehlungs-Reihen
    showLatest       = true,    // "Zuletzt hinzugefügt" (Filme + Serien)
    showCollections  = true,    // "Sammlungen" (BoxSets)
    sharedSuggestions = [],     // "Für euch beide" — Titel, die zur gemeinsamen Vorliebe passen
    showSharedSuggestions = false, // Reihe anzeigen (nur wenn gemeinsames Profil eingerichtet)
    resumeStale = false,        // App: seit dem letzten Dashboard-Besuch lief eine Wiedergabe → Resume/NextUp frisch holen
    onResumeRefreshed,          // () => void — App setzt das Flag zurück
    onLibrariesLoaded, onOpenCollection, onOpenContext, onOpenDetails, onOpenLibrary,   // Callback-Props
  } = $props();

  let isLoading        = $state(false);
  let libraries        = $state([]);
  // An App melden, sobald die Mediatheken da sind (Cache-Hit oder Fetch) — speist die
  // Sidebar/Navigation reaktiv, ohne dass App separat fetchen muss (verhindert Race).
  $effect(() => { if (libraries.length) onLibrariesLoaded?.(libraries); });
  let continueWatching = $state([]);
  let nextUp           = $state([]);
  let latestMovies     = $state([]);
  let latestSeries     = $state([]);
  let recentlyWatched  = $state([]);   // "Zuletzt gesehen" (Verlauf)
  let recommendations  = $state([]);   // [{ seedTitle, items }] — "Weil du X gesehen hast"
  let collections      = $state([]);   // BoxSets ("Sammlungen")

  // "Weiterschauen" reaktiv ableiten: ein in-place als gesehen markiertes / zurückgesetztes Item
  // (ContextMenu mutiert item.UserData direkt) verschwindet sofort aus der Zeile — ohne Reload.
  let resumeRow = $derived(continueWatching.filter(
    i => !i.UserData?.Played && (i.UserData?.PlaybackPositionTicks || 0) > 0
  ));

  // HERO-BANNER: rotierendes Featured-Item (Netflix-Stil)
  let heroItems  = $state([]);
  let heroIndex  = $state(0);
  let prevHeroIndex = $state(-1);   // vorheriges Bild bleibt beim Wechsel als Unterlage stehen (Crossfade statt Dip-to-Black)
  let heroTimer;
  let heroBuilt  = false;   // pro Laden: true, sobald der Hero einmal gebaut ist (verhindert Neu-Mischen beim zweiten Latest-Fetch)
  let heroForYouPending = false;   // true, solange der "Für dich"-Fetch läuft → Neuzugangs-Fallback wartet, bis er entschieden hat
  let heroLoading = $state(false);   // true, solange die Featured-Daten noch laden → Platz reservieren (kein Nachrücken)
  let heroCurrent = $derived(heroItems[heroIndex] || null);

  const skeletons = Array(6).fill(0);

  onMount(() => { loadDashboardData(); });
  onDestroy(() => { clearInterval(heroTimer); clearTimeout(previewTimer); clearTimeout(clearTimer); });

  // ── Backdrop-Vorschau (wie in der Library): 700 ms nach Fokus auf einer Karte deren Backdrop
  //    hinter dem Dashboard einblenden; beim Verlassen wieder weg. Opt-out via dashboardBackdrop. ──
  let previewBackdrop = $state("");
  let previewTimer, clearTimer;
  function previewItem(item) {
    if (!dashboardBackdrop || !item) return;
    clearTimeout(clearTimer);   // folgt direkt ein Karten-Fokus → NICHT leeren (kein Flackern Karte→Karte)
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      const tag  = item.BackdropImageTags?.[0];
      const pTag = item.ParentBackdropImageTags?.[0];
      if (tag)       previewBackdrop = `${session.serverUrl}/Items/${item.Id}/Images/Backdrop?tag=${tag}&maxWidth=1280&quality=70&format=webp`;
      else if (pTag) previewBackdrop = `${session.serverUrl}/Items/${item.ParentBackdropItemId}/Images/Backdrop?tag=${pTag}&maxWidth=1280&quality=70&format=webp`;
    }, 700);
  }
  // Fokus verlässt eine Karte: Einblende-Timer stoppen und das Backdrop kurz verzögert leeren.
  // Folgt sofort ein anderer Karten-Fokus (Karte→Karte), bricht previewItem das Leeren ab → kein
  // Flackern. Geht der Fokus zum Hero, zu den Mediathek-Kacheln oder zur Navigation, bleibt es beim
  // Leeren → kein Backdrop hinter dem Hero mehr (siehe Screenshot-Problem).
  // Backdrop-Deckkraft an die Hero-Sichtbarkeit koppeln: ganz oben (Hero sichtbar) aus → kein
  // Konflikt mit dem Hero-Bild; beim Runterscrollen blendet es ein, sobald der Hero das Bild
  // verlässt. So bekommen auch Weiterschauen/Als Nächstes das Backdrop, nur eben erst beim Scrollen.
  let bgOpacity = $state(0);
  function heroScrollFade(node) {
    let sc = node.parentElement;   // scrollenden Vorfahren (App-Hauptbereich) suchen
    while (sc && !(/(auto|scroll)/.test(getComputedStyle(sc).overflowY) && sc.scrollHeight > sc.clientHeight + 4)) sc = sc.parentElement;
    if (!sc) { bgOpacity = 1; return; }
    let raf = 0;
    const update = () => {
      raf = 0;
      if (!showHero || !heroItems.length) { bgOpacity = 1; return; }   // kein Hero → kein Konflikt, voll zeigen
      const heroH = sc.clientHeight * 0.44;   // entspricht der Hero-Höhe (h-[44vh])
      bgOpacity = Math.min(1, Math.max(0, sc.scrollTop / heroH));
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(update); };
    sc.addEventListener("scroll", onScroll, { passive: true });
    update();   // Anfangswert sofort
    return () => { sc.removeEventListener("scroll", onScroll); if (raf) cancelAnimationFrame(raf); };
  }

  function cancelPreview() {
    clearTimeout(previewTimer);
    clearTimeout(clearTimer);
    clearTimer = setTimeout(() => { previewBackdrop = ""; }, 150);
  }

  // Featured-Liste aus neuesten Filmen/Serien mit Backdrop bauen + Rotation starten
  // Lädt das Bild des nächsten Hero-Items vorab → nahtloser Wechsel ohne Aufploppen.
  function preloadHero(index) {
    const next = heroItems[index];
    if (!next) return;
    const url = getHeroBackdrop(next);
    if (url) { const img = new Image(); img.src = url; }
  }

  // Titel ausschließen, die bereits in "Weiterschauen" laufen (keine Dopplung); Serien auch über SeriesId.
  function heroInProgressSet() {
    const inProgress = new Set();
    continueWatching.forEach(i => { inProgress.add(i.Id); if (i.SeriesId) inProgress.add(i.SeriesId); });
    return inProgress;
  }

  // Rotation für die bereits gesetzten heroItems starten (gemeinsam für "Für dich" und Fallback).
  function startHeroRotation() {
    heroIndex = 0;
    prevHeroIndex = -1;
    heroBuilt = true;
    heroLoading = false;   // Hero steht → Skelett weg
    clearInterval(heroTimer);
    if (apiCache.dashboard) apiCache.dashboard.heroItems = heroItems;   // cache-fest: Dashboard-Wechsel lädt nicht neu
    if (!reduceAnimations && heroItems.length > 1) {
      preloadHero(1);   // nächstes Bild schon laden
      heroTimer = setInterval(() => {
        prevHeroIndex = heroIndex;
        heroIndex = (heroIndex + 1) % heroItems.length;
        preloadHero((heroIndex + 1) % heroItems.length);
      }, 8000);
    }
  }

  // "Für dich"-Pool (rating-sortiert) in den Hero übernehmen. Leicht durchmischen unter den
  // Top-Bewerteten, damit Qualität oben bleibt, aber nicht immer dieselben 5 gleich sortiert stehen.
  // false = Pool zu dünn → Aufrufer nutzt den Neuzugangs-Fallback.
  function applyHeroPool(pool) {
    if (heroBuilt) return true;
    const inProgress = heroInProgressSet();
    const filtered = (pool || []).filter(i => i.BackdropImageTags?.length > 0 && !inProgress.has(i.Id));
    if (filtered.length < HERO_MIN) return false;
    heroItems = filtered.slice(0, 12).sort(() => Math.random() - 0.5).slice(0, 5);
    startHeroRotation();
    return true;
  }

  // Neuzugangs-Fallback: neueste Filme/Serien mit Backdrop, zufällig. Greift, wenn "Für dich"
  // kein/zu dünnes Signal hatte (neues Profil, leere Genres) oder der Fetch fehlschlug.
  function buildHero() {
    if (heroBuilt || heroForYouPending) return;   // schon gebaut ODER "Für dich" entscheidet noch
    const inProgress = heroInProgressSet();
    const pool = [...latestMovies, ...latestSeries]
      .filter(i => i.BackdropImageTags?.length > 0 && !inProgress.has(i.Id));
    if (pool.length === 0) return;   // noch keine brauchbaren Items → nächster Aufruf versucht es erneut
    heroItems = pool.sort(() => Math.random() - 0.5).slice(0, 5);
    startHeroRotation();
  }

  const getAuthHeaders = () => authHeaders(session.token);
  const FIELDS = "PrimaryImageAspectRatio,Overview,BackdropImageTags";
  const ROW_LIMIT = 12;   // einheitliche Reihenlänge: Reihen sind Teaser, der Katalog ist die Bibliothek
  const HERO_MIN = 3;     // "Für dich"-Pool erst ab so vielen brauchbaren Titeln nutzen, sonst Neuzugangs-Fallback
                          // (Ausnahmen bewusst: Hero = 5er-Rotation, Sammlungen = kuratiert, ungekappt)

  // NextUp um Titel bereinigen, die schon in "Weiterschauen" laufen (per Episode- oder Serien-Id).
  function filterNextUp(raw) {
    const inProgress = new Set();
    continueWatching.forEach(i => { inProgress.add(i.Id); if (i.SeriesId) inProgress.add(i.SeriesId); });
    return raw.filter(i => !inProgress.has(i.Id) && !inProgress.has(i.SeriesId));
  }

  // Nach einer Wiedergabe: NUR Resume + NextUp frisch holen und in den Cache mergen — die
  // Sofort-Anzeige aus dem Cache bleibt, aber die eine Zeile, die sich wirklich geändert hat,
  // stimmt wieder (Fortschritt/neuer Titel). Kein Vollreload, Hero bleibt stehen (kein Neu-Mischen).
  async function refreshResume() {
    try {
      const uId  = selectedUser.Id;
      const opts = { headers: getAuthHeaders() };
      const [rRes, rNext] = await Promise.all([
        fetch(`${session.serverUrl}/Users/${uId}/Items/Resume?Limit=${ROW_LIMIT}&Fields=${FIELDS}&EnableImageTypes=Primary,Backdrop,Thumb&EnableTotalRecordCount=false`, opts),
        fetch(`${session.serverUrl}/Shows/NextUp?UserId=${uId}&Limit=${ROW_LIMIT}&Fields=${FIELDS}&EnableImageTypes=Primary,Backdrop,Thumb&EnableTotalRecordCount=false`, opts),
      ]);
      continueWatching = (await rRes.json()).Items || [];
      const dNext = await rNext.json();
      nextUp = filterNextUp(Array.isArray(dNext) ? dNext : (dNext.Items || []));
      if (apiCache.dashboard) { apiCache.dashboard.continueWatching = continueWatching; apiCache.dashboard.nextUp = nextUp; }
      onResumeRefreshed?.();
    } catch { /* Flag bleibt gesetzt → nächster Dashboard-Besuch versucht es erneut */ }
  }

  // Empfehlungen: Seeds aus zuletzt gesehenen Items, dann /Items/{id}/Similar.
  // Best Practice (Netflix/Plex): direkt im Dashboard, kein eigener Tab.
  async function loadRecommendations(uId, opts, fields) {
    try {
      // Zuletzt gespielte Filme/Serien als Aufhänger holen
      const res = await fetch(
        `${session.serverUrl}/Users/${uId}/Items?SortBy=DatePlayed&SortOrder=Descending&Filters=IsPlayed` +
        `&IncludeItemTypes=Movie,Series&Recursive=true&Limit=4&Fields=${fields}`, opts
      );
      const seeds = (await res.json()).Items || [];

      // Bis zu zwei Reihen ähnlicher Titel (gecacht). Gerendert wird je nach
      // Einstellung 1 oder 2 — so wirkt das Umschalten ohne Neuladen sofort.
      const rows = [];
      for (const seed of seeds.slice(0, 2)) {
        const sim = await fetch(`${session.serverUrl}/Items/${seed.Id}/Similar?userId=${uId}&limit=${ROW_LIMIT}&Fields=${fields}`, opts);
        const items = (await sim.json()).Items || [];
        if (items.length >= 4) rows.push({ seedTitle: seed.Name, items });
      }
      recommendations = rows;
      if (apiCache.dashboard) apiCache.dashboard.recommendations = rows;
    } catch { /* Empfehlungen sind optional */ }
  }

  // "Für dich"-Hero (Variante A): leitet aus zuletzt Gesehenem die häufigsten Genres ab und zieht
  // daraus UNGESEHENE, gut bewertete Titel mit Backdrop — statt "neueste Neuzugänge, zufällig".
  // Gibt den Kandidaten-Pool zurück (rating-sortiert). Leer = kein Signal / Fehler → der Aufrufer
  // fällt auf die bisherige Neuzugangs-Logik zurück, damit der Hero nie leer wirkt.
  // NOCH NICHT verdrahtet — Schritt 2 stellt buildHero darauf um.
  async function loadHeroForYou(uId, opts) {
    try {
      // 1) Geschmackssignal: zuletzt gesehene Filme/Serien MIT Genres (eigener Fetch, da FIELDS keine führt).
      const seedRes = await fetch(
        `${session.serverUrl}/Users/${uId}/Items?SortBy=DatePlayed&SortOrder=Descending&Filters=IsPlayed` +
        `&IncludeItemTypes=Movie,Series&Recursive=true&Limit=25&Fields=Genres&EnableTotalRecordCount=false`, opts
      );
      const seeds = (await seedRes.json()).Items || [];

      // 2) Genres gewichtet auszählen — frisch Gesehenes (weiter oben in der DatePlayed-Liste) zählt etwas mehr.
      const counts = new Map();
      seeds.forEach((it, idx) => {
        const weight = 1 + (seeds.length - idx) / seeds.length;
        (it.Genres || []).forEach(g => counts.set(g, (counts.get(g) || 0) + weight));
      });
      if (counts.size === 0) return [];   // kein Signal (neues Profil) → Fallback beim Aufrufer

      const topGenres = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([g]) => g);

      // 3) "Für dich"-Pool: ungesehene, gut bewertete Titel aus diesen Genres, mit Backdrop.
      //    Genres= ist pipe-getrennt (ODER-Verknüpfung).
      const genreParam = topGenres.map(encodeURIComponent).join('|');
      const poolRes = await fetch(
        `${session.serverUrl}/Users/${uId}/Items?IncludeItemTypes=Movie,Series&Recursive=true` +
        `&Filters=IsUnplayed&Genres=${genreParam}&SortBy=CommunityRating&SortOrder=Descending` +
        `&Limit=40&Fields=${FIELDS}&EnableImageTypes=Backdrop,Primary,Logo&EnableTotalRecordCount=false`, opts
      );
      const pool = ((await poolRes.json()).Items || []).filter(i => i.BackdropImageTags?.length > 0);
      return pool;
    } catch {
      return [];   // Fehler → Neuzugangs-Fallback beim Aufrufer
    }
  }

  async function loadDashboardData() {
    heroBuilt = false;   // pro Laden neu bauen
    // Cache-Hit: sofort aus Cache laden, kein Netzwerk
    if (apiCache.dashboard) {
      ({ libraries, continueWatching, nextUp, latestMovies, latestSeries, recentlyWatched, recommendations } = apiCache.dashboard);
      recentlyWatched = recentlyWatched || [];
      recommendations = recommendations || [];
      collections     = apiCache.dashboard.collections || [];
      // Cache-Hit: die zuvor gebaute "Für dich"-Auswahl direkt übernehmen (instant, kein Netz);
      // nur falls keine gecacht ist, den Neuzugangs-Fallback bauen.
      if (apiCache.dashboard.heroItems?.length) { heroItems = apiCache.dashboard.heroItems; startHeroRotation(); }
      else buildHero();
      if (resumeStale) refreshResume();   // Hintergrund-Refresh, UI steht bereits aus dem Cache
      return;
    }

    isLoading   = true;
    heroLoading = true;   // Hero-Platz ab dem ersten Paint reservieren, bis die Featured-Daten da sind
    try {
      const uId   = selectedUser.Id;
      const opts  = { headers: getAuthHeaders() };
      const fields = FIELDS;

      // Alle 5 Fetches gleichzeitig starten — kein sequentielles Warten
      const pViews        = fetch(`${session.serverUrl}/Users/${uId}/Views`, opts);
      const pResume       = fetch(`${session.serverUrl}/Users/${uId}/Items/Resume?Limit=${ROW_LIMIT}&Fields=${fields}&EnableImageTypes=Primary,Backdrop,Thumb&EnableTotalRecordCount=false`, opts);
      const pNextUp       = fetch(`${session.serverUrl}/Shows/NextUp?UserId=${uId}&Limit=${ROW_LIMIT}&Fields=${fields}&EnableImageTypes=Primary,Backdrop,Thumb&EnableTotalRecordCount=false`, opts);
      const pLatestMovies = fetch(`${session.serverUrl}/Users/${uId}/Items/Latest?IncludeItemTypes=Movie&Limit=${ROW_LIMIT}&Fields=${fields}`, opts);
      const pLatestSeries = fetch(`${session.serverUrl}/Users/${uId}/Items/Latest?IncludeItemTypes=Series&Limit=${ROW_LIMIT}&Fields=${fields}`, opts);
      // Verlauf: zuletzt gesehene Filme/Folgen. Mehr holen (40), da Serien danach
      // zu je einem Eintrag zusammengefasst werden (Puffer für eine gute Mischung).
      const pHistory      = fetch(`${session.serverUrl}/Users/${uId}/Items?SortBy=DatePlayed&SortOrder=Descending&Filters=IsPlayed&IncludeItemTypes=Movie,Episode&Recursive=true&Limit=40&Fields=${fields}&EnableTotalRecordCount=false`, opts);
      // Sammlungen (BoxSets)
      const pCollections  = fetch(`${session.serverUrl}/Users/${uId}/Items?IncludeItemTypes=BoxSet&Recursive=true&SortBy=SortName&Fields=PrimaryImageAspectRatio&Limit=50&EnableTotalRecordCount=false`, opts);

      // Priorität: Views + Resume → UI sofort freigeben
      const [resViews, resResume] = await Promise.all([pViews, pResume]);
      libraries        = (await resViews.json()).Items  || [];
      continueWatching = (await resResume.json()).Items || [];
      isLoading        = false;
      session.connectionLost = false;   // Server erreichbar

      // Cache früh befüllen → Sidebar-Navigation funktioniert sofort
      apiCache.dashboard = { libraries, continueWatching, nextUp: [], latestMovies: [], latestSeries: [], recentlyWatched: [], recommendations: [], collections: [], heroItems: [] };

      // Sammlungen unabhängig laden
      pCollections.then(r => r.json()).then(d => {
        collections = (Array.isArray(d) ? d : (d.Items || [])).filter(c => c.ChildCount !== 0);
        apiCache.dashboard.collections = collections;
      }).catch(() => {});

      // Empfehlungen ("Weil du X gesehen hast") aus zuletzt Gesehenem ableiten
      loadRecommendations(uId, opts, fields);

      // "Für dich"-Hero (Variante A) parallel anstoßen: entscheidet zwischen Genre-Pool und
      // Neuzugangs-Fallback. Bis dahin blockiert buildHero (heroForYouPending) — kurzer Skelett-
      // Moment mehr, dafür der bessere Hero; der reservierte Platz verhindert ein Nachrücken.
      heroForYouPending = true;
      const pHeroForYou = loadHeroForYou(uId, opts)
        .then(pool => { heroForYouPending = false; if (!heroBuilt && !applyHeroPool(pool)) buildHero(); })
        .catch(() => { heroForYouPending = false; if (!heroBuilt) buildHero(); });

      // Verlauf laden + nach Serie zusammenfassen
      pHistory.then(r => r.json()).then(async d => {
        let items = dedupeHistory(d.Items || []).slice(0, ROW_LIMIT);   // Reihenlänge vereinheitlicht; Kappen VOR der Anreicherung spart Serien-Lookups
        // Serien wie in der Mediathek mit echtem Jahresbereich zeigen ("2016 – 2019" / "2024 – heute"):
        // einmalig die echten Serien-Infos (Jahr/Status/EndDate) für alle Serien-Einträge nachladen.
        const seriesIds = items.filter(i => i.Type === 'Series').map(i => i.Id);
        if (seriesIds.length) {
          try {
            const r2 = await fetch(`${session.serverUrl}/Users/${uId}/Items?Ids=${seriesIds.join(',')}&Fields=ProductionYear,Status,EndDate`, opts);
            const info = new Map(((await r2.json()).Items || []).map(s => [s.Id, s]));
            items = items.map(i => {
              const s = i.Type === 'Series' ? info.get(i.Id) : null;
              // UserData der ECHTEN Serie mitnehmen: die Pseudo-Einträge aus dedupeHistory haben
              // keine — ohne sie bleibt das Gesehen-Badge bei komplett geschauten Serien blind.
              return s ? { ...i, ProductionYear: s.ProductionYear, Status: s.Status, EndDate: s.EndDate, UserData: s.UserData } : i;
            });
          } catch { /* Anreicherung optional — schlägt sie fehl, bleibt nur der Titel */ }
        }
        recentlyWatched = items;
        apiCache.dashboard.recentlyWatched = recentlyWatched;
      }).catch(() => {});

      // Sekundäre Sektionen unabhängig aktualisieren — schnellste kommt zuerst
      // FIX: `|| d` entfernt (d wäre das Response-Objekt, nicht ein Array)
      // FIX: .catch(() => {}) damit ein einzelner Fehler nicht alles blockiert
      // /Items/Latest gibt ein DIREKTES Array zurück (nicht { Items: [...] })!
      // Andere Endpunkte geben { Items, TotalRecordCount }. Beide Fälle abfangen.
      pNextUp.then(r => r.json()).then(d => {
        const raw = Array.isArray(d) ? d : (d.Items || []);
        // In-Progress-Titel ausschließen (stehen schon in "Weiterschauen") — wie die Jellyfin-App.
        nextUp = filterNextUp(raw);
        apiCache.dashboard.nextUp = nextUp;
      }).catch(() => {});

      // Latest-Fetches UNABHÄNGIG verarbeiten: jede Reihe füllt sich sofort, und der Hero wird
      // gebaut, sobald die ERSTEN brauchbaren Daten da sind — nicht erst, wenn der langsamere
      // der beiden Fetches zurück ist (das war der eigentliche Skelett-Engpass).
      const pm = pLatestMovies.then(r => r.json()).catch(() => []);
      const ps = pLatestSeries.then(r => r.json()).catch(() => []);
      pm.then(d => {
        latestMovies = Array.isArray(d) ? d : (d.Items || []);
        apiCache.dashboard.latestMovies = latestMovies;
        buildHero();
      });
      ps.then(d => {
        latestSeries = Array.isArray(d) ? d : (d.Items || []);
        apiCache.dashboard.latestSeries = latestSeries;
        buildHero();
      });
      // Sicherheitsnetz: Skelett erst beenden, wenn Latest UND "Für dich" entschieden haben
      // (sonst verschwände der Platzhalter, während der Für-dich-Fetch noch läuft → Lücke/Sprung).
      Promise.all([pm, ps, pHeroForYou]).then(() => { heroLoading = false; });

    } catch (err) {
      console.error("Dashboard load failed:", err);
      isLoading   = false;
      heroLoading = false;
      session.connectionLost = true;   // Server nicht erreichbar → Banner
    }
  }

  // Verlauf nach Serie zusammenfassen: pro Serie nur die zuletzt gesehene Folge
  // (Liste ist bereits nach Datum absteigend → die erste ist die neueste).
  // Filme bleiben einzeln. Verhindert "10× dieselbe Serie" beim Binge-Watching.
  function dedupeHistory(items) {
    const seenSeries = new Set();
    const out = [];
    for (const it of items) {
      let entry = it;
      if (it.Type === 'Episode' && it.SeriesId) {
        if (seenSeries.has(it.SeriesId)) continue;
        seenSeries.add(it.SeriesId);
        // Verlauf: die Serie als EIN Eintrag zeigen (nicht die einzelne Folge). "Weiterschauen"
        // deckt die konkrete Folge schon ab; hier zählt nur, welche Serie zuletzt lief.
        entry = {
          Id: it.SeriesId,
          Name: it.SeriesName,
          Type: 'Series',
          ImageTags: it.SeriesPrimaryImageTag ? { Primary: it.SeriesPrimaryImageTag } : undefined,
          PrimaryImageAspectRatio: 0.6667,
          ImageBlurHashes: it.ImageBlurHashes,
        };
      }
      out.push(entry);
      if (out.length >= 16) break;
    }
    return out;
  }

  // Verlauf-Karten einheitlich Hochkant: Folgen nutzen das Serien-Poster
  function getHistoryImageUrl(item) {
    if (item.Type === 'Episode' && item.SeriesId && item.SeriesPrimaryImageTag)
      return `${session.serverUrl}/Items/${item.SeriesId}/Images/Primary?tag=${item.SeriesPrimaryImageTag}&fillHeight=400&fillWidth=266&quality=80&format=webp`;
    if (item.ImageTags?.Primary)
      return `${session.serverUrl}/Items/${item.Id}/Images/Primary?tag=${item.ImageTags.Primary}&fillHeight=400&fillWidth=266&quality=80&format=webp`;
    return null;
  }

  function getItemImageUrl(item, format = 'portrait') {
    if (format === 'landscape') {
      // Wie Jellyfin (preferThumb): Querformat-Artwork bevorzugen — eigenes Thumb, sonst
      // Serien-/Eltern-Thumb, dann Backdrop (Folge → Serie), zuletzt der Folgen-Still.
      if (item.ImageTags?.Thumb)
        return `${session.serverUrl}/Items/${item.Id}/Images/Thumb?tag=${item.ImageTags.Thumb}&maxWidth=600&quality=80&format=webp`;
      if (item.ParentThumbItemId && item.ParentThumbImageTag)
        return `${session.serverUrl}/Items/${item.ParentThumbItemId}/Images/Thumb?tag=${item.ParentThumbImageTag}&maxWidth=600&quality=80&format=webp`;
      if (item.SeriesId && item.SeriesThumbImageTag)
        return `${session.serverUrl}/Items/${item.SeriesId}/Images/Thumb?tag=${item.SeriesThumbImageTag}&maxWidth=600&quality=80&format=webp`;
      if (item.BackdropImageTags?.length > 0)
        return `${session.serverUrl}/Items/${item.Id}/Images/Backdrop?tag=${item.BackdropImageTags[0]}&maxWidth=600&quality=80&format=webp`;
      if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.length > 0)
        return `${session.serverUrl}/Items/${item.ParentBackdropItemId}/Images/Backdrop?tag=${item.ParentBackdropImageTags[0]}&maxWidth=600&quality=80&format=webp`;
      if (item.ImageTags?.Primary)
        return `${session.serverUrl}/Items/${item.Id}/Images/Primary?tag=${item.ImageTags.Primary}&maxWidth=600&quality=80&format=webp`;
    } else {
      if (item.ImageTags?.Primary)
        return `${session.serverUrl}/Items/${item.Id}/Images/Primary?tag=${item.ImageTags.Primary}&fillHeight=400&fillWidth=266&quality=80&format=webp`;
    }
    return null;
  }

  function getItemTitle(item) {
    return (item.Type === 'Episode' && item.SeriesName) ? item.SeriesName : item.Name;
  }

  // Restzeit in Minuten für "Weiterschauen"
  function getRemainingMinutes(item) {
    if (!item.RunTimeTicks || !item.UserData?.PlaybackPositionTicks) return null;
    const remTicks = item.RunTimeTicks - item.UserData.PlaybackPositionTicks;
    const mins = Math.round(remTicks / 10000000 / 60);
    return mins > 0 ? mins : null;
  }

  // Hero-Backdrop in hoher Auflösung
  function getHeroBackdrop(item) {
    if (item?.BackdropImageTags?.length > 0)
      return `${session.serverUrl}/Items/${item.Id}/Images/Backdrop?tag=${item.BackdropImageTags[0]}&maxWidth=1920&quality=85&format=webp`;
    return null;
  }

  // Logo-Bild (transparenter Titel-Schriftzug) — falls vorhanden, statt Text-Titel.
  // Wirkt hochwertiger; ein zusätzliches Bild, kein Mehraufwand bei den Daten.
  function getHeroLogo(item) {
    if (item.ImageTags?.Logo)
      return `${session.serverUrl}/Items/${item.Id}/Images/Logo?tag=${item.ImageTags.Logo}&maxHeight=130&quality=90&format=webp`;
    return null;
  }</script>

<div class="relative">
  <!-- Dashboard-Backdrop: Backdrop des fokussierten Titels, an der Viewport-Oberkante fixiert
       (sticky, nicht absolute — das Dashboard scrollt im App-Container). -mb-[100vh] hebt die
       Eigenhöhe wieder auf, sodass der Inhalt darüber liegt statt darunter zu rutschen. -->
  {#if dashboardBackdrop && previewBackdrop}
    <div {@attach heroScrollFade} style="opacity:{bgOpacity}" class="sticky top-0 h-screen w-full -mb-[100vh] z-0 pointer-events-none overflow-hidden">
      {#key previewBackdrop}
        <img src={previewBackdrop} alt="" class="w-full h-full object-cover preview-fade" />
      {/key}
      <div class="absolute inset-0 bg-gradient-to-r from-gray-900 via-gray-900/85 to-gray-900/40"></div>
      <div class="absolute inset-0 bg-gradient-to-t from-gray-900 via-transparent to-gray-900/60"></div>
    </div>
  {/if}
  <div class="relative z-10 px-10 pt-16 pb-20 flex flex-col gap-12">

  <!-- Wiederverwendbare Card-Snippets (statt 8 fast identischer Blöcke) -->
  {#snippet landscapeCard(item)}
    {@const img = getItemImageUrl(item, 'landscape')}
    {@const prog = itemProgress(item)}
    {@const badge = itemBadge(item)}
    {@const rem = getRemainingMinutes(item)}
    {@const sub = getItemSubtitle(item, i18n.t.today)}
    <button onclick={() => onOpenDetails?.(item)} data-item-id={item.Id} {@attach longPress()} onlongpress={() => onOpenContext?.(item)}
      onfocus={() => previewItem(item)} onblur={cancelPreview}
      class="shrink-0 w-80 group flex flex-col focus:outline-none text-left scroll-mt-24 scroll-mx-4">
      <div class="aspect-video w-full bg-gray-800 rounded-lg overflow-hidden
                  border-4 border-transparent group-focus:border-white group-focus:scale-105
                  transition-all duration-200 shadow-xl relative">
        {#if img}
          <img src={img} {@attach blurUp(itemBlurHash(item, 'Backdrop'))} alt={item.Name}
            class="w-full h-full object-cover" loading="lazy" />
        {/if}
        {#if badge}
          <div class="absolute top-2 left-2 z-10 min-w-[1.6rem] h-[1.6rem] px-1.5 rounded-full flex items-center justify-center bg-blue-600/90 text-white text-xs font-bold shadow-md pointer-events-none">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
        {/if}
        {#if prog > 0}
          <div class="absolute bottom-0 left-0 w-full h-1.5 bg-gray-900/80">
            <div class="h-full bg-blue-500" style="width:{prog}%"></div>
          </div>
        {/if}
        {#if rem}
          <div class="absolute top-2 right-2 bg-black/80 text-white text-xs font-bold px-2 py-1 rounded-md">
            {rem} {i18n.t.mins} {i18n.t.remaining}
          </div>
        {/if}
      </div>
      <div class="mt-3 flex flex-col w-full overflow-hidden">
        <span class="text-sm font-bold text-gray-200 group-focus:text-white truncate w-full">{getItemTitle(item)}</span>
        {#if sub}
          <span class="text-xs text-gray-400 group-focus:text-gray-300 truncate w-full mt-0.5">{sub}</span>
        {/if}
      </div>
    </button>
  {/snippet}

  {#snippet portraitCard(item, img, blur)}
    {@const prog = itemProgress(item)}
    {@const badge = itemBadge(item)}
    {@const sub = getItemSubtitle(item, i18n.t.today)}
    <button onclick={() => onOpenDetails?.(item)} data-item-id={item.Id} {@attach longPress()} onlongpress={() => onOpenContext?.(item)}
      onfocus={() => previewItem(item)} onblur={cancelPreview}
      class="shrink-0 w-48 group flex flex-col focus:outline-none text-left scroll-mt-24 scroll-mx-4">
      <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg overflow-hidden relative
                  border-4 border-transparent group-focus:border-white group-focus:scale-105
                  transition-all duration-200 shadow-xl">
        {#if img}
          <img src={img} {@attach blurUp(blur)} alt={item.Name}
            class="w-full h-full object-cover" loading="lazy" />
        {/if}
        {#if badge}
          <div class="absolute top-2 left-2 z-10 min-w-[1.6rem] h-[1.6rem] px-1.5 rounded-full flex items-center justify-center bg-blue-600/90 text-white text-xs font-bold shadow-md pointer-events-none">
            <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
        {/if}
        {#if prog > 0}
          <div class="absolute bottom-0 left-0 w-full h-1.5 bg-gray-900/80">
            <div class="h-full bg-blue-500" style="width:{prog}%"></div>
          </div>
        {/if}
      </div>
      <div class="mt-3 flex flex-col w-full overflow-hidden">
        <span class="text-sm font-bold text-gray-200 group-focus:text-white truncate w-full">{getItemTitle(item)}</span>
        {#if sub}
          <span class="text-xs text-gray-400 group-focus:text-gray-300 truncate w-full mt-0.5">{sub}</span>
        {/if}
      </div>
    </button>
  {/snippet}

  {#snippet collectionCard(col)}
    {@const img = getItemImageUrl(col)}
    <button onclick={() => onOpenCollection?.(col)} onfocus={() => previewItem(col)} onblur={cancelPreview}
      class="shrink-0 w-48 group flex flex-col focus:outline-none text-left scroll-mt-24 scroll-mx-4">
      <div class="aspect-[2/3] w-full bg-gray-800 rounded-lg overflow-hidden relative
                  border-4 border-transparent group-focus:border-white group-focus:scale-105
                  transition-all duration-200 shadow-xl">
        {#if img}
          <img src={img} {@attach blurUp(itemBlurHash(col))} alt={col.Name}
            class="w-full h-full object-cover" loading="lazy" />
        {:else}
          <div class="w-full h-full flex items-center justify-center text-gray-600">
            <svg class="w-14 h-14" fill="currentColor" viewBox="0 0 24 24"><path d="M4 6h16v2H4zm2-4h12v2H6zm-4 8h20v10a2 2 0 01-2 2H4a2 2 0 01-2-2V10z"/></svg>
          </div>
        {/if}
      </div>
      <span class="mt-3 text-sm font-bold text-gray-200 group-focus:text-white truncate w-full">{col.Name}</span>
    </button>
  {/snippet}

  <!-- Hero-Skelett: reserviert Banner-Höhe + deutet Titel/Text/Button an. EIN Snippet für beide
       Ladephasen (Erst-Skelett UND heroLoading), damit ab dem ersten Paint nichts nachrückt. -->
  {#snippet heroSkeleton()}
    <div class="relative -mx-10 -mt-16 mb-2 h-[44vh] min-h-[320px] overflow-hidden bg-gradient-to-br from-gray-800/40 via-gray-900/70 to-gray-900">
      <div class="absolute inset-0 bg-gradient-to-t from-gray-900 via-gray-900/40 to-transparent"></div>
      <div class="absolute bottom-0 left-0 p-10 pb-8 max-w-3xl flex flex-col gap-3 {reduceAnimations ? '' : 'animate-pulse'}">
        <div class="h-14 w-80 max-w-[60%] bg-white/10 rounded-lg"></div>
        <div class="h-4 w-44 bg-white/10 rounded"></div>
        <div class="h-3.5 w-full max-w-xl bg-white/10 rounded"></div>
        <div class="h-3.5 w-2/3 max-w-md bg-white/10 rounded"></div>
        <div class="h-12 w-44 bg-white/10 rounded-xl mt-2"></div>
      </div>
    </div>
  {/snippet}


  {#if isLoading}
    <!-- Skeleton-Loader — spiegelt den echten Aufbau: erst Hero-Höhe (wenn aktiv), dann Reihen,
         damit beim Fertigladen nichts nachspringt. -->
    {#if showHero}{@render heroSkeleton()}{/if}
    {#each [1, 2, 3] as _}
      <div>
        <div class="h-8 w-48 bg-gray-800 rounded animate-pulse mb-4"></div>
        <div class="flex gap-6 overflow-hidden">
          {#each skeletons as __}
            <div class="shrink-0 w-48 aspect-[2/3] bg-gray-800 rounded-lg animate-pulse"></div>
          {/each}
        </div>
      </div>
    {/each}

  {:else}

    <!-- HERO-BANNER — rotierendes Featured-Item -->
    {#if showHero && heroCurrent}
      <div transition:uiFade class="relative -mx-10 -mt-16 mb-2 h-[44vh] min-h-[320px] overflow-hidden bg-gray-900">
        <!-- Vollflächiger Backdrop (Netflix-Stil): Crossfade — das VORHERIGE Bild bleibt als Unterlage
             stehen, das neue blendet obendrauf ein (kein Dip-to-Black mehr). Blurhash → scharf. -->
        {#if prevHeroIndex >= 0 && prevHeroIndex !== heroIndex && heroItems[prevHeroIndex] && getHeroBackdrop(heroItems[prevHeroIndex])}
          <img src={getHeroBackdrop(heroItems[prevHeroIndex])} alt="" aria-hidden="true" decoding="async"
            class="absolute inset-0 w-full h-full object-cover object-center" />
        {/if}
        {#key heroCurrent?.Id}
          {#if heroCurrent && getHeroBackdrop(heroCurrent)}
            <img src={getHeroBackdrop(heroCurrent)} {@attach blurUp(itemBlurHash(heroCurrent, 'Backdrop'))} alt={heroCurrent.Name} fetchpriority="high" loading="eager" decoding="async"
              class="absolute inset-0 w-full h-full object-cover object-center hero-fade" />
          {/if}
        {/key}
        <!-- Verläufe: links für Textlesbarkeit, unten für nahtlosen Übergang in die Reihen darunter -->
        <div class="absolute inset-0 bg-gradient-to-r from-gray-900 via-gray-900/50 to-transparent"></div>
        <div class="absolute inset-0 bg-gradient-to-t from-gray-900 via-gray-900/50 to-transparent"></div>

        <!-- Inhalt -->
        <div class="absolute bottom-0 left-0 p-10 pb-8 max-w-3xl flex flex-col gap-3">
          {#if getHeroLogo(heroCurrent)}
            <img src={getHeroLogo(heroCurrent)} alt={getItemTitle(heroCurrent)}
              class="max-h-[130px] max-w-[60%] object-contain object-left drop-shadow-lg" />
          {:else}
            <h1 class="text-5xl font-bold text-white drop-shadow-lg">{getItemTitle(heroCurrent)}</h1>
          {/if}
          <div class="flex items-center gap-3 text-gray-300 font-semibold">
            {#if heroCurrent.ProductionYear}<span class="text-blue-400">{heroCurrent.ProductionYear}</span>{/if}
            {#if heroCurrent.CommunityRating}
              <span class="flex items-center gap-1 text-yellow-400">
                <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/></svg>
                {heroCurrent.CommunityRating.toFixed(1)}
              </span>
            {/if}
            {#if heroCurrent.CriticRating}
              <span class="flex items-center gap-1 text-red-400">• {heroCurrent.CriticRating}%</span>
            {/if}
          </div>
          {#if heroCurrent.Overview}
            <p class="text-gray-300 text-lg line-clamp-2 max-w-2xl drop-shadow">{heroCurrent.Overview}</p>
          {/if}
          <div class="flex items-center gap-4 mt-2">
            <button onclick={() => onOpenDetails?.(heroCurrent)} data-scroll-top
              class="bg-white hover:bg-gray-200 focus:bg-gray-200 text-black font-bold text-lg px-8 py-3 rounded-xl
                     focus:outline-none focus:ring-4 focus:ring-blue-500 transition-all flex items-center gap-2 shadow-lg">
              <svg class="w-6 h-6" fill="currentColor" viewBox="0 0 20 20"><path d="M4 4l12 6-12 6z"/></svg>
              {i18n.t.play}
            </button>
            <!-- Punkt-Indikatoren — nur wenn auch rotiert wird (bei reduzierter Bewegung: statischer Hero ohne Punkte) -->
            {#if !reduceAnimations && heroItems.length > 1}
              <div class="flex gap-2 ml-2">
                {#each heroItems as h, i (h.Id)}
                  <div class="h-2 rounded-full transition-all {i === heroIndex ? 'w-6 bg-white' : 'w-2 bg-white/40'}"></div>
                {/each}
              </div>
            {/if}
          </div>
        </div>
      </div>
    {:else if showHero && heroLoading}
      {@render heroSkeleton()}
    {/if}

    <!-- MEDIATHEKEN -->
    {#if showLibraries && libraries.length > 0}
      <div>
        <h2 class="text-2xl font-bold text-gray-400 mb-4 px-2">{i18n.t.myMedia}</h2>
        <div class="flex gap-6 overflow-x-auto hide-scrollbar py-4 px-2">
          {#each libraries as library (library.Id)}
            <button onclick={() => onOpenLibrary?.(library)}
              class="shrink-0 scroll-mt-24 scroll-mx-4 group flex flex-col items-center focus:outline-none">
              <div class="w-64 h-36 bg-gray-800 rounded-xl flex items-center justify-center
                          border-4 border-transparent group-focus:border-white group-focus:scale-105 group-hover:border-gray-400
                          transition-all duration-200 shadow-lg overflow-hidden">
                {#if getItemImageUrl(library)}
                  <img src={getItemImageUrl(library)} {@attach blurUp(itemBlurHash(library))} alt={library.Name}
                    class="w-full h-full object-cover opacity-80 group-focus:opacity-100" loading="lazy" />
                {:else}
                  <span class="text-2xl text-gray-500 font-bold">{library.Name}</span>
                {/if}
              </div>
              <span class="mt-3 text-lg text-gray-300 group-focus:text-white">{library.Name}</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- WEITERSCHAUEN -->
    {#if resumeRow.length > 0}
      <div>
        <h2 class="text-2xl font-bold text-white mb-4 px-2">{i18n.t.continueWatchingRow}</h2>
        <div class="flex gap-6 overflow-x-auto hide-scrollbar py-4 px-2">
          {#each resumeRow as item (item.Id)}
            {@render landscapeCard(item)}
          {/each}
        </div>
      </div>
    {/if}

    <!-- ALS NÄCHSTES -->
    {#if showNextUp && nextUp.length > 0}
      <div>
        <h2 class="text-2xl font-bold text-white mb-4 px-2">{i18n.t.nextUp}</h2>
        <div class="flex gap-6 overflow-x-auto hide-scrollbar py-4 px-2">
          {#each nextUp as item (item.Id)}
            {@render landscapeCard(item)}
          {/each}
        </div>
      </div>
    {/if}

    <!-- ZULETZT GESEHEN (Verlauf) -->
    {#if showHistory && recentlyWatched.length > 0}
      <div>
        <h2 class="text-2xl font-bold text-white mb-4 px-2">{i18n.t.recentlyWatched}</h2>
        <div class="flex gap-6 overflow-x-auto hide-scrollbar py-4 px-2">
          {#each recentlyWatched as item (item.Id)}
            {@render portraitCard(item, getHistoryImageUrl(item), itemBlurHash(item))}
          {/each}
        </div>
      </div>
    {/if}

    <!-- GEMEINSAME VORSCHLÄGE ("Für euch beide") — nur bei eingerichtetem gemeinsamen Profil -->
    {#if showSharedSuggestions && sharedSuggestions.length > 0}
      <div>
        <h2 class="text-2xl font-bold text-white mb-4 px-2">{i18n.t.sharedSuggestions}</h2>
        <div class="flex gap-6 overflow-x-auto hide-scrollbar py-4 px-2">
          {#each sharedSuggestions as item (item.Id)}
            {@render portraitCard(item, getItemImageUrl(item), itemBlurHash(item))}
          {/each}
        </div>
      </div>
    {/if}

    <!-- EMPFEHLUNGEN: "Weil du X gesehen hast" — personalisiert, daher weit oben -->
    {#each (showRecommendations ? recommendations.slice(0, recommendationRows) : []) as rec}
      <div>
        <h2 class="text-2xl font-bold text-white mb-4 px-2">{i18n.t.becauseSeen.replace('{x}', rec.seedTitle)}</h2>
        <div class="flex gap-6 overflow-x-auto hide-scrollbar py-4 px-2">
          {#each rec.items as item (item.Id)}
            {@render portraitCard(item, getItemImageUrl(item), itemBlurHash(item))}
          {/each}
        </div>
      </div>
    {/each}

    <!-- ZULETZT HINZUGEFÜGTE FILME -->
    {#if showLatest && latestMovies.length > 0}
      <div>
        <h2 class="text-2xl font-bold text-white mb-4 px-2">{i18n.t.latestMovies}</h2>
        <div class="flex gap-6 overflow-x-auto hide-scrollbar py-4 px-2">
          {#each latestMovies as item (item.Id)}
            {@render portraitCard(item, getItemImageUrl(item), itemBlurHash(item))}
          {/each}
        </div>
      </div>
    {/if}

    <!-- ZULETZT HINZUGEFÜGTE SERIEN -->
    {#if showLatest && latestSeries.length > 0}
      <div>
        <h2 class="text-2xl font-bold text-white mb-4 px-2">{i18n.t.latestSeries}</h2>
        <div class="flex gap-6 overflow-x-auto hide-scrollbar py-4 px-2">
          {#each latestSeries as item (item.Id)}
            {@render portraitCard(item, getItemImageUrl(item), itemBlurHash(item))}
          {/each}
        </div>
      </div>
    {/if}

    <!-- SAMMLUNGEN (BoxSets) — browse-orientiert, daher unten -->
    {#if showCollections && collections.length > 0}
      <div>
        <h2 class="text-2xl font-bold text-white mb-4 px-2">{i18n.t.collections}</h2>
        <div class="flex gap-6 overflow-x-auto hide-scrollbar py-4 px-2">
          {#each collections as col (col.Id)}
            {@render collectionCard(col)}
          {/each}
        </div>
      </div>
    {/if}

  {/if}
  </div>
</div>

<style>
  /* Backdrop-Vorschau: sanft einblenden statt hart umschalten ({#key} remountet das <img>) */
  .preview-fade { animation: previewFadeIn 0.5s ease-out; }
  @keyframes previewFadeIn { from { opacity: 0; } to { opacity: 1; } }
  /* Bewusst KEIN scroll-snap auf den Reihen: auf D-Pad-Geraeten scrollt ausschliesslich
     der Fokus (scrollIntoView) — Proximity-Snapping zog dessen Position phasenabhaengig
     zurueck und schnitt den skalierten Rahmen der Randkarte ab (webOS/B4). */

  /* Sanftes Einblenden beim Hero-Wechsel */
  .hero-fade { animation: heroFadeIn 1.2s ease; }
  @keyframes heroFadeIn { from { opacity: 0; } to { opacity: 1; } }
</style>
