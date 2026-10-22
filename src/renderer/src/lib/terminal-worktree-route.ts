import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { isEphemeralSetupTerminalWorktreeId } from '../../../shared/ephemeral-setup-terminal-worktree-id'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { AppState } from '@/store/types'
import { resolveOwnerWithLegacyFallback } from './worktree-runtime-owner'
import { namedHostForOwnerRef, runtimeEnvironmentIdUnlessTwin } from './resolve-owner'
import type { WorktreeRuntimeOwnerState } from './worktree-runtime-owner-state'
import {
  resolveWorktreeOperationRouteResultForHost,
  resolveWorktreeOperationRouteResult,
  type WorktreeOperationRouteResolution
} from './worktree-operation-route'
import { getSingleFocusedRuntimeEnvironmentId } from './single-runtime-legacy-owner'
import {
  hasIndexedDetectedWorktree,
  resolveIndexedRepoOwner,
  resolveIndexedWorktreeOwner
} from './worktree-runtime-owner-index'

export type TerminalWorktreeRoute = {
  runtimeEnvironmentId: string | null
}

/**
 * Which host owns a terminal surface. Spawn and teardown both resolve it here so they can never
 * disagree about whether an id is routable — #9994 fixed spawn only, and STA-2639 was the teardown
 * half of that same asymmetry.
 */
export type TerminalHostOwnership =
  | { kind: 'local-or-ssh'; runtimeEnvironmentId: null }
  | { kind: 'runtime'; runtimeEnvironmentId: string }
  | { kind: 'unresolved'; runtimeEnvironmentId: null }

/**
 * `spawn` asks which host should start a new process, so a setup terminal may follow the focused
 * runtime. `teardown` asks which provider can kill an existing one, where that guess strands the
 * local PTY the surface was actually spawned on.
 */
export type TerminalHostOwnershipPurpose = 'spawn' | 'teardown'

const UNRESOLVED_TERMINAL_HOST: TerminalHostOwnership = {
  kind: 'unresolved',
  runtimeEnvironmentId: null
}
const LOCAL_OR_SSH_TERMINAL_HOST: TerminalHostOwnership = {
  kind: 'local-or-ssh',
  runtimeEnvironmentId: null
}

function ownershipForRuntimeEnvironmentId(
  runtimeEnvironmentId: string | null
): TerminalHostOwnership {
  return runtimeEnvironmentId
    ? { kind: 'runtime', runtimeEnvironmentId }
    : LOCAL_OR_SSH_TERMINAL_HOST
}

export function resolveTerminalHostOwnership(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string | null | undefined,
  purpose: TerminalHostOwnershipPurpose
): TerminalHostOwnership {
  if (!worktreeId) {
    // Why: a tab with no owning row proves nothing about its host, so teardown cannot claim its PTY.
    return purpose === 'teardown' ? UNRESOLVED_TERMINAL_HOST : LOCAL_OR_SSH_TERMINAL_HOST
  }
  if (
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID ||
    parseWorkspaceKey(worktreeId)?.type === 'folder'
  ) {
    const owner = resolveOwnerWithLegacyFallback(state, { workspaceId: worktreeId })
    if (owner.kind !== 'resolved') {
      // Why: spawn must not pick a twin; a twin's runtime PTYs carry `remote:` ids, so a raw id is
      // local or SSH on either copy.
      return purpose === 'spawn' ? UNRESOLVED_TERMINAL_HOST : LOCAL_OR_SSH_TERMINAL_HOST
    }
    const { endpoint } = owner.owner
    return resolveFloatingScopeOwnership(
      state,
      worktreeId,
      purpose,
      endpoint.kind === 'environment' ? endpoint.environmentId : null
    )
  }
  // Why: inline setup/onboarding terminals (skill installs, feature tips) have no worktree row,
  // so the strict owner resolver reports them as an unresolved cross-host worktree. Scope them to
  // the active runtime — so a remote skill install lands on that runtime — falling back to local
  // when none is focused, instead of failing them closed.
  if (isEphemeralSetupTerminalWorktreeId(worktreeId)) {
    return resolveFloatingScopeOwnership(
      state,
      worktreeId,
      purpose,
      getSingleFocusedRuntimeEnvironmentId(state)
    )
  }
  const resolution = resolveGitWorktreeRoute(state, worktreeId)
  if (resolution.kind === 'resolved') {
    if (resolution.route.runtimeEnvironmentId) {
      // Why: a real worktree row keeps its runtime owner on teardown. Unlike the host-agnostic
      // surfaces above, its HUB-native wake hints are `ssh:`-shaped rather than `remote:`-prefixed,
      // so downgrading to local here would kill a paired-client PTY that lives on the HUB (#9994).
      return { kind: 'runtime', runtimeEnvironmentId: resolution.route.runtimeEnvironmentId }
    }
    const parsed = parseExecutionHostId(resolution.route.executionHostId)
    return parsed?.kind === 'local' || parsed?.kind === 'ssh'
      ? LOCAL_OR_SSH_TERMINAL_HOST
      : UNRESOLVED_TERMINAL_HOST
  }
  if (
    purpose === 'spawn' &&
    state.worktreesByRepo === undefined &&
    state.detectedWorktreesByRepo === undefined &&
    state.repos === undefined
  ) {
    // Why: narrow unit/legacy adapters can omit all owner catalogs; production stores always provide
    // them and still fail closed above. The `teardown` purpose never takes this fail-open.
    return ownershipForRuntimeEnvironmentId(getSingleFocusedRuntimeEnvironmentId(state))
  }
  return UNRESOLVED_TERMINAL_HOST
}

/** A named host takes the strict route, so rival servers for one `ssh:` target never read as direct. */
function resolveGitWorktreeRoute(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string
): WorktreeOperationRouteResolution {
  const hostId = namedHostForOwnerRef(state, { workspaceId: worktreeId })
  return hostId
    ? resolveWorktreeOperationRouteResultForHost(state, worktreeId, hostId)
    : resolveWorktreeOperationRouteResult(state, worktreeId)
}

export type TerminalPtyOwner =
  | { kind: 'runtime'; environmentId: string }
  | { kind: 'non-runtime' }
  | { kind: 'ambiguous' }

const NON_RUNTIME_PTY_OWNER: TerminalPtyOwner = { kind: 'non-runtime' }
const AMBIGUOUS_PTY_OWNER: TerminalPtyOwner = { kind: 'ambiguous' }

/**
 * Where spawn started a worktree's PTYs, for teardown, close and PTY identity. A contested or
 * unattributed-twin owner is `ambiguous`; an id no row places stays this app's, as it always has.
 * `spawn` is for unscoped `remote:` ids, which live where spawn put them; `teardown` keeps a setup
 * terminal's raw ids local, as they always have been.
 */
export function resolveTerminalPtyOwner(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string | null | undefined,
  purpose: TerminalHostOwnershipPurpose = 'teardown'
): TerminalPtyOwner {
  if (!worktreeId) {
    return NON_RUNTIME_PTY_OWNER
  }
  const setup = isEphemeralSetupTerminalWorktreeId(worktreeId)
  if (
    !setup &&
    !namedHostForOwnerRef(state, { workspaceId: worktreeId }) &&
    isUnattributedTwinWorktree(state, worktreeId)
  ) {
    return AMBIGUOUS_PTY_OWNER
  }
  const ownership = resolveTerminalHostOwnership(state, worktreeId, setup ? purpose : 'spawn')
  switch (ownership.kind) {
    case 'runtime':
      return { kind: 'runtime', environmentId: ownership.runtimeEnvironmentId }
    case 'local-or-ssh':
      return NON_RUNTIME_PTY_OWNER
    case 'unresolved':
      return setup ||
        (parseWorkspaceKey(worktreeId)?.type !== 'folder' &&
          resolveGitWorktreeRoute(state, worktreeId).kind === 'missing')
        ? NON_RUNTIME_PTY_OWNER
        : AMBIGUOUS_PTY_OWNER
  }
}

/**
 * An unstamped worktree row with no detected copy, in a project two hosts publish: no row says
 * which host started its PTYs, so only each PTY's own `remote:<env>` id may.
 */
export function isUnattributedTwinWorktree(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string
): boolean {
  const worktree = resolveIndexedWorktreeOwner(state.worktreesByRepo, worktreeId)
  return (
    worktree.kind === 'resolved' &&
    !worktree.owner.runtimeOwnerEnvironmentId?.trim() &&
    !parseExecutionHostId(worktree.owner.hostId) &&
    !hasIndexedDetectedWorktree(state.detectedWorktreesByRepo, worktreeId) &&
    resolveIndexedRepoOwner(state.repos, worktree.owner.repoId).kind === 'ambiguous'
  )
}

/**
 * Host ownership for the host-agnostic surfaces — floating, folder workspace, ephemeral setup.
 * Safe to downgrade on teardown because these never hold an `ssh:`-shaped HUB wake hint: a
 * runtime-hosted one carries a `remote:` id, which is routed before ownership is consulted.
 */
function resolveFloatingScopeOwnership(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string,
  purpose: TerminalHostOwnershipPurpose,
  runtimeEnvironmentId: string | null
): TerminalHostOwnership {
  if (purpose === 'spawn' || !runtimeEnvironmentId) {
    return ownershipForRuntimeEnvironmentId(runtimeEnvironmentId)
  }
  // Why a twin downgrades too: runtime PTYs on these surfaces carry `remote:` ids, so a raw id is
  // local or SSH on either twin.
  if (runtimeEnvironmentIdUnlessTwin(state, worktreeId)) {
    return ownershipForRuntimeEnvironmentId(runtimeEnvironmentId)
  }
  // Why: this surface publishes no runtime owner and only looks runtime-owned through a guess (the
  // focused runtime, a web client's server) that flips as catalogs hydrate, stranding the local
  // PTY (STA-2639).
  return LOCAL_OR_SSH_TERMINAL_HOST
}

export function resolveTerminalWorktreeRoute(
  state: AppState,
  worktreeId: string | null | undefined
): TerminalWorktreeRoute | null {
  const ownership = resolveTerminalHostOwnership(state, worktreeId, 'spawn')
  return ownership.kind === 'unresolved'
    ? null
    : { runtimeEnvironmentId: ownership.runtimeEnvironmentId }
}

export function hasUnroutableTerminalWorktreeOwner(state: AppState, worktreeId: string): boolean {
  return resolveTerminalWorktreeRoute(state, worktreeId) === null
}
