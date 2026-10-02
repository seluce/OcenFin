<script>
  // The app's mark — the ring on a rounded square, in the accent colour. The sidebar's logo and the
  // sign-in screens share it (the splash keeps its own gradient version).
  let { class: cls = '' } = $props();
</script>

<svg viewBox="0 0 512 512" class={cls} aria-hidden="true">
  <rect x="0" y="0" width="512" height="512" rx="118" ry="118" fill="var(--color-blue-600, #2563eb)"/>
  <circle cx="256" cy="256" r="118" fill="none" stroke="#ffffff" stroke-width="64"/>
</svg>
