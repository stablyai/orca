// ABC and US share the standard layout; international variants retain Option composition.
const META_INPUT_SOURCE_IDS: readonly string[] = [
  'com.apple.keylayout.us',
  'com.apple.keylayout.abc'
]

export type InputSourceOverride =
  /** Auto uses Option-as-Meta on this standard input source. Resolves to `'us'`
   *  for `effectiveMacOptionAsAlt`. */
  | 'meta'
  /** Option composes layout characters on this input source. Resolves
   *  to `'non-us'` so `macOptionIsMeta` stays off and compositions like
   *  Option+A → ą reach the shell. */
  | 'compose'
  /** No input source ID available. macOS stays conservative; other
   *  platforms may use the layout fingerprint. */
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
  // International layouts need their Option composition layer, including US-International-PC.
  return 'compose'
}
