import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { parseExecutionHostId, type ExecutionHostId } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { HostLiveTerminalProbeVerdict } from '@/runtime/host-live-terminal-probe'
import type { SshConnectionState } from '../../../shared/ssh-types'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session-environment'
import { resolveExplicitWorktreeOperationRouteResult } from '@/lib/worktree-operation-catalog-route'
import { resolveWorktreeOperationRouteResultForHost } from '@/lib/worktree-operation-route'
import { getPairedWebClientEnvironmentId } from '@/lib/paired-web-client-host'
import {
  findFolderWorkspaceOwner,
  getExplicitRuntimeEnvironmentIdForFolderWorkspace
} from '@/lib/folder-workspace-runtime-owner'
import {
  findIndexedProjectGroupOwner,
  hasIndexedDetectedWorktree
} from '@/lib/worktree-runtime-owner-index'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner-state'

/** Reuse HostLiveTerminalProbeVerdict: live means remote owns creation, unverifiable means owner cannot answer, none means local or connected SSH without host-replaced scope. Unknown must never authorize client seeding or sleeping resume, which duplicate tabs/writers (STA-4658/3500/3498/3374; ssh-execution-boundary.md). */
export type WorkspaceTerminalHostAuthority = HostLiveTerminalProbeVerdict

export type WorkspaceTerminalHostAuthorityState = WorktreeRuntimeOwnerState & {
  sshConnectionStates?: ReadonlyMap<string, SshConnectionState>
}

/** Use connection evidence: managed hosts publish runtime tabs, and ssh: workspace snapshots have no responder after relay removal (#27214). */
function resolveDirectSshAuthority(
  state: WorkspaceTerminalHostAuthorityState,
  targetId: string
): WorkspaceTerminalHostAuthority {
  // Not connected is "we could not ask", never "nothing there".
  return state.sshConnectionStates?.get(targetId)?.status === 'connected' ? 'none' : 'unverifiable'
}

/** Ask who owns terminal creation, not whether this window is a live paired client; host desktop/client windows answered that differently and both seeded (#15556). */
export function resolveWorkspaceTerminalHostAuthority(
  state: WorkspaceTerminalHostAuthorityState,
  worktreeId: string | null | undefined,
  /** The host the caller knows owns the workspace (a create's target), over the active selection. */
  executionHostId?: ExecutionHostId
): WorkspaceTerminalHostAuthority {
  if (!worktreeId || worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return 'none'
  }
  const selectedHost = executionHostId
    ? parseExecutionHostId(executionHostId)
    : state.activeWorktreeId === worktreeId
      ? parseExecutionHostId(state.activeWorkspaceExecutionHostId)
      : null
  const scope = parseWorkspaceKey(worktreeId)
  if (!selectedHost && scope?.type === 'folder') {
    const folderId = scope.folderWorkspaceId
    const owner = findFolderWorkspaceOwner(state, folderId)
    if (!owner && state.folderWorkspaces?.some((folder) => folder.id === folderId)) {
      return 'unverifiable'
    }
    if (
      owner &&
      !owner.executionHostId &&
      !owner.connectionId &&
      state.projectGroups?.some((group) => group.id === owner.projectGroupId) &&
      !findIndexedProjectGroupOwner(state.projectGroups, owner.projectGroupId)
    ) {
      return 'unverifiable'
    }
    const environmentId =
      getExplicitRuntimeEnvironmentIdForFolderWorkspace(state, folderId) ??
      getPairedWebClientEnvironmentId(state)
    // Folder workspaces were never host-replaced, so direct SSH keeps `none`.
    return isWebRuntimeSessionActive(environmentId) ? 'live' : 'none'
  }
  const resolution = selectedHost
    ? resolveWorktreeOperationRouteResultForHost(state, worktreeId, selectedHost.id)
    : resolveExplicitWorktreeOperationRouteResult(state, worktreeId)
  if (
    resolution.kind === 'ambiguous' ||
    (resolution.kind === 'missing' &&
      hasIndexedDetectedWorktree(state.detectedWorktreesByRepo, worktreeId))
  ) {
    return 'unverifiable'
  }
  const route = resolution.kind === 'resolved' ? resolution.route : null
  // A focused runtime routes legacy operations; only owner evidence grants terminal authority.
  if (
    isWebRuntimeSessionActive(route?.runtimeEnvironmentId ?? getPairedWebClientEnvironmentId(state))
  ) {
    return 'live'
  }
  const host = parseExecutionHostId(route?.executionHostId)
  if (host?.kind === 'runtime') {
    return 'unverifiable'
  }
  if (host?.kind === 'ssh' && scope?.type !== 'folder') {
    return resolveDirectSshAuthority(state, host.targetId)
  }
  // Local/out-of-replace-scope clients own their rows; absent catalogs alone prove no remote owner and must not strand unhydrated workspaces.
  return 'none'
}

/** Memoize every catalog/selected-host input; resolving uncached owner indexes on each Zustand write repeats STA-3363, as createConnectionIdForFileSelector avoids. */
const AUTHORITY_INPUT_KEYS = [
  'activeWorktreeId',
  'activeWorkspaceExecutionHostId',
  'detectedWorktreesByRepo',
  'folderWorkspaces',
  'projectGroups',
  'removedRuntimeEnvironmentIds',
  'repos',
  'restoredRuntimeHostIdByWorkspaceSessionKey',
  'runtimeEnvironmentCatalogHydrated',
  'runtimeEnvironments',
  'settings',
  'sshConnectionStates',
  'worktreesByRepo'
] as const satisfies readonly (keyof WorkspaceTerminalHostAuthorityState)[]

/** Check key-list completeness too: satisfies validates membership only, silently missing new inputs and caching stale authority verdicts. */
type MissingAuthorityInputKey = Exclude<
  keyof WorkspaceTerminalHostAuthorityState,
  (typeof AUTHORITY_INPUT_KEYS)[number]
>
/** Require an empty missing-key union; an empty array typed MissingKey[] accepts every union and proves nothing. */
type AssertNoMissingAuthorityInputKey<T extends never> = T
export type AuthorityInputKeysAreComplete =
  AssertNoMissingAuthorityInputKey<MissingAuthorityInputKey>

type AuthorityInputs = readonly unknown[]

function captureAuthorityInputs(state: WorkspaceTerminalHostAuthorityState): AuthorityInputs {
  return AUTHORITY_INPUT_KEYS.map((key) => state[key])
}

export function createWorkspaceTerminalHostAuthoritySelector(
  worktreeId: string | null | undefined
): (state: WorkspaceTerminalHostAuthorityState) => WorkspaceTerminalHostAuthority {
  let previousInputs: AuthorityInputs | null = null
  let previousResult: WorkspaceTerminalHostAuthority = 'none'
  return (state) => {
    const inputs = captureAuthorityInputs(state)
    if (previousInputs?.every((value, index) => value === inputs[index]) === true) {
      return previousResult
    }
    previousInputs = inputs
    previousResult = resolveWorkspaceTerminalHostAuthority(state, worktreeId)
    return previousResult
  }
}
