<script>
  // A view that throws while it builds or updates (CODE-HEALTH §155) — a repeated key in server data, a field of an
  // unexpected shape — left the screen half drawn with nothing to focus; only a restart helped. Inside this boundary
  // the error goes to the log and the view gives way to a short message: Retry builds it again, Back leaves it (the
  // Back key does the same through App). Svelte catches what is thrown while rendering and in effects and
  // attachments, not in event handlers or after an await — utils.js logs those from window.
  // `onRetry` instead of building it again here: a view that reads a cache of App's (the dashboard) would only meet the
  // same answer — App drops the cache and builds it anew. `onRetried`: Retry's button is gone with the message, so App
  // brings focus into the view again unless the view takes it itself. `shown`: a view kept mounted while hidden
  // (Library, Search) builds again when it is shown again — otherwise it reopened onto the old message, unfocused.
  // `trap`: over a screen not to be reached around (the Player).
  import { untrack } from 'svelte';
  import { i18n } from '../i18n.svelte.js';
  import { focusOnMount, describeError } from '../utils.js';

  let { children, name, onBack = null, onRetry = null, onRetried = null, shown = true, trap = false } = $props();

  let again = null;   // the boundary's reset while the message is up — a plain variable: reading it must not re-run
  function report(error, reset) {
    again = reset;
    console.error(`[view] ${name} failed: ${describeError(error)}`);
  }
  function retry() {
    const reset = again; again = null;
    if (onRetry) onRetry(); else reset?.();
    onRetried?.();
  }
  $effect(() => { if (shown) untrack(() => { if (again) { const reset = again; again = null; reset(); } }); });
</script>

<svelte:boundary onerror={report}>
  {@render children()}

  {#snippet failed()}
    <div class="h-full w-full flex items-center justify-center" data-focus-group={trap ? 'view-error' : undefined}
      data-focus-trap={trap || undefined}>
      <div class="flex flex-col items-center gap-5 max-w-3xl text-center px-8">
        <svg class="w-16 h-16 text-red-500" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m0 3.75h.008M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/>
        </svg>
        <p class="text-white text-2xl font-bold">{i18n.t.viewFailed}</p>
        <p class="text-gray-400">{i18n.t.viewFailedDesc.replace('{where}', `${i18n.t.settings} › ${i18n.t.statusSection}`)}</p>
        <div class="flex gap-4 mt-2">
          <button onclick={retry} {@attach focusOnMount()}
            class="bg-white text-black font-bold px-6 py-3 rounded-xl focus:outline-none focus:ring-4 focus:ring-white hover:bg-gray-200 transition-colors">
            {i18n.t.retry}
          </button>
          {#if onBack}
            <button onclick={() => onBack()}
              class="bg-gray-700 text-white font-bold px-6 py-3 rounded-xl focus:outline-none focus:ring-4 focus:ring-white hover:bg-gray-600 transition-colors">
              {i18n.t.back}
            </button>
          {/if}
        </div>
      </div>
    </div>
  {/snippet}
</svelte:boundary>
