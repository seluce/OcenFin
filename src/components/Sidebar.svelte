<script>
  import { i18n } from '../i18n.svelte.js';
  import { isBackKey, focusOnMount, buildNavEntries, applyNavConfig } from '../utils.js';
  import { session } from '../session.svelte.js';

  let {
    selectedUser,
    viewState,
    activeLibraryId = null,    // ID of the currently open library (for the active state)
    libraries = [],            // the profile's real libraries (dynamic entries)
    navOrder = [],             // the profile's entry order
    navHidden = [],            // hidden entries (locked ones stay visible)
    navIcons = {},             // per-entry chosen icons {entryId: paletteKey}
    showLogo = true,           // logo at the top of the sidebar (setting, opt-out)
    onNavigate, onNavigateLibrary, onSwitchUser, onLogOutServer,   // callback props (instead of events)
  } = $props();

  let isExpanded      = $state(false);
  let showProfileMenu = $state(false);
  let profileButton;   // for focus return after closing the menu (bind:this)

  // Active entry: fixed views via viewState, libraries via their ID.
  let activeNavId = $derived(
    viewState === 'dashboard' ? 'dashboard' :
    viewState === 'search'    ? 'search'    :
    viewState === 'favorites' ? 'favorites' :
    viewState === 'settings'  ? 'settings'  :
    viewState === 'library'   ? 'lib:' + activeLibraryId : ''
  );

  // Entries from the shared source (utils): fixed views + real libraries,
  // in profile order, hidden ones removed. Click depends on the kind (view/library).
  let navItems = $derived(
    applyNavConfig(buildNavEntries(libraries, i18n.t, navIcons), navOrder, navHidden).filter(e => !e.hidden)
  );
  function activate(entry) {
    if (entry.kind === 'library') onNavigateLibrary?.(entry.lib);
    else                          onNavigate?.(entry.target);
  }

  function getAvatarUrl(user) {
    if (user?.PrimaryImageTag)
      return `${session.serverUrl}/Users/${user.Id}/Images/Primary?tag=${user.PrimaryImageTag}&fillWidth=120&fillHeight=120&quality=90&format=webp`;
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
      profileButton?.focus();   // focus back on the profile button (D-pad orientation)
    }
  }
</script>

<svelte:window onclick={() => showProfileMenu = false} />

<!-- Fixed placeholder (w-24): keeps the flex layout constant so the content does NOT
     reflow on expand (the main source of jank). The visible bar sits
     absolutely on top and overlaps the content when expanded (like modern TV apps). -->
<div class="h-full w-24 shrink-0 relative z-40">
<!-- The sidebar expands on focus/hover of its child buttons (a container-level enhancement) and
     delegates D-pad keys to the nav manager. It stays a <nav> landmark; an interactive role would
     misrepresent a navigation region that holds multiple buttons. -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<nav
  data-focus-group="sidebar"
  class="absolute top-0 left-0 h-full bg-gray-900 border-r border-gray-800 flex flex-col pt-8 pb-8 [contain:layout]
         transition-[width] duration-300 ease-in-out overflow-visible
         {isExpanded ? 'w-72' : 'w-24'}"
  onfocusin={() => isExpanded = true}
  onfocusout={handleFocusOut}
  onmouseenter={() => isExpanded = true}
  onmouseleave={() => { isExpanded = false; showProfileMenu = false; }}
  onkeydown={handleNavKeyDown}
>
  <!-- Edge shadow as a gradient with an opacity fade instead of box-shadow: a box-shadow on an
       element whose width animates is re-rasterized on EVERY frame on the B4 (large
       blur radius = expensive) — that was the last big cost on expand. Opacity runs
       on the compositor; when collapsed the border-r separates the bar from the content.
       [contain:layout] above: per-frame layout recalculation stays strictly limited to the panel
       (deliberately NO contain:paint — that would clip the profile flyout). -->
  <div class="absolute inset-y-0 -right-6 w-6 bg-gradient-to-r from-black/35 to-transparent pointer-events-none
              transition-opacity duration-300 {isExpanded ? 'opacity-100' : 'opacity-0'}" aria-hidden="true"></div>

  <!-- LOGO + NAME (above the profile) — hideable via a setting -->
  {#if showLogo}
  <div class="w-full px-5 mb-5 flex items-center gap-3 select-none">
    <svg viewBox="0 0 512 512" class="w-11 h-11 shrink-0 drop-shadow">
      <rect x="0" y="0" width="512" height="512" rx="118" ry="118" fill="var(--color-blue-600, #2563eb)"/>
      <circle cx="256" cy="256" r="118" fill="none" stroke="#ffffff" stroke-width="64"/>
    </svg>
    <span class="text-2xl font-bold tracking-wide text-white overflow-hidden whitespace-nowrap transition-opacity duration-300
                 {isExpanded ? 'opacity-100' : 'opacity-0'}">OcenFin</span>
  </div>
  {/if}

  <!-- PROFILE BUTTON -->
  <button
    bind:this={profileButton}
    onclick={(e) => { e.stopPropagation(); showProfileMenu = !showProfileMenu; }}
    class="group w-full px-5 mb-6 focus:outline-none flex items-center gap-4 relative"
  >
    <div class="w-14 h-14 shrink-0 rounded-full overflow-hidden border-4 border-transparent
                group-focus:border-blue-500 shadow-md transition-all">
      {#if getAvatarUrl(selectedUser)}
        <img src={getAvatarUrl(selectedUser)} alt={i18n.t.profile} class="w-full h-full object-cover" />
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

  <!-- PROFILE DROPDOWN -->
  {#if showProfileMenu && isExpanded}
    <div data-focus-trap class="absolute top-24 left-20 bg-gray-800 border border-gray-700 shadow-2xl
                rounded-xl p-2 flex flex-col gap-1 z-[60] min-w-[220px]">
      <button
        {@attach focusOnMount()}
        onclick={(e) => { e.stopPropagation(); showProfileMenu = false; onSwitchUser?.(); }}
        class="text-left px-5 py-4 rounded-lg text-white font-semibold text-lg
               hover:bg-gray-700 focus:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-white
               transition-colors flex items-center gap-3"
      >
        <svg class="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7"/>
        </svg>
        {i18n.t.switchUser}
      </button>
      <button
        onclick={(e) => { e.stopPropagation(); showProfileMenu = false; onLogOutServer?.(); }}
        class="text-left px-5 py-4 rounded-lg text-red-400 font-semibold text-lg
               hover:bg-red-900/60 focus:bg-red-900/60 focus:outline-none focus:ring-2 focus:ring-red-500
               transition-colors flex items-center gap-3"
      >
        <svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"/>
        </svg>
        {i18n.t.logout}
      </button>
    </div>
  {/if}

  <!-- NAV BUTTONS — activeNavId is $: reactive, the class is updated correctly -->
  <!-- flex-1 + min-h-0 + overflow-y-auto: with more entries than space, the list scrolls
       so even the bottom entry (e.g. Settings) always stays reachable. -->
  <!-- py-2 + scroll-my-2 on the buttons: the focus ring (ring-4) extends beyond the button
       box; without padding AND scroll-margin the ring gets clipped at the very first/last
       entry once the list scrolls (scrollIntoView aligns the box flush with the edge). -->
  <div class="w-full flex-1 min-h-0 overflow-y-auto hide-scrollbar flex flex-col gap-2 px-4 py-2">
    {#each navItems as navItem (navItem.id)}
      <button
        onclick={() => activate(navItem)}
        data-group-current={activeNavId === navItem.id ? '' : null}
        onfocus={(e) => e.currentTarget.scrollIntoView({ block: 'nearest' })}
        class="w-full flex items-center gap-6 px-4 py-3.5 rounded-xl transition-colors focus:outline-none shrink-0 scroll-my-2
               {activeNavId === navItem.id
                 ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/30 focus:ring-4 focus:ring-white'
                 : 'text-gray-400 hover:bg-gray-800 hover:text-white focus:bg-gray-800 focus:text-white focus:ring-4 focus:ring-white'}"
      >
        <svg class="w-8 h-8 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d={navItem.icon}/>
        </svg>
        <div class="overflow-hidden text-ellipsis whitespace-nowrap transition-opacity duration-300
                    {isExpanded ? 'opacity-100' : 'opacity-0'}">
          <span class="text-xl font-semibold">{navItem.label}</span>
        </div>
      </button>
    {/each}
  </div>

</nav>
</div>

