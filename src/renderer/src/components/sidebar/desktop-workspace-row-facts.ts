import { getWorktreeExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { WorkspaceRowFactReader } from '../../../../shared/workspace-view/workspace-row-filters'
import {
  isAutomationGeneratedWorkspace,
  isCliCreatedWorkspace,
  isDefaultBranchWorkspace,
  isDetachedHeadWorkspace
} from '../../../../shared/worktree/workspace-kinds'
import { isWorkspaceOwnedBySomeoneElse } from '../../../../shared/workspace-creator-visibility'
import { parseWorkspaceKey } from '../../../../shared/workspace-scope'
import type { Worktree } from '../../../../shared/worktree/types'
import { isInactiveWorkspace } from '@/lib/worktree-activity-state'

export type DesktopWorkspaceRowFactInputs = {
  repoMap: ReadonlyMap<string, Repo>
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
  return {
    isArchived: (worktree) => worktree.isArchived,
    isFolderWorkspace: (worktree) => parseWorkspaceKey(worktree.id)?.type === 'folder',
    repoId: (worktree) => worktree.repoId,
    hostId: (worktree) => {
      const repo = inputs.repoMap.get(worktree.repoId)
      return repo ? getWorktreeExecutionHostId(worktree, repo, inputs.defaultHostId) : null
    },
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
