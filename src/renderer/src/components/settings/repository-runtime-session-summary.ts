import type { AppState } from '../../store/types'
import { getRepoIdFromWorktreeId } from '../../../../shared/worktree/id'
import { getTabIdToWorktreeId } from '../sidebar/worktree-agent-row-selectors'

export type ProjectRuntimeSessionSummary = {
  liveTerminalCount: number
  activeTaskCount: number
}

type RuntimeSessionSummaryState = Pick<
  AppState,
  'tabsByWorktree' | 'ptyIdsByTabId' | 'agentStatusByPaneKey'
>

type SessionSummaryCache = {
  ptyIdsByTabId: AppState['ptyIdsByTabId']
  agentStatusByPaneKey: AppState['agentStatusByPaneKey']
  byRepoId: Map<string, ProjectRuntimeSessionSummary>
}

// Why: one RepositoryPane per project reruns this on every store write, and each
// run walked every worktree bucket plus every agent-status pane. Key on the three
// input slices so unrelated writes reuse the answer instead of rescanning.
const sessionSummaryCache = new WeakMap<AppState['tabsByWorktree'], SessionSummaryCache>()

function getTabIdFromPaneKey(paneKey: string): string | null {
  const separator = paneKey.indexOf(':')
  return separator > 0 ? paneKey.slice(0, separator) : null
}

function computeProjectRuntimeSessionSummary(
  state: RuntimeSessionSummaryState,
  repoId: string
): ProjectRuntimeSessionSummary {
  const projectWorktreeIds = new Set<string>()
  let liveTerminalCount = 0

  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    if (getRepoIdFromWorktreeId(worktreeId) !== repoId) {
      continue
    }
    projectWorktreeIds.add(worktreeId)

    for (const tab of tabs) {
      const livePtyIds = new Set(state.ptyIdsByTabId[tab.id] ?? [])
      if (tab.ptyId) {
        livePtyIds.add(tab.ptyId)
      }
      liveTerminalCount += livePtyIds.size
    }
  }

  // Rows outside this project resolve to a worktree the checks below reject, so
  // the shared index answers the same question the repo-scoped map used to.
  const tabWorktreeIds = getTabIdToWorktreeId(state.tabsByWorktree)
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

export function getProjectRuntimeSessionSummary(
  state: RuntimeSessionSummaryState,
  repoId: string
): ProjectRuntimeSessionSummary {
  let cache = sessionSummaryCache.get(state.tabsByWorktree)
  if (
    !cache ||
    cache.ptyIdsByTabId !== state.ptyIdsByTabId ||
    cache.agentStatusByPaneKey !== state.agentStatusByPaneKey
  ) {
    cache = {
      ptyIdsByTabId: state.ptyIdsByTabId,
      agentStatusByPaneKey: state.agentStatusByPaneKey,
      byRepoId: new Map()
    }
    sessionSummaryCache.set(state.tabsByWorktree, cache)
  }
  const cached = cache.byRepoId.get(repoId)
  if (cached) {
    return cached
  }
  const summary = computeProjectRuntimeSessionSummary(state, repoId)
  cache.byRepoId.set(repoId, summary)
  return summary
}
