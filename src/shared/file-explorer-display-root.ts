export const FILE_EXPLORER_FULL_ROOT = '/'

export function normalizeExplorerDisplayRootByWorktree(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  return Object.fromEntries(
    Object.entries(value).filter(
      ([key, choice]) =>
        key &&
        !['__proto__', 'constructor', 'prototype'].includes(key) &&
        typeof choice === 'string'
    )
  )
}

export function migrateExplorerDisplayRoots(
  saved: unknown,
  migrated: boolean,
  worktreeMeta: Record<string, { sparseDirectories?: string[] }>
): Record<string, string> {
  const choices = normalizeExplorerDisplayRootByWorktree(saved)
  if (!migrated) {
    for (const [id, meta] of Object.entries(worktreeMeta)) {
      if (
        meta?.sparseDirectories?.length &&
        !['__proto__', 'constructor', 'prototype'].includes(id) &&
        choices[id] === undefined
      ) {
        choices[id] = FILE_EXPLORER_FULL_ROOT
      }
    }
  }
  return choices
}
