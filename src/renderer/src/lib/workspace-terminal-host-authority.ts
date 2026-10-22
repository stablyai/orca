import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { parseExecutionHostId } from '../../../shared/execution-host'
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

/**
 * Who holds a workspace's terminals right now, in the same three-verdict vocabulary the renderer
 * already uses for host terminal inventory ({@link HostLiveTerminalProbeVerdict}) — aliased rather
 * than restated so the two cannot drift:
 *
 * - `live` — a remote execution host owns terminal creation here. It supplies the surface itself.
 * - `unverifiable` — the workspace has a remote execution host that has not answered for it: a
 *   runtime owner that cannot be named yet, or an SSH target that is not connected.
 * - `none` — no remote host holds terminals here: either the workspace is local (this client *is*
 *   the execution host, and its own tab rows are the whole truth) or its SSH target is connected
 *   and serves no host-side workspace for this row to wait on.
 *
 * `unverifiable` is a verdict, never a synonym for `none`. Two client behaviours read local rows as
 * the verdict on what the host is running, and both are wrong before it answers:
 *
 * - seeding an initial terminal adds one tab per launch (STA-4658) — the snapshot then arrives, the
 *   merge rightly keeps the tab it was never told about, and the union uploads as the new host truth;
 * - resuming a sleeping agent forks a second `claude --resume` onto a transcript the host is still
 *   writing (STA-3500, STA-3498, STA-3374), which no later evidence can undo.
 *
 * See docs/reference/ssh-execution-boundary.md.
 */
export type WorkspaceTerminalHostAuthority = HostLiveTerminalProbeVerdict

export type WorkspaceTerminalHostAuthorityState = WorktreeRuntimeOwnerState & {
  sshConnectionStates?: ReadonlyMap<string, SshConnectionState>
}

/** Why connection, not a host snapshot: managed hosts publish their tabs through runtime
 *  session tabs, and nothing answers a host workspace snapshot for an `ssh:` row since the relay
 *  was removed (#27214). Waiting for one would refuse forever. */
function resolveDirectSshAuthority(
  state: WorkspaceTerminalHostAuthorityState,
  targetId: string
): WorkspaceTerminalHostAuthority {
  // Not connected is "we could not ask", never "nothing there".
  return state.sshConnectionStates?.get(targetId)?.status === 'connected' ? 'none' : 'unverifiable'
}

/**
 * The one host-authority question the seeding and sleeping-agent-resume paths ask, for both remote
 * flavors: does some other party own this workspace's terminals right now?
 *
 * Deliberately an ownership question, not a client-liveness one — the guard it replaces asked "am I
 * a client of a live paired session?", which a host desktop window answers "no" while a paired
 * client answers "yes", so both seeded (#15556).
 */
export function resolveWorkspaceTerminalHostAuthority(
  state: WorkspaceTerminalHostAuthorityState,
  worktreeId: string | null | undefined
): WorkspaceTerminalHostAuthority {
  if (!worktreeId || worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return 'none'
  }
  const selectedHost =
    state.activeWorktreeId === worktreeId
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
  // Local, or outside the host's replace scope: this client is the execution host and its own rows are
  // the whole truth. Absence of a catalog row is not evidence of a remote owner, and refusing to act
  // on it would strand every workspace whose repo has not landed yet.
  return 'none'
}

/**
 * Every slice the resolution above reads. Resolution walks the owner catalogs (and, for an active
 * `ssh:` selection, `worktreesByRepo` uncached via resolveSelectedHostRoute), so a Zustand selector
 * must not run it per store write — STA-3363 is the same shape. Same retained-selector memo as
 * createConnectionIdForFileSelector.
 */
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

/** Completeness, not just membership. The `satisfies` above only proves each listed key EXISTS on
 *  the state; a field added to WorkspaceTerminalHostAuthorityState and forgotten from the list would
 *  type-check while making the memo return a stale verdict — the failure mode is silent and looks
 *  like "the gate did not fire". This assignment fails to compile unless every key is listed. */
type MissingAuthorityInputKey = Exclude<
  keyof WorkspaceTerminalHostAuthorityState,
  (typeof AUTHORITY_INPUT_KEYS)[number]
>
/** Errors with the missing key names when the union is not empty. Deliberately NOT
 *  `const x: MissingAuthorityInputKey[] = []` — an empty array literal is assignable to every array
 *  type, so that spelling passes no matter what is missing. */
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
