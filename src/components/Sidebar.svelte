<script>
  import { t } from '../i18n.js';
  import { isBackKey, focusOnMount, buildNavEntries, applyNavConfig } from '../utils.js';
  import { createEventDispatcher } from 'svelte';

  export let selectedUser;
  export let serverUrl;
  export let viewState;
  export let activeLibraryId = null;    // Id der aktuell geöffneten Mediathek (für Aktiv-Zustand)
  export let libraries = [];            // echte Mediatheken des Profils (dynamische Einträge)
  export let navOrder = [];             // Profil-Reihenfolge der Einträge
  export let navHidden = [];            // ausgeblendete Einträge (gesperrte bleiben sichtbar)
  export let navIcons = {};             // pro-Eintrag gewählte Icons {entryId: paletteKey}
  export let showLogo = true;           // Logo oben in der Sidebar (Einstellung, Opt-out)

  const dispatch = createEventDispatcher();

  let isExpanded      = false;
  let showProfileMenu = false;
  let profileButton;   // für Fokus-Rückgabe nach Menü-Schließen

  // FIX: $: reaktive Variable statt Funktion.
  // Aktiver Eintrag: feste Ansichten über viewState, Mediatheken über ihre Id.
  $: activeNavId =
    viewState === 'dashboard' ? 'dashboard' :
    viewState === 'search'    ? 'search'    :
    viewState === 'favorites' ? 'favorites' :
    viewState === 'settings'  ? 'settings'  :
    viewState === 'library'   ? 'lib:' + activeLibraryId : '';

  // Einträge aus der gemeinsamen Quelle (utils): feste Ansichten + echte Mediatheken,
  // in Profil-Reihenfolge, ausgeblendete entfernt. Klick je nach Art (Ansicht/Mediathek).
  $: navItems = applyNavConfig(buildNavEntries(libraries, $t, navIcons), navOrder, navHidden)
                  .filter(e => !e.hidden);
  function activate(entry) {
    if (entry.kind === 'library') dispatch('navigateLibrary', entry.lib);
    else                          dispatch('navigate', entry.target);
  }

  function getAvatarUrl(user) {
    if (user?.PrimaryImageTag)
      return `${serverUrl}/Users/${user.Id}/Images/Primary?tag=${user.PrimaryImageTag}`;
    return null;
  }

  function handleFocusOut(e) {
    if (!e.currentTarget.contains(e.relatedTarget)) {
      isExpanded      = false;
      showProfileMenu = false;
    }
  }

  function handleNavKeyDown(e) {
    if (showProfileMenu && isBackKey(e)) {
      e.stopPropagation();
      showProfileMenu = false;
      profileButton?.focus();   // Fokus zurück auf Profil-Button (D-Pad-Orientierung)
    }
  }
</script>

<svelte:window on:click={() => showProfileMenu = false} />

<!-- Fester Platzhalter (w-24): hält das Flex-Layout konstant, damit der Inhalt beim
     Aufklappen NICHT umbricht (Haupt-Ruckelquelle). Die sichtbare Leiste liegt
     absolut darüber und überlagert den Inhalt beim Ausklappen (wie moderne TV-Apps). -->
<div class="h-full w-24 shrink-0 relative z-40">
<nav
  data-focus-group="sidebar"
  class="absolute top-0 left-0 h-full bg-gray-900 border-r border-gray-800 flex flex-col pt-8 pb-8 shadow-2xl
         transition-[width] duration-300 ease-in-out overflow-visible
         {isExpanded ? 'w-72' : 'w-24'}"
  on:focusin={() => isExpanded = true}
  on:focusout={handleFocusOut}
  on:mouseenter={() => isExpanded = true}
  on:mouseleave={() => { isExpanded = false; showProfileMenu = false; }}
  on:keydown={handleNavKeyDown}
>

  <!-- LOGO + NAME (über dem Profil) — ausblendbar via Einstellung -->
  {#if showLogo}
  <div class="w-full px-5 mb-8 flex items-center gap-3 select-none">
    <svg viewBox="0 0 512 512" class="w-11 h-11 shrink-0 drop-shadow">
      <rect x="0" y="0" width="512" height="512" rx="118" ry="118" fill="var(--color-blue-600, #2563eb)"/>
      <circle cx="256" cy="256" r="118" fill="none" stroke="#ffffff" stroke-width="64"/>
    </svg>
    <span class="text-2xl font-bold tracking-wide text-white overflow-hidden whitespace-nowrap transition-opacity duration-300
                 {isExpanded ? 'opacity-100' : 'opacity-0'}">OcenFin</span>
  </div>
  {/if}

  <!-- PROFIL-BUTTON -->
  <button
    bind:this={profileButton}
    on:click|stopPropagation={() => showProfileMenu = !showProfileMenu}
    class="group w-full px-5 mb-12 focus:outline-none flex items-center gap-4 relative"
  >
    <div class="w-14 h-14 shrink-0 rounded-full overflow-hidden border-4 border-transparent
                group-focus:border-blue-500 shadow-md transition-all">
      {#if getAvatarUrl(selectedUser)}
        <img src={getAvatarUrl(selectedUser)} alt={$t.profile} class="w-full h-full object-cover" />
      {:else}
        <div class="w-full h-full bg-gray-700 flex items-center justify-center">
          <span class="text-xl font-bold">{selectedUser.Name[0]}</span>
        </div>
      {/if}
    </div>
    <div class="overflow-hidden whitespace-nowrap transition-opacity duration-300
                {isExpanded ? 'opacity-100' : 'opacity-0'}">
      <span class="text-xl font-bold text-gray-300 group-focus:text-white">{selectedUser.Name}</span>
    </div>
  </button>

  <!-- PROFIL-DROPDOWN -->
  {#if showProfileMenu && isExpanded}
    <div data-focus-trap class="absolute top-24 left-20 bg-gray-800 border border-gray-700 shadow-2xl
                rounded-xl p-2 flex flex-col gap-1 z-[60] min-w-[220px]">
      <button
        use:focusOnMount
        on:click|stopPropagation={() => { showProfileMenu = false; dispatch('switchUser'); }}
        class="text-left px-5 py-4 rounded-lg text-white font-semibold text-lg
               hover:bg-gray-700 focus:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-white
               transition-colors flex items-center gap-3"
      >
        <svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7"/>
        </svg>
        {$t.switchUser}
      </button>
      <button
        on:click|stopPropagation={() => { showProfileMenu = false; dispatch('logOutServer'); }}
        class="text-left px-5 py-4 rounded-lg text-red-400 font-semibold text-lg
               hover:bg-red-900/60 focus:bg-red-900/60 focus:outline-none focus:ring-2 focus:ring-red-500
               transition-colors flex items-center gap-3"
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
        </svg>
        {$t.logout}
      </button>
    </div>
  {/if}

  <!-- NAV-BUTTONS — activeNavId ist $: reaktiv, Klasse wird korrekt aktualisiert -->
  <!-- flex-1 + min-h-0 + overflow-y-auto: bei mehr Einträgen als Platz scrollt die Liste,
       sodass auch der unterste Eintrag (z. B. Einstellungen) immer erreichbar bleibt. -->
  <div class="w-full flex-1 min-h-0 overflow-y-auto hide-scrollbar flex flex-col gap-2 px-4 py-1">
    {#each navItems as navItem (navItem.id)}
      <button
        on:click={() => activate(navItem)}
        on:focus={(e) => e.currentTarget.scrollIntoView({ block: 'nearest' })}
        class="w-full flex items-center gap-6 p-4 rounded-xl transition-colors focus:outline-none shrink-0
               {activeNavId === navItem.id
                 ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/30 focus:ring-4 focus:ring-white'
                 : 'text-gray-400 hover:bg-gray-800 hover:text-white focus:bg-gray-800 focus:text-white focus:ring-4 focus:ring-white'}"
      >
        <svg class="w-8 h-8 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d={navItem.icon}/>
        </svg>
        <div class="overflow-hidden whitespace-nowrap transition-opacity duration-300
                    {isExpanded ? 'opacity-100' : 'opacity-0'}">
          <span class="text-xl font-semibold">{navItem.label}</span>
        </div>
      </button>
    {/each}
  </div>

</nav>
</div>

<style>
  .hide-scrollbar::-webkit-scrollbar { display: none; }
  .hide-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
</style>
