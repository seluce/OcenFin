<script>
  import { currentLang } from '../i18n.js';
  import { onMount, onDestroy } from 'svelte';

  // viewState wird übergeben um bei Bibliothek-Ansicht (A-Z-Leiste) nach links zu rücken
  let { viewState = '', use24h = true } = $props();   // use24h: Zeitformat aus Einstellung

  let timeString = $state('');
  let ticker;

  function updateTime() {
    const now = new Date();
    timeString = now.toLocaleTimeString(
      $currentLang === 'de' ? 'de-DE' : 'en-US',
      { hour: '2-digit', minute: '2-digit', hour12: !use24h }
    );
  }

  // Sprache + Format reaktiv: $effect verfolgt die Lesezugriffe in updateTime ($currentLang, use24h)
  // und formatiert die Zeit bei jeder Änderung neu.
  $effect(() => { updateTime(); });

  // A-Z-Leiste ist w-16 (64px). Im Library-View Uhrzeit nach links versetzen.
  let rightClass = $derived(viewState === 'library' ? 'right-20' : 'right-8');

  onMount(() => {
    updateTime();
    // Auf volle Sekunde synchronisieren
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
