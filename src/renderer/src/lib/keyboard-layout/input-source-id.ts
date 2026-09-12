/**
 * Classifier for macOS's `AppleCurrentKeyboardLayoutInputSourceID`.
 *
 * Why this exists alongside detect-option-as-alt: the layout-fingerprint
 * probe (`detectOptionAsAltFromLayoutMap`) inspects `navigator.keyboard
 * .getLayoutMap()`, which only surfaces the base (unshifted) layer. Many
 * macOS layouts keep a US-identical base layer but repurpose the Option
 * layer for dead-key composition — ABC (Option+A = å), Polish Pro
 * (Option+A = ą), US Extended, ABC Extended, and the CJK Roman IMEs all
 * share this trap. The fingerprint classifies them as `'us'`, the
 * effective setting resolves to `'true'`, xterm's `macOptionIsMeta`
 * turns on, and every Option+letter keystroke is silently translated to
 * an Esc+letter readline chord — so typing å, ą, ï, etc., fails with no
 * visible feedback (issue #1205).
 *
 * Plain US Standard is the only layout where Option-as-Meta is the right
 * default: its Option layer carries glyphs (ç, å, ∫) nobody selected that
 * layout to type. US-International-PC is deliberately NOT allowlisted even
 * though Ghostty allowlists it — picking the International variant over US
 * is itself the statement that accented input matters, and its Option layer
 * is a composition layer (Option+C → ç, Option+Shift+C → Ç, Option+A → å,
 * Option+E → dead acute, verified with UCKeyTranslate against the shipped
 * keylayout). Treating it as Meta swallows every one of those keystrokes.
 *
 * When the main-process IPC returns a non-null ID, this classifier is
 * authoritative: `'meta'` → Option-as-Meta is safe; `'compose'` →
 * Option must compose. The fingerprint probe is only consulted when no
 * ID is available (non-Darwin, sandboxed defaults, IPC failure).
 */

/**
 * Input source IDs where Option-as-Meta is the correct default. Every
 * other Apple layout — ABC, Polish Pro, US Extended, ABC Extended,
 * US-International-PC, every international layout, every CJK Roman IME —
 * composes via Option and must stay `'false'`.
 *
 * Matching is case-insensitive full-ID. We deliberately do NOT prefix-
 * match here: `com.apple.keylayout.US` must not silently allowlist
 * `com.apple.keylayout.USExtended`.
 */
const META_INPUT_SOURCE_IDS: readonly string[] = ['com.apple.keylayout.us']

export type InputSourceOverride =
  /** Option-as-Meta is safe on this input source. Resolves to `'us'`
   *  for `effectiveMacOptionAsAlt`. */
  | 'meta'
  /** Option composes layout characters on this input source. Resolves
   *  to `'non-us'` so `macOptionIsMeta` stays off and compositions like
   *  Option+A → å / ą reach the shell. */
  | 'compose'
  /** No macOS input source ID available (non-Darwin, IPC failure,
   *  sandboxed defaults). The caller should fall back to the layout
   *  fingerprint. */
  | 'unknown'

export function classifyInputSourceId(id: string | null | undefined): InputSourceOverride {
  if (!id) {
    return 'unknown'
  }
  const normalized = id.toLowerCase()
  for (const allowed of META_INPUT_SOURCE_IDS) {
    if (normalized === allowed) {
      return 'meta'
    }
  }
  // Why: any other macOS input source ID composes via Option. This
  // includes ABC (not to be confused with US), Polish Pro, US Extended,
  // ABC Extended, US-International-PC, every international layout,
  // Dvorak, Colemak, and every CJK Roman IME. Allowlist-only keeps the
  // #1205-style silent-swallow bug from recurring on any future
  // Apple-shipped layout.
  return 'compose'
}
