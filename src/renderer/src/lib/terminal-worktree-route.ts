import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { isEphemeralSetupTerminalWorktreeId } from '../../../shared/ephemeral-setup-terminal-worktree-id'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { AppState } from '@/store/types'
import {
  getExplicitRuntimeEnvironmentIdForWorktree,
  getRuntimeEnvironmentIdForWorktree,
  type WorktreeRuntimeOwnerState
} from './worktree-runtime-owner'
import { resolveWorktreeOperationRouteResult } from './worktree-operation-route'
import { getSingleFocusedRuntimeEnvironmentId } from './single-runtime-legacy-owner'

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
 * `spawn` asks which host should start a new process, so a merely focused runtime is a fine guess.
 * `teardown` asks which provider can kill an existing one, where that same guess strands the local
 * PTY the surface was actually spawned on.
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
    return resolveFloatingScopeOwnership(
      state,
      worktreeId,
      purpose,
      getRuntimeEnvironmentIdForWorktree(state, worktreeId)
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
  const resolution = resolveWorktreeOperationRouteResult(state, worktreeId)
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
    // them and still fail closed above. Teardown never takes this fail-open — it would kill on a guess.
    return ownershipForRuntimeEnvironmentId(getSingleFocusedRuntimeEnvironmentId(state))
  }
  return UNRESOLVED_TERMINAL_HOST
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
  if (
    purpose === 'spawn' ||
    !runtimeEnvironmentId ||
    getExplicitRuntimeEnvironmentIdForWorktree(state, worktreeId)
  ) {
    return ownershipForRuntimeEnvironmentId(runtimeEnvironmentId)
  }
  // Why: this surface publishes no runtime owner and only looks runtime-owned because exactly one
  // runtime is focused — a guess that flips as catalogs hydrate, stranding the local PTY (STA-2639).
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
