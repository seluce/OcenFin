<script>
  import { i18n } from '../i18n.svelte.js';
  import { onMount, onDestroy } from 'svelte';

  // viewState is passed to shift left in the library view (A-Z bar)
  let { viewState = '', use24h = true } = $props();   // use24h: time format from the setting

  let timeString = $state('');
  let ticker;

  function updateTime() {
    const now = new Date();
    timeString = now.toLocaleTimeString(
      i18n.lang === 'de' ? 'de-DE' : 'en-US',
      { hour: '2-digit', minute: '2-digit', hour12: !use24h }
    );
  }

  // Language + format reactive: $effect tracks the reads in updateTime (i18n.lang, use24h)
  // and reformats the time on every change.
  $effect(() => { updateTime(); });

  // The A-Z bar is w-16 (64px). Shift the clock left in the library view.
  let rightClass = $derived(viewState === 'library' ? 'right-20' : 'right-8');

  onMount(() => {
    updateTime();
    // Sync to the full second
    const delay = 1000 - (Date.now() % 1000);
    const init  = setTimeout(() => {
      updateTime();
      ticker = setInterval(updateTime, 1000);
    }, delay);
    return () => clearTimeout(init);
  });

  onDestroy(() => clearInterval(ticker));
</script>

<div class="fixed top-6 z-[90] pointer-events-none select-none transition-all duration-300 {rightClass}"
  aria-hidden="true">
  <span class="text-2xl font-medium text-white/60 tabular-nums tracking-wide drop-shadow-md">
    {timeString}
  </span>
</div>
