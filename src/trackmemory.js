// Per-series memory of the chosen audio/subtitle LANGUAGE, so consecutive episodes keep the same
// track choice. Matched by language (robust across episodes where the track order/index differs)
// and persisted in localStorage. Subtitle "Off" is stored as the string 'off'.
// Shape: { [seriesId]: { audio: <lang>, subtitle: { lang, forced, sdh } | 'off' } }
//
// PER PROFILE (Ferris, 2026-10-01): one key per user, `ocenfin:trackmem:<userId>`. It used to be one
// key for the whole TV, and since the memory comes first in pickDefaultTracks, one profile's choice
// for a series overrode the next profile's language settings. App names the profile on every
// sign-in (setTrackMemoryUser); without one nothing is read or written.

import { LANGUAGES } from './i18n.svelte.js';

const LEGACY_KEY = 'ocenfin:trackmem';
const keyFor = (userId) => `${LEGACY_KEY}:${userId}`;
let _userId = null;

export function setTrackMemoryUser(userId) {
  _userId = userId || null;
  if (!_userId) return;
  // The device-wide memory from before goes to the first profile that signs in after the update —
  // most TVs have one main viewer, and dropping it would forget every series at once.
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy != null) {
      if (localStorage.getItem(keyFor(_userId)) == null) localStorage.setItem(keyFor(_userId), legacy);
      localStorage.removeItem(LEGACY_KEY);
    }
  } catch {}
}

function _load() {
  if (!_userId) return {};
  // A plain object or nothing: valid JSON of another shape (null, an array) would make every
  // lookup below throw — and take setupPlayback with it for every episode (CODE-HEALTH §15).
  try {
    const v = JSON.parse(localStorage.getItem(keyFor(_userId)) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

// Store the chosen language for one kind ('audio' | 'subtitle') of a series.
export function rememberTrack(seriesId, kind, value) {
  if (!seriesId || !value || !_userId) return;
  const data = _load();
  data[seriesId] = { ...(data[seriesId] || {}), [kind]: value };
  try { localStorage.setItem(keyFor(_userId), JSON.stringify(data)); } catch {}
}

// A track picked BY HAND — in the Player's menu or in Details' dropdowns — becomes the series'
// memory, as far as the profile wants that (rememberAudioTrack / rememberSubtitleTrack). One place
// for both, so a choice made on the details page is not overruled by an older one from the Player.
// streams: the list the index comes from; index -1 is subtitle "Off".
export function rememberChoice(seriesId, kind, index, streams, prefs = {}) {
  if (!seriesId) return;
  if (kind === 'audio') {
    if (!prefs.rememberAudioTrack) return;
    const lang = streams.find(s => s.Index === index && s.Type === 'Audio')?.Language;
    if (lang) rememberTrack(seriesId, 'audio', lang);
  } else if (prefs.rememberSubtitleTrack) {
    if (index === -1) { rememberTrack(seriesId, 'subtitle', 'off'); return; }
    const st = streams.find(s => s.Index === index && s.Type === 'Subtitle');
    // Language + the flags that distinguish same-language variants (Full vs Forced vs SDH).
    if (st?.Language) rememberTrack(seriesId, 'subtitle', { lang: st.Language, forced: !!st.IsForced, sdh: !!st.IsHearingImpaired });
  }
}

// Retrieve the remembered language for a series+kind, or null if none.
export function getRememberedTrack(seriesId, kind) {
  if (!seriesId) return null;
  return _load()[seriesId]?.[kind] ?? null;
}

// Resolve a remembered choice against THIS title's stream list. Audio matches by language alone;
// subtitles by language plus the flags that distinguish same-language variants (Full vs Forced vs
// SDH), falling back to any track of the language. Returns the stream Index, -1 for subtitle
// 'off', or null when nothing is remembered or nothing matches. Lives here because Player
// (setupPlayback) and Details (applySourceDefaults) carried token-identical copies whose comments
// promised they mirror each other exactly — now they provably do.
export function matchRememberedAudioIndex(streams, seriesId) {
  const remA = getRememberedTrack(seriesId, 'audio');
  if (!remA) return null;
  const t = streams.find(s => s.Type === 'Audio' && s.Language === remA);
  return t ? t.Index : null;
}
export function matchRememberedSubtitleIndex(streams, seriesId) {
  const remS = getRememberedTrack(seriesId, 'subtitle');
  if (remS === 'off') return -1;
  if (!remS?.lang) return null;
  const subs = streams.filter(s => s.Type === 'Subtitle' && s.Language === remS.lang);
  const t = subs.find(s => !!s.IsForced === remS.forced && !!s.IsHearingImpaired === remS.sdh) || subs[0];
  return t ? t.Index : null;
}

// ── Which tracks a title starts with when nobody picked any ─────────────────────────────────────
// ONE rule for Details (the preselection on the page) and the Player (a start from anywhere else:
// a series' play button, play-all, shuffle, SyncPlay). Moved here from Details, which was the only
// place applying the app's language preferences — every other start played the file's own default
// track and no subtitle, whatever the settings said.
//   audio:    remembered per series → the app's language → the server's default, which is where the
//             Jellyfin profile's preference lands ("original language" included)
//   subtitle: remembered → off → the app's language → in "default" mode a forced track, ideally in
//             the audio's language → the server's default → none
// Returns stream indexes; -1 means "none" for subtitles and "the file's default" for audio.
const GRAPHIC_SUB_CODECS = ['pgssub', 'pgs', 'dvdsub', 'dvbsub', 'vobsub', 'sub'];
const isGraphicSub = (s) => GRAPHIC_SUB_CODECS.includes((s?.Codec || '').toLowerCase());

// May a subtitle be switched on automatically? Text always; a graphic one (PGS, VobSub/DVD) as long
// as the app renders them itself (libbitsub, Direct Play stays) — Jellyfin 12 delivers both.
function subtitleAutoEligible(s, prefs) {
  if (!isGraphicSub(s)) return true;
  return prefs.pgsRendering !== false;
}

// First stream of that type in the preferred language, or null for 'default' / no match.
function matchLanguageStream(streams, type, prefKey) {
  if (!prefKey || prefKey === 'default') return null;
  const lang = LANGUAGES.find(l => l.key === prefKey);
  if (!lang) return null;
  const match = streams.find(s => s.Type === type && s.Language && lang.codes.includes(s.Language.toLowerCase()));
  return match ? match.Index : null;
}

function pickForcedSubtitle(streams, audioIndex, serverDefault, prefs) {
  const audioLang = streams.find(s => s.Type === 'Audio' && s.Index === audioIndex)?.Language?.toLowerCase();
  const subs = streams.filter(s => s.Type === 'Subtitle');
  const ok = (s) => subtitleAutoEligible(s, prefs);
  const pick = subs.find(s => s.IsForced && ok(s) && audioLang && s.Language?.toLowerCase() === audioLang)
            ?? subs.find(s => s.IsForced && ok(s));
  if (pick) return pick.Index;
  if (serverDefault != null) {
    const def = subs.find(s => s.Index === serverDefault);
    if (def && ok(def)) return serverDefault;
  }
  return -1;
}

// source: a MediaSourceInfo (its MediaStreams plus the server's Default*StreamIndex for this user).
export function pickDefaultTracks(source, { seriesId = null, prefs = {} } = {}) {
  const streams = source?.MediaStreams || [];
  let audio = null, subtitle = null;
  if (seriesId && prefs.rememberAudioTrack)    audio    = matchRememberedAudioIndex(streams, seriesId);
  if (seriesId && prefs.rememberSubtitleTrack) subtitle = matchRememberedSubtitleIndex(streams, seriesId);

  if (audio == null) audio = matchLanguageStream(streams, 'Audio', prefs.audioLanguage) ?? source?.DefaultAudioStreamIndex ?? -1;

  if (subtitle == null) {
    if (prefs.subtitleLanguage === 'off') subtitle = -1;
    else {
      const subPref = matchLanguageStream(streams, 'Subtitle', prefs.subtitleLanguage);
      if (subPref != null) subtitle = subPref;
      else if (prefs.subtitleLanguage === 'default')
        subtitle = pickForcedSubtitle(streams, audio, source?.DefaultSubtitleStreamIndex, prefs);
      else subtitle = source?.DefaultSubtitleStreamIndex ?? -1;
    }
  }
  return { audio, subtitle };
}
