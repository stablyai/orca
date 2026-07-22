/**
 * Resolve which terminal tab owns the session agent for a collab session board.
 * Session boards never spawn a second omp — they inject into an existing terminal.
 */

export type SessionAgentTabLike = {
  id: string
  contentType: string
}

/**
 * Pick a terminal tab in the worktree for collab inject.
 * Prefer `preferredTabIds` order (typically recentTabIds, most-recent first),
 * else the first terminal tab in the worktree.
 */
export function resolveSessionAgentTerminalTabId(args: {
  tabs: readonly SessionAgentTabLike[]
  preferredTabIds?: readonly string[]
}): string | null {
  const terminals = args.tabs.filter((t) => t.contentType === 'terminal')
  if (terminals.length === 0) {
    return null
  }
  if (args.preferredTabIds) {
    for (const id of args.preferredTabIds) {
      if (terminals.some((t) => t.id === id)) {
        return id
      }
    }
  }
  return terminals[0]?.id ?? null
}

/**
 * Flatten group recentTabIds into a most-recent-first preference list.
 * Group order is preserved; within each group, recent is reversed so the
 * latest interaction wins.
 */
export function preferredTabIdsFromGroups(
  groups: readonly { recentTabIds?: readonly string[] | null }[]
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const group of groups) {
    const recent = group.recentTabIds ?? []
    for (let i = recent.length - 1; i >= 0; i--) {
      const id = recent[i]
      if (!id || seen.has(id)) continue
      seen.add(id)
      out.push(id)
    }
  }
  return out
}
