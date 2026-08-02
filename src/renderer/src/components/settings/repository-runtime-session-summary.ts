import type { AppState } from '../../store/types'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree-id'

export type ProjectRuntimeSessionSummary = {
  liveTerminalCount: number
  activeTaskCount: number
}

type RuntimeSessionSummaryState = Pick<
  AppState,
  'tabsByWorktree' | 'ptyIdsByTabId' | 'agentStatusByPaneKey'
>

function getTabIdFromPaneKey(paneKey: string): string | null {
  const separator = paneKey.indexOf(':')
  return separator > 0 ? paneKey.slice(0, separator) : null
}

export function getProjectRuntimeSessionSummary(
  state: RuntimeSessionSummaryState,
  repoId: string
): ProjectRuntimeSessionSummary {
  const tabWorktreeIds = new Map<string, string>()
  const projectWorktreeIds = new Set<string>()
  let liveTerminalCount = 0

  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    if (getRepoIdFromWorktreeId(worktreeId) !== repoId) {
      continue
    }
    projectWorktreeIds.add(worktreeId)

    for (const tab of tabs) {
      tabWorktreeIds.set(tab.id, worktreeId)
      const livePtyIds = new Set(state.ptyIdsByTabId[tab.id] ?? [])
      if (tab.ptyId) {
        livePtyIds.add(tab.ptyId)
      }
      liveTerminalCount += livePtyIds.size
    }
  }

  let activeTaskCount = 0
  for (const [paneKey, entry] of Object.entries(state.agentStatusByPaneKey)) {
    if (entry.state === 'done') {
      continue
    }
    const tabId = entry.tabId ?? getTabIdFromPaneKey(paneKey)
    const worktreeId = entry.worktreeId ?? (tabId ? tabWorktreeIds.get(tabId) : null)
    if (!worktreeId) {
      continue
    }
    if (projectWorktreeIds.has(worktreeId) || getRepoIdFromWorktreeId(worktreeId) === repoId) {
      activeTaskCount += 1
    }
  }

  return { liveTerminalCount, activeTaskCount }
}
