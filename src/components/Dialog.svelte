<script>
  // The frame of every dialog (§142): the darkening, the focus trap, the fade, Back. Fourteen dialogs built their own,
  // at four darknesses (70/80/85/90 %) and one with a blur over the whole screen — now one. What sits inside, the
  // panel with its width, padding and colour, stays with each dialog.
  //   onBack     — Back closes it (stopPropagation, so App's own Back handling stays out). Left out where App handles
  //                Back itself (SyncPlay, the exit question) or the dialog listens on the window (the card menu).
  //   onkeydown  — the dialog's other keys (▲▼ scrolling a long text); Back is decided first.
  //   onBackdrop — a pointer click on the darkening; a convenience, the remote closes with Back or a button.
  //   z          — its layer: dialogs stack over views and over each other (a picker over Details).
  // The trap is on this element, the darkening inside it. A pointer press on the darkening must not move focus there:
  // the frame covers the screen, so no arrow would lead anywhere from it — mousedown is held back and focus stays in
  // the panel (where the trap sat on the panel, the pull-back used to put it on the first button instead).
  // On the way out the trap goes at once (dropTrapOnOutro), so focus can go back to the opener during the fade. The
  // outro starts a moment AFTER the flush that closed the dialog: a focus return that stands down while something else
  // holds focus must let go of a button in here first (App's restoreContextFocus).
  import { isBackKey, uiFade, dropTrapOnOutro } from '../utils.js';

  let { onBack, onkeydown, onBackdrop, z = 'z-[100]', children } = $props();

  function keydown(e) {
    if (onBack && isBackKey(e)) { e.preventDefault(); e.stopPropagation(); onBack(); return; }
    onkeydown?.(e);
  }
  function click(e) {
    if (onBackdrop && e.target === e.currentTarget) onBackdrop();
  }
  function keepFocus(e) {
    if (e.target === e.currentTarget) e.preventDefault();
  }
</script>

<div data-focus-trap role="dialog" aria-modal="true" tabindex="-1"
  transition:uiFade onoutrostart={dropTrapOnOutro}
  class="fixed inset-0 {z} bg-black/90 flex items-center justify-center p-8"
  onkeydown={keydown} onclick={click} onmousedown={keepFocus}>
  {@render children()}
</div>
