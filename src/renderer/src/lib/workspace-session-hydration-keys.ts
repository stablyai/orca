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

function collectWorkspaceSessionKeys(session: WorkspaceSessionState): string[] {
  const keys = new Set<string>()
  const addKey = (value: unknown): void => {
    if (typeof value === 'string') {
      keys.add(value)
    }
  }

  addKey(session.activeWorkspaceKey)
  addKey(session.activeWorktreeId)
  for (const field of WORKSPACE_KEYED_SESSION_FIELDS) {
    const value = session[field]
    if (!isPlainRecord(value)) {
      continue
    }
    for (const key of Object.keys(value)) {
      addKey(key)
    }
  }
  for (const worktreeId of session.activeWorktreeIdsOnShutdown ?? []) {
    addKey(worktreeId)
  }
  for (const pages of Object.values(session.browserPagesByWorkspace ?? {})) {
    if (!Array.isArray(pages)) {
      continue
    }
    for (const page of pages) {
      addKey(page.worktreeId)
    }
  }
  for (const record of Object.values(session.sleepingAgentSessionsByPaneKey ?? {})) {
    addKey(record.worktreeId)
  }

  return [...keys]
}

export function collectFolderWorkspaceKeysFromSession(
  session: WorkspaceSessionState
): WorkspaceKey[] {
  const keys = new Set<WorkspaceKey>()
  for (const key of collectWorkspaceSessionKeys(session)) {
    addFolderWorkspaceKey(keys, key)
  }

  return [...keys]
}

export function collectWorktreeHydrationRepoIdsFromSession(
  session: WorkspaceSessionState,
  runtimeHostIdByWorkspaceSessionKey?: Record<string, ExecutionHostId>
): string[] {
  const repoIds = new Set<string>()
  const addWorktreeRepoId = (value: unknown): void => {
    if (typeof value !== 'string') {
      return
    }
    const scope = parseWorkspaceKey(value)
    if (scope?.type === 'folder') {
      return
    }
    const rawWorktreeId = scope?.type === 'worktree' ? scope.worktreeId : value
    const isRuntimeOwned = [value, rawWorktreeId].some(
      (key) => parseExecutionHostId(runtimeHostIdByWorkspaceSessionKey?.[key])?.kind === 'runtime'
    )
    if (!isRuntimeOwned) {
      repoIds.add(getRepoIdFromWorktreeId(rawWorktreeId))
    }
  }

  for (const key of collectWorkspaceSessionKeys(session)) {
    addWorktreeRepoId(key)
  }
  // Why: a repo referenced only by activeRepoId (no active worktree, no tabs) still needs
  // enumeration so hydrateWorkspaceSession can restore its main worktree from worktreesByRepo.
  addWorktreeRepoId(session.activeRepoId)

  return [...repoIds].filter(Boolean).sort()
}

export function addAdditionalValidWorkspaceKeys(
  validWorkspaceIds: Set<string>,
  options?: WorkspaceSessionHydrationOptions
): void {
  for (const key of options?.additionalValidWorkspaceKeys ?? []) {
    validWorkspaceIds.add(key)
  }
}
