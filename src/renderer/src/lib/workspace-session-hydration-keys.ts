import type { ExecutionHostId } from '../../../shared/execution-host'
import { parseExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceKey, WorkspaceSessionState } from '../../../shared/types'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree-id'

export type WorkspaceSessionHydrationOptions = {
  additionalValidWorkspaceKeys?: readonly WorkspaceKey[]
}

const WORKSPACE_KEYED_SESSION_FIELDS = [
  'tabsByWorktree',
  'openFilesByWorktree',
  'activeFileIdByWorktree',
  'activeBrowserTabIdByWorktree',
  'activeTabTypeByWorktree',
  'activeTabIdByWorktree',
  'browserTabsByWorktree',
  'unifiedTabs',
  'tabGroups',
  'tabGroupLayouts',
  'activeGroupIdByWorktree',
  'lastVisitedAtByWorktreeId',
  'defaultTerminalTabsAppliedByWorktreeId'
] as const satisfies readonly (keyof WorkspaceSessionState)[]

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function addFolderWorkspaceKey(keys: Set<WorkspaceKey>, value: unknown): void {
  if (typeof value !== 'string') {
    return
  }
  const scope = parseWorkspaceKey(value)
  if (scope?.type === 'folder') {
    keys.add(value as WorkspaceKey)
  }
}

export function collectFolderWorkspaceKeysFromSession(
  session: WorkspaceSessionState
): WorkspaceKey[] {
  const keys = new Set<WorkspaceKey>()

  addFolderWorkspaceKey(keys, session.activeWorkspaceKey)
  addFolderWorkspaceKey(keys, session.activeWorktreeId)

  for (const field of WORKSPACE_KEYED_SESSION_FIELDS) {
    const value = session[field]
    if (!isPlainRecord(value)) {
      continue
    }
    for (const key of Object.keys(value)) {
      addFolderWorkspaceKey(keys, key)
    }
  }

  for (const worktreeId of session.activeWorktreeIdsOnShutdown ?? []) {
    addFolderWorkspaceKey(keys, worktreeId)
  }
  for (const pages of Object.values(session.browserPagesByWorkspace ?? {})) {
    if (!Array.isArray(pages)) {
      continue
    }
    for (const page of pages) {
      addFolderWorkspaceKey(keys, page.worktreeId)
    }
  }
  for (const record of Object.values(session.sleepingAgentSessionsByPaneKey ?? {})) {
    addFolderWorkspaceKey(keys, record.worktreeId)
  }

  return [...keys]
}

export function collectWorktreeRecoveryRepoIdsFromSession(
  session: WorkspaceSessionState,
  runtimeHostIdByWorkspaceSessionKey?: Record<string, ExecutionHostId>
): string[] {
  const worktreeIds = new Set<string>()
  const addWorktreeId = (value: unknown): void => {
    if (typeof value !== 'string' || parseWorkspaceKey(value)?.type === 'folder') {
      return
    }
    const scope = parseWorkspaceKey(value)
    const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : value
    if (
      parseExecutionHostId(runtimeHostIdByWorkspaceSessionKey?.[worktreeId])?.kind === 'runtime'
    ) {
      return
    }
    worktreeIds.add(worktreeId)
  }

  const remoteTabIds = new Set(Object.keys(session.remoteSessionIdsByTabId ?? {}))
  const tabsByWorktree = session.tabsByWorktree ?? {}
  const shutdownIds = session.activeWorktreeIdsOnShutdown
  const candidateWorktreeIds = shutdownIds
    ? new Set(shutdownIds)
    : new Set(Object.keys(tabsByWorktree))
  const terminalLayoutsByTabId = session.terminalLayoutsByTabId ?? {}

  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    if (!candidateWorktreeIds.has(worktreeId)) {
      continue
    }
    const hasPersistedSession = tabs.some((tab) => {
      if (tab.ptyId || remoteTabIds.has(tab.id)) {
        return true
      }
      const layout = terminalLayoutsByTabId[tab.id]
      return Object.values(layout?.ptyIdsByLeafId ?? {}).some(Boolean)
    })
    if (hasPersistedSession) {
      addWorktreeId(worktreeId)
    }
  }

  const repoIds = new Set<string>()
  for (const worktreeId of worktreeIds) {
    const repoId = getRepoIdFromWorktreeId(worktreeId)
    if (repoId) {
      repoIds.add(repoId)
    }
  }
  return [...repoIds]
}

export function addAdditionalValidWorkspaceKeys(
  validWorkspaceIds: Set<string>,
  options?: WorkspaceSessionHydrationOptions
): void {
  for (const key of options?.additionalValidWorkspaceKeys ?? []) {
    validWorkspaceIds.add(key)
  }
}
