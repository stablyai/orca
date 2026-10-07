import type { Automation } from './automations-types'
import type { PersistedState } from './persisted-state-types'
import { getAutomationRunRepoId } from './automation-run-identity'
import { parseWorkspaceKey } from './workspace-scope'
import { splitWorktreeIdForFilesystem } from './worktree/id'
import { resolveFolderWorkspaceHost } from './folder-workspace-execution-host'

export type AutomationWorkspaceRecoveryTarget =
  | { kind: 'worktree'; baseBranch: string | null }
  | {
      kind: 'folder'
      projectGroupId: string
      folderPath: string
      connectionId: string | null
    }

export function captureAutomationWorkspaceRecoveryTarget(
  state: Pick<PersistedState, 'folderWorkspaces' | 'worktreeMeta' | 'repos' | 'projectGroups'>,
  workspaceId: string | null
): AutomationWorkspaceRecoveryTarget | null {
  if (!workspaceId) {
    return null
  }
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type === 'folder') {
    const folder = state.folderWorkspaces.find((entry) => entry.id === scope.folderWorkspaceId)
    const host = resolveFolderWorkspaceHost(state, scope.folderWorkspaceId)
    if (host.kind === 'ambiguous' || host.kind === 'missing') {
      return null
    }
    return folder
      ? {
          kind: 'folder',
          projectGroupId: folder.projectGroupId,
          folderPath: folder.folderPath,
          connectionId: host.kind === 'ssh' ? host.targetId : null
        }
      : null
  }
  const id = scope?.type === 'worktree' ? scope.worktreeId : workspaceId
  return splitWorktreeIdForFilesystem(id)
    ? { kind: 'worktree', baseBranch: state.worktreeMeta[id]?.baseRef ?? null }
    : null
}

export function getAutomationWorkspaceRecoveryTarget(
  automation: Automation
): AutomationWorkspaceRecoveryTarget | null {
  if (automation.workspaceMode !== 'existing' || !automation.workspaceId) {
    return null
  }
  const scope = parseWorkspaceKey(automation.workspaceId)
  if (scope?.type === 'folder') {
    return automation.workspaceRecovery?.kind === 'folder' ? automation.workspaceRecovery : null
  }
  const parsed = splitWorktreeIdForFilesystem(
    scope?.type === 'worktree' ? scope.worktreeId : automation.workspaceId
  )
  if (!parsed || parsed.repoId !== getAutomationRunRepoId(automation)) {
    return null
  }
  return automation.workspaceRecovery?.kind === 'worktree'
    ? automation.workspaceRecovery
    : { kind: 'worktree', baseBranch: automation.baseBranch ?? null }
}
