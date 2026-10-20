import { MARINE_CREATURES } from '../marine-creatures'

/**
 * Pick a creature name for a workspace label that leaves no ASCII behind once
 * sanitized (a name written entirely in CJK, Cyrillic, etc.). Deterministic so
 * the same label always proposes the same branch; two labels landing on one
 * creature are separated by the create loop's existing `-2` collision suffix.
 */
export function creatureNameForUnsanitizableName(input: string): string {
  // FNV-1a: no crypto dependency, and stable across platforms and runs.
  let hash = 0x811c9dc5
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return MARINE_CREATURES[hash % MARINE_CREATURES.length].toLowerCase()
}
