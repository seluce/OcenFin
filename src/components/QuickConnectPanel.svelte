<script>
  // Shared Quick Connect presentation — the sign-in screen and the watch-together picker run the
  // SAME flow (quickconnect.js), so they show the same face: code on the left, QR on the right.
  // Heading, container and cancel button stay with the caller; this is only the middle part.
  // Alignment is set HERE rather than inherited: the sign-in card happens to carry text-center,
  // the settings modal does not, and relying on that made the same component render the code
  // centred in one place and left-aligned in the other.
  // While no code has arrived yet a spinner holds the space (the code round trip takes a moment).
  import { i18n } from '../i18n.svelte.js';
  let { code = null, qrSvg = null, class: klass = '' } = $props();
</script>

{#if code}
  <div class="flex items-center justify-center gap-10 {klass}">
    <!-- Code method (left) -->
    <div class="flex-1 flex flex-col items-center gap-4">
      <div class="bg-gray-900 border-2 border-blue-500 rounded-lg py-6 px-6 w-full text-center">
        <span class="text-6xl font-mono font-bold text-white tracking-widest">{code}</span>
      </div>
      <p class="text-gray-400 text-base leading-snug text-center">{i18n.t.qcInstruction}</p>
    </div>
    {#if qrSvg}
      <!-- QR method (right) -->
      <div class="flex flex-col items-center gap-3 shrink-0">
        <div class="rounded-xl bg-white p-3 [&>svg]:block [&>svg]:w-full [&>svg]:h-full"
             style="width:240px;height:240px;">{@html qrSvg}</div>
        <p class="text-gray-400 text-base leading-snug max-w-[240px] text-center">{i18n.t.qcQrHint}</p>
      </div>
    {/if}
  </div>
{:else}
  <div class="flex justify-center py-10 {klass}">
    <div class="w-12 h-12 border-4 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
  </div>
{/if}
