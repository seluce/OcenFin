// ============================================================
// PlaybackInfo / Transkodierung
// Der Server entscheidet anhand des Geräteprofils, ob ein Titel direkt
// abgespielt werden kann (Direct Play / Direct Stream) oder transkodiert
// werden muss (z.B. 10-Bit-H.264 "Hi10P", oder ASS-Untertitel die ins Bild
// gebrannt werden müssen, weil der Browser nur VTT rendern kann).
// ============================================================

import { dlog } from './utils.js';

// Auth-Header — exakt im selben Format wie die übrigen (funktionierenden) API-Aufrufe der App,
// damit PlaybackInfo nicht an einem abweichenden Header scheitert.
function authHeader(token) {
  return `MediaBrowser Token="${token}"`;
}

// Geräteprofil für den LG B4 (webOS, Chromium-basierter <video>-Player).
// Bewusste Entscheidungen:
//  • Direct Play breit erlaubt: HEVC, VP9, AV1, H.264 dekodiert der B4 nativ.
//  • Hi10P (10-Bit H.264) wird über ein CodecProfile geblockt → Server transkodiert.
//    (10-Bit H.264 kann praktisch keine Hardware dekodieren, auch High-End-TVs nicht.)
//  • DTS NICHT in Direct Play → der Browser kann DTS oft nicht dekodieren (sonst Video
//    läuft, aber kein Ton). Server macht dann einen leichten reinen Audio-Transcode.
//  • Transkodier-Ziel: HLS (TS/H.264/AAC) — über hls.js universell abspielbar.
//  • Untertitel: VTT/SRT extern (als Spur), ASS/SSA/PGS/VOBSUB werden ins Bild gebrannt.
export function buildDeviceProfile(maxBitrate = 120000000, burnSubtitles = false, clientGraphicSubs = false, serverVobSub = false) {
  // Textuntertitel (SubRip/ASS): bei burnSubtitles=true ins Bild brennen (mit Styling, aber
  // Transcode + harter Wechsel), sonst extern als VTT liefern → eigener Overlay-Renderer
  // (kein Styling, dafür Direct Play + weicher Wechsel). Grafik-Untertitel immer brennen.
  const textSub = burnSubtitles ? 'Encode' : 'External';
  // Bild-Untertitel werden clientseitig via libbitsub gerendert (wenn aktiviert) → als External
  // liefern → kein Transcode, Direct Play bleibt. Sonst brennen.
  //   • PGS (Blu-ray): liefert Jellyfin schon immer extern als .sup → läuft überall.
  //   • VobSub (DVD/dvdsub): liefert Jellyfin erst ab 12.0 als .mks-Container (PR #16552).
  //     Auf älteren Servern NICHT extern möglich (404) → dort weiter brennen (serverVobSub=false).
  const pgsSub = clientGraphicSubs ? 'External' : 'Encode';
  const vobSub = (clientGraphicSubs && serverVobSub) ? 'External' : 'Encode';

  // Läuft die App auf dem echten TV (webOS)? Dort dekodiert die Media-Pipeline auch DTS, Dolby
  // TrueHD/Atmos und MP2 (europäische DVB-/TS-Inhalte) → in Direct Play erlauben, damit der Server
  // NICHT unnötig transkodiert. Im Browser-Dev (Firefox/Linux) bleibt es bei sicher dekodierbaren
  // Codecs (sonst Bild ohne Ton). Alle Zusätze sind rein additiv → können Direct Play nur erweitern.
  const isWebOS = (typeof window !== 'undefined' && !!window.webOSSystem)
               || (typeof navigator !== 'undefined' && /web0s|webos/i.test(navigator.userAgent || ''));
  const tvAudio  = isWebOS ? ',dts,truehd,mp2' : '';
  const baseAudio = `aac,mp3,ac3,eac3,flac,alac,opus,vorbis,pcm${tvAudio}`;
  const tsAudio   = `aac,mp3,ac3,eac3${isWebOS ? ',dts,truehd,mp2' : ''}`;

  return {
    MaxStreamingBitrate: maxBitrate,
    MaxStaticBitrate: maxBitrate,
    MusicStreamingTranscodingBitrate: 384000,

    DirectPlayProfiles: [
      // Video — der B4 dekodiert H.264, HEVC (inkl. HDR10/HLG/HDR10+/Dolby Vision),
      // VP9 und AV1 in Hardware. AC3/EAC3/FLAC/ALAC/PCM überall; DTS/TrueHD nur auf dem TV.
      { Container: 'mp4,m4v,mov',     Type: 'Video', VideoCodec: 'h264,hevc,vp9,av1', AudioCodec: baseAudio },
      { Container: 'mkv',             Type: 'Video', VideoCodec: 'h264,hevc,vp9,av1', AudioCodec: baseAudio },
      { Container: 'ts,m2ts,mpegts',  Type: 'Video', VideoCodec: 'h264,hevc',        AudioCodec: tsAudio },
      { Container: 'webm',            Type: 'Video', VideoCodec: 'vp9,av1',          AudioCodec: 'opus,vorbis' },
      { Container: 'mp3', Type: 'Audio' },
      { Container: 'aac', Type: 'Audio' },
      { Container: 'flac', Type: 'Audio' },
      { Container: 'opus', Type: 'Audio' },
    ],

    TranscodingProfiles: [
      {
        // Fallback wenn Direct Play nicht geht. WICHTIG: Audio NUR AAC — AC3/EAC3 im HLS
        // kann Chromium/MSE (hls.js) oft nicht dekodieren → war die wahrscheinliche Ursache
        // für fehlschlagende/ tonlose HEVC-Wiedergabe. AAC ist universell MSE-kompatibel.
        Container: 'ts', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac',
        Protocol: 'hls', Context: 'Streaming',
        MaxAudioChannels: '2', MinSegments: '1', BreakOnNonKeyFrames: true,
      },
      { Container: 'aac', Type: 'Audio', AudioCodec: 'aac', Protocol: 'http', Context: 'Streaming', MaxAudioChannels: '2' },
    ],

    CodecProfiles: [
      {
        Type: 'Video', Codec: 'h264',
        Conditions: [
          // Hi10P (10-Bit H.264) blocken → erzwingt Transcode
          { Condition: 'NotEquals',      Property: 'VideoProfile',        Value: 'high 10', IsRequired: false },
          { Condition: 'LessThanEqual',  Property: 'VideoLevel',          Value: '52',      IsRequired: false },
          { Condition: 'EqualsAny',      Property: 'VideoRangeType',      Value: 'SDR|HDR10|HLG', IsRequired: false },
        ],
      },
    ],

    SubtitleProfiles: [
      { Format: 'vtt',      Method: textSub },
      { Format: 'webvtt',   Method: textSub },
      { Format: 'srt',      Method: textSub },
      { Format: 'subrip',   Method: textSub },
      { Format: 'mov_text', Method: textSub },
      { Format: 'ass',      Method: textSub },   // gestylt: extern → Overlay ohne Styling, Encode → gebrannt mit Styling
      { Format: 'ssa',      Method: textSub },
      { Format: 'pgssub',   Method: pgsSub     }, // Blu-ray-Bild-Untertitel → libbitsub rendert clientseitig (External) oder brennen
      { Format: 'dvdsub',   Method: vobSub     }, // DVD/VobSub → External (.mks) ab Jellyfin 12.0, sonst brennen
      { Format: 'vobsub',   Method: vobSub     },
      { Format: 'pgs',      Method: pgsSub     },
    ],
  };
}

// Ruft /Items/{id}/PlaybackInfo auf und liefert die Server-Entscheidung.
// AutoOpenLiveStream=true sorgt dafür, dass eine ggf. nötige Transkodier-Session
// sofort geöffnet und eine nutzbare TranscodingUrl zurückgegeben wird.
export async function getPlaybackInfo({
  serverUrl, userId, token, itemId,
  audioStreamIndex = null, subtitleStreamIndex = null,
  maxBitrate = 120000000, startTicks = 0,
  enableDirectPlay = true, enableDirectStream = true, allowAudioStreamCopy = true,
  burnSubtitles = false, mediaSourceId = null, clientGraphicSubs = false, serverVobSub = false,
}) {
  // WICHTIG: Jellyfin liest AudioStreamIndex/SubtitleStreamIndex und die Enable*-Flags
  // aus dem QUERY-STRING (nur das DeviceProfile gehört in den Body). Genau so macht es
  // jellyfin-web. Vorher standen sie im Body → Server ignorierte die gewählte Tonspur.
  const qs = new URLSearchParams({
    UserId: userId,
    StartTimeTicks: String(startTicks),
    MaxStreamingBitrate: String(maxBitrate),
    EnableDirectPlay: String(enableDirectPlay),
    EnableDirectStream: String(enableDirectStream),
    EnableTranscoding: 'true',
    AllowVideoStreamCopy: 'true',
    AllowAudioStreamCopy: String(allowAudioStreamCopy),
    AutoOpenLiveStream: 'true',
  });
  if (audioStreamIndex !== null && audioStreamIndex !== -1)       qs.set('AudioStreamIndex', String(audioStreamIndex));
  if (subtitleStreamIndex !== null && subtitleStreamIndex !== -1) qs.set('SubtitleStreamIndex', String(subtitleStreamIndex));
  if (mediaSourceId) qs.set('MediaSourceId', mediaSourceId);   // gewählte Version erzwingen

  // Body: DeviceProfile (Pflicht) + dieselben Felder zur Sicherheit (manche Versionen lesen sie hier).
  const body = {
    UserId: userId,
    DeviceProfile: buildDeviceProfile(maxBitrate, burnSubtitles, clientGraphicSubs, serverVobSub),
    MaxStreamingBitrate: maxBitrate,
    StartTimeTicks: startTicks,
    EnableDirectPlay: enableDirectPlay,
    EnableDirectStream: enableDirectStream,
    EnableTranscoding: true,
    AllowVideoStreamCopy: true,
    AllowAudioStreamCopy: allowAudioStreamCopy,
    AutoOpenLiveStream: true,
  };
  if (audioStreamIndex !== null && audioStreamIndex !== -1)       body.AudioStreamIndex = audioStreamIndex;
  if (subtitleStreamIndex !== null && subtitleStreamIndex !== -1) body.SubtitleStreamIndex = subtitleStreamIndex;
  if (mediaSourceId) body.MediaSourceId = mediaSourceId;
  dlog('[OcenFin] PlaybackInfo request:', { audioStreamIndex, subtitleStreamIndex, enableDirectPlay, enableDirectStream, allowAudioStreamCopy });

  const res = await fetch(`${serverUrl}/Items/${itemId}/PlaybackInfo?${qs.toString()}`, {
    method: 'POST',
    headers: { 'Authorization': authHeader(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    console.error(`[OcenFin] PlaybackInfo HTTP ${res.status}:`, txt.slice(0, 300));
    throw new Error(`PlaybackInfo HTTP ${res.status}`);
  }
  const data = await res.json();
  const ms = (mediaSourceId && data.MediaSources?.find(s => s.Id === mediaSourceId)) || data.MediaSources?.[0] || null;
  const vStream = ms?.MediaStreams?.find(s => s.Type === 'Video');
  const aStream = ms?.MediaStreams?.find(s => s.Type === 'Audio' && (audioStreamIndex == null || audioStreamIndex < 0 || s.Index === audioStreamIndex));
  // Welche Audiospur hat der SERVER tatsächlich gewählt (aus der Transcoding-URL gelesen)?
  const urlAudioIdx = ms?.TranscodingUrl?.match(/AudioStreamIndex=(-?\d+)/)?.[1] ?? null;
  const urlSubIdx   = ms?.TranscodingUrl?.match(/SubtitleStreamIndex=(-?\d+)/)?.[1] ?? null;
  // Ausführliche Diagnose — zeigt GENAU warum/wie der Server abspielt.
  dlog('[OcenFin] PlaybackInfo:', {
    method: ms?.TranscodingUrl ? 'Transcode' : (ms?.SupportsDirectPlay ? 'DirectPlay' : 'DirectStream'),
    transcoding: !!ms?.TranscodingUrl,
    subProtocol: ms?.TranscodingSubProtocol,
    container: ms?.Container,
    transcodeReasons: ms?.TranscodeReasons,        // z.B. ["VideoCodecNotSupported"] / ["SubtitleCodecNotSupported"]
    sourceVideo: vStream ? `${vStream.Codec} ${vStream.VideoRange || ''} ${vStream.Profile || ''} ${vStream.BitDepth || 8}bit`.trim() : null,
    sourceAudio: aStream ? `${aStream.Codec} ${aStream.Channels}ch` : null,
    urlAudioStreamIndex: urlAudioIdx,              // im Transcode tatsächlich gewählte Audiospur
    urlSubtitleStreamIndex: urlSubIdx,
    audioStreams: (ms?.MediaStreams || []).filter(s => s.Type === 'Audio').map(s => `#${s.Index} ${s.Language || '?'} ${s.Codec}`),
    subtitleStreams: (ms?.MediaStreams || []).filter(s => s.Type === 'Subtitle').map(s => `#${s.Index} ${s.Language || '?'} ${s.Codec} (${s.DeliveryMethod || '-'})`),
  });
  // Flach geloggt (ohne Aufklappen sichtbar): welche Spur der Server WIRKLICH nimmt + volle URL.
  dlog(`[OcenFin] → server chose AudioStreamIndex=${urlAudioIdx} SubtitleStreamIndex=${urlSubIdx} | requested Audio=${audioStreamIndex}`);
  if (ms?.TranscodingUrl) dlog('[OcenFin] TranscodingUrl:', ms.TranscodingUrl);
  return { mediaSource: ms, playSessionId: data.PlaySessionId || null };
}

// ---- Leichter Prefetch der nächsten Folge -----------------------------------------------------
// Holt die PlaybackInfo der nächsten Folge im Voraus und cached das Promise kurz, damit der
// Folgenwechsel den Netzwerk-Roundtrip spart. KEIN Video-Pre-Buffering (das würde bei Transcode
// eine zweite Session öffnen) — nur Metadaten/Stream-URL. Greift nur, wenn die Parameter passen,
// sonst normaler Abruf (sicheres Fallback).
const _pfCache = new Map();   // itemId → { ts, key, promise }
const _PF_TTL  = 25000;       // ~25 s gültig (so lange bleibt auch eine Transcode-Session offen)

function _pfKey(p) {
  return [p.itemId, p.audioStreamIndex ?? -1, p.subtitleStreamIndex ?? -1, !!p.burnSubtitles, p.mediaSourceId || '', !!p.clientGraphicSubs, !!p.serverVobSub].join('|');
}

export function prefetchPlaybackInfo(params) {
  if (!params?.itemId) return;
  const key = _pfKey(params);
  const existing = _pfCache.get(params.itemId);
  if (existing && existing.key === key && Date.now() - existing.ts < _PF_TTL) return;  // schon frisch geladen
  _pfCache.set(params.itemId, { ts: Date.now(), key, promise: getPlaybackInfo(params).catch(() => null) });
}

export async function getPlaybackInfoFast(params) {
  const entry = _pfCache.get(params.itemId);
  if (entry && entry.key === _pfKey(params) && Date.now() - entry.ts < _PF_TTL) {
    _pfCache.delete(params.itemId);
    const info = await entry.promise;
    if (info) { dlog('[OcenFin] PlaybackInfo taken from prefetch'); return info; }
  }
  return getPlaybackInfo(params);
}

// Baut aus der Server-Entscheidung die finale Wiedergabe-URL + Metadaten.
// Rückgabe: { url, isHls, method, mediaSource }
export function resolveStream({ serverUrl, token, itemId, mediaSource, audioStreamIndex = -1, subtitleStreamIndex = -1 }) {
  // Transkodieren: Server liefert eine (relative) TranscodingUrl, meist HLS.
  if (mediaSource?.TranscodingUrl) {
    let url = mediaSource.TranscodingUrl.startsWith('http')
      ? mediaSource.TranscodingUrl
      : `${serverUrl}${mediaSource.TranscodingUrl}`;

    // WICHTIG: Jellyfin ignoriert in der generierten TranscodingUrl unsere gewünschten
    // Indizes und trägt stur die Profil-Standardsprache ein (z. B. Audio=1, Subtitle=3).
    // Die eigentliche Transkodierung wird aber erst beim master.m3u8-Abruf anhand der
    // URL-Query ausgelöst — daher überschreiben wir die Parameter hier direkt.
    const setParam = (u, key, val) =>
      u.includes(`${key}=`)
        ? u.replace(new RegExp(`${key}=-?\\d+`), `${key}=${val}`)
        : `${u}&${key}=${val}`;

    if (audioStreamIndex !== null && audioStreamIndex !== -1) {
      url = setParam(url, 'AudioStreamIndex', audioStreamIndex);
    }
    // Untertitel: gewünschte Spur erzwingen – oder explizit -1, um einen vom Server
    // stur eingebrannten (forced) Untertitel zu entfernen.
    url = setParam(url, 'SubtitleStreamIndex', subtitleStreamIndex === null ? -1 : subtitleStreamIndex);

    const isHls = (mediaSource.TranscodingSubProtocol || '').toLowerCase() === 'hls' || url.includes('.m3u8');
    dlog('[OcenFin] TranscodingUrl patched →', { audioStreamIndex, subtitleStreamIndex });
    return { url, isHls, method: 'Transcode', mediaSource };
  }
  // Direct Play / Direct Stream: vollständige, byte-seekbare Datei (Container unverändert;
  // serverseitige Tonspur-Wahl ist hier nicht möglich, daher keine Index-Parameter).
  const msId = mediaSource?.Id || itemId;
  const url = `${serverUrl}/Videos/${itemId}/stream?static=true&mediaSourceId=${msId}&ApiKey=${token}`;
  const method = (mediaSource && mediaSource.SupportsDirectStream && !mediaSource.SupportsDirectPlay)
    ? 'DirectStream' : 'DirectPlay';
  return { url, isHls: false, method, mediaSource };
}

// Liefert die externe VTT-Untertitel-URL für eine Spur (falls DeliveryMethod = External).
export function externalSubtitleUrl({ serverUrl, itemId, mediaSourceId, stream, token }) {
  if (!stream) return null;
  // IMMER als WebVTT anfordern: unser Overlay-Renderer parst nur VTT, und stream.DeliveryUrl
  // zeigt häufig auf das Quellformat (.subrip/.srt). Jellyfin konvertiert hier on-the-fly.
  return `${serverUrl}/Videos/${itemId}/${mediaSourceId}/Subtitles/${stream.Index}/0/Stream.vtt?ApiKey=${token}`;
}

// Liefert die Original-ASS/SSA-URL für JASSUB (clientseitiges Rendern mit vollem Styling).
// Bewusst IMMER Stream.ass: liefert das Originalformat samt Styles statt der VTT-Konvertierung,
// die Positionierung/Typesetting verwirft (SSA wird vom Server nach ASS gewandelt).
export function assSubtitleUrl({ serverUrl, itemId, mediaSourceId, stream, token }) {
  if (!stream) return null;
  return `${serverUrl}/Videos/${itemId}/${mediaSourceId}/Subtitles/${stream.Index}/0/Stream.ass?ApiKey=${token}`;
}

// Liefert die rohe Bild-Untertitel-URL für libbitsub. Bevorzugt IMMER die vom Server berechnete
// DeliveryUrl (richtiges Format: PGS=.sup, VobSub=.mks ab Jellyfin 12.0). Fällt nur für PGS auf
// den Standard-.sup-Endpunkt zurück — VobSub OHNE DeliveryUrl ist nicht abrufbar (alter Server).
export function graphicSubtitleUrl({ serverUrl, itemId, mediaSourceId, stream, token }) {
  if (!stream) return null;
  if (stream.DeliveryUrl) {
    const u = stream.DeliveryUrl;
    if (/^https?:/i.test(u)) return u;
    return `${serverUrl}${u}${(u.includes('api_key') || u.includes('ApiKey')) ? '' : (u.includes('?') ? '&' : '?') + 'ApiKey=' + token}`;
  }
  const codec = (stream.Codec || '').toLowerCase();
  if (codec === 'pgssub' || codec === 'pgs')
    return `${serverUrl}/Videos/${itemId}/${mediaSourceId}/Subtitles/${stream.Index}/0/Stream.sup?ApiKey=${token}`;
  return null;   // VobSub/DVDSub ohne DeliveryUrl → nicht clientseitig renderbar (brennen)
}
