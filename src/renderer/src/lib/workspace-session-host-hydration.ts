import type { Repo } from '../../../shared/repo-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import {
  mergeWorkspaceSessionsWithHostShadow,
  normalizeWorkspaceSessionKeyToWorktreeId
} from './workspace-session-host-contention'
import { nonLocalHostSessionEntries, type HostSessionSlices } from './workspace-session-host-split'

type SessionReadApi = {
  get: (hostId?: ExecutionHostId) => Promise<WorkspaceSessionState>
}

export type WorkspaceSessionHostRead = {
  session: WorkspaceSessionState
  runtimeHostIdByWorkspaceSessionKey: Record<string, ExecutionHostId>
  contestedHostWorkspaceSessions: HostSessionSlices
  contestedPrimaryHostBySessionKey: Record<string, ExecutionHostId>
}

const WORKSPACE_SESSION_KEYED_FIELDS = [
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

function addWorkspaceSessionKeyForOwnerMap(ids: Set<string>, value: unknown): void {
  if (typeof value === 'string') {
    ids.add(normalizeWorkspaceSessionKeyToWorktreeId(value))
  }
}

function collectWorkspaceSessionKeysFromHostSession(session: WorkspaceSessionState): string[] {
  const ids = new Set<string>()
  for (const field of WORKSPACE_SESSION_KEYED_FIELDS) {
    const value = session[field]
    if (isPlainRecord(value)) {
      for (const id of Object.keys(value)) {
        addWorkspaceSessionKeyForOwnerMap(ids, id)
      }
    }
  }
  for (const id of session.activeWorktreeIdsOnShutdown ?? []) {
    addWorkspaceSessionKeyForOwnerMap(ids, id)
  }
  for (const pages of Object.values(session.browserPagesByWorkspace ?? {})) {
    if (!Array.isArray(pages)) {
      continue
    }
    for (const page of pages) {
      addWorkspaceSessionKeyForOwnerMap(ids, page.worktreeId)
    }
  }
  for (const record of Object.values(session.sleepingAgentSessionsByPaneKey ?? {})) {
    // Why: a hibernated agent can be the only restored session evidence for a
    // runtime worktree before its remote catalog answers.
    addWorkspaceSessionKeyForOwnerMap(ids, record.worktreeId)
  }
  return [...ids]
}

function buildRuntimeHostIdByWorkspaceSessionKey(
  slices: HostSessionSlices
): Record<string, ExecutionHostId> {
  const owners: Record<string, ExecutionHostId> = {}
  const ambiguous = new Set<string>()
  for (const [hostId, slice] of nonLocalHostSessionEntries(slices)) {
    for (const worktreeId of collectWorkspaceSessionKeysFromHostSession(slice)) {
      if (owners[worktreeId] && owners[worktreeId] !== hostId) {
        ambiguous.add(worktreeId)
        delete owners[worktreeId]
      } else if (!ambiguous.has(worktreeId)) {
        owners[worktreeId] = hostId
      }
    }
  }
  return owners
}

/** Collect the distinct runtime hosts owning any persisted repo. */
export function listKnownRuntimeHostIds(
  repos: readonly Pick<Repo, 'connectionId' | 'executionHostId'>[]
): ExecutionHostId[] {
  const hostIds = new Set<ExecutionHostId>()
  for (const repo of repos) {
    const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
    if (parsed?.kind === 'runtime') {
      hostIds.add(parsed.id)
    }
  }
  return [...hostIds]
}

/** Boot-time hydration: fetch the local partition plus one partition per known
 *  runtime host (from loaded repos and saved runtime ids), then merge them into
 *  the unified session the hydrators expect.
 *
 *  Fail-soft: a partition whose fetch rejects is skipped — boot proceeds with
 *  the rest. Corrupt partitions never reach here; persistence zod-validates
 *  each one and falls back to defaults on the main side. */
export async function fetchWorkspaceSessionFromHosts(
  api: SessionReadApi,
  repos: readonly Pick<Repo, 'connectionId' | 'executionHostId'>[],
  additionalRuntimeHostIds: readonly ExecutionHostId[] = []
): Promise<WorkspaceSessionState> {
  return (await fetchWorkspaceSessionWithRuntimeHostOwners(api, repos, additionalRuntimeHostIds))
    .session
}

export async function fetchWorkspaceSessionWithRuntimeHostOwners(
  api: SessionReadApi,
  repos: readonly Pick<Repo, 'connectionId' | 'executionHostId'>[],
  additionalRuntimeHostIds: readonly ExecutionHostId[] = []
): Promise<WorkspaceSessionHostRead> {
  const slices: HostSessionSlices = {
    [LOCAL_EXECUTION_HOST_ID]: await api.get()
  }
  // Why: startup can know saved runtime session hosts before their repo
  // catalogs hydrate, so include those partitions in the first read.
  const runtimeHostIds = new Set<ExecutionHostId>([
    ...listKnownRuntimeHostIds(repos),
    ...additionalRuntimeHostIds
  ])
  await Promise.all(
    [...runtimeHostIds].map(async (hostId) => {
      try {
        slices[hostId] = await api.get(hostId)
      } catch (err) {
        console.warn(`[session] skipping unreadable host partition ${hostId}:`, err)
      }
    })
  )
  const merged = mergeWorkspaceSessionsWithHostShadow(slices)
  return {
    session: merged.session,
    // Why the merged slices and not the raw ones: a row parked out of the renderer session must not
    // still name its host as the owner, or startup builds runtime placeholders for a local row.
    runtimeHostIdByWorkspaceSessionKey: buildRuntimeHostIdByWorkspaceSessionKey(merged.slices),
    contestedHostWorkspaceSessions: merged.shadow,
    contestedPrimaryHostBySessionKey: merged.primaryHostBySessionKey
  }
}
