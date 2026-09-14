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
 *   yet attempted. It is bounded: a sync that terminates without an answer resolves `none` rather
 *   than refusing forever (see resolveDirectSshAuthority).
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

/** A sync attempt that has stopped without an answer. `unverifiable` is the honest verdict about the
 *  host, but holding it forever is not a verdict — it is a refusal to act, so nothing would ever
 *  lift it. Four paths reach here: local-hydration timeout, a null `remoteWorkspace.get`, a falsy
 *  apply token, and never connecting at all.
 *
 *  Known gap: this floor was reasoned about when hydration was add-only, so "un-hydrated" implied
 *  "the host never answered". A snapshot whose rows could not be placed now revokes hydration
 *  (remote-workspace-snapshot-apply.ts), so a target that later lands on `offline`/`error` reaches
 *  this floor having *demonstrably* answered with tabs. Seeding is then authorised over live host
 *  terminals. That is not a regression — before the revocation existed the same target was marked
 *  hydrated and `synced`, which reached `none` sooner — but the floor should learn to tell a
 *  revoked target from one that never answered. Tracked for the SSH-v3 consolidation, where a
 *  single authoritative liveness source replaces this pair. */
const TERMINATED_WITHOUT_ANSWER_PHASES = new Set(['offline', 'error'])

function resolveDirectSshAuthority(
  state: WorkspaceTerminalHostAuthorityState,
  targetId: string
): WorkspaceTerminalHostAuthority {
  const phase = state.remoteWorkspaceSyncStatusByTargetId?.[targetId]?.phase
  if (state.remoteWorkspaceHydratedTargetIds?.has(targetId)) {
    // Why: the same pair use-app-session-persistence.ts gates uploads on. A conflicting snapshot
    // means the client's picture is not the host's, so it is no basis for deciding the host holds
    // nothing.
    return phase === 'conflict' ? 'unverifiable' : 'none'
  }
  if (phase !== undefined && TERMINATED_WITHOUT_ANSWER_PHASES.has(phase)) {
    // The bounded floor. Without it a single failed sync leaves every git worktree on this target
    // terminal-less and its sleeping agents unresumable for the rest of the app session — strictly
    // worse than the pre-gate behaviour, and only escapable by creating a tab by hand. Declining to
    // seed is meant to be a wait, not a permanent refusal.
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
