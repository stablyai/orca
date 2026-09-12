import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { HostLiveTerminalProbeVerdict } from '@/runtime/host-live-terminal-probe'
import type { RemoteWorkspaceSyncStatus } from '@/store/slices/ssh'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session'
import {
  getExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree,
  type WorktreeRuntimeOwnerState
} from '@/lib/worktree-runtime-owner'

/**
 * Who holds a workspace's terminals right now, in the same three-verdict vocabulary the renderer
 * already uses for host terminal inventory ({@link HostLiveTerminalProbeVerdict}) — aliased rather
 * than restated so the two cannot drift:
 *
 * - `live` — a remote execution host owns terminal creation here. It supplies the surface itself.
 * - `unverifiable` — the workspace has a remote execution host with a sync still in flight or not
 *   yet attempted, or a failed sync. Only a successful hydration can lift that uncertainty.
 * - `none` — no remote host holds terminals here: either the workspace is local (this client *is*
 *   the execution host, and its own tab rows are the whole truth) or the host answered and holds
 *   nothing.
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
  remoteWorkspaceHydratedTargetIds?: ReadonlySet<string>
  remoteWorkspaceSyncStatusByTargetId?: Record<string, RemoteWorkspaceSyncStatus>
}

function resolveDirectSshAuthority(
  state: WorkspaceTerminalHostAuthorityState,
  targetId: string
): WorkspaceTerminalHostAuthority {
  const phase = state.remoteWorkspaceSyncStatusByTargetId?.[targetId]?.phase
  // A failed or conflicting pull cannot establish the host's current inventory.
  if (phase === 'offline' || phase === 'error' || phase === 'conflict') {
    return 'unverifiable'
  }
  if (state.remoteWorkspaceHydratedTargetIds?.has(targetId)) {
    return 'none'
  }

  // Not connected, still pulling, or not yet attempted — "we could not ask", never "nothing there".
  return 'unverifiable'
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
  if (isWebRuntimeSessionActive(getRuntimeEnvironmentIdForWorktree(state, worktreeId))) {
    return 'live'
  }
  const host = parseExecutionHostId(getExecutionHostIdForWorktree(state, worktreeId))
  if (host?.kind === 'runtime') {
    // A runtime host we could not name (rival detected publications, unhydrated catalog) is unasked.
    return 'unverifiable'
  }
  if (host?.kind === 'ssh' && parseWorkspaceKey(worktreeId)?.type !== 'folder') {
    // Why the git-worktree narrowing: the snapshot replaces exactly DirectSshTargetScope.gitWorktreeIds
    // (remote-workspace-snapshot-apply.ts). A folder workspace's rows are never replaced by the host,
    // so waiting on an answer that will never name them would leave it terminal-less for good.
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
  'remoteWorkspaceHydratedTargetIds',
  'remoteWorkspaceSyncStatusByTargetId',
  'removedRuntimeEnvironmentIds',
  'repos',
  'restoredRuntimeHostIdByWorkspaceSessionKey',
  'runtimeEnvironmentCatalogHydrated',
  'runtimeEnvironments',
  'settings',
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
