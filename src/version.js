// ─────────────────────────────────────────────────────────────────────────────
// SINGLE version source: public/appinfo.json (the webOS manifest requires this file in the
// package root anyway). Since Vite (from v8) forbids importing assets from public/, the version
// is NO LONGER imported here, but read at BUILD TIME from public/appinfo.json in vite.config.js
// and injected as the global constant __APP_VERSION__. The settings display and Jellyfin auth header
// still read exclusively from here — so for a release, still ONLY the "version" in appinfo.json counts.
//
// webOS expects the version without leading zeros (e.g. 2026.6.28). For display + Jellyfin we
// normalize month/day to two digits: 2026.6.28 → 2026.06.28. (Assumption: schema year.month.day.)
// ─────────────────────────────────────────────────────────────────────────────
/* global __APP_VERSION__ */
const [year, month = '', day = ''] = String(__APP_VERSION__).split('.');
export const APP_VERSION = `${year}.${month.padStart(2, '0')}.${day.padStart(2, '0')}`;
