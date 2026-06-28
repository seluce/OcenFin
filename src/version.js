// ─────────────────────────────────────────────────────────────────────────────
// EINZIGE Versionsquelle: appinfo.json (das webOS-Manifest verlangt diese Datei ohnehin).
// Settings-Anzeige und der Jellyfin-Auth-Header lesen ausschließlich von hier — beim nächsten
// Release also NUR die "version" in appinfo.json hochzählen, alles andere zieht automatisch nach.
//
// webOS erwartet die Version ohne führende Nullen (z. B. 2026.6.28). Für Anzeige + Jellyfin
// normalisieren wir Monat/Tag auf zwei Stellen: 2026.6.28 → 2026.06.28. (Annahme: Schema Jahr.Monat.Tag.
// Wer lieber überall den rohen Wert hätte, exportiert einfach appinfo.version direkt.)
// ─────────────────────────────────────────────────────────────────────────────
import appinfo from '../public/appinfo.json';   // ← einzige Stelle mit dem Pfad (liegt in public/)

const [year, month = '', day = ''] = String(appinfo.version).split('.');
export const APP_VERSION = `${year}.${month.padStart(2, '0')}.${day.padStart(2, '0')}`;
