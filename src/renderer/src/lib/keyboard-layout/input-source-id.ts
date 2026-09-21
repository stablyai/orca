// The base-layer probe cannot distinguish US from layouts whose Option layer composes text.
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
  // International layouts need their Option composition layer, including US-International-PC.
  return 'compose'
}
