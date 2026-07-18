// ============================================================
// PlaybackInfo / transcoding
// Based on the device profile, the server decides whether a title can be
// played directly (Direct Play / Direct Stream) or has to be transcoded
// (e.g. 10-bit H.264 "Hi10P", or ASS subtitles that must be burned into
// the picture because the browser can only render VTT).
// ============================================================

import { dlog, authHeaders } from './utils.js';

// Device profile for the LG B4 (webOS, Chromium-based <video> player).
// Deliberate choices:
//  • Direct Play broadly allowed: the B4 decodes HEVC, VP9, AV1, H.264 natively.
//  • Hi10P (10-bit H.264) is blocked via a CodecProfile → the server transcodes.
//    (Practically no hardware can decode 10-bit H.264, not even high-end TVs.)
//  • DTS NOT in Direct Play → the browser often can't decode DTS (otherwise video
//    plays but there's no sound). The server then does a light audio-only transcode.
//  • Transcode target: HLS (TS/H.264/AAC) — universally playable via hls.js.
//  • Subtitles: VTT/SRT external (as a track), ASS/SSA/PGS/VOBSUB are burned into the picture.
export function buildDeviceProfile(maxBitrate = 120000000, burnSubtitles = false, clientGraphicSubs = false, serverVobSub = false) {
  // Text subtitles (SubRip/ASS): with burnSubtitles=true burn into the picture (with styling, but
  // transcode + hard switch), otherwise deliver externally as VTT → our own overlay renderer
  // (no styling, but Direct Play + soft switch). Graphic subtitles are always burned in.
  const textSub = burnSubtitles ? 'Encode' : 'External';
  // Graphic subtitles are rendered client-side via libbitsub (when enabled) → deliver as
  // External → no transcode, Direct Play stays. Otherwise burn in.
  //   • PGS (Blu-ray): Jellyfin has always delivered it externally as .sup → works everywhere.
  //   • VobSub (DVD/dvdsub): Jellyfin only delivers it as an .mks container from 12.0 on (PR #16552).
  //     On older servers NOT possible externally (404) → keep burning there (serverVobSub=false).
  const pgsSub = clientGraphicSubs ? 'External' : 'Encode';
  const vobSub = (clientGraphicSubs && serverVobSub) ? 'External' : 'Encode';

  // Is the app running on the real TV (webOS)? There the media pipeline also decodes DTS, Dolby
  // TrueHD/Atmos and MP2 (European DVB/TS content) → allow them in Direct Play so the server
  // does NOT transcode unnecessarily. In browser dev (Firefox/Linux) it stays with safely decodable
  // codecs (otherwise picture without sound). All additions are purely additive → they can only widen Direct Play.
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
      // Video — the B4 decodes H.264, HEVC (incl. HDR10/HLG/HDR10+/Dolby Vision),
      // VP9 and AV1 in hardware. AC3/EAC3/FLAC/ALAC/PCM everywhere; DTS/TrueHD only on the TV.
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
        // Fallback when Direct Play doesn't work. IMPORTANT: audio ONLY AAC — Chromium/MSE
        // (hls.js) often can't decode AC3/EAC3 in HLS → this was the likely cause
        // of failing / silent HEVC playback. AAC is universally MSE-compatible.
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
          // Block Hi10P (10-bit H.264) → forces transcode
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
      { Format: 'ass',      Method: textSub },   // styled: External → overlay without styling, Encode → burned in with styling
      { Format: 'ssa',      Method: textSub },
      { Format: 'pgssub',   Method: pgsSub     }, // Blu-ray graphic subtitles → libbitsub renders client-side (External) or burn in
      { Format: 'dvdsub',   Method: vobSub     }, // DVD/VobSub → External (.mks) from Jellyfin 12.0, otherwise burn in
      { Format: 'vobsub',   Method: vobSub     },
      { Format: 'pgs',      Method: pgsSub     },
    ],
  };
}

// Calls /Items/{id}/PlaybackInfo and returns the server's decision.
// AutoOpenLiveStream=true ensures that a transcode session, if needed, is
// opened immediately and a usable TranscodingUrl is returned.
export async function getPlaybackInfo({
  serverUrl, userId, token, itemId,
  audioStreamIndex = null, subtitleStreamIndex = null,
  maxBitrate = 120000000, startTicks = 0,
  enableDirectPlay = true, enableDirectStream = true, allowAudioStreamCopy = true,
  burnSubtitles = false, mediaSourceId = null, clientGraphicSubs = false, serverVobSub = false,
}) {
  // IMPORTANT: Jellyfin reads AudioStreamIndex/SubtitleStreamIndex and the Enable* flags
  // from the QUERY STRING (only the DeviceProfile belongs in the body). Previously they were
  // in the body → the server ignored the chosen audio track.
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
  if (mediaSourceId) qs.set('MediaSourceId', mediaSourceId);   // force the chosen version

  // Body: DeviceProfile (required) + the same fields for safety (some versions read them here).
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
    headers: authHeaders(token),   // one auth scheme, one source (utils)
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
  // Which audio track did the SERVER actually choose (read from the transcoding URL)?
  const urlAudioIdx = ms?.TranscodingUrl?.match(/AudioStreamIndex=(-?\d+)/)?.[1] ?? null;
  const urlSubIdx   = ms?.TranscodingUrl?.match(/SubtitleStreamIndex=(-?\d+)/)?.[1] ?? null;
  // Detailed diagnostics — show EXACTLY why/how the server plays.
  dlog('[OcenFin] PlaybackInfo:', {
    method: ms?.TranscodingUrl ? 'Transcode' : (ms?.SupportsDirectPlay ? 'DirectPlay' : 'DirectStream'),
    transcoding: !!ms?.TranscodingUrl,
    subProtocol: ms?.TranscodingSubProtocol,
    container: ms?.Container,
    transcodeReasons: ms?.TranscodeReasons,        // e.g. ["VideoCodecNotSupported"] / ["SubtitleCodecNotSupported"]
    sourceVideo: vStream ? `${vStream.Codec} ${vStream.VideoRange || ''} ${vStream.Profile || ''} ${vStream.BitDepth || 8}bit`.trim() : null,
    sourceAudio: aStream ? `${aStream.Codec} ${aStream.Channels}ch` : null,
    urlAudioStreamIndex: urlAudioIdx,              // audio track actually chosen in the transcode
    urlSubtitleStreamIndex: urlSubIdx,
    audioStreams: (ms?.MediaStreams || []).filter(s => s.Type === 'Audio').map(s => `#${s.Index} ${s.Language || '?'} ${s.Codec}`),
    subtitleStreams: (ms?.MediaStreams || []).filter(s => s.Type === 'Subtitle').map(s => `#${s.Index} ${s.Language || '?'} ${s.Codec} (${s.DeliveryMethod || '-'})`),
  });
  // Logged flat (visible without expanding): which track the server REALLY takes + full URL.
  dlog(`[OcenFin] → server chose AudioStreamIndex=${urlAudioIdx} SubtitleStreamIndex=${urlSubIdx} | requested Audio=${audioStreamIndex}`);
  if (ms?.TranscodingUrl) dlog('[OcenFin] TranscodingUrl:', ms.TranscodingUrl);
  return { mediaSource: ms, playSessionId: data.PlaySessionId || null };
}

// ---- Lightweight prefetch of the next episode -------------------------------------------------
// Fetches the next episode's PlaybackInfo in advance and briefly caches the promise so the
// episode switch saves the network round-trip. NO video pre-buffering (that would open a second
// session on transcode) — only metadata/stream URL. Applies only when the parameters match,
// otherwise a normal fetch (safe fallback).
const _pfCache = new Map();   // itemId → { ts, key, promise }
const _PF_TTL  = 25000;       // valid ~25 s (a transcode session also stays open that long)

function _pfKey(p) {
  return [p.itemId, p.audioStreamIndex ?? -1, p.subtitleStreamIndex ?? -1, !!p.burnSubtitles, p.mediaSourceId || '', !!p.clientGraphicSubs, !!p.serverVobSub].join('|');
}

export function prefetchPlaybackInfo(params) {
  if (!params?.itemId) return;
  const key = _pfKey(params);
  const existing = _pfCache.get(params.itemId);
  if (existing && existing.key === key && Date.now() - existing.ts < _PF_TTL) return;  // already freshly loaded
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

// Builds the final playback URL + metadata from the server's decision.
// Returns: { url, isHls, method, mediaSource }
export function resolveStream({ serverUrl, token, itemId, mediaSource, audioStreamIndex = -1, subtitleStreamIndex = -1 }) {
  // Transcoding: the server provides a (relative) TranscodingUrl, usually HLS.
  if (mediaSource?.TranscodingUrl) {
    let url = mediaSource.TranscodingUrl.startsWith('http')
      ? mediaSource.TranscodingUrl
      : `${serverUrl}${mediaSource.TranscodingUrl}`;

    // IMPORTANT: in the generated TranscodingUrl Jellyfin ignores our desired
    // indices and stubbornly inserts the profile's default language (e.g. Audio=1, Subtitle=3).
    // The actual transcoding, however, is only triggered on the master.m3u8 fetch based on the
    // URL query — so we overwrite the parameters here directly.
    const setParam = (u, key, val) =>
      u.includes(`${key}=`)
        ? u.replace(new RegExp(`${key}=-?\\d+`), `${key}=${val}`)
        : `${u}&${key}=${val}`;

    if (audioStreamIndex !== null && audioStreamIndex !== -1) {
      url = setParam(url, 'AudioStreamIndex', audioStreamIndex);
    }
    // Subtitles: force the desired track – or explicitly -1 to remove a subtitle
    // stubbornly burned in (forced) by the server.
    url = setParam(url, 'SubtitleStreamIndex', subtitleStreamIndex === null ? -1 : subtitleStreamIndex);

    const isHls = (mediaSource.TranscodingSubProtocol || '').toLowerCase() === 'hls' || url.includes('.m3u8');
    dlog('[OcenFin] TranscodingUrl patched →', { audioStreamIndex, subtitleStreamIndex });
    return { url, isHls, method: 'Transcode', mediaSource };
  }
  // Direct Play / Direct Stream: complete, byte-seekable file (container unchanged;
  // server-side audio track selection isn't possible here, so no index parameters).
  const msId = mediaSource?.Id || itemId;
  const url = `${serverUrl}/Videos/${itemId}/stream?static=true&mediaSourceId=${msId}&ApiKey=${token}`;
  const method = (mediaSource && mediaSource.SupportsDirectStream && !mediaSource.SupportsDirectPlay)
    ? 'DirectStream' : 'DirectPlay';
  return { url, isHls: false, method, mediaSource };
}

// Returns the external VTT subtitle URL for a track (if DeliveryMethod = External).
export function externalSubtitleUrl({ serverUrl, itemId, mediaSourceId, stream, token }) {
  if (!stream) return null;
  // ALWAYS request WebVTT: our overlay renderer only parses VTT, and stream.DeliveryUrl
  // often points at the source format (.subrip/.srt). Jellyfin converts on-the-fly here.
  return `${serverUrl}/Videos/${itemId}/${mediaSourceId}/Subtitles/${stream.Index}/0/Stream.vtt?ApiKey=${token}`;
}

// Returns the original ASS/SSA URL for assjs (client-side rendering with full styling).
// Deliberately ALWAYS Stream.ass: delivers the original format including styles instead of the VTT
// conversion, which discards positioning/typesetting (SSA is converted to ASS by the server).
export function assSubtitleUrl({ serverUrl, itemId, mediaSourceId, stream, token }) {
  if (!stream) return null;
  return `${serverUrl}/Videos/${itemId}/${mediaSourceId}/Subtitles/${stream.Index}/0/Stream.ass?ApiKey=${token}`;
}

// Returns the raw graphic-subtitle URL for libbitsub. ALWAYS prefers the DeliveryUrl computed by
// the server (correct format: PGS=.sup, VobSub=.mks from Jellyfin 12.0). Falls back only for PGS to
// the default .sup endpoint — VobSub WITHOUT a DeliveryUrl isn't retrievable (old server).
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
  return null;   // VobSub/DVDSub without a DeliveryUrl → not client-side renderable (burn in)
}
