<script>
  import { currentLang } from '../i18n.js';
  import { createEventDispatcher, onMount, onDestroy } from 'svelte';

  const dispatch = createEventDispatcher();

  export let use24h = true;   // Zeitformat (aus Einstellung abgeleitet)

  // Position in % — wechselt periodisch und gleitet sanft per CSS-Transition.
  // Moderner Ansatz (Apple TV, Plex, Jellyfin): Element ruht, gleitet dann langsam
  // an eine neue Zufallsposition. Kein 60fps-Loop, kein hektisches Abprallen.
  let posX = 30, posY = 35;
  let moveTimer, clockTick, firstMove;

  let timeString = '';
  let dateString = '';

  function updateClock() {
    const now  = new Date();
    timeString = now.toLocaleTimeString(
      $currentLang === 'de' ? 'de-DE' : 'en-US',
      { hour: '2-digit', minute: '2-digit', hour12: !use24h }
    );
    dateString = now.toLocaleDateString(
      $currentLang === 'de' ? 'de-DE' : 'en-US',
      { weekday: 'long', day: 'numeric', month: 'long' }
    );
  }

  // Neue Zufallsposition im sicheren Bereich
  function reposition() {
    posX = 15 + Math.random() * 70;
    posY = 18 + Math.random() * 60;
  }

  onMount(() => {
    updateClock();
    clockTick = setInterval(updateClock, 1000);
    // Erste Bewegung nach 8s, danach alle 18s sanft an neue Position gleiten
    firstMove = setTimeout(reposition, 8000);
    moveTimer = setInterval(reposition, 18000);
  });

  onDestroy(() => {
    clearInterval(clockTick);
    clearInterval(moveTimer);
    clearTimeout(firstMove);
  });

  function dismiss() {
    dispatch('dismiss');
  }
</script>

<!--
  Reines Schwarz — bester OLED-Schutz. Das Element gleitet über 4s sanft
  zur neuen Position (CSS-Transition), ruht dann 18s. Gedimmte Grautöne
  verhindern Burn-in auch bei längerer Anzeige.
-->
<div
  class="fixed inset-0 bg-black z-[500] cursor-none select-none"
  on:click={dismiss}
  on:keydown={dismiss}
  on:pointermove|self={dismiss}
  tabindex="-1"
>
  <div
    class="absolute pointer-events-none screensaver-clock"
    style="left:{posX}%; top:{posY}%;"
  >
    <p class="text-gray-300 font-thin tabular-nums text-center"
       style="font-size: clamp(3rem, 8vw, 7rem); letter-spacing: 0.15em">
      {timeString}
    </p>
    <p class="text-gray-400 text-center text-2xl font-light mt-1 tracking-wider">
      {dateString}
    </p>
    <p class="text-gray-600 text-center text-sm mt-3 tracking-widest font-medium uppercase">
      OcenFin
    </p>
  </div>
</div>

<style>
  /* Sanftes Gleiten zur neuen Position — modern statt hektischem Abprallen */
  .screensaver-clock {
    transform: translate(-50%, -50%);
    transition: left 4s ease-in-out, top 4s ease-in-out;
  }
</style>
