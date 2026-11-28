// A long grid of poster cards is put up in steps (CODE-HEALTH §165): the person page and the collection/playlist view.
// The first FIRST cards at once, the rest STEP per frame from the frame AFTER the first one — measured on a CPU slowed
// to the B4's (4×), 233 cards were ONE block of 132 ms before focus landed, and Back to a kept page built all of them
// again before the card had focus. The same cards in the same order in the end; only what is built when.
//
// `slice(groups)` cuts the view's groups ({ items } each) to what is up, in order — a group fills before the next one
// starts, so no heading stands above an empty grid. A return to a card further down asks `reach(index)` BEFORE the
// view lands: that card plus FIRST more, enough below it for the remembered offset to fit. `grow(total)` builds the
// rest (`total` a function, read each frame: a refresh may change the count). Call it from the view's script, once:
// its frame is cancelled with the view.
const FIRST = 24, STEP = 48;

export function cardSteps() {
  let upTo = $state(FIRST);
  let raf = 0;
  $effect(() => () => cancelAnimationFrame(raf));
  return {
    reset() { cancelAnimationFrame(raf); raf = 0; upTo = FIRST; },
    reach(index) { if (index >= 0 && index + FIRST > upTo) upTo = index + FIRST; },
    grow(total) {
      cancelAnimationFrame(raf);
      const next = () => {
        raf = 0;
        if (upTo >= total()) return;
        upTo += STEP;
        raf = requestAnimationFrame(next);
      };
      raf = requestAnimationFrame(() => { raf = requestAnimationFrame(next); });   // the first screenful is drawn first
    },
    slice(groups) {
      let left = upTo;
      const out = [];
      for (const g of groups) {
        if (left <= 0) break;
        out.push(g.items.length <= left ? g : { ...g, items: g.items.slice(0, left) });
        left -= g.items.length;
      }
      return out;
    },
  };
}
