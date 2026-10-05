// ─────────────────────────────────────────────────────────────────────────────
// SINGLE version source: public/appinfo.json (the webOS manifest requires this file in the
// package root anyway). Vite forbids importing assets from public/, so vite.config.js reads it at
// BUILD TIME and injects the global constant __APP_VERSION__. The settings display and the Jellyfin
// auth header read it exclusively from here — for a release, ONLY the "version" in appinfo.json counts.
//
// webOS expects the version without leading zeros (e.g. 2026.6.28). For display + Jellyfin we
// normalize month/day to two digits: 2026.6.28 → 2026.06.28. (Assumption: schema year.month.day.)
// ─────────────────────────────────────────────────────────────────────────────
/* global __APP_VERSION__ */
const [year, month = '', day = ''] = String(__APP_VERSION__).split('.');
export const APP_VERSION = `${year}.${month.padStart(2, '0')}.${day.padStart(2, '0')}`;
