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
