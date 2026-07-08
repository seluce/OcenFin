import { defineConfig } from 'vite'
import { svelte } from '@sveltejs/vite-plugin-svelte'
import tailwindcss from '@tailwindcss/vite'

import { readFileSync } from 'node:fs';

const appinfo = JSON.parse(
  readFileSync(new URL('./public/appinfo.json', import.meta.url), 'utf-8')
);

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(appinfo.version),
  },
  base: './',
  plugins: [
    tailwindcss(),
    svelte(),
  ],
})
