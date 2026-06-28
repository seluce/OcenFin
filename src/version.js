// ─────────────────────────────────────────────────────────────────────────────
// EINZIGE Versionsquelle: public/appinfo.json (das webOS-Manifest verlangt diese Datei ohnehin im
// Paket-Root). Da Vite (ab v8) das Importieren von Assets aus public/ verbietet, wird die Version
// NICHT mehr hier importiert, sondern in vite.config.js zur BUILD-ZEIT aus public/appinfo.json gelesen
// und als globale Konstante __APP_VERSION__ eingespeist. Settings-Anzeige und Jellyfin-Auth-Header lesen
// weiterhin ausschließlich von hier — beim Release also weiterhin NUR die "version" in appinfo.json zählen.
//
// webOS erwartet die Version ohne führende Nullen (z. B. 2026.6.28). Für Anzeige + Jellyfin normalisieren
// wir Monat/Tag auf zwei Stellen: 2026.6.28 → 2026.06.28. (Annahme: Schema Jahr.Monat.Tag.)
// ─────────────────────────────────────────────────────────────────────────────
/* global __APP_VERSION__ */
const [year, month = '', day = ''] = String(__APP_VERSION__).split('.');
export const APP_VERSION = `${year}.${month.padStart(2, '0')}.${day.padStart(2, '0')}`;
