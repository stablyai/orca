import type { Repo } from '../../../../shared/repo-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { FilterAgentIds } from '../../../../shared/workspace-agent-filter'
import type { WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { ExecutionHostId, ExecutionHostScope } from '../../../../shared/execution-host'

export type VisibleWorktreeOptions = {
  filterRepoIds: readonly string[]
  showSleepingWorkspaces: boolean
  tabsByWorktree: Record<string, Pick<TerminalTab, 'id'>[]> | null
  ptyIdsByTabId: Record<string, string[]> | null
  browserTabsByWorktree?: Record<string, { id: string }[]> | null
  worktreeIdsWithLiveAgent: ReadonlySet<string>
  hideDefaultBranchWorkspace: boolean
  hideAutomationGeneratedWorkspaces: boolean
  hideCliCreatedWorkspaces: boolean
  hideDetachedHeadWorkspaces: boolean
  hideWorkspacesFromOtherDevices: boolean
  pairedDeviceIdsByEnvironment: ReadonlyMap<string, string>
  alwaysShowDefaultBranchWorkspace?: boolean
  filterAgentIds: FilterAgentIds
  agentTypesByWorktree?: Record<string, readonly (string | null | undefined)[]> | null
  repoMap: Map<string, Repo>
  workspaceHostScope: ExecutionHostScope
  visibleWorkspaceHostIds?: readonly ExecutionHostId[] | null
  defaultHostId: ExecutionHostId
  worktreeLineageById: Record<string, WorktreeLineage>
  injectLineageAncestors?: boolean
  forcedVisibleWorktreeIds?: readonly string[]
}
