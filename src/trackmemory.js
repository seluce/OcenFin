// Per-series memory of the chosen audio/subtitle LANGUAGE, so consecutive episodes keep the same
// track choice. Matched by language (robust across episodes where the track order/index differs)
// and persisted in localStorage. Subtitle "Off" is stored as the string 'off'.
// Shape: { [seriesId]: { audio: <lang>, subtitle: { lang, forced, sdh } | 'off' } }

import { LANGUAGES } from './i18n.svelte.js';

const KEY = 'ocenfin:trackmem';

function _load() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; }
}

// Store the chosen language for one kind ('audio' | 'subtitle') of a series.
export function rememberTrack(seriesId, kind, value) {
  if (!seriesId || !value) return;
  const data = _load();
  data[seriesId] = { ...(data[seriesId] || {}), [kind]: value };
  try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {}
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

// May a subtitle be switched on automatically? Text always; PGS when rendered client-side
// (libbitsub, Direct Play stays); VobSub/DVD likewise once the server delivers it as .mks (12.0+).
// On older servers DVD only through the opt-in option, because it is then burned in.
function subtitleAutoEligible(s, prefs, serverVobSub) {
  if (!isGraphicSub(s)) return true;
  if (prefs.pgsRendering === false) return false;
  const codec = (s?.Codec || '').toLowerCase();
  if (['pgssub', 'pgs'].includes(codec)) return true;
  if (serverVobSub) return true;
  return !!prefs.forcedGraphicSubs;
}

// First stream of that type in the preferred language, or null for 'default' / no match.
function matchLanguageStream(streams, type, prefKey) {
  if (!prefKey || prefKey === 'default') return null;
  const lang = LANGUAGES.find(l => l.key === prefKey);
  if (!lang) return null;
  const match = streams.find(s => s.Type === type && s.Language && lang.codes.includes(s.Language.toLowerCase()));
  return match ? match.Index : null;
}

function pickForcedSubtitle(streams, audioIndex, serverDefault, prefs, serverVobSub) {
  const audioLang = streams.find(s => s.Type === 'Audio' && s.Index === audioIndex)?.Language?.toLowerCase();
  const subs = streams.filter(s => s.Type === 'Subtitle');
  const ok = (s) => subtitleAutoEligible(s, prefs, serverVobSub);
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
export function pickDefaultTracks(source, { seriesId = null, prefs = {}, serverVobSub = false } = {}) {
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
        subtitle = pickForcedSubtitle(streams, audio, source?.DefaultSubtitleStreamIndex, prefs, serverVobSub);
      else subtitle = source?.DefaultSubtitleStreamIndex ?? -1;
    }
  }
  return { audio, subtitle };
}
