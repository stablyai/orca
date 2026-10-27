import { readStructuredAgentLaunchRecords } from './agent-session/launch/structured-agent-session-launch-persistence'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { parseExecutionHostId } from '../../../shared/execution-host'
import type { WorkspaceKey } from '../../../shared/folder-workspace-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'

export type WorkspaceSessionHydrationOptions = {
  additionalValidWorkspaceKeys?: readonly WorkspaceKey[]
  replaceWorkspaceKeys?: readonly string[]
}

// Worktree-keyed fields carrying restorable chrome — a repo appears here only if it has live
// session state (open tabs, editors, browser) to restore.
const WORKSPACE_CHROME_SESSION_FIELDS = [
  'tabsByWorktree',
  'openFilesByWorktree',
  'browserTabsByWorktree',
  'unifiedTabs',
  'tabGroups',
  'tabGroupLayouts'
] as const satisfies readonly (keyof WorkspaceSessionState)[]

// Unbounded history maps hydrate unfiltered; scan folder shapes but never enumerate repos from them, or selective startup fetch expands to every historical repo.
const WORKSPACE_HISTORY_SESSION_FIELDS = [
  'lastVisitedAtByWorktreeId',
  'defaultTerminalTabsAppliedByWorktreeId'
] as const satisfies readonly (keyof WorkspaceSessionState)[]

// Why: selection markers can outlive their content and cannot restore anything by themselves.
const WORKSPACE_SELECTION_SESSION_FIELDS = [
  'activeFileIdByWorktree',
  'activeBrowserTabIdByWorktree',
  'activeTabIdByWorktree',
  'activeGroupIdByWorktree',
  'activeTabTypeByWorktree'
] as const satisfies readonly (keyof WorkspaceSessionState)[]

const WORKSPACE_KEYED_SESSION_FIELDS = [
  ...WORKSPACE_CHROME_SESSION_FIELDS,
  ...WORKSPACE_SELECTION_SESSION_FIELDS,
  ...WORKSPACE_HISTORY_SESSION_FIELDS
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

function collectWorkspaceSessionKeys(
  session: WorkspaceSessionState,
  fields: readonly (keyof WorkspaceSessionState)[],
  includeEntry: (value: unknown) => boolean = () => true
): string[] {
  const keys = new Set<string>()
  const addKey = (value: unknown): void => {
    if (typeof value === 'string') {
      keys.add(value)
    }
  }

  addKey(session.activeWorkspaceKey)
  addKey(session.activeWorktreeId)
  for (const field of fields) {
    const value = session[field]
    if (!isPlainRecord(value)) {
      continue
    }
    for (const [key, entry] of Object.entries(value)) {
      if (includeEntry(entry)) {
        addKey(key)
      }
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

function hasRestorableWorkspaceChrome(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0
  }
  if (isPlainRecord(value)) {
    return Object.keys(value).length > 0
  }
  return value !== null && value !== undefined && value !== ''
}

export function collectFolderWorkspaceKeysFromSession(
  session: WorkspaceSessionState
): WorkspaceKey[] {
  const keys = new Set<WorkspaceKey>()
  for (const key of collectWorkspaceSessionKeys(session, WORKSPACE_KEYED_SESSION_FIELDS)) {
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

  // Enumerate repos only from restorable chrome, never unbounded history that hydrates unfiltered.
  for (const key of collectWorkspaceSessionKeys(
    session,
    WORKSPACE_CHROME_SESSION_FIELDS,
    hasRestorableWorkspaceChrome
  )) {
    addWorktreeRepoId(key)
  }
  // activeRepoId alone still needs enumeration so hydration can restore its main worktree.
  addWorktreeRepoId(session.activeRepoId)
  for (const record of readStructuredAgentLaunchRecords()) {
    if (record.executionHostId === 'local' && record.surfaceAddress) {
      addWorktreeRepoId(record.surfaceAddress.worktreeId)
    }
  }

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
