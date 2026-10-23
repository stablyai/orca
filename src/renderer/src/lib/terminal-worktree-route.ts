import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { isEphemeralSetupTerminalWorktreeId } from '../../../shared/ephemeral-setup-terminal-worktree-id'
import {
  getWorktreeExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { parseRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import type { Tab } from '../../../shared/tab-types'
import { parseTerminalHostStamp } from '../../../shared/workspace-layout/terminal-host-stamp'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { AppState } from '@/store/types'
import { getWorktreeProjectId } from '@/components/tab-bar/tab-bar-host-terminal-targets'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import {
  selectWorktreesByRepo,
  selectDetectedWorktreesByRepo
} from '@/store/workspace-record-selectors'
import { resolveExplicitWorktreeOperationRouteResult } from './worktree-operation-catalog-route'
import { resolveOwnerOrLocal } from './worktree-runtime-owner'
import { namedHostForOwnerRef, resolveOwner, runtimeEnvironmentIdUnlessTwin } from './resolve-owner'
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
    const owner = resolveOwnerOrLocal(state, { workspaceId: worktreeId })
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

/** Positive proof a worktree runs here; a missing row, runtime provenance or ambiguity is not local. */
export function isPositivelyLocalSourceWorktree(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string
): boolean {
  const rows = Object.values(selectWorktreesByRepo(state) ?? {})
    .flat()
    .filter((worktree) => worktree.id === worktreeId)
  const repo = state.repos?.find((repo) => repo.id === rows[0]?.repoId)
  const route = resolveExplicitWorktreeOperationRouteResult(state, worktreeId)
  const owner = resolveOwner(state, { workspaceId: worktreeId })
  return (
    rows.length === 1 &&
    !rows[0].runtimeOwnerEnvironmentId?.trim() &&
    owner.kind === 'resolved' &&
    owner.owner.endpoint.kind === 'self' &&
    owner.owner.at === LOCAL_EXECUTION_HOST_ID &&
    getWorktreeExecutionHostId(rows[0], repo) === LOCAL_EXECUTION_HOST_ID &&
    route.kind !== 'ambiguous' &&
    (!hasIndexedDetectedWorktree(selectDetectedWorktreesByRepo(state), worktreeId) ||
      (route.kind === 'resolved' && route.route.executionHostId === LOCAL_EXECUTION_HOST_ID))
  )
}

/** Proof for worktrees holding a setup-stamped tab; owned predicates refuse a stamp without it. */
export function getLocalSourceWorktreeIds(
  state: WorktreeRuntimeOwnerState & Pick<AppState, 'unifiedTabsByWorktree'>
): ReadonlySet<string> {
  return new Set(
    Object.entries(state.unifiedTabsByWorktree ?? {})
      .filter(([, tabs]) => tabs?.some((tab) => tab.projectHostSetupId !== undefined))
      .map(([worktreeId]) => worktreeId)
      .filter((worktreeId) => isPositivelyLocalSourceWorktree(state, worktreeId))
  )
}

type StampedTerminal = {
  environmentId: string
  executionHostId: ExecutionHostId
  projectHostSetupId: string
}

export type HostStampedTerminal =
  | { kind: 'none' }
  | { kind: 'invalid'; reason: string }
  | ({ kind: 'stamped' } & StampedTerminal)

/** Recognized by the setup stamp alone, so a malformed stamp never reads as a legacy tab. */
export function classifyHostStampedTerminal(
  unifiedTabs:
    | readonly (Pick<Tab, 'id' | 'contentType'> & {
        executionHostId?: unknown
        projectHostSetupId?: unknown
      })[]
    | undefined,
  tabId: string
): HostStampedTerminal {
  const matches = (unifiedTabs ?? []).filter((tab) => tab.id === tabId)
  if (!matches.some((tab) => tab.projectHostSetupId !== undefined)) {
    return { kind: 'none' }
  }
  const [tab] = matches
  if (matches.length !== 1) {
    return { kind: 'invalid', reason: 'ambiguous_tab' }
  }
  if (tab.contentType !== 'terminal') {
    return { kind: 'invalid', reason: 'not_terminal' }
  }
  return parseTerminalHostStamp(tab.projectHostSetupId, tab.executionHostId)
}

export type HostTerminalRoute =
  | ({ kind: 'host-terminal'; targetWorktreeSelector: string } & StampedTerminal)
  | { kind: 'refused'; reason: string }

/** Null only for a tab with no setup stamp; every stamped tab routes to its target or refuses. */
export function resolveHostTerminalRoute(
  state: AppState,
  worktreeId: string,
  tabId: string,
  ptyIds: readonly (string | null | undefined)[]
): HostTerminalRoute | null {
  const stamp = classifyHostStampedTerminal(state.unifiedTabsByWorktree?.[worktreeId], tabId)
  if (stamp.kind !== 'stamped') {
    return stamp.kind === 'none' ? null : { kind: 'refused', reason: stamp.reason }
  }
  if (!isPositivelyLocalSourceWorktree(state, worktreeId)) {
    return { kind: 'refused', reason: 'source_worktree_not_local' }
  }
  const worktree = findWorktreeById(selectWorktreesByRepo(state), worktreeId)
  const repo = state.repos.find((candidate) => candidate.id === worktree?.repoId)
  const projectId = worktree && getWorktreeProjectId(worktree, repo, state.projectHostSetups)
  const setups = state.projectHostSetups.filter(
    (setup) =>
      setup.id === stamp.projectHostSetupId &&
      setup.projectId === projectId &&
      setup.setupState === 'ready' &&
      setup.hostId === stamp.executionHostId &&
      !setup.connectionId &&
      setup.path.trim() !== ''
  )
  if (!projectId || setups.length !== 1) {
    return { kind: 'refused', reason: 'setup_not_ready' }
  }
  // Why: a local, ownerless or foreign PTY on a host-stamped tab proves nothing about its target.
  const foreignPty = ptyIds.some((ptyId) => {
    const owner = ptyId ? parseRemoteRuntimePtyId(ptyId) : undefined
    return ptyId && (!owner?.handle.trim() || owner.environmentId !== stamp.environmentId)
  })
  return foreignPty
    ? { kind: 'refused', reason: 'pty_owner_mismatch' }
    : { ...stamp, kind: 'host-terminal', targetWorktreeSelector: `path:${setups[0].path}` }
}
