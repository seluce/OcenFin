<script>
  // The parental PIN's pad (§151): four digits, from the remote's number keys or picked on the pad with the D-pad and
  // the pointer. One dialog for every use, the flow per mode lives here:
  //   check  — the PIN → onDone                    (App: a profile without an age limit, a locked profile's settings)
  //   set    — a new PIN twice → saved → onDone    (Settings; App's reset after a password sign-in, over the old one)
  //   change — the PIN, then a new one twice → onDone
  //   remove — the PIN → removed → onDone
  // Back or Cancel → onCancel; onForgot adds "Forgot the PIN?". The fourth digit submits by itself, a moment later so
  // its dot is seen. A held OK repeats the click on a digit (isRepeatedEnter): ignored, or one press typed 1111 and
  // spent a try — the very press that opened the pad would run on into it.
  import { onDestroy, untrack } from 'svelte';
  import Dialog from './Dialog.svelte';
  import { i18n } from '../i18n.svelte.js';
  import { focusOnMount, isRepeatedEnter } from '../utils.js';
  import { checkPin, setPin, clearPin, pinWaitLeft, PIN_LENGTH } from '../parentalpin.svelte.js';

  let { mode = 'check', reason = '', onDone, onCancel, onForgot, z = 'z-[650]' } = $props();

  const firstStep = untrack(() => mode) === 'set' ? 'new' : 'old';   // the mode stays put while the pad is open
  let step   = $state(firstStep);
  let digits = $state('');
  let error  = $state('');
  let first  = '';                      // the new PIN's first entry, until it is repeated
  // Seconds to wait — one earned before the pad opened counts too, but only for asking the PIN: a new one (the reset
  // after "Forgot the PIN?", which is exactly where the wrong tries came from) checks nothing and waits for nothing.
  let waitLeft = $state(firstStep === 'old' ? pinWaitLeft() : 0);

  const heading = $derived(step === 'old' ? i18n.t.pinEnter : step === 'new' ? i18n.t.pinNew : i18n.t.pinRepeat);
  const waiting = $derived(waitLeft > 0);
  const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  $effect(() => {
    if (!waiting) return;
    const t = setInterval(() => { waitLeft = pinWaitLeft(); }, 250);
    return () => clearInterval(t);
  });

  let submitTimer = null;
  onDestroy(() => clearTimeout(submitTimer));

  function press(d) {
    if (waiting || submitTimer || digits.length >= PIN_LENGTH) return;
    error = '';
    digits += d;
    if (digits.length === PIN_LENGTH) submitTimer = setTimeout(() => { submitTimer = null; submit(); }, 180);
  }
  function backspace() {
    if (!submitTimer) digits = digits.slice(0, -1);
  }

  function submit() {
    const pin = digits;
    digits = '';
    if (step === 'old') {
      const r = checkPin(pin);
      if (!r.ok) { waitLeft = r.wait; error = i18n.t.pinWrong; return; }
      if (mode === 'change') { step = 'new'; return; }
      if (mode === 'remove') clearPin();
      onDone?.();
      return;
    }
    if (step === 'new') { first = pin; step = 'repeat'; return; }
    if (pin !== first) { first = ''; step = 'new'; error = i18n.t.pinMismatch; return; }
    setPin(pin);
    onDone?.();
  }

  // The remote's number keys (key '0'–'9'; a few remotes only send the key code), the PC's number pad too.
  function keydown(e) {
    const d = e.key?.length === 1 && e.key >= '0' && e.key <= '9' ? e.key
            : e.keyCode >= 48 && e.keyCode <= 57 ? String(e.keyCode - 48)
            : e.keyCode >= 96 && e.keyCode <= 105 ? String(e.keyCode - 96) : null;
    if (d === null || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault(); e.stopPropagation();
    if (!e.repeat) press(d);
  }

  const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  const KEY_CLS = 'w-20 h-16 rounded-xl bg-gray-700 text-white text-2xl font-bold tabular-nums focus:bg-gray-600 focus:outline-none focus:ring-4 focus:ring-white';
</script>

<Dialog onBack={() => onCancel?.()} onkeydown={keydown} {z}>
  <div class="bg-gray-800 border border-gray-700 rounded-2xl shadow-2xl p-8 w-full max-w-lg mx-6 flex flex-col items-center gap-5">
    <div class="text-center">
      <h2 class="text-2xl font-bold text-white">{heading}</h2>
      {#if reason}<p class="text-gray-400 mt-2">{reason}</p>{/if}
    </div>

    <div class="flex gap-3" aria-hidden="true">
      {#each { length: PIN_LENGTH }, i}
        <div class="w-12 h-14 rounded-xl border-2 flex items-center justify-center {i < digits.length ? 'border-blue-400' : 'border-gray-600'}">
          {#if i < digits.length}<div class="w-3.5 h-3.5 rounded-full bg-white"></div>{/if}
        </div>
      {/each}
    </div>

    <!-- Two lines held free: the wait runs to two in most languages, and the pad must not jump when it appears -->
    <p class="min-h-12 flex items-center justify-center text-center font-semibold {waiting ? 'text-gray-300' : 'text-red-400'}" role="status">
      {waiting ? i18n.t.pinWait.replace('{time}', clock(waitLeft)) : error}
    </p>

    <div class="grid grid-cols-3 gap-3 {waiting ? 'opacity-40' : ''}">
      {#each KEYS as d}
        <button class={KEY_CLS} onclick={() => { if (!isRepeatedEnter()) press(d); }} {@attach focusOnMount(d === '1')}>{d}</button>
      {/each}
      <div></div>
      <button class={KEY_CLS} onclick={() => { if (!isRepeatedEnter()) press('0'); }}>0</button>
      <button class="{KEY_CLS} flex items-center justify-center" onclick={backspace} aria-label={i18n.t.pinBackspace} title={i18n.t.pinBackspace}>
        <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24">
          <path d="M21 5H9l-6 7 6 7h12a1 1 0 001-1V6a1 1 0 00-1-1zM17 9l-6 6M11 9l6 6"/>
        </svg>
      </button>
    </div>

    <div class="flex gap-3 w-full mt-1">
      <button onclick={() => onCancel?.()}
        class="flex-1 bg-gray-700 text-white font-bold py-3 rounded-xl hover:bg-gray-600 focus:bg-gray-600 focus:outline-none focus:ring-4 focus:ring-white">
        {i18n.t.cancel}
      </button>
      {#if onForgot}
        <button onclick={() => onForgot()}
          class="flex-1 bg-gray-700/50 text-gray-300 font-bold py-3 rounded-xl hover:bg-gray-600 hover:text-white focus:bg-gray-600 focus:text-white focus:outline-none focus:ring-4 focus:ring-white">
          {i18n.t.pinForgot}
        </button>
      {/if}
    </div>
  </div>
</Dialog>
