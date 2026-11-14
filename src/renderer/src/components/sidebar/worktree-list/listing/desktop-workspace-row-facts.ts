import { isWorktreeRetiredByRemoval } from '../../../../../../shared/worktree/removal/removal-visibility'
import {
  getWorktreeExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { Repo } from '../../../../../../shared/repo-types'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import type { WorkspaceRowFactReader } from '../../../../../../shared/workspace-view/workspace-row-filters'
import {
  isAutomationGeneratedWorkspace,
  isCliCreatedWorkspace,
  isDefaultBranchWorkspace,
  isDetachedHeadWorkspace
} from '../../../../../../shared/worktree/visibility/workspace-kinds'
import { isWorkspaceOwnedBySomeoneElse } from '../../../../../../shared/workspace-creator-visibility'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  hiddenProjectRowFacts,
  type HiddenProjects
} from '../../../../../../shared/hidden-projects'
import { isInactiveWorkspace } from '@/lib/workspace/activity/worktree-activity-state'

export type DesktopWorkspaceRowFactInputs = {
  repoMap: ReadonlyMap<string, Repo>
  /** indexHiddenProjects over every repo row; repoMap keeps one row per id. */
  hiddenProjects: HiddenProjects
  defaultHostId: ExecutionHostId
  pairedDeviceIdsByEnvironment: ReadonlyMap<string, string>
  tabsByWorktree: Record<string, Pick<TerminalTab, 'id'>[]> | null
  ptyIdsByTabId: Record<string, string[]> | null
  browserTabsByWorktree?: Record<string, { id: string }[]> | null
  worktreeIdsWithLiveAgent: ReadonlySet<string>
  worktreeIdsWithStructuredChat?: ReadonlySet<string>
  /** Rows in a PTY-rebind grace window; read as unverifiable, never as asleep (#15996). */
  sleepingSweepExemptWorktreeIds?: ReadonlySet<string>
}

export function buildDesktopWorkspaceRowFactReader(
  inputs: DesktopWorkspaceRowFactInputs
): WorkspaceRowFactReader<Worktree> {
  const hostId = (worktree: Worktree): ExecutionHostId | null => {
    const repo = inputs.repoMap.get(worktree.repoId)
    return repo ? getWorktreeExecutionHostId(worktree, repo, inputs.defaultHostId) : null
  }
  return {
    isArchived: (worktree) => worktree.isArchived || isWorktreeRetiredByRemoval(worktree),
    ...hiddenProjectRowFacts(inputs.hiddenProjects),
    isFolderWorkspace: (worktree) => parseWorkspaceKey(worktree.id)?.type === 'folder',
    repoId: (worktree) => worktree.repoId,
    hostId,
    isOtherClient: (worktree) =>
      isWorkspaceOwnedBySomeoneElse(worktree, inputs.pairedDeviceIdsByEnvironment),
    isDefaultBranch: (worktree) =>
      isDefaultBranchWorkspace(worktree, inputs.repoMap.get(worktree.repoId)),
    isAutomationCreated: isAutomationGeneratedWorkspace,
    isCliCreated: isCliCreatedWorkspace,
    isDetachedHead: isDetachedHeadWorkspace,
    isMainWorktree: (worktree) => worktree.isMainWorktree,
    isSleeping: (worktree) =>
      inputs.sleepingSweepExemptWorktreeIds?.has(worktree.id) !== true &&
      isInactiveWorkspace(
        worktree.id,
        inputs.tabsByWorktree,
        inputs.ptyIdsByTabId,
        inputs.browserTabsByWorktree,
        inputs.worktreeIdsWithLiveAgent,
        inputs.worktreeIdsWithStructuredChat
      )
  }
}
