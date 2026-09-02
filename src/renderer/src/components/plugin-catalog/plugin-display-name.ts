/** Human title from a dotted plugin key (`example.worktree-notes` → `Worktree Notes`). */
export function pluginDisplayNameFromKey(pluginKey: string): string {
  return pluginKey
    .split('.')
    .at(-1)!
    .split(/[-_]+/)
    .map((word) =>
      word.toLowerCase() === 'orca' ? 'Orca' : `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`
    )
    .join(' ')
}

/** One- or two-letter monogram for plugin avatar tiles. */
export function pluginMonogram(name: string): string {
  const parts = name
    .trim()
    .split(/[\s._-]+/)
    .filter(Boolean)
  if (parts.length === 0) {
    return '?'
  }
  if (parts.length === 1) {
    return parts[0]!.slice(0, 2).toUpperCase()
  }
  return `${parts[0]![0] ?? ''}${parts[1]![0] ?? ''}`.toUpperCase()
}
