import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

import { readFileSync } from 'node:fs';

const appinfo = JSON.parse(
  readFileSync(new URL('./public/appinfo.json', import.meta.url), 'utf-8')
);

// JASSUB (ASS subtitles) ships libass twice: "modern" (relaxed SIMD + mimalloc) and plain. It picks at
// runtime, but every `new URL(…)` reference gets bundled — 2 MB per WASM. webOS 25's Chromium 120 has
// relaxed SIMD (since 114; the B4 logged "SIMD build"), so the plain references point at the modern
// files and only those ship. Since 2.5.36 each build has its OWN Emscripten glue (the glue fetches its
// own WASM), and JASSUB takes the plain pair when navigator.deviceMemory ≤ 2 — so both halves of the
// plain pair are swapped, WASM and glue: one would load the other build's WASM into the wrong glue.
// The B4 stays on the build it has run since 2.5.x; measured, the plain one is as fast on a desktop
// and needs ~13 MB less heap with a 20 000-line script (CODE-HEALTH §78). Warns if a JASSUB update
// renames a reference, so the saving cannot vanish unnoticed.
function jassubSimdOnly() {
  const swaps = {
    '/node_modules/jassub/dist/jassub.js': [
      ["new URL('./wasm/jassub-worker.wasm', import.meta.url)", "new URL('./wasm/jassub-worker-modern.wasm', import.meta.url)"],
      ["new URL('./wasm/jassub-worker.js', import.meta.url)", "new URL('./wasm/jassub-worker-modern.js', import.meta.url)"],
    ],
  };
  return {
    name: 'jassub-simd-only',
    transform(code, id) {
      const file = Object.keys(swaps).find(f => id.replace(/\\/g, '/').endsWith(f));
      if (!file) return null;
      for (const [plain, simd] of swaps[file]) {
        if (!code.includes(plain)) { this.warn(`JASSUB changed (${file}): the plain build is bundled again`); return null; }
        code = code.replace(plain, simd);
      }
      return { code, map: null };
    },
  };
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appinfo.version),
  },
  base: './',
  plugins: [
    tailwindcss(),
    svelte(),
    jassubSimdOnly(),
  ],
  // Workers are bundled separately and do not see the plugins above: JASSUB's glue lives in its worker.
  worker: { plugins: () => [jassubSimdOnly()] },
})
