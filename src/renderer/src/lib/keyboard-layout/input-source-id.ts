// ABC and US share the standard layout; international variants retain Option composition.
const META_INPUT_SOURCE_IDS: readonly string[] = [
  'com.apple.keylayout.us',
  'com.apple.keylayout.abc'
]

export type InputSourceOverride =
  /** Standard source permits Option-as-Meta (us). */
  | 'meta'
  /** Composition source keeps Option text and maps to non-us. */
  | 'compose'
  /** Missing native identity stays conservative on macOS; other platforms may use browser fingerprints. */
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
