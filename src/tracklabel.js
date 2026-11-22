// Names of audio and subtitle tracks — Details' lists and the Player's menu (CODE-HEALTH §138). Display only.
//
// Built from the stream's own fields, not from Jellyfin's DisplayTitle. That one is put together by the server in ITS
// languages (language names in English, flags in German: "German (Forced) - Standard - Erzwungen - SUBRIP") and
// repeats whatever the muxer wrote into the track's Title ("AC3 5.1 @ 640 Kbps - English - Default"). Here:
//   main  — language in the UI language, then Forced / SDH / Original, then what the Title says beyond all that
//           ("Kommentar", "Signs & Songs", "Dub")
//   tech  — audio: codec (+ Atmos / DTS:X) and channels; subtitles: the format, External
// The Title is never parsed for meaning, only cleaned: everything the fields already say (language names and codes,
// codec and channel words, bitrates, default/forced/SDH words) is struck out, and what is left is shown as written.
// Unknown junk therefore stays visible — a label can look as busy as before, but never loses what a Title said.
// "forced" / "SDH" / "CC" / "original" in a Title count like the flags (a muxer often writes them there only).
import { LANGUAGES, i18n } from './i18n.svelte.js';
import { PGS_CODECS, VOBSUB_CODECS } from './utils.js';

const UNDEFINED = ['und', 'unknown', 'undetermined', 'mul', 'zxx', 'mis'];
// Codes Jellyfin passes on that are no BCP 47 tag (OpenSubtitles' Brazilian Portuguese)
const ALIASES = { pob: 'pt-BR' };
const tagOf = (code) => ALIASES[code] || code;

// One Intl.DisplayNames per language, as the library's language filter uses it (works with "ger", "fre", "cze").
// Names are kept: .of() is the slow part (a 33-track list asked it ~100 times for a handful of languages).
const namers = new Map(), names = new Map();
function namer(lang) {
  if (!namers.has(lang)) { let n = null; try { n = new Intl.DisplayNames([lang], { type: 'language' }); } catch { /* none */ } namers.set(lang, n); }
  return namers.get(lang);
}
function nameIn(lang, code) {
  const key = `${lang}|${code}`;
  if (!names.has(key)) {
    let name = '';
    try { const n = namer(lang)?.of(code); if (n && n.toLowerCase() !== code.toLowerCase() && n !== 'root') name = n; } catch { /* invalid code */ }
    names.set(key, name);
  }
  return names.get(key);
}
const capital = (s, lang) => s ? s.charAt(0).toLocaleUpperCase(lang) + s.slice(1) : s;

// The language's name in the UI language; a code the engine cannot name keeps the server's name without its
// ISO note ("Modern Greek (1453-)" → "Modern Greek"), else the code.
export function languageName(s, lang) {
  const code = (s?.Language || '').toLowerCase();
  if (!code || UNDEFINED.includes(code)) return '';
  const name = nameIn(lang, tagOf(code));
  if (name) return capital(name, lang);
  return (s.LocalizedLanguage || '').replace(/\s*\(.*\)\s*$/, '').trim() || code.toUpperCase();
}

const AUDIO_CODECS = { ac3: 'Dolby Digital', eac3: 'Dolby Digital+', truehd: 'Dolby TrueHD', mlp: 'Dolby TrueHD', ac4: 'AC-4',
  aac: 'AAC', flac: 'FLAC', alac: 'ALAC', opus: 'Opus', vorbis: 'Vorbis', mp3: 'MP3', mp2: 'MP2', wmav2: 'WMA', wmapro: 'WMA Pro' };
function audioCodec(s) {
  const c = (s.Codec || '').toLowerCase(), p = s.Profile || '';
  const dtsx = s.AudioSpatialFormat === 'DTSX' || /dts:x/i.test(p);
  if (c === 'dts' || c.startsWith('dca')) return dtsx ? 'DTS:X' : (/^dts/i.test(p) ? p.replace(/\s*\+.*$/, '') : 'DTS');
  const atmos = s.AudioSpatialFormat === 'DolbyAtmos' || /atmos/i.test(p);
  const name = c.startsWith('pcm') ? 'PCM' : (AUDIO_CODECS[c] || c.toUpperCase());
  return atmos ? `${name} Atmos` : name;
}
const CHANNELS = { 1: '1.0', 2: '2.0', 3: '2.1', 4: '4.0', 5: '5.0', 6: '5.1', 7: '6.1', 8: '7.1' };
function channels(s) {
  const l = (s.ChannelLayout || '').toLowerCase();
  const m = l.match(/^(\d\.\d)/);
  if (m) return m[1];
  if (l === 'mono') return '1.0';
  if (l === 'stereo') return '2.0';
  return CHANNELS[s.Channels] || '';
}
const SUB_FORMATS = { subrip: 'SRT', srt: 'SRT', ass: 'ASS', ssa: 'SSA', webvtt: 'VTT', vtt: 'VTT', dvbsub: 'DVB', mov_text: 'TX3G', ttml: 'TTML' };
function subFormat(s) {
  const c = (s.Codec || '').toLowerCase();
  if (PGS_CODECS.includes(c)) return 'PGS';
  if (VOBSUB_CODECS.includes(c)) return 'VobSub';
  return SUB_FORMATS[c] || c.toUpperCase();
}

// What a Title may repeat. Phrases before their parts (sorted longest first); matched as whole words.
const NOISE = [
  'dolby digital plus', 'dolby digital', 'dolby truehd', 'dolby atmos', 'dolby vision', 'dolby', 'true hd', 'truehd', 'atmos',
  'dts-hd ma', 'dts-hd hra', 'dts hd ma', 'dts hd', 'dts-hd', 'dts:x', 'dts-x', 'dtsx', 'dts-es', 'dts', 'hd ma', 'hra',
  'e-ac-3', 'e-ac3', 'eac3', 'ac-3', 'ac3', 'ddp', 'dd+', 'dd', 'he-aac', 'aac-lc', 'aac', 'flac', 'alac', 'opus', 'vorbis',
  'mp3', 'mp2', 'lpcm', 'pcm', 'wma',
  'subrip', 'srt', 'ass', 'ssa', 'pgssub', 'pgs', 'sup', 'vobsub', 'dvdsub', 'idx', 'webvtt', 'vtt', 'hdmv',
  'subtitles', 'subtitle', 'subs', 'untertitel',
  'dual mono', 'mono', 'stereo', 'surround',
  'default', 'standard', 'full', 'complete', 'external', 'extern', 'original',
  'forced', 'erzwungen', 'forcé', 'forcés', 'forzado', 'forzados', 'forzati',
  'closed captions', 'hearing impaired', 'untertitel für hörgeschädigte', 'für hörgeschädigte', 'hörgeschädigte', 'hörgeschädigt',
  'sdh', 'cc',
].sort((a, b) => b.length - a.length);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const words = (list) => new RegExp(`(?<![\\p{L}\\p{N}])(?:${list.map(esc).join('|')})(?![\\p{L}\\p{N}])`, 'giu');
const NOISE_RE = words(NOISE);
const MEASURES = /\d+(?:[.,]\d+)?\s*(?:[km]bps|[km]b\/s|[km]bit\/s|kbit|khz|-?bit\b|ch\b)|(?<![\p{L}\p{N}])\d\.\d(?:\.\d)?(?:\s*\(?(?:side|back|wide)\)?)?/giu;
const FORCED_T = /(?<![\p{L}])(?:forced|erzwungen|forcé|forzados?|forzati)(?![\p{L}])/iu;
const SDH_T = /(?<![\p{L}])(?:sdh|cc|closed captions|hearing impaired|hörgeschädigt\p{L}*)(?![\p{L}])/iu;
const HI_T = /(?<![\p{L}])HI(?![\p{L}])/gu;   // "HI" for hearing impaired only in capitals — "hi" is a word
const ORIGINAL_T = /(?<![\p{L}])original(?![\p{L}])/iu;

// The language as a Title may write it: in English, in the UI language, in itself, as the server names it, as a
// code. One RegExp per language (kept), null for none.
const langWords = new Map();
function languageWords(s, lang) {
  const code = (s.Language || '').toLowerCase();
  if (!code || UNDEFINED.includes(code)) return null;
  const key = `${lang}|${code}|${s.LocalizedLanguage || ''}`;
  if (!langWords.has(key)) {
    const known = LANGUAGES.find(l => l.codes.includes(code));
    const tag = tagOf(code);
    let short = ''; try { short = Intl.getCanonicalLocales(tag)[0]; } catch { /* no tag */ }   // hin → hi, gre → el
    const list = [nameIn('en', tag), nameIn(lang, tag), known?.name || nameIn(tag, tag), s.LocalizedLanguage || '',
      (s.LocalizedLanguage || '').replace(/\s*\(.*\)\s*$/, ''), ...(known?.codes || [code]), short];
    const strike = [...new Set(list.filter(n => n && n.length > 1).map(n => n.toLowerCase()))];
    langWords.set(key, strike.length ? words(strike.sort((a, b) => b.length - a.length)) : null);
  }
  return langWords.get(key);
}

// The Title minus what the label shows anyway; '' when nothing is left that says something.
function titleRest(s, lang) {
  let t = (s.Title || '').trim();
  if (!t) return '';
  const re = languageWords(s, lang);
  if (re) t = t.replace(re, ' ');
  // "DDP5.1", "AAC2.0": the codec glued to its channels
  t = t.replace(/(\p{L}\+?)(\d\.\d)/gu, '$1 $2');
  t = t.replace(HI_T, ' ').replace(MEASURES, ' ').replace(NOISE_RE, ' ');
  t = t.replace(/[()[\]{}|/\\,;:_@•·]+/g, ' ').replace(/(^|\s)[-–—.+]+(?=\s|$)/g, ' ').replace(/\s+/g, ' ')
    .replace(/^[\s&]+|[\s&]+$/g, '');
  return /\p{L}/u.test(t) ? capital(t, lang) : '';
}

// { main, tech } for an Audio or Subtitle stream, in the UI language.
export function trackLabel(s) {
  if (!s) return { main: '', tech: '' };
  const lang = i18n.lang;
  const title = s.Title || '';
  const rest = titleRest(s, lang);
  const sdh = s.IsHearingImpaired || SDH_T.test(title) || /(?<![\p{L}])HI(?![\p{L}])/u.test(title);
  const flags = s.Type === 'Subtitle'
    ? [(s.IsForced || FORCED_T.test(title)) && i18n.t.subtitleForced, sdh && 'SDH']
    : [(s.IsOriginal || ORIGINAL_T.test(title)) && i18n.t.trackOriginal, sdh && 'SDH'];
  const parts = [languageName(s, lang), ...flags, rest].filter(Boolean);
  const tech = s.Type === 'Subtitle'
    ? [subFormat(s), s.IsExternal && i18n.t.trackExternal].filter(Boolean).join(' · ')
    : [audioCodec(s), channels(s)].filter(Boolean).join(' ');
  if (!parts.length) parts.push(s.Codec || s.Language ? i18n.t.unknown : (s.DisplayTitle || i18n.t.unknown));
  return { main: parts.join(' · '), tech };
}

// Every audio and subtitle track of a media source: Map Index → { main, tech }. Two tracks that still read the same
// (two German PGS tracks without a Title) get a number in the file's order, as two alike versions do (sourceLabels).
export function trackLabels(streams) {
  const labels = new Map(), seen = new Map();
  const list = (streams || []).filter(s => s.Type === 'Audio' || s.Type === 'Subtitle').sort((a, b) => a.Index - b.Index);
  for (const s of list) {
    const l = trackLabel(s), k = `${s.Type}|${l.main}|${l.tech}`;
    labels.set(s.Index, l);
    seen.set(k, [...(seen.get(k) || []), l]);
  }
  for (const same of seen.values()) if (same.length > 1) same.forEach((l, i) => { l.tech = [l.tech, `#${i + 1}`].filter(Boolean).join(' · '); });
  return labels;
}
