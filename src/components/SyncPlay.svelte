<script>
  import { i18n } from '../i18n.svelte.js';
  import { focusOnMount, uiFade, dropTrapOnOutro } from '../utils.js';

  let {
    group   = null,   // current group { GroupId, GroupName, Participants: [name] } or null
    groups  = [],     // available groups
    loading = false,
    onClose, onLeave, onCreate, onRefresh, onJoin,   // callback props (instead of events)
  } = $props();
</script>

<!-- Backdrop: click-outside-to-close is a pointer-only convenience and duplicates the Close
     button below; keyboard/remote users close via that button or the back key. A role + key
     handler on a full-screen backdrop would be semantically wrong and fight the focus trap. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="fixed inset-0 z-[130] bg-black/85 flex items-center justify-center p-8"
     transition:uiFade onoutrostart={dropTrapOnOutro}
     onclick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
  <div data-focus-trap
       class="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-xl max-h-[85vh]
              overflow-y-auto hide-scrollbar p-8 flex flex-col gap-6">

    <div class="flex items-center gap-4">
      <svg class="w-9 h-9 text-blue-400 shrink-0" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" d="M18 18.72a9.094 9.094 0 003.741-.479 3 3 0 00-4.682-2.72m.94 3.198l.001.031c0 .225-.012.447-.037.666A11.944 11.944 0 0112 21c-2.17 0-4.207-.576-5.963-1.584A6.062 6.062 0 016 18.719m12 0a5.971 5.971 0 00-.941-3.197m0 0A5.995 5.995 0 0012 12.75a5.995 5.995 0 00-5.058 2.772m0 0a3 3 0 00-4.681 2.72 8.986 8.986 0 003.74.477m.94-3.197a5.971 5.971 0 00-.94 3.197M15 6.75a3 3 0 11-6 0 3 3 0 016 0zm6 3a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0zm-13.5 0a2.25 2.25 0 11-4.5 0 2.25 2.25 0 014.5 0z"/>
      </svg>
      <div>
        <h2 class="text-3xl font-bold text-white">{i18n.t.syncPlay}</h2>
        <p class="text-gray-400 text-sm mt-1">{i18n.t.syncPlayIntro}</p>
      </div>
    </div>

    {#if group}
      <!-- In a group: members + leave -->
      <div class="bg-gray-800/70 border border-gray-700 rounded-xl p-5 flex flex-col gap-3">
        <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">{i18n.t.syncGroupActive}</span>
        <span class="text-xl font-bold text-white">{group.GroupName}</span>
        <div class="flex flex-col gap-1">
          <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">{i18n.t.groupMembers}</span>
          {#each (group.Participants || []) as p (p)}
            <span class="text-gray-200">{p}</span>
          {/each}
        </div>
      </div>
      <button onclick={() => onLeave?.()} {@attach focusOnMount()}
        class="w-full bg-red-800 hover:bg-red-700 focus:bg-red-700 text-white font-bold text-xl py-4 rounded-xl
               focus:outline-none focus:ring-4 focus:ring-white transition-colors">
        {i18n.t.leaveGroup}
      </button>
    {:else}
      <!-- Not in a group: create or join -->
      <button onclick={() => onCreate?.()} {@attach focusOnMount()}
        class="w-full bg-blue-600 hover:bg-blue-500 focus:bg-blue-500 text-white font-bold text-xl py-4 rounded-xl
               focus:outline-none focus:ring-4 focus:ring-white transition-colors flex items-center justify-center gap-3">
        <svg class="w-6 h-6" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"/>
        </svg>
        {i18n.t.createGroup}
      </button>

      <div class="flex flex-col gap-2">
        <div class="flex items-center justify-between">
          <span class="text-xs font-semibold text-gray-400 uppercase tracking-wider">{i18n.t.availableGroups}</span>
          <button onclick={() => onRefresh?.()}
            class="text-gray-400 hover:text-white focus:text-white text-sm font-bold px-3 py-1 rounded-lg
                   focus:outline-none focus:ring-2 focus:ring-white">{i18n.t.refresh}</button>
        </div>
        {#if groups.length > 0}
          {#each groups as g (g.GroupId)}
            <div class="bg-gray-800/70 border border-gray-700 rounded-xl p-4 flex items-center justify-between gap-4">
              <div class="min-w-0">
                <span class="text-white font-bold truncate block">{g.GroupName}</span>
                <span class="text-gray-400 text-sm">{(g.Participants || []).length} · {(g.Participants || []).join(', ')}</span>
              </div>
              <button onclick={() => onJoin?.(g.GroupId)}
                class="shrink-0 bg-gray-700 hover:bg-blue-600 focus:bg-blue-600 text-white font-bold px-6 py-2.5 rounded-lg
                       focus:outline-none focus:ring-4 focus:ring-white transition-colors">{i18n.t.joinGroup}</button>
            </div>
          {/each}
        {:else}
          <p class="text-gray-500 text-center py-6">{loading ? '…' : i18n.t.noSyncGroups}</p>
        {/if}
      </div>
    {/if}

    <button onclick={() => onClose?.()}
      class="w-full bg-gray-800 hover:bg-gray-700 focus:bg-gray-700 text-gray-300 font-bold py-3 rounded-xl
             focus:outline-none focus:ring-4 focus:ring-white transition-colors mt-2">
      {i18n.t.close}
    </button>
  </div>
</div>

