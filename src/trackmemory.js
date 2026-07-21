// Per-series memory of the chosen audio/subtitle LANGUAGE, so consecutive episodes keep the same
// track choice. Matched by language (robust across episodes where the track order/index differs)
// and persisted in localStorage. Subtitle "Off" is stored as the string 'off'.
// Shape: { [seriesId]: { audio: <lang>, subtitle: <lang> | 'off' } }

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
