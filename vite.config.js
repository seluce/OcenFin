import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

import { readFileSync } from 'node:fs';

const appinfo = JSON.parse(
  readFileSync(new URL('./public/appinfo.json', import.meta.url), 'utf-8')
);

// JASSUB (ASS subtitles) ships libass twice: with relaxed SIMD and without. It picks at runtime, but
// every `new URL(…wasm)` reference gets bundled — 2.1 MB each. webOS 25's Chromium 120 has relaxed
// SIMD (since 114; the B4 logged "SIMD build"), so point the plain references at the SIMD file and
// only that one ships: the one in jassub.js (the runtime pick) and the Emscripten glue's default,
// which is never fetched (the worker hands the glue the picked URL). Warns if a JASSUB update renames
// either reference, so the saving cannot vanish unnoticed.
function jassubSimdOnly() {
  const swaps = {
    '/node_modules/jassub/dist/jassub.js':
      ["new URL('./wasm/jassub-worker.wasm', import.meta.url)", "new URL('./wasm/jassub-worker-modern.wasm', import.meta.url)"],
    '/node_modules/jassub/dist/wasm/jassub-worker.js':
      ['new URL("jassub-worker.wasm", import.meta.url)', 'new URL("jassub-worker-modern.wasm", import.meta.url)'],
  };
  return {
    name: 'jassub-simd-only',
    transform(code, id) {
      const file = Object.keys(swaps).find(f => id.replace(/\\/g, '/').endsWith(f));
      if (!file) return null;
      const [plain, simd] = swaps[file];
      if (!code.includes(plain)) { this.warn(`JASSUB changed (${file}): the plain WASM build is bundled again`); return null; }
      return { code: code.replace(plain, simd), map: null };
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
