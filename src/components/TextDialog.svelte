<script>
  // A long text in full — the title page's plot (§136) and a person's biography (§163), opened from the clamped text
  // with OK; ▲▼ scroll it. The caller places it at its own top level, outside any stacking context of its layout.
  //
  // The text in paragraphs (§145). Most texts come as ONE block (TMDb), a wall of text in the dialog. Blank lines of
  // its own make paragraphs (single line breaks stay, whitespace-pre-line); a long block without any is cut at sentence
  // ends into parts of about PARA characters, as even as the sentences allow. Never after a word of up to three
  // letters, a number or an initial ("Agentin K. Larsen", "Dr.", "z. B.", "3. Oktober", "U.S.A."): a break missed there
  // costs nothing, a wrong one would cut a sentence in two. Intl.Segmenter: Chromium 87, webOS 25 has it.
  import { i18n } from '../i18n.svelte.js';
  import { focusOnMount, scrollByKey } from '../utils.js';
  import Dialog from './Dialog.svelte';

  let { title, text, onClose } = $props();
  let scroller = $state();

  const PARA = 320;
  function bySentences(block) {
    const n = Math.round(block.length / PARA);
    if (n < 2 || block.includes('\n') || typeof Intl.Segmenter !== 'function') return [block];
    const sentences = [];
    for (const { segment } of new Intl.Segmenter(i18n.lang, { granularity: 'sentence' }).segment(block)) {
      const last = sentences.length - 1;
      if (last >= 0 && /(?:^|[\s(„"'.])(?:\p{L}{1,3}|\d+)\.$/u.test(sentences[last].trimEnd())) sentences[last] += segment;
      else sentences.push(segment);
    }
    const target = block.length / n, parts = [];
    let cur = '';
    sentences.forEach((sentence, i) => {
      cur += sentence;
      const next = sentences[i + 1];
      // Close the part here when that lands nearer the target than taking the next sentence along.
      if (next === undefined || (parts.length < n - 1 && Math.abs(cur.length - target) <= Math.abs(cur.length + next.length - target))) {
        parts.push(cur.trim()); cur = '';
      }
    });
    return parts;
  }
  let parts = $derived((text || '').split(/\n\s*\n/).map(b => b.trim()).filter(Boolean).flatMap(bySentences));
</script>

<Dialog z="z-[200]" onBack={onClose} onkeydown={(e) => scrollByKey(e, scroller)}>
  <div bind:this={scroller} class="bg-gray-800 border border-gray-700 rounded-2xl w-full max-w-4xl max-h-[85vh] overflow-y-auto hide-scrollbar shadow-2xl">
    <div class="flex justify-between items-start gap-6 p-8 pb-4 sticky top-0 bg-gray-800 z-10">
      <h2 class="text-4xl leading-[1.3] -my-[0.0944em] text-white font-bold line-clamp-2">{title}</h2>
      <button onclick={onClose} {@attach focusOnMount()} aria-label={i18n.t.close}
        class="shrink-0 text-gray-400 hover:text-white focus:text-white focus:outline-none focus:ring-4 focus:ring-white rounded-full p-2">
        <svg class="w-8 h-8" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
      </button>
    </div>
    <div class="px-8 pb-8 flex flex-col gap-5 text-2xl text-gray-200 leading-relaxed whitespace-pre-line">
      {#each parts as part}<p>{part}</p>{/each}
    </div>
  </div>
</Dialog>
