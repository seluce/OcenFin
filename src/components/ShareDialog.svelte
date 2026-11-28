<script>
  // The share dialog: a QR code to scan with a phone — a public link (IMDb/TMDb), else a name to look up, never a dead
  // link. The title page's (from its menu) and a person's (§164). The caller works out `target` (null while it is still
  // being worked out: no code yet) and says what is shared in `children`, under the code; `hint` the line below.
  // The caller places it at its own top level, like every dialog.
  import { i18n } from '../i18n.svelte.js';
  import { focusOnMount } from '../utils.js';
  import Dialog from './Dialog.svelte';

  let { target = null, hint, onClose, children } = $props();
  let svg = $state(null);
  $effect(() => {
    const t = target;
    svg = null;
    if (t == null) return;
    let gone = false;
    import('uqr')   // loaded on first use, zero-dependency
      .then(({ renderSVG }) => { if (!gone) svg = renderSVG(t || ' ', { ecc: 'M', border: 1 }); })   // vector → razor sharp
      .catch((e) => console.warn('[OcenFin] share QR failed', e));
    return () => { gone = true; };
  });
</script>

<Dialog onBack={onClose}>
  <div data-modal
    class="bg-gray-800 border border-gray-700 rounded-2xl p-8 w-full max-w-lg flex flex-col items-center gap-5 shadow-2xl">
    <div class="flex items-center justify-between gap-4 w-full">
      <h2 class="text-3xl text-white font-bold">{i18n.t.share}</h2>
      <button onclick={onClose} {@attach focusOnMount()}
        class="px-5 py-3 rounded-xl font-bold bg-gray-700 hover:bg-gray-600 focus:bg-gray-600 text-white
               focus:outline-none focus:ring-4 focus:ring-white transition-colors">{i18n.t.close}</button>
    </div>
    {#if svg}
      <div class="rounded-xl bg-white p-3 [&>svg]:block [&>svg]:w-full [&>svg]:h-full"
           style="width:320px;height:320px;max-width:40vh;max-height:40vh;">{@html svg}</div>
    {/if}
    {@render children()}
    <p class="text-gray-400 text-base text-center max-w-md">{hint}</p>
  </div>
</Dialog>
