// Runes-native i18n (replaces the earlier Svelte-store variant). `lang` is $state, `i18n.t` a
// reactive getter on the translation table — components read `i18n.t.key` or `i18n.lang`
// and re-render automatically on language change, exactly following the pattern of session.svelte.js.
// No Svelte store in the project anymore.

// Translations live per language in /locales. en is the reference (complete key list);
// every other language falls back PER KEY to en in case a string is ever missing there.
import en from './locales/en.js';
import de from './locales/de.js';
import fr from './locales/fr.js';
import nl from './locales/nl.js';
import es from './locales/es.js';
import it from './locales/it.js';
import pt from './locales/pt.js';
import pl from './locales/pl.js';

// Each language layered over en → missing keys automatically inherit the English text (never undefined).
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

// Selection list for the language menu. `codes` maps 2-/3-letter language codes (e.g. "ger"/"deu"/"de")
// to the internal key so device detection works.
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

// Detects the UI language at startup: last chosen language → otherwise the device language of the
// TV/browser (e.g. "de-DE" → "de") → otherwise English. Matched against the EXISTING
// translations (Object.keys(translations)) so newly added languages take effect automatically
// and anything unknown falls back cleanly to English.
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
    if (supported.includes(sub)) return sub;                      // direct hit (2 letters)
    const viaCode = LANGUAGES.find(l => l.codes.includes(sub));   // map 3-letter codes (ger/eng ...)
    if (viaCode && supported.includes(viaCode.key)) return viaCode.key;
  }
  return supported.includes('en') ? 'en' : supported[0];          // fallback: English
}

// --- Reactive state (runes) ---
let lang = $state(detectUiLang());

// Keep the DOCUMENT's language declaration in step with the interface. Nothing in the app reads it,
// but the browser does — text handling (hyphenation, quotes, font fallback) follows what the
// document declares, and index.html's static <html lang="en"> would otherwise stay put while the
// interface is German or Polish. Set once at startup and on every change; this module is loaded
// from a deferred module script, so documentElement exists by the time it runs.
function syncDocumentLang() {
  try { document.documentElement.lang = lang; } catch { /* no DOM (never on the TV) */ }
}
syncDocumentLang();

// Reactive access for components: i18n.t.key (translation) and i18n.lang (current code).
// Both getters read `lang` ($state) → reads in templates/$effects are automatically reactive.
export const i18n = {
  get lang() { return lang; },
  get t()    { return translations[lang] || translations.en; },
};

// Change language (validated against existing translations; persistence happens in the caller).
export function setLang(code) {
  if (translations[code]) { lang = code; syncDocumentLang(); }
}
