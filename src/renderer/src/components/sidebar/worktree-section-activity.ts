import type { AppState } from '@/store/types'
import { resolveWorktreeStatus } from '@/lib/worktree-status'
import type {
  ProjectGroup,
  Repo,
  TerminalPaneLayoutNode,
  TerminalTab,
  Worktree,
  WorkspaceStatusDefinition
} from '../../../../shared/types'
import {
  getGroupKeysForWorktree,
  type WorktreeGroupBy,
  PINNED_GROUP_KEY
} from './worktree-list-groups'
import {
  selectLivePtyIdsForWorktree,
  selectRuntimePaneTitlesForWorktree
} from './worktree-card-status-inputs'
import { selectWorktreeAgentActivitySummary } from './worktree-agent-activity-summary'
import { selectHasRateLimitedForWorktree } from '@/store/slices/auto-resume'
import type { BrowserActivityTab } from './visible-worktree-activity-inputs'

export type WorktreeSectionActivityState = Pick<
  AppState,
  | 'ptyIdsByTabId'
  | 'runtimePaneTitlesByTabId'
  | 'agentStatusEpoch'
  | 'agentStatusByPaneKey'
  | 'migrationUnsupportedByPtyId'
  | 'retainedAgentsByPaneKey'
  | 'autoResumeEntries'
> & {
  tabsByWorktree: Record<string, readonly Pick<TerminalTab, 'id' | 'title'>[]>
  browserTabsByWorktree: Record<string, readonly BrowserActivityTab[]>
  terminalLayoutRootsByTabId: Record<string, TerminalPaneLayoutNode | null | undefined>
}

export type WorktreeSectionActivitySummary = {
  runningCount: number
}

export const EMPTY_WORKTREE_SECTION_ACTIVITY: WorktreeSectionActivitySummary = {
  runningCount: 0
}

export function buildWorktreeSectionActivitySummaries({
  groupBy,
  worktrees,
  repoMap,
  prCache,
  workspaceStatuses,
  settings,
  projectGroups,
  state
}: {
  groupBy: WorktreeGroupBy
  worktrees: readonly Worktree[]
  repoMap: Map<string, Repo>
  prCache: Record<string, unknown> | null
  workspaceStatuses: readonly WorkspaceStatusDefinition[]
  settings?: AppState['settings']
  projectGroups: readonly ProjectGroup[]
  state: WorktreeSectionActivityState
}): Map<string, WorktreeSectionActivitySummary> {
  const summaries = new Map<string, WorktreeSectionActivitySummary>()

  for (const worktree of worktrees) {
    const groupKeys = [
      ...(worktree.isPinned ? [PINNED_GROUP_KEY] : []),
      ...getGroupKeysForWorktree(
        groupBy,
        worktree,
        repoMap,
        prCache,
        workspaceStatuses,
        settings,
        projectGroups
      )
    ]
    if (groupKeys.length === 0) {
      continue
    }

    const status = getSectionWorktreeStatus(state, worktree.id)
    for (const groupKey of groupKeys) {
      const summary = summaries.get(groupKey) ?? { ...EMPTY_WORKTREE_SECTION_ACTIVITY }
      if (status === 'working') {
        summary.runningCount++
      }
      summaries.set(groupKey, summary)
    }
  }

  return summaries
}

function getSectionWorktreeStatus(
  state: WorktreeSectionActivityState,
  worktreeId: string
): ReturnType<typeof resolveWorktreeStatus> {
  const agentSummary = selectWorktreeAgentActivitySummary(state, worktreeId)

  // Why: collapsed headers must mirror the card dot semantics exactly; otherwise
  // a hidden section can advertise different activity than its visible cards.
  return resolveWorktreeStatus({
    tabs: state.tabsByWorktree[worktreeId] ?? [],
    browserTabs: state.browserTabsByWorktree[worktreeId] ?? [],
    ptyIdsByTabId: selectLivePtyIdsForWorktree(state, worktreeId),
    runtimePaneTitlesByTabId: selectRuntimePaneTitlesForWorktree(state, worktreeId),
    agentStatusPaneIdsByTabId: agentSummary.agentStatusPaneIdsByTabId,
    terminalLayoutRootsByTabId: state.terminalLayoutRootsByTabId,
    hasPermission: agentSummary.hasPermission,
    hasLiveWorking: agentSummary.hasLiveWorking,
    hasLiveDone: agentSummary.hasLiveDone,
    hasRetainedDone: agentSummary.hasRetainedDone,
    hasRateLimited: selectHasRateLimitedForWorktree(state, worktreeId)
  })
}
