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
import { CLIENT_SUB_CODECS, GRAPHIC_SUB_CODECS } from './utils.js';

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
//   subtitle: remembered → off → the app's language (its best track, see matchSubtitleLanguage; with
//             "only for foreign audio" and the audio already in that language, a forced track at
//             most) → in "default" mode a forced track, ideally in the audio's language → the
//             server's default → none
// Returns stream indexes; -1 means "none" for subtitles and "the file's default" for audio.
const subCodec = (s) => (s?.Codec || '').toLowerCase();
const langOf = (s) => s?.Language?.toLowerCase() || null;
// Jellyfin's own list of "no language" tags (MediaStreamSelector.IsLanguageUndefined) — the track pick follows the
// server's. tracklabel.js builds on it for the names.
export const UNDEFINED_LANGS = ['und', 'unknown', 'undetermined', 'mul', 'zxx'];

// May a subtitle be switched on automatically? Text always; a graphic one only when the app renders
// it itself (PGS, VobSub/DVD via libbitsub — Direct Play stays). DVB bitmap subtitles can only be
// burned in (the server cannot hand them out, see utils.js), which costs Direct Play — so never
// automatically, only when chosen.
function subtitleAutoEligible(s, prefs) {
  if (!GRAPHIC_SUB_CODECS.includes(subCodec(s))) return true;
  return CLIENT_SUB_CODECS.includes(subCodec(s)) && prefs.pgsRendering !== false;
}

// First audio stream in the preferred language, or null for 'default' / no match.
function matchLanguageStream(streams, type, prefKey) {
  if (!prefKey || prefKey === 'default') return null;
  const lang = LANGUAGES.find(l => l.key === prefKey);
  if (!lang) return null;
  const match = streams.find(s => s.Type === type && s.Language && lang.codes.includes(s.Language.toLowerCase()));
  return match ? match.Index : null;
}

// The language of the audio that will play. -1 (the file's own default) is the track flagged
// default, else the first one; null when that track carries no language.
function audioLanguageOf(streams, audioIndex) {
  const audios = streams.filter(s => s.Type === 'Audio');
  return langOf(audioIndex === -1 ? (audios.find(s => s.IsDefault) ?? audios[0])
                                  : audios.find(s => s.Index === audioIndex));
}

// The subtitle for a chosen language. One language often comes as several tracks, and the first one
// used to win — on many releases that is "Deutsch (Forced)", signs only. Ranked instead: a full track
// before a forced one, one the app shows without a transcode before one that costs Direct Play,
// plain before SDH; the file's order among equals. null when the language has no track.
const subtitleRank = (s, prefs) => (s.IsForced ? 4 : 0) + (subtitleAutoEligible(s, prefs) ? 0 : 2) + (s.IsHearingImpaired ? 1 : 0);
function matchSubtitleLanguage(streams, lang, prefs) {
  let best = null;
  for (const s of streams) {
    if (s.Type !== 'Subtitle' || !lang.codes.includes(langOf(s))) continue;
    if (!best || subtitleRank(s, prefs) < subtitleRank(best, prefs)) best = s;
  }
  return best ? best.Index : null;
}

// "Only for foreign audio" with the audio already in the chosen language: a forced track in that
// language, else a forced one tagged with no language (Jellyfin's Smart mode does the same) — and
// only one the app can switch on by itself. -1 when there is none.
function pickOwnLanguageForced(streams, lang, prefs) {
  const forced = streams.filter(s => s.Type === 'Subtitle' && s.IsForced && subtitleAutoEligible(s, prefs));
  const pick = forced.find(s => lang.codes.includes(langOf(s)))
            ?? forced.find(s => !langOf(s) || UNDEFINED_LANGS.includes(langOf(s)));
  return pick ? pick.Index : -1;
}

function pickForcedSubtitle(streams, audioIndex, serverDefault, prefs) {
  const audioLang = audioLanguageOf(streams, audioIndex);
  const subs = streams.filter(s => s.Type === 'Subtitle');
  const ok = (s) => subtitleAutoEligible(s, prefs);
  const pick = subs.find(s => s.IsForced && ok(s) && audioLang && langOf(s) === audioLang)
            ?? subs.find(s => s.IsForced && ok(s));
  if (pick) return pick.Index;
  if (serverDefault != null) {
    const def = subs.find(s => s.Index === serverDefault);
    if (def && ok(def)) return serverDefault;
  }
  return -1;
}

// source: a MediaSourceInfo (its MediaStreams plus the server's Default*StreamIndex for this user).
// audio: an audio track already chosen (Details, when one is picked by hand) — only the subtitle is
// picked then, since "only for foreign audio" depends on it.
export function pickDefaultTracks(source, { seriesId = null, prefs = {}, audio = null } = {}) {
  const streams = source?.MediaStreams || [];
  let subtitle = null;
  if (audio == null) {
    if (seriesId && prefs.rememberAudioTrack) audio = matchRememberedAudioIndex(streams, seriesId);
    if (audio == null) audio = matchLanguageStream(streams, 'Audio', prefs.audioLanguage) ?? source?.DefaultAudioStreamIndex ?? -1;
  }
  if (seriesId && prefs.rememberSubtitleTrack) subtitle = matchRememberedSubtitleIndex(streams, seriesId);

  if (subtitle == null) {
    const lang = LANGUAGES.find(l => l.key === prefs.subtitleLanguage);
    if (prefs.subtitleLanguage === 'off') subtitle = -1;
    else if (lang) {
      // Audio without a language tag counts as foreign, as in Jellyfin's Smart mode.
      subtitle = prefs.subtitleSmart && lang.codes.includes(audioLanguageOf(streams, audio))
        ? pickOwnLanguageForced(streams, lang, prefs)
        : matchSubtitleLanguage(streams, lang, prefs) ?? source?.DefaultSubtitleStreamIndex ?? -1;
    }
    else if (prefs.subtitleLanguage === 'default')
      subtitle = pickForcedSubtitle(streams, audio, source?.DefaultSubtitleStreamIndex, prefs);
    else subtitle = source?.DefaultSubtitleStreamIndex ?? -1;
  }
  return { audio, subtitle };
}

// ── The order a track LIST shows (Details' dropdowns, the Player's menu) ─────────────────────────────
// The file's own order hid the two or three tracks anyone wants among 25 (CODE-HEALTH §134). Grouped by
// language: the profile's languages first — for audio its audio language, then the app's; for subtitles
// its subtitle language, the app's, then its audio language — then every other language where it first
// turns up in the file (no language at all is a group of its own). Inside a language audio keeps the
// file's order; subtitles follow the rank the preselection uses (matchSubtitleLanguage), so the track it
// would pick heads its language. Display only: the indexes, the preselection and the memory are untouched.
// uiLang: the app language's LANGUAGES key (baseLang(i18n.lang)).
export function orderTracks(streams, type, prefs = {}, uiLang = null) {
  const list = (streams || []).filter(s => s.Type === type);
  const groupOf = (s) => {
    const code = langOf(s);
    if (!code || UNDEFINED_LANGS.includes(code)) return '';
    return LANGUAGES.find(l => l.codes.includes(code))?.key ?? code;
  };
  const preferred = (type === 'Audio' ? [prefs.audioLanguage, uiLang] : [prefs.subtitleLanguage, uiLang, prefs.audioLanguage])
    .filter(k => k && LANGUAGES.some(l => l.key === k));
  const first = new Map();
  const rows = list.map((s, i) => { const g = groupOf(s); if (!first.has(g)) first.set(g, i); return { s, i, g }; });
  const groupRank = (g) => { const p = preferred.indexOf(g); return p >= 0 ? p - preferred.length : first.get(g); };
  const within = type === 'Subtitle' ? (s) => subtitleRank(s, prefs) : () => 0;
  return rows.sort((a, b) => groupRank(a.g) - groupRank(b.g) || within(a.s) - within(b.s) || a.i - b.i).map(r => r.s);
}
