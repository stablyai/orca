import type { GitStatusEntry } from '../../../../shared/git-status-types'

export type WorktreeChangeSummary = {
  total: number
  staged: number
  unstaged: number
  untracked: number
  submodules: number
}

/**
 * Breaks a workspace's uncommitted entries into the parts the sidebar count is
 * made of. A dirty submodule counts once, as a submodule, and never also as a
 * file — the parts always add up to `total`, which is what the row displays.
 */
export function summarizeWorktreeChanges(
  entries: readonly GitStatusEntry[]
): WorktreeChangeSummary {
  const summary: WorktreeChangeSummary = {
    total: entries.length,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    submodules: 0
  }
  for (const entry of entries) {
    if (entry.submodule) {
      summary.submodules += 1
      continue
    }
    if (entry.area === 'staged') {
      summary.staged += 1
    } else if (entry.area === 'untracked') {
      summary.untracked += 1
    } else {
      summary.unstaged += 1
    }
  }
  return summary
}
