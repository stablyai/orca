/** Native walkers count directories, WSL find counts files; derive both and the delete guard from the SKILL.md depth. */
export const SKILL_FILE_MAX_DEPTH = 5
export const PLUGIN_SKILL_FILE_MAX_DEPTH = 10

export function skillFileMaxDepth(sourceKind: 'home' | 'repo' | 'bundled' | 'plugin'): number {
  return sourceKind === 'plugin' ? PLUGIN_SKILL_FILE_MAX_DEPTH : SKILL_FILE_MAX_DEPTH
}

export function skillDirectoryMaxDepth(sourceKind: 'home' | 'repo' | 'bundled' | 'plugin'): number {
  return skillFileMaxDepth(sourceKind) - 1
}
