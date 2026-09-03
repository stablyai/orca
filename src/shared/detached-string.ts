// Why: `String.prototype.slice` yields a V8 sliced string that keeps its parent
// alive. A 20-char title sliced from an 8 MiB PTY chunk therefore retains all
// 8 MiB for as long as the title is cached, which is how a handful of idle agent
// panes exhausted the renderer heap. Copying the code units breaks that edge.

/**
 * Copy `value` into a string that shares no backing store with its source, so
 * the source becomes collectable. Code-unit identical to the input, including
 * lone surrogates. Safe for any length.
 */
export function detachString(value: string): string {
  if (value.length === 0) {
    return ''
  }
  // Why this shape: prepending forces V8 to flatten into a freshly allocated
  // sequential string, then slicing that owned result off by one yields a copy
  // holding no reference to `value`. Uint16Array/fromCharCode round-trips also
  // detach but run ~45x slower on dense PTY frames; `padEnd`/`repeat(1)` are
  // no-ops V8 returns unchanged, so they leave the value sliced.
  return ` ${value}`.slice(1)
}
