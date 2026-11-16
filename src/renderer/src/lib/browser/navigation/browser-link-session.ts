import type { AppState } from '@/store/types'
import type { BrowserWorkspace } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import type { ExecutionHostId } from '../../../../../shared/execution-host'
import { LOCAL_EXECUTION_HOST_ID, parseExecutionHostId } from '../../../../../shared/execution-host'
import '../../../../../shared/constants'
import { ORCA_BROWSER_PARTITION } from '../../../../../shared/browser/browser-session-partition'
import { getOrcaProfileBrowserDefaultPartition } from '../../../../../shared/orca-profiles/orca-profiles'
import { resolveNewBrowserTabProfile } from '@/store/slices/browser/profiles/browser-new-tab-profile'

function createPartitionResolver(
  state: AppState,
  hostId: ExecutionHostId
): (profileId: string | null, explicit: string | null | undefined) => string | null {
  const profiles = new Map(
    (state.browserSessionProfilesByHostId[hostId] ?? []).map((profile) => [profile.id, profile])
  )
  const defaultPartition =
    profiles.get('default')?.partition ??
    (hostId === LOCAL_EXECUTION_HOST_ID
      ? ((state.activeOrcaProfileId
          ? getOrcaProfileBrowserDefaultPartition(state.activeOrcaProfileId)
          : null) ?? ORCA_BROWSER_PARTITION)
      : null)
  return (id, explicit) => {
    if (explicit) {
      return explicit
    }
    if (id && !profiles.has(id)) {
      return null
    }
    return (id ? profiles.get(id)?.partition : null) ?? defaultPartition
  }
}

export function resolveBrowserLinkSession(
  state: AppState,
  worktreeId: string,
  hostId: ExecutionHostId
): { sessionProfileId: string | null; sessionPartition: string | null } {
  const profile = resolveNewBrowserTabProfile(state, worktreeId, hostId)
  return {
    sessionProfileId: profile.sessionProfileId,
    sessionPartition: createPartitionResolver(state, hostId)(
      profile.sessionProfileId,
      profile.sessionPartition
    )
  }
}

export function createBrowserLinkSessionMatcher(
  state: AppState,
  hostId: ExecutionHostId,
  profileId: string | null,
  explicitPartition: string | null
): (workspace: BrowserWorkspace) => boolean {
  const partitionFor = createPartitionResolver(state, hostId)
  const expectedPartition = partitionFor(profileId, explicitPartition)
  // The verified SSH route derives a partition from this target and profile even before its list loads.
  const sshProfileRoute = parseExecutionHostId(hostId)?.kind === 'ssh' && explicitPartition === null
  const matchesByWorkspace = new Map<string, boolean>()
  return (workspace) => {
    const cached = matchesByWorkspace.get(workspace.id)
    if (cached !== undefined) {
      return cached
    }
    // Absent legacy metadata does not prove the default session.
    const matches =
      workspace.sessionProfileId !== undefined &&
      workspace.sessionProfileId === profileId &&
      ((expectedPartition !== null &&
        partitionFor(workspace.sessionProfileId, workspace.sessionPartition) ===
          expectedPartition) ||
        (sshProfileRoute && !workspace.sessionPartition))
    matchesByWorkspace.set(workspace.id, matches)
    return matches
  }
}
