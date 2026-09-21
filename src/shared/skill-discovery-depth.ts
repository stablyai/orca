/**
 * One source for how deep a skill file may sit below a discovery root.
 *
 * Why one constant for two numbers: the native walker bounds *directories* and
 * WSL's `find -maxdepth` bounds the *file*, so the two spellings drifted apart
 * historically. Expressing the limit on the `SKILL.md` path and deriving the
 * directory bound from it keeps native, WSL, and the delete guard on one number.
 */
export const SKILL_FILE_MAX_DEPTH = 5
export const PLUGIN_SKILL_FILE_MAX_DEPTH = 10

export function skillFileMaxDepth(sourceKind: 'home' | 'repo' | 'bundled' | 'plugin'): number {
  return sourceKind === 'plugin' ? PLUGIN_SKILL_FILE_MAX_DEPTH : SKILL_FILE_MAX_DEPTH
}

/** The directory the walker may still descend into — one level above the file. */
export function skillDirectoryMaxDepth(sourceKind: 'home' | 'repo' | 'bundled' | 'plugin'): number {
  return skillFileMaxDepth(sourceKind) - 1
}
