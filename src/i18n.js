import { writable, derived } from 'svelte/store';

// Übersetzungen liegen pro Sprache in /locales. en ist die Referenz (vollständige Key-Liste);
// jede andere Sprache fällt PRO KEY auf en zurück, falls dort mal ein String fehlt.
import en from './locales/en.js';
import de from './locales/de.js';
import fr from './locales/fr.js';
import nl from './locales/nl.js';
import es from './locales/es.js';
import it from './locales/it.js';
import pt from './locales/pt.js';
import pl from './locales/pl.js';

// Jede Sprache über en gelegt → fehlende Keys erben automatisch den englischen Text (nie undefined).
const withFallback = (lang) => ({ ...en, ...lang });

export const translations = {
  en,
  de: withFallback(de),
  fr: withFallback(fr),
  nl: withFallback(nl),
  es: withFallback(es),
  it: withFallback(it),
  pt: withFallback(pt),
  pl: withFallback(pl),
};

// Auswahlliste fürs Sprach-Menü. `codes` mappt 2-/3-Buchstaben-Sprachcodes (z. B. "ger"/"deu"/"de")
// auf den internen Key, damit die Geräteerkennung greift.
export const LANGUAGES = [
  { key: 'de', name: 'Deutsch',     flag: '🇩🇪', codes: ['ger', 'deu', 'de'] },
  { key: 'en', name: 'English',     flag: '🇬🇧', codes: ['eng', 'en'] },
  { key: 'fr', name: 'Français',    flag: '🇫🇷', codes: ['fre', 'fra', 'fr'] },
  { key: 'nl', name: 'Nederlands',  flag: '🇳🇱', codes: ['dut', 'nld', 'nl'] },
  { key: 'es', name: 'Español',     flag: '🇪🇸', codes: ['spa', 'es'] },
  { key: 'it', name: 'Italiano',    flag: '🇮🇹', codes: ['ita', 'it'] },
  { key: 'pt', name: 'Português',   flag: '🇵🇹', codes: ['por', 'pt'] },
  { key: 'pl', name: 'Polski',      flag: '🇵🇱', codes: ['pol', 'pl'] },
];

// Erkennt die UI-Sprache beim Start: zuletzt gewählte Sprache → sonst Gerätesprache des
// TVs/Browsers (z. B. "de-DE" → "de") → sonst Englisch. Gematcht wird gegen die VORHANDENEN
// Übersetzungen (Object.keys(translations)), damit neu hinzugefügte Sprachen automatisch greifen
// und alles Unbekannte sauber auf Englisch zurückfällt.
export function detectUiLang() {
  const supported = Object.keys(translations);
  try {
    const saved = localStorage.getItem('app_language');
    if (saved && supported.includes(saved)) return saved;
  } catch {}
  const navLangs = (typeof navigator !== 'undefined')
    ? (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language])
    : [];
  for (const raw of navLangs) {
    if (!raw) continue;
    const sub = String(raw).toLowerCase().split('-')[0];          // "de-DE" -> "de"
    if (supported.includes(sub)) return sub;                      // direkter Treffer (2-Buchstaben)
    const viaCode = LANGUAGES.find(l => l.codes.includes(sub));   // 3-Buchstaben-Codes (ger/eng ...) mappen
    if (viaCode && supported.includes(viaCode.key)) return viaCode.key;
  }
  return supported.includes('en') ? 'en' : supported[0];          // Fallback: Englisch
}

export const currentLang = writable(detectUiLang());
// Faellt eine (noch) nicht uebersetzte Sprache auf Englisch zurueck, statt undefined zu liefern.
export const t = derived(currentLang, ($currentLang) => translations[$currentLang] || translations.en);
