// Per-series memory of the chosen audio/subtitle LANGUAGE, so consecutive episodes keep the same
// track choice. Matched by language (robust across episodes where the track order/index differs)
// and persisted in localStorage. Subtitle "Off" is stored as the string 'off'.
// Shape: { [seriesId]: { audio: <lang>, subtitle: { lang, forced, sdh } | 'off' } }

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
