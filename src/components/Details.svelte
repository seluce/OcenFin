<script>
  import { i18n, LANGUAGES } from '../i18n.svelte.js';
  import { isBackKey, focusOnMount, personImageUrl, itemProgress, authHeaders, blurUp, itemBlurHash, makeFocusReturn, uiFade, dropTrapOnOutro } from '../utils.js';
  import { session } from '../session.svelte.js';
  import { onMount, onDestroy, tick, untrack } from 'svelte';
  import AddToPicker from './AddToPicker.svelte';

  let {
    item,
    selectedUser,
    playbackPrefs = { audioLanguage: 'default', subtitleLanguage: 'default' },
    use24h = true,              // Zeitformat für den „Endet um"-Chip (folgt der Einstellung)
    serverVobSub = false,       // Server liefert VobSub/DVD extern (.mks, Jellyfin 12.0+)?
    spoilerProtection = true,   // ungesehene Folgen-Thumbnails leicht verschleiern
    detailsBackdrop = true,     // Hero-Backdrop auf der Detailseite zeigen (eigener Schalter, von reduceAnimations entkoppelt)
    detailsLogo = false,        // Titel als Logo-Grafik statt Text (Rückfall auf Text, wenn kein Logo vorhanden)
    onClose, onLibChanged, onOpenItemById, onOpenPerson, onPlayVideo,   // Callback-Props (statt Events)
  } = $props();

  let fullItem     = $state(null);
  let relatedItems = $state([]);
  let similarItems = $state([]);
  let isLoading    = $state(true);

  let selectedAudioIndex    = $state(-1);
  let selectedSubtitleIndex = $state(-1);
  let selectedMediaSourceId = $state(null);   // gewählte Version (FullHD/4K …), wenn mehrere existieren

  // aktuell gewählte Quelle (für Stream-Infos, Audio-/Untertitelspuren)
  let selectedSource = $derived(
    fullItem?.MediaSources?.find(s => s.Id === selectedMediaSourceId)
    || fullItem?.MediaSources?.[0] || null
  );

  // Label für die Auflösungsauswahl, z. B. "4K HEVC" / "1080p HEVC"
  function sourceLabel(src) {
    const v = (src?.MediaStreams || []).find(s => s.Type === 'Video');
    const h = v?.Height || 0;
    const res = h >= 2160 ? '4K' : h >= 1080 ? '1080p' : h >= 720 ? '720p' : (h ? h + 'p' : '');
    const codec = (v?.Codec || '').toUpperCase();
    return [res, codec].filter(Boolean).join(' ') || src?.Name || 'Quelle';
  }

  // Standard-Audio/-Untertitel für eine Quelle wählen (Präferenzen + Server-Defaults)
  function applySourceDefaults(src) {
    const streams = src?.MediaStreams || [];
    selectedAudioIndex = -1;
    const audioPref = matchLanguageStream(streams, 'Audio', playbackPrefs.audioLanguage);
    if (audioPref != null)                        selectedAudioIndex = audioPref;
    else if (src?.DefaultAudioStreamIndex != null) selectedAudioIndex = src.DefaultAudioStreamIndex;

    if (playbackPrefs.subtitleLanguage === 'off') {
      selectedSubtitleIndex = -1;
    } else {
      const subPref = matchLanguageStream(streams, 'Subtitle', playbackPrefs.subtitleLanguage);
      if (subPref != null)                              selectedSubtitleIndex = subPref;
      else if (playbackPrefs.subtitleLanguage === 'default')
        selectedSubtitleIndex = pickForcedSubtitle(streams, selectedAudioIndex, src?.DefaultSubtitleStreamIndex);
      else if (src?.DefaultSubtitleStreamIndex != null) selectedSubtitleIndex = src.DefaultSubtitleStreamIndex;
      else selectedSubtitleIndex = -1;
    }
  }

  // Bei Wechsel der Auflösung/Version: Spuren neu auf die Standardwerte der Quelle setzen
  function onSourceChange() {
    const src = fullItem?.MediaSources?.find(s => s.Id === selectedMediaSourceId);
    if (src) applySourceDefaults(src);
  }

  // ---- Eigene Dropdowns (Auflösung/Audio/Untertitel) ------------------------------------------
  // Native <select> friert auf webOS beim Zurück-Knopf ein → D-Pad-taugliche Eigenbau-Dropdowns.
  let openDropdown = $state(null);     // 'resolution' | 'audio' | 'subtitle'
  let openTrigger  = null;     // Auslöser-Button (DOM-Ref; Fokus kehrt beim Schließen dorthin zurück)

  async function toggleDropdown(key, e) {
    if (openDropdown === key) { openDropdown = null; openTrigger = null; return; }
    openDropdown = key;
    openTrigger  = e.currentTarget;
    // Fokus auf das aktive (blau hinterlegte) Element legen, sonst auf die erste Option —
    // intuitiver, als jedes Mal ganz oben zu starten.
    const panel = e.currentTarget.closest('[data-dropdown]');
    await tick();
    const active = panel?.querySelector('[data-opt][data-active="true"]');
    (active || panel?.querySelector('[data-opt]'))?.focus();
  }
  function closeDropdown(refocus = true) {
    const t = openTrigger;
    openDropdown = null; openTrigger = null;
    if (refocus) t?.focus();
  }
  function onDropdownBack(e) {
    // Zurück schließt nur das offene Dropdown — nicht die Detailansicht.
    if (openDropdown && isBackKey(e)) { e.preventDefault(); e.stopPropagation(); closeDropdown(); }
  }
  function onDropdownOutside(e) {
    // Klick mit der Magic-Remote außerhalb des Dropdowns schließt es (wie ein normales Dropdown).
    if (openDropdown && !e.target.closest('[data-dropdown]')) closeDropdown(false);
  }
  onMount(()   => { window.addEventListener('keydown', onDropdownBack, true); window.addEventListener('click', onDropdownOutside); });
  onDestroy(() => { window.removeEventListener('keydown', onDropdownBack, true); window.removeEventListener('click', onDropdownOutside); });

  // Anzeige-Labels für die Trigger-Buttons
  function audioLabel(s)    { return s ? (s.DisplayTitle || `${s.Language || 'Unbekannt'} – ${s.Codec}`) : ''; }
  function subtitleLabel(s) { return s ? (s.DisplayTitle || s.Language || 'Unbekannt') : ''; }

  // ---- Zur Sammlung / Wiedergabeliste hinzufügen ----------------------------------------------
  // Der Dialog selbst liegt in der gemeinsamen Komponente <AddToPicker>; hier nur der Schalter.
  let pickerMode = $state(null);   // null | 'collection' | 'playlist'

  // Trailer-Modal
  let trailerEmbedUrl = $state(null);
  let showMediaInfo   = $state(false);   // Medieninformationen-Modal
  let mediaInfoScroll = $state();           // Scroll-Container des Modals (bind:this, für D-Pad-Scrollen)

  // Teilen: QR-Code mit öffentlichem Titel-Link (IMDb/TMDb) — jeder kann ihn scannen, kein Serverzugang nötig.
  let showShare = $state(false);
  let kebabBtnEl = $state();                 // Drei-Punkte-Button (bind:this, immer im DOM)
  const shareFocus = makeFocusReturn();   // Fokus-Rückgabe nach Schließen des Teilen-Modals
  // Nach dem Schließen des Teilen-Modals den Fokus zurück auf die drei Punkte legen.
  $effect(() => { if (!showShare && shareFocus.pending) shareFocus.restore(); });
  let shareQrSvg = $state(null);
  // Öffentlicher Link (IMDb/TMDb) eines Items — oder null, wenn keine eigene ID vorhanden.
  function buildShareUrl(item) {
    const p = item?.ProviderIds || {};
    if (p.Imdb) return `https://www.imdb.com/title/${p.Imdb}/`;
    if (p.Tmdb && (item.Type === 'Movie' || item.Type === 'Series'))
      return `https://www.themoviedb.org/${item.Type === 'Series' ? 'tv' : 'movie'}/${p.Tmdb}`;
    return null;
  }
  // Titel als lesbarer Fallback (Scan zeigt den Namen zum Nachschlagen, nie ein toter Link).
  function shareTitleText(item) {
    return item?.ProductionYear ? `${item.Name} (${item.ProductionYear})` : (item?.Name || '');
  }
  async function openShare() {
    shareFocus.capture(kebabBtnEl);
    showShare = true;
    shareQrSvg = null;
    try {
      let target = buildShareUrl(fullItem);
      // Kein eigener öffentlicher Link (z.B. Staffel/Episode ohne ID) → auf den Serien-Link ausweichen.
      if (!target && fullItem.SeriesId) {
        try {
          const res = await fetch(`${session.serverUrl}/Users/${selectedUser.Id}/Items/${fullItem.SeriesId}?Fields=ProviderIds`, { headers: getAuthHeaders() });
          if (res.ok) target = buildShareUrl(await res.json());
        } catch { /* Serie nicht erreichbar → Titel-Fallback unten */ }
      }
      target = target || shareTitleText(fullItem);
      const { renderSVG } = await import('uqr');   // dynamisch geladen, zero-dependency
      shareQrSvg = renderSVG(target || ' ', { ecc: 'M', border: 1 });   // Vektor statt PNG → gestochen scharf
    } catch (e) { console.warn('[OcenFin] share QR failed', e); }
  }

  function formatBytes(bytes) {
    if (!bytes) return null;
    const gb = bytes / 1073741824;
    if (gb >= 1) return `${gb.toFixed(2)} GB`;
    return `${(bytes / 1048576).toFixed(0)} MB`;
  }

  function formatBitrate(bps) {
    if (!bps) return null;
    return `${(bps / 1000000).toFixed(1)} Mbit/s`;
  }

  const YOUTUBE_APP_ID = 'youtube.leanback.v4';   // LG webOS YouTube-App

  function openTrailer() {
    if (!fullItem?.RemoteTrailers?.length) return;
    const url     = fullItem.RemoteTrailers[0].Url;
    const match   = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([^&?\s]{11})/);
    const videoId = match ? match[1] : null;

    // Auf dem TV: native YouTube-App starten. Embeds scheitern auf WebOS an der Referer-/
    // Plattform-Beschränkung (Fehler 153) — so macht es auch LiteFin/Jellyfin-webOS.
    if (videoId && window.webOS?.service?.request) {
      window.webOS.service.request('luna://com.webos.applicationManager', {
        method: 'launch',
        parameters: { id: YOUTUBE_APP_ID, params: { contentTarget: `v=${videoId}` } },
        onFailure: () => {   // App nicht vorhanden o. Ä. → Embed als Notlösung
          trailerEmbedUrl = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0&playsinline=1&modestbranding=1`;
        },
      });
      return;   // YouTube-App übernimmt; kein App-internes Modal nötig
    }

    // Browser/Entwicklung (kein webOS) oder keine YouTube-URL → wie bisher per Overlay.
    if (videoId) {
      trailerEmbedUrl = `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0&playsinline=1&modestbranding=1`;
    } else {
      trailerEmbedUrl = url;
    }
  }

  // Besetzung: Schauspieler (max. 20) aus den People-Daten
  let castMembers = $derived((fullItem?.People || []).filter(p => p.Type === 'Actor').slice(0, 20));

  // Findet den Index des ersten Streams (Audio/Subtitle), dessen Sprache zur Präferenz passt.
  // Gibt null zurück wenn keine Präferenz gesetzt ('default') oder kein Treffer.
  function matchLanguageStream(streams, type, prefKey) {
    if (!prefKey || prefKey === 'default') return null;
    const lang = LANGUAGES.find(l => l.key === prefKey);
    if (!lang) return null;
    const match = streams.find(s =>
      s.Type === type && s.Language && lang.codes.includes(s.Language.toLowerCase())
    );
    return match ? match.Index : null;
  }

  // Wie Jellyfin im Standardmodus: erzwungenen ("Forced") Untertitel in der Sprache der
  // gewählten Audiospur einblenden. Automatisch wählbar sind: TEXT (VTT) immer; PGS, wenn
  // clientseitiges Rendern an ist (libbitsub → Direct Play); VobSub/DVD ebenso, SOBALD der
  // Server sie als .mks liefert (Jellyfin 12.0+) → dann ebenfalls Direct Play. Auf älteren
  // Servern greift für DVD nur die Opt-out-Option (dann bewusst mit Transcode/Brennen).
  const GRAPHIC_SUB_CODECS = ['pgssub', 'pgs', 'dvdsub', 'dvbsub', 'vobsub', 'sub'];
  function isGraphicSub(s) { return GRAPHIC_SUB_CODECS.includes((s?.Codec || '').toLowerCase()); }
  function subtitleAutoEligible(s) {
    if (!isGraphicSub(s)) return true;                                  // Text → immer
    if (playbackPrefs.pgsRendering === false) return false;            // Bild-Rendern global aus
    const codec = (s?.Codec || '').toLowerCase();
    if (['pgssub', 'pgs'].includes(codec)) return true;               // PGS → clientseitig (Direct Play)
    if (serverVobSub) return true;                                    // VobSub/DVD via .mks → clientseitig (Direct Play)
    return !!playbackPrefs.forcedGraphicSubs;                          // alter Server: nur per Option (gebrannt)
  }
  function pickForcedSubtitle(streams, audioIndex, serverDefault) {
    const audioLang = streams.find(s => s.Type === 'Audio' && s.Index === audioIndex)?.Language?.toLowerCase();
    const subs = streams.filter(s => s.Type === 'Subtitle');
    const pick = subs.find(s => s.IsForced && subtitleAutoEligible(s) && audioLang && s.Language?.toLowerCase() === audioLang)
              ?? subs.find(s => s.IsForced && subtitleAutoEligible(s));
    if (pick) return pick.Index;
    if (serverDefault != null) {
      const def = subs.find(s => s.Index === serverDefault);
      if (def && subtitleAutoEligible(def)) return serverDefault;
    }
    return -1;
  }

  function closeTrailer() {
    trailerEmbedUrl = null;
  }

  const getAuthHeaders = () => authHeaders(session.token);

  // Stale-Guard (Muster wie in Suche/Library): Die Breadcrumb-Navigation (Folge → Serie → Staffel)
  // wechselt das Item schnell hintereinander — nur Antworten zur JÜNGSTEN Anfrage dürfen
  // fullItem/relatedItems/similarItems schreiben, sonst überschreibt eine langsame alte Antwort
  // die neue Ansicht.
  let detailToken = 0;

  // Reaktiv: lädt neu, sobald sich die 'item'-Prop ändert. untrack(), damit der Effect NUR auf
  // item reagiert — nicht auf Stores/User, die loadFullDetails intern synchron liest.
  $effect(() => { const id = item?.Id; if (id) untrack(() => loadFullDetails(id)); });

  async function loadFullDetails(itemId) {
    const myToken = ++detailToken;
    isLoading    = true;
    fullItem     = null;
    relatedItems = [];
    similarItems = [];
    selectedAudioIndex    = -1;
    selectedSubtitleIndex = -1;
    selectedMediaSourceId = null;

    try {
      const res = await fetch(
        `${session.serverUrl}/Users/${selectedUser.Id}/Items/${itemId}?Fields=MediaSources,Overview,Path,ProviderIds,People,RemoteTrailers`,
        { headers: getAuthHeaders() }
      );
      if (res.ok) {
        const data = await res.json();
        if (myToken !== detailToken) return;   // inzwischen anderes Item geöffnet → verwerfen
        fullItem = data;

        if (fullItem.MediaSources?.length > 0) {
          const src = fullItem.MediaSources[0];
          selectedMediaSourceId = src.Id;   // erste Version vorwählen
          applySourceDefaults(src);
        }

        // Parallel laden
        // "Ähnliches" für Staffel/Episode über die SERIE abfragen (sonst liefert der Server
        // ähnliche Staffeln verschiedener Serien). Bei einer Serie direkt deren ID.
        const similarId = (fullItem.Type === 'Season' || fullItem.Type === 'Episode')
          ? (fullItem.SeriesId || itemId)
          : itemId;
        loadSimilarItems(similarId, myToken);
        if (fullItem.Type === 'Episode' && fullItem.SeasonId) {
          loadRelatedItems(fullItem.SeasonId, myToken);
        } else if (fullItem.Type === 'Series' || fullItem.Type === 'Season') {
          loadRelatedItems(fullItem.Id, myToken);
        }
      }
    } catch (e) { console.error(e); }
    // Spinner nur löschen, wenn wir noch aktuell sind — sonst killt eine alte Antwort den der neuen.
    finally     { if (myToken === detailToken) isLoading = false; }
  }

  async function loadSimilarItems(itemId, myToken) {
    try {
      const res = await fetch(
        `${session.serverUrl}/Items/${itemId}/Similar?Limit=10&Fields=PrimaryImageAspectRatio`,
        { headers: getAuthHeaders() }
      );
      if (res.ok) { const d = await res.json(); if (myToken !== detailToken) return; similarItems = d.Items || []; }
    } catch (e) { console.error(e); }
  }

  async function loadRelatedItems(parentId, myToken) {
    try {
      const res = await fetch(
        `${session.serverUrl}/Users/${selectedUser.Id}/Items?ParentId=${parentId}&Fields=Overview,PrimaryImageAspectRatio&SortBy=SortName&EnableTotalRecordCount=false`,
        { headers: getAuthHeaders() }
      );
      if (res.ok) { const d = await res.json(); if (myToken !== detailToken) return; relatedItems = d.Items || []; }
    } catch (e) { console.error(e); }
  }

  async function handlePlay() {
    if (fullItem.Type === 'Series' || fullItem.Type === 'Season') {
      const url = fullItem.Type === 'Series'
        ? `${session.serverUrl}/Shows/NextUp?SeriesId=${fullItem.Id}&UserId=${selectedUser.Id}&Limit=1&EnableTotalRecordCount=false`
        : `${session.serverUrl}/Users/${selectedUser.Id}/Items?ParentId=${fullItem.Id}&IncludeItemTypes=Episode&Filters=IsNotPlayed&Limit=1&SortBy=SortName&EnableTotalRecordCount=false`;
      try {
        const res  = await fetch(url, { headers: getAuthHeaders() });
        const data = await res.json();
        if (data.Items?.length > 0) {
          onPlayVideo?.({ item: data.Items[0], audioIndex: -1, subtitleIndex: -1 });
        } else {
          // Fallback: erste Folge
          const fb = await fetch(
            `${session.serverUrl}/Users/${selectedUser.Id}/Items?ParentId=${fullItem.Id}&IncludeItemTypes=Episode&Recursive=true&Limit=1&SortBy=SortName&EnableTotalRecordCount=false`,
            { headers: getAuthHeaders() }
          );
          const fd = await fb.json();
          if (fd.Items?.length > 0) onPlayVideo?.({ item: fd.Items[0], audioIndex: -1, subtitleIndex: -1 });
        }
      } catch (e) { console.error(e); }
    } else {
      onPlayVideo?.({ item: fullItem, audioIndex: selectedAudioIndex, subtitleIndex: selectedSubtitleIndex, mediaSourceId: selectedMediaSourceId });
    }
  }

  // "Von Anfang": gleiches Item, aber Fortsetzen-Position auf 0 → Player startet bei Null.
  function playFromBeginning() {
    const fresh = { ...fullItem, UserData: { ...(fullItem.UserData || {}), PlaybackPositionTicks: 0 } };
    onPlayVideo?.({ item: fresh, audioIndex: selectedAudioIndex, subtitleIndex: selectedSubtitleIndex, mediaSourceId: selectedMediaSourceId });
  }

  // Zufallsfolge — für lange Serien "spiel einfach irgendwas". Serie → aus ALLEN Folgen (rekursiv über alle
  // Staffeln, Specials/Staffel 0 ausgeschlossen); Staffel → nur aus dieser Staffel. Gleichverteilt, inkl. schon
  // gesehener (bewusst: Comfort-Rewatch). Landet wie handlePlay über onPlayVideo im Player.
  async function playRandomEpisode() {
    const isSeries = fullItem.Type === 'Series';
    const url = `${session.serverUrl}/Users/${selectedUser.Id}/Items?ParentId=${fullItem.Id}`
      + `&IncludeItemTypes=Episode${isSeries ? '&Recursive=true' : ''}&EnableTotalRecordCount=false`;
    try {
      const res  = await fetch(url, { headers: getAuthHeaders() });
      const data = await res.json();
      let pool = (data.Items || []).filter(e => e.Type === 'Episode');
      if (isSeries) pool = pool.filter(e => e.ParentIndexNumber !== 0);   // Specials (Staffel 0) ausschließen
      if (!pool.length) return;
      const pick = pool[Math.floor(Math.random() * pool.length)];
      onPlayVideo?.({ item: pick, audioIndex: -1, subtitleIndex: -1 });
    } catch (e) { console.error(e); }
  }

  async function togglePlayed() {
    // Optimistisch lokal umschalten — kein Neuladen der ganzen Detailseite
    const willBePlayed = !fullItem.UserData?.Played;
    fullItem.UserData = { ...fullItem.UserData, Played: willBePlayed };
    if (item) item.UserData = { ...item.UserData, Played: willBePlayed };   // Original-Listen-Item mitziehen → Herkunftsliste aktualisiert sich
    try {
      await fetch(`${session.serverUrl}/Users/${selectedUser.Id}/PlayedItems/${fullItem.Id}`, {
        method: willBePlayed ? "POST" : "DELETE",
        headers: getAuthHeaders()
      });
    } catch (e) {
      // Bei Fehler zurückrollen
      console.warn('[OcenFin] played-status toggle failed, rolled back:', e);
      fullItem.UserData = { ...fullItem.UserData, Played: !willBePlayed };
      if (item) item.UserData = { ...item.UserData, Played: !willBePlayed };
    }
  }

  async function toggleFavorite() {
    const willBeFav = !fullItem.UserData?.IsFavorite;
    fullItem.UserData = { ...fullItem.UserData, IsFavorite: willBeFav };
    if (item) item.UserData = { ...item.UserData, IsFavorite: willBeFav };   // Original-Listen-Item mitziehen → Favoriten-Ansicht entfernt/ergänzt reaktiv
    try {
      await fetch(`${session.serverUrl}/Users/${selectedUser.Id}/FavoriteItems/${fullItem.Id}`, {
        method: willBeFav ? "POST" : "DELETE",
        headers: getAuthHeaders()
      });
    } catch (e) {
      console.warn('[OcenFin] favorite toggle failed, rolled back:', e);
      fullItem.UserData = { ...fullItem.UserData, IsFavorite: !willBeFav };
      if (item) item.UserData = { ...item.UserData, IsFavorite: !willBeFav };
    }
  }

  // FIX: Nur dispatchen — die reaktive $: if(item) in dieser Datei übernimmt das Laden.
  // Kein direktes loadFullDetails() mehr hier, sonst doppelter API-Call.
  function navigateTo(id) {
    isLoading = true;
    fullItem  = null;   // Spinner sofort zeigen
    onOpenItemById?.(id);
  }

  function getItemImageUrl(targetItem, format = "portrait") {
    if (format === 'landscape') {
      if (targetItem.Type === 'Episode' && targetItem.ImageTags?.Primary)
        return `${session.serverUrl}/Items/${targetItem.Id}/Images/Primary?tag=${targetItem.ImageTags.Primary}&maxWidth=600&quality=80&format=webp`;
      if (targetItem.BackdropImageTags?.length > 0)
        return `${session.serverUrl}/Items/${targetItem.Id}/Images/Backdrop?tag=${targetItem.BackdropImageTags[0]}&maxWidth=600&quality=80&format=webp`;
    }
    if (targetItem.ImageTags?.Primary)
      return `${session.serverUrl}/Items/${targetItem.Id}/Images/Primary?tag=${targetItem.ImageTags.Primary}&fillHeight=400&quality=80&format=webp`;
    if (targetItem.SeriesPrimaryImageTag)
      return `${session.serverUrl}/Items/${targetItem.SeriesId}/Images/Primary?tag=${targetItem.SeriesPrimaryImageTag}&fillHeight=400&quality=80&format=webp`;
    return null;
  }

  function getItemBackdropUrl(targetItem) {
    if (targetItem.BackdropImageTags?.length > 0)
      return `${session.serverUrl}/Items/${targetItem.Id}/Images/Backdrop?tag=${targetItem.BackdropImageTags[0]}&maxWidth=1920&quality=80&format=webp`;
    if (targetItem.ParentBackdropImageTags?.length > 0)
      return `${session.serverUrl}/Items/${targetItem.ParentBackdropItemId}/Images/Backdrop?tag=${targetItem.ParentBackdropImageTags[0]}&maxWidth=1920&quality=80&format=webp`;
    return null;
  }

  // Titel-Logo (transparentes PNG) der Folge/Serie; bei Folgen die Serie. Null → Aufrufer fällt auf Text zurück.
  function getItemLogoUrl(targetItem) {
    if (targetItem.ImageTags?.Logo)
      return `${session.serverUrl}/Items/${targetItem.Id}/Images/Logo?tag=${targetItem.ImageTags.Logo}&maxHeight=200&quality=90&format=webp`;
    if (targetItem.ParentLogoImageTag)
      return `${session.serverUrl}/Items/${targetItem.ParentLogoItemId}/Images/Logo?tag=${targetItem.ParentLogoImageTag}&maxHeight=200&quality=90&format=webp`;
    return null;
  }

  function getRuntimeMinutes(ticks) {
    return !ticks ? "" : Math.round(ticks / 10000000 / 60) + ` ${i18n.t.mins}`;
  }

  // Spoilerschutz: ungesehene Folgen leicht verschleiern. Ausgenommen sind Staffeln (Poster),
  // bereits begonnene, gesehene und als Favorit markierte Folgen.
  function epSpoiler(ep) {
    return spoilerProtection
      && ep?.Type === 'Episode'
      && !ep.UserData?.Played
      && !(ep.UserData?.PlaybackPositionTicks > 0)
      && !ep.UserData?.IsFavorite;
  }

  function getMediaStreams(type) {
    return (selectedSource?.MediaStreams || []).filter(s => s.Type === type);
  }

  function getEndTime(targetItem) {
    if (!targetItem?.RunTimeTicks) return "";
    const remainingTicks = targetItem.RunTimeTicks - (targetItem.UserData?.PlaybackPositionTicks || 0);
    const endDate = new Date(Date.now() + remainingTicks / 10000);
    return `${i18n.t.endsAt} ${endDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: !use24h })}`;   // i18n statt hartkodiertem Deutsch
  }
</script>

<div class="flex flex-col h-full relative overflow-hidden">
  {#if isLoading}
    <div class="flex-1 flex items-center justify-center">
      <div class="w-16 h-16 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
    </div>

  {:else if fullItem}

    <div class="flex-1 overflow-y-auto hide-scrollbar">

      <!-- ════ CINEMATIC HERO-BANNER — Backdrop scrollt mit, läuft unten/links ins App-Grau ════ -->
      <div class="relative">
        {#if detailsBackdrop && getItemBackdropUrl(fullItem)}
          <div class="absolute inset-0 z-0">
            <img src={getItemBackdropUrl(fullItem)} {@attach blurUp(itemBlurHash(fullItem, 'Backdrop'))} alt="" class="w-full h-full object-cover object-top" />
            <div class="absolute inset-0 bg-gradient-to-t from-gray-900 via-gray-900/60 to-gray-900/20"></div>
            <div class="absolute inset-0 bg-gradient-to-r from-gray-900 via-gray-900/40 to-transparent"></div>
          </div>
        {/if}

        <div class="relative z-10 p-10 pt-16">

          <!-- BREADCRUMB + ZURÜCK -->
      <div class="flex items-center gap-6 mb-10" data-focus-group="details-top">
        <button onclick={() => onClose?.()}
          class="bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 px-6 py-2 rounded-lg text-white font-bold focus:outline-none focus:ring-4 focus:ring-white">
          {i18n.t.back}
        </button>
        {#if fullItem.Type === 'Episode'}
          <div class="flex items-center text-xl font-semibold text-gray-400 gap-2">
            <button onclick={() => navigateTo(fullItem.SeriesId)}
              class="hover:text-white focus:text-white focus:outline-none">{fullItem.SeriesName}</button>
            <span>/</span>
            <button onclick={() => navigateTo(fullItem.SeasonId)}
              class="hover:text-white focus:text-white focus:outline-none">{fullItem.SeasonName}</button>
          </div>
        {/if}
      </div>

      <!-- HERO -->
      <div class="flex gap-12 items-start mb-8">

        <div class="w-64 shrink-0 rounded-xl overflow-hidden shadow-2xl border-2 border-gray-700 bg-gray-800">
          {#if getItemImageUrl(fullItem)}
            <img src={getItemImageUrl(fullItem)} {@attach blurUp(itemBlurHash(fullItem))} alt={fullItem.Name} class="w-full h-full object-cover" />
          {/if}
        </div>

        <div class="flex-1 max-w-4xl" data-focus-group="details-hero">
          {#if detailsLogo && getItemLogoUrl(fullItem)}
            <img src={getItemLogoUrl(fullItem)} alt={fullItem.Name} class="max-h-28 max-w-full w-auto object-contain object-left mb-4 drop-shadow-lg" />
          {:else}
            <h1 class="text-6xl font-bold text-white mb-4 drop-shadow-lg">{fullItem.Name}</h1>
          {/if}

          <!-- META -->
          <div class="flex items-center flex-wrap gap-4 text-lg font-semibold text-gray-300 mb-6">
            {#if fullItem.ProductionYear}
              <span class="text-blue-400">{fullItem.ProductionYear}</span>
            {/if}
            {#if fullItem.RunTimeTicks}
              <span class="flex items-center gap-2">
                • {getRuntimeMinutes(fullItem.RunTimeTicks)}
                <span class="text-sm font-normal text-gray-400 bg-gray-800/80 px-2 py-0.5 rounded-md border border-gray-700 ml-1">
                  {getEndTime(fullItem)}
                </span>
              </span>
            {/if}
            {#if fullItem.CommunityRating}
              <span class="flex items-center gap-1 text-yellow-400">
                •
                <svg class="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"/>
                </svg>
                {fullItem.CommunityRating.toFixed(1)}
              </span>
            {/if}
            {#if fullItem.CriticRating}
              <span class="flex items-center gap-1 text-red-400">• {fullItem.CriticRating}%</span>
            {/if}
          </div>

          <p class="text-xl text-gray-300 mb-10 line-clamp-4 leading-relaxed">{fullItem.Overview || i18n.t.noDescription}</p>

          <!-- AKTIONS-BUTTONS -->
          <div class="flex items-center gap-4 mb-12">
            <button onclick={handlePlay} {@attach focusOnMount()}
              class="bg-white hover:bg-gray-200 focus:bg-gray-200 text-black font-bold text-2xl px-12 py-4 rounded-xl
                     focus:outline-none focus:ring-4 focus:ring-blue-500 transition-all flex items-center gap-3 shadow-lg">
              <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 20 20"><path d="M4 4l12 6-12 6z"/></svg>
              {#if fullItem.UserData?.PlaybackPositionTicks > 0}{i18n.t.resumePlay}{:else}{i18n.t.play}{/if}
            </button>

            {#if fullItem.Type === 'Series' || fullItem.Type === 'Season'}
              <button onclick={playRandomEpisode}
                class="bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 text-white font-bold text-lg px-8 py-4 rounded-xl
                       focus:outline-none focus:ring-4 focus:ring-blue-500 transition-colors shadow-lg flex items-center gap-2">
                <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
                  <polyline points="16 3 21 3 21 8"/>
                  <line x1="4" y1="20" x2="21" y2="3"/>
                  <polyline points="21 16 21 21 16 21"/>
                  <line x1="15" y1="15" x2="21" y2="21"/>
                  <line x1="4" y1="4" x2="9" y2="9"/>
                </svg>
                {i18n.t.shuffle}
              </button>
            {/if}

            {#if fullItem.UserData?.PlaybackPositionTicks > 0 && fullItem.Type !== 'Series' && fullItem.Type !== 'Season'}
              <button onclick={playFromBeginning}
                class="bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 text-white font-bold text-lg px-7 py-4 rounded-xl
                       focus:outline-none focus:ring-4 focus:ring-blue-500 transition-colors shadow-lg flex items-center gap-2">
                <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" d="M9 15L3 9m0 0l6-6M3 9h12a6 6 0 010 12h-3"/>
                </svg>
                {i18n.t.playFromStart}
              </button>
            {/if}

            {#if fullItem.RemoteTrailers?.length > 0}
              <button onclick={openTrailer} aria-label={i18n.t.trailer} title={i18n.t.trailer}
                class="p-4 rounded-xl bg-gray-800 text-white hover:bg-gray-700 focus:bg-gray-700
                       focus:outline-none focus:ring-4 focus:ring-blue-500 transition-colors shadow-lg">
                <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M4.5 4.5a3 3 0 00-3 3v9a3 3 0 003 3h8.25a3 3 0 003-3v-9a3 3 0 00-3-3H4.5zM19.94 18.75l-2.69-2.69V7.94l2.69-2.69c.944-.945 2.56-.276 2.56 1.06v11.38c0 1.336-1.616 2.005-2.56 1.06z"/>
                </svg>
              </button>
            {/if}

            <button onclick={togglePlayed}
              class="p-4 rounded-xl focus:outline-none focus:ring-4 focus:ring-blue-500 transition-colors shadow-lg
                     {fullItem.UserData?.Played ? 'bg-green-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white focus:text-white'}">
              <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 20 20">
                <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/>
              </svg>
            </button>

            <button onclick={toggleFavorite}
              class="p-4 rounded-xl focus:outline-none focus:ring-4 focus:ring-blue-500 transition-colors shadow-lg
                     {fullItem.UserData?.IsFavorite ? 'bg-red-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-white focus:text-white'}">
              <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/>
              </svg>
            </button>

            {#if fullItem.MediaSources?.length > 0 || fullItem.Type === 'Series' || fullItem.Type === 'Season'}
              <div class="relative" data-dropdown data-focus-trap={openDropdown === 'kebab' || undefined}>
                <button bind:this={kebabBtnEl} onclick={(e) => toggleDropdown('kebab', e)} aria-label={i18n.t.more} title={i18n.t.more}
                  class="p-4 rounded-xl bg-gray-800 text-gray-400 hover:text-white focus:text-white focus:outline-none focus:ring-4 focus:ring-blue-500 transition-colors shadow-lg">
                  <svg class="w-8 h-8" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>
                </button>
                {#if openDropdown === 'kebab'}
                  <div class="absolute right-0 mt-2 z-50 w-80 flex flex-col gap-1 bg-gray-900 rounded-xl border border-gray-700 p-2 shadow-2xl">
                    {#if fullItem.MediaSources?.length > 0}
                      <button onclick={() => { closeDropdown(false); showMediaInfo = true; }}
                        class="text-left text-base px-4 py-3 rounded-lg text-gray-200 hover:bg-gray-700 focus:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-white flex items-center gap-3">
                        <svg class="w-6 h-6 shrink-0 text-gray-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                        {i18n.t.mediaInfo}
                      </button>
                    {/if}
                    <button onclick={() => { closeDropdown(false); pickerMode = 'playlist'; }}
                      class="text-left text-base px-4 py-3 rounded-lg text-gray-200 hover:bg-gray-700 focus:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-white flex items-center gap-3">
                      <svg class="w-6 h-6 shrink-0 text-gray-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M3 6h13M3 12h9m-9 6h9m4-3v6m3-3h-6"/></svg>
                      {i18n.t.addToPlaylist}
                    </button>
                    <button onclick={() => { closeDropdown(false); pickerMode = 'collection'; }}
                      class="text-left text-base px-4 py-3 rounded-lg text-gray-200 hover:bg-gray-700 focus:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-white flex items-center gap-3">
                      <svg class="w-6 h-6 shrink-0 text-gray-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10"/></svg>
                      {i18n.t.addToCollection}
                    </button>
                    <button onclick={() => { closeDropdown(false); openShare(); }}
                      class="text-left text-base px-4 py-3 rounded-lg text-gray-200 hover:bg-gray-700 focus:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-white flex items-center gap-3">
                      <svg class="w-6 h-6 shrink-0 text-gray-400" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z"/></svg>
                      {i18n.t.share}
                    </button>
                  </div>
                {/if}
              </div>
            {/if}
          </div>

          <!-- STREAM-INFO -->
          {#if fullItem.MediaSources?.length > 0}
            <div class="bg-gray-800/80 border border-gray-700 rounded-xl p-4 flex flex-col gap-4 max-w-2xl">

              <!-- AUFLÖSUNG / VERSION: eigenes Dropdown bei mehreren Quellen, sonst statisch -->
              {#if fullItem.MediaSources.length > 1}
                <div class="flex items-start gap-4 w-full">
                  <svg class="w-6 h-6 text-gray-500 shrink-0 mt-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z"/>
                  </svg>
                  <div class="flex-1" data-dropdown data-focus-trap={openDropdown === 'resolution' || undefined}>
                    <button onclick={(e) => toggleDropdown('resolution', e)}
                      class="w-full flex items-center justify-between bg-gray-900 text-gray-300 text-sm px-4 py-2 rounded border border-gray-600 focus:outline-none focus:ring-2 focus:ring-white">
                      <span>{sourceLabel(selectedSource)}</span>
                      <svg class="w-4 h-4 ml-2 shrink-0 transition-transform {openDropdown === 'resolution' ? 'rotate-180' : ''}" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
                    </button>
                    {#if openDropdown === 'resolution'}
                      <div class="mt-2 flex flex-col gap-1 bg-gray-900 rounded border border-gray-700 p-1">
                        {#each fullItem.MediaSources as src (src.Id)}
                          <button onclick={() => { selectedMediaSourceId = src.Id; onSourceChange(); closeDropdown(); }} data-opt data-active={src.Id === selectedMediaSourceId || undefined}
                            class="text-left text-sm px-3 py-2 rounded focus:outline-none focus:ring-2 focus:ring-white {src.Id === selectedMediaSourceId ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-700 focus:bg-gray-700'}">
                            {sourceLabel(src)}
                          </button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
              {:else}
                {#each getMediaStreams('Video') as stream (stream.Index)}
                  <div class="flex items-center gap-4">
                    <svg class="w-6 h-6 text-gray-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z"/>
                    </svg>
                    <span class="text-sm font-semibold text-gray-300">{stream.DisplayTitle || stream.Codec}</span>
                  </div>
                {/each}
              {/if}

              <!-- AUDIO: eigenes Dropdown bei mehreren Spuren, sonst statisch -->
              {#if getMediaStreams('Audio').length > 1}
                <div class="flex items-start gap-4 w-full">
                  <svg class="w-6 h-6 text-gray-500 shrink-0 mt-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"/>
                  </svg>
                  <div class="flex-1" data-dropdown data-focus-trap={openDropdown === 'audio' || undefined}>
                    <button onclick={(e) => toggleDropdown('audio', e)}
                      class="w-full flex items-center justify-between bg-gray-900 text-gray-300 text-sm px-4 py-2 rounded border border-gray-600 focus:outline-none focus:ring-2 focus:ring-white">
                      <span>{audioLabel(getMediaStreams('Audio').find(s => s.Index === selectedAudioIndex))}</span>
                      <svg class="w-4 h-4 ml-2 shrink-0 transition-transform {openDropdown === 'audio' ? 'rotate-180' : ''}" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
                    </button>
                    {#if openDropdown === 'audio'}
                      <div class="mt-2 flex flex-col gap-1 bg-gray-900 rounded border border-gray-700 p-1">
                        {#each getMediaStreams('Audio') as stream (stream.Index)}
                          <button onclick={() => { selectedAudioIndex = stream.Index; closeDropdown(); }} data-opt data-active={stream.Index === selectedAudioIndex || undefined}
                            class="text-left text-sm px-3 py-2 rounded focus:outline-none focus:ring-2 focus:ring-white {stream.Index === selectedAudioIndex ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-700 focus:bg-gray-700'}">
                            {audioLabel(stream)}
                          </button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
              {:else if getMediaStreams('Audio').length === 1}
                <div class="flex items-center gap-4">
                  <svg class="w-6 h-6 text-gray-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"/>
                  </svg>
                  <span class="text-sm font-semibold text-gray-300">{getMediaStreams('Audio')[0].DisplayTitle || getMediaStreams('Audio')[0].Language || getMediaStreams('Audio')[0].Codec}</span>
                </div>
              {/if}

              <!-- UNTERTITEL: eigenes Dropdown (mit "Aus") -->
              {#if getMediaStreams('Subtitle').length > 0}
                <div class="flex items-start gap-4 w-full">
                  <svg class="w-6 h-6 text-gray-500 shrink-0 mt-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 10h16M4 14h16M4 18h16"/>
                  </svg>
                  <div class="flex-1" data-dropdown data-focus-trap={openDropdown === 'subtitle' || undefined}>
                    <button onclick={(e) => toggleDropdown('subtitle', e)}
                      class="w-full flex items-center justify-between bg-gray-900 text-gray-300 text-sm px-4 py-2 rounded border border-gray-600 focus:outline-none focus:ring-2 focus:ring-white">
                      <span>{selectedSubtitleIndex === -1 ? i18n.t.subtitleOff : subtitleLabel(getMediaStreams('Subtitle').find(s => s.Index === selectedSubtitleIndex))}</span>
                      <svg class="w-4 h-4 ml-2 shrink-0 transition-transform {openDropdown === 'subtitle' ? 'rotate-180' : ''}" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7"/></svg>
                    </button>
                    {#if openDropdown === 'subtitle'}
                      <div class="mt-2 flex flex-col gap-1 bg-gray-900 rounded border border-gray-700 p-1">
                        <button onclick={() => { selectedSubtitleIndex = -1; closeDropdown(); }} data-opt data-active={selectedSubtitleIndex === -1 || undefined}
                          class="text-left text-sm px-3 py-2 rounded focus:outline-none focus:ring-2 focus:ring-white {selectedSubtitleIndex === -1 ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-700 focus:bg-gray-700'}">
                          {i18n.t.subtitleOff}
                        </button>
                        {#each getMediaStreams('Subtitle') as stream (stream.Index)}
                          <button onclick={() => { selectedSubtitleIndex = stream.Index; closeDropdown(); }} data-opt data-active={stream.Index === selectedSubtitleIndex || undefined}
                            class="text-left text-sm px-3 py-2 rounded focus:outline-none focus:ring-2 focus:ring-white {stream.Index === selectedSubtitleIndex ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-700 focus:bg-gray-700'}">
                            {subtitleLabel(stream)}
                          </button>
                        {/each}
                      </div>
                    {/if}
                  </div>
                </div>
              {/if}

            </div>
          {/if}

        </div>
      </div>
        </div>
      </div>
      <!-- ════ /HERO-BANNER ════ -->

      <!-- INHALT (Reihen) auf vollem App-Grau — eigene Fokus-Gruppe pro Reihe,
           damit D-Pad LINKS am Reihenanfang direkt zur Sidebar springt. -->
      <div class="relative z-10 px-10 pb-16 bg-gray-900 flex flex-col">

      <!-- STAFFELN / FOLGEN -->
      {#if relatedItems.length > 0}
        <div class="mt-8 border-t border-gray-800 pt-8" data-focus-group="details-episodes">
          <h2 class="text-3xl font-bold text-white mb-6">
            {#if fullItem.Type === 'Series'}{i18n.t.seasons}
            {:else if fullItem.Type === 'Season'}{i18n.t.episodes}
            {:else}{i18n.t.moreFromSeason} {fullItem.SeasonName || ''}
            {/if}
          </h2>
          <div class="flex gap-6 overflow-x-auto hide-scrollbar pb-8 px-2 snap-row">
            {#each relatedItems as ep (ep.Id)}
              <button onclick={() => { fullItem = null; loadFullDetails(ep.Id); }}
                class="shrink-0 group flex flex-col focus:outline-none text-left relative {ep.Type === 'Season' ? 'w-48' : 'w-80'}">
                <div class="{ep.Type === 'Season' ? 'aspect-[2/3]' : 'aspect-video'} w-full bg-gray-800 rounded-xl overflow-hidden border-4 border-transparent group-focus:border-white group-hover:border-gray-500 transition-all shadow-xl relative">
                  {#if getItemImageUrl(ep, ep.Type === 'Season' ? 'portrait' : 'landscape')}
                    <img src={getItemImageUrl(ep, ep.Type === 'Season' ? 'portrait' : 'landscape')} {@attach blurUp(itemBlurHash(ep))} alt={ep.Name} loading="lazy"
                      class="w-full h-full object-cover transition-all duration-200 {epSpoiler(ep) ? 'blur-md scale-110' : ''}" />
                  {/if}
                  {#if itemProgress(ep) > 0}
                    <div class="absolute bottom-0 left-0 w-full h-1.5 bg-gray-900/80">
                      <div class="h-full bg-blue-500" style="width:{itemProgress(ep)}%"></div>
                    </div>
                  {/if}
                  {#if ep.UserData?.Played}
                    <div class="absolute top-2 right-2 bg-green-500 text-white rounded-full p-1 shadow-md">
                      <svg class="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                        <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/>
                      </svg>
                    </div>
                  {/if}
                </div>
                <span class="mt-3 text-sm font-bold text-gray-300 group-focus:text-white truncate w-full">
                  {#if ep.IndexNumber && ep.Type !== 'Season'}{ep.IndexNumber}.&nbsp;{/if}{ep.Name}
                </span>
              </button>
            {/each}
          </div>
        </div>
      {/if}

      <!-- BESETZUNG (antippbar → Filmografie der Person) — gehört zum Titel, daher über Ähnliches -->
      {#if castMembers.length > 0}
        <div class="mt-8 border-t border-gray-800 pt-8" data-focus-group="details-cast">
          <h2 class="text-3xl font-bold text-white mb-6">{i18n.t.cast}</h2>
          <div class="flex gap-6 overflow-x-auto hide-scrollbar pb-8 px-2 snap-row">
            {#each castMembers as person (person.Id)}
              <button onclick={() => onOpenPerson?.(person)} class="shrink-0 w-36 group focus:outline-none text-center">
                <div class="aspect-square w-full bg-gray-800 rounded-full overflow-hidden border-4 border-transparent group-focus:border-white shadow-xl mx-auto">
                  {#if personImageUrl(session.serverUrl, person)}
                    <img src={personImageUrl(session.serverUrl, person)} {@attach blurUp(itemBlurHash(person))} alt={person.Name} class="w-full h-full object-cover" loading="lazy" />
                  {:else}
                    <div class="w-full h-full flex items-center justify-center text-gray-600">
                      <svg class="w-14 h-14" fill="currentColor" viewBox="0 0 24 24"><path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/></svg>
                    </div>
                  {/if}
                </div>
                <span class="mt-3 text-sm font-bold text-gray-300 group-focus:text-white truncate w-full block">{person.Name}</span>
                {#if person.Role}<span class="text-xs text-gray-500 truncate w-full block">{person.Role}</span>{/if}
              </button>
            {/each}
          </div>
        </div>
      {/if}

      <!-- ÄHNLICHES -->
      {#if similarItems.length > 0}
        <div class="mt-8 border-t border-gray-800 pt-8" data-focus-group="details-similar">
          <h2 class="text-3xl font-bold text-white mb-6">{i18n.t.similar}</h2>
          <div class="flex gap-6 overflow-x-auto hide-scrollbar pb-8 px-2 snap-row">
            {#each similarItems as si (si.Id)}
              <button onclick={() => navigateTo(si.Id)} class="shrink-0 w-48 group flex flex-col focus:outline-none text-left">
                <div class="aspect-[2/3] w-full bg-gray-800 rounded-xl overflow-hidden border-4 border-transparent group-focus:border-white shadow-xl">
                  {#if getItemImageUrl(si, 'portrait')}
                    <img src={getItemImageUrl(si, 'portrait')} {@attach blurUp(itemBlurHash(si))} alt={si.Name} class="w-full h-full object-cover" loading="lazy" />
                  {/if}
                </div>
                <span class="mt-3 text-sm font-bold text-gray-300 group-focus:text-white truncate w-full">{si.Name}</span>
              </button>
            {/each}
          </div>
        </div>
      {/if}

      </div>
      <!-- ════ /INHALT ════ -->
    </div>
  {/if}
</div>

<!-- TRAILER-MODAL — YouTube Embed oder direktes Video -->
{#if trailerEmbedUrl}
  <div
    data-focus-trap
    class="fixed inset-0 bg-black z-[200] flex items-center justify-center"
    onkeydown={(e) => { if (isBackKey(e)) { e.stopPropagation(); closeTrailer(); } }}
  >
    <!-- Schließen-Button (oben rechts, über dem Video) -->
    <button
      onclick={closeTrailer}
      {@attach focusOnMount()}
      class="absolute top-6 right-8 z-10 text-white/80 hover:text-white focus:text-white
             bg-black/50 rounded-full p-3 focus:outline-none focus:ring-4 focus:ring-white transition-colors"
    >
      <svg class="w-9 h-9" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/>
      </svg>
    </button>

    <!-- Vollbild: Video füllt den Bildschirm -->
    {#if trailerEmbedUrl.includes('/embed/')}
      <iframe
        src={trailerEmbedUrl}
        class="w-full h-full"
        allow="autoplay; fullscreen"
        allowfullscreen
        title={i18n.t.trailer}
      ></iframe>
    {:else}
      <!-- svelte-ignore a11y-media-has-caption -->
      <video
        src={trailerEmbedUrl}
        class="w-full h-full object-contain"
        autoplay
        controls
      ></video>
    {/if}
  </div>
{/if}

<!-- MEDIENINFORMATIONEN-MODAL (Codec, Bitrate, Sprachen, …) -->
{#if showMediaInfo && fullItem?.MediaSources?.length}
  <div data-focus-trap transition:uiFade onoutrostart={dropTrapOnOutro} class="fixed inset-0 bg-black/90 z-[200] flex items-center justify-center p-8"
    onkeydown={(e) => {
      if (isBackKey(e)) { e.stopPropagation(); showMediaInfo = false; return; }
      if (e.key === 'ArrowDown')    { e.preventDefault(); e.stopPropagation(); mediaInfoScroll?.scrollBy({ top: 160, behavior: 'smooth' }); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); mediaInfoScroll?.scrollBy({ top: -160, behavior: 'smooth' }); }
    }}>
    <div bind:this={mediaInfoScroll} class="bg-gray-800 border border-gray-700 rounded-2xl w-full max-w-3xl max-h-[85vh] overflow-y-auto hide-scrollbar shadow-2xl">
      <div class="flex justify-between items-center p-8 pb-4 sticky top-0 bg-gray-800 z-10">
        <h2 class="text-4xl text-white font-bold">{i18n.t.mediaInfo}</h2>
        <button onclick={() => showMediaInfo = false} {@attach focusOnMount()}
          class="text-gray-400 hover:text-white focus:text-white focus:outline-none focus:ring-4 focus:ring-white rounded-full p-2">
          <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
        </button>
      </div>
      <!-- Zeigt die aktuell GEWÄHLTE Version (nicht stur die erste) — folgt der Auflösungsauswahl -->
      {#each (selectedSource ? [selectedSource] : []) as src (src.Id)}
        <div class="px-8 pb-8 flex flex-col gap-5">
          <!-- Datei: Container / Größe / Gesamtbitrate -->
          <div class="grid grid-cols-3 gap-3">
            {#if src.Container}
              <div><div class="text-gray-500 text-xs uppercase tracking-wider">Container</div><div class="text-white font-semibold uppercase">{src.Container}</div></div>
            {/if}
            {#if formatBytes(src.Size)}
              <div><div class="text-gray-500 text-xs uppercase tracking-wider">{i18n.t.miSize}</div><div class="text-white font-semibold">{formatBytes(src.Size)}</div></div>
            {/if}
            {#if formatBitrate(src.Bitrate)}
              <div><div class="text-gray-500 text-xs uppercase tracking-wider">Bitrate</div><div class="text-white font-semibold">{formatBitrate(src.Bitrate)}</div></div>
            {/if}
          </div>

          <!-- Einzelne Spuren -->
          {#each (src.MediaStreams || []) as s (s.Index)}
            <div class="bg-gray-900 rounded-xl p-4 border border-gray-700/50">
              <div class="flex items-center gap-3 mb-2">
                <span class="text-xs uppercase font-bold px-2 py-1 rounded bg-blue-600 text-white shrink-0">{s.Type === 'Subtitle' ? i18n.t.miSubtitle : s.Type}</span>
                <span class="text-white font-semibold truncate">{s.DisplayTitle || s.Codec || '—'}</span>
              </div>
              <div class="grid grid-cols-2 gap-x-6 gap-y-1 text-sm text-gray-300">
                {#if s.Codec}<div><span class="text-gray-500">Codec:&nbsp;</span>{s.Codec.toUpperCase()}</div>{/if}
                {#if s.Type === 'Video' && s.Width}<div><span class="text-gray-500">{i18n.t.miResolution}:&nbsp;</span>{s.Width}×{s.Height}</div>{/if}
                {#if s.Type === 'Video' && s.VideoRange}<div><span class="text-gray-500">HDR:&nbsp;</span>{s.VideoRange}</div>{/if}
                {#if s.Type === 'Video' && s.AverageFrameRate}<div><span class="text-gray-500">{i18n.t.miFramerate}:&nbsp;</span>{s.AverageFrameRate.toFixed(0)} fps</div>{/if}
                {#if s.Type === 'Audio' && s.ChannelLayout}<div><span class="text-gray-500">{i18n.t.miChannels}:&nbsp;</span>{s.ChannelLayout}</div>{/if}
                {#if s.Language}<div><span class="text-gray-500">{i18n.t.miLanguage}:&nbsp;</span>{s.Language}</div>{/if}
                {#if formatBitrate(s.BitRate)}<div><span class="text-gray-500">Bitrate:&nbsp;</span>{formatBitrate(s.BitRate)}</div>{/if}
              </div>
            </div>
          {/each}
        </div>
      {/each}
    </div>
  </div>
{/if}

<!-- Teilen: QR-Code mit Titel-Link (IMDb/TMDb) zum Scannen -->
{#if showShare}
  <div class="fixed inset-0 bg-black/90 z-[100] flex items-center justify-center p-8"
    transition:uiFade onoutrostart={dropTrapOnOutro}
    onkeydown={(e) => { if (isBackKey(e)) { e.stopPropagation(); showShare = false; } }}>
    <div data-modal data-focus-trap
      class="bg-gray-800 border border-gray-700 rounded-2xl p-8 w-full max-w-lg flex flex-col items-center gap-5 shadow-2xl">
      <div class="flex items-center justify-between gap-4 w-full">
        <h2 class="text-3xl text-white font-bold">{i18n.t.share}</h2>
        <button onclick={() => showShare = false} {@attach focusOnMount()}
          class="px-5 py-3 rounded-xl font-bold bg-gray-700 hover:bg-gray-600 focus:bg-gray-600 text-white
                 focus:outline-none focus:ring-4 focus:ring-white transition-colors">{i18n.t.close}</button>
      </div>
      {#if shareQrSvg}
        <div class="rounded-xl bg-white p-3 [&>svg]:block [&>svg]:w-full [&>svg]:h-full"
             style="width:320px;height:320px;max-width:40vh;max-height:40vh;">{@html shareQrSvg}</div>
      {/if}
      <p class="text-white font-bold text-center break-words">{fullItem?.Name}</p>
      <p class="text-gray-400 text-base text-center max-w-md">{i18n.t.shareHint}</p>
    </div>
  </div>
{/if}

<!-- Zur Sammlung / Wiedergabeliste hinzufügen (gemeinsame Komponente) -->
<AddToPicker mode={pickerMode} item={fullItem} {selectedUser} {getAuthHeaders}
  onCreated={() => onLibChanged?.()} onClose={() => pickerMode = null} />

<style>
  .snap-row { scroll-snap-type: x proximity; scroll-padding-inline-start: 0.5rem; }
  .snap-row > * { scroll-snap-align: start; }
</style>
