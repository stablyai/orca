import type { RuntimeMobileSessionTabsResult } from '../../../../../../shared/runtime-session-contracts'
import type { RuntimeTerminalResolvePane } from '../../../../../../shared/runtime-terminal-contracts'
import type { RuntimeRpcResponse } from '../../../../../../shared/runtime-rpc-envelope'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { runInTerminalRecoveryRpcLane } from '../scheduling/web-session-terminal-orphan-recovery-rpc-lane'
import {
  cacheStablePaneResolutionFailure,
  clearSurfaceInventoryAbsence,
  confirmSurfaceInventoryAbsence,
  readStablePaneResolutionFailure
} from '../evidence/web-session-terminal-orphan-recovery-cache'
import { latestTerminalRetirementProof } from '../surfaces/web-session-terminal-orphan-recovery-surface-index'
import { hostSnapshotAffirmsWorktreeContents } from '../../../web-session-tabs-sync/hydration/host-session-snapshot-authority'
import type {
  RecoverySurface,
  UnresolvedRecoverySurface
} from '../surfaces/web-session-terminal-orphan-recovery-surface'

type RuntimeCall = (args: {
  selector: string
  method: string
  params: unknown
  timeoutMs: number
  expectedEnvironmentPairingRevision?: number
}) => Promise<RuntimeRpcResponse<unknown>>

type PaneResolution = {
  resolved: RecoverySurface[]
  unresolved: UnresolvedRecoverySurface[]
}

/** `absent`: the host has no terminal for the pane; `owned`: it has one, just not attachable yet. */
type PaneOutcome = RecoverySurface | 'absent' | 'owned' | null

type ResolvedPaneResponse =
  | { kind: 'connected'; terminal: RuntimeTerminalResolvePane }
  | { kind: 'disconnected' }
  | { kind: 'invalid' }

const MAX_PANE_RESOLVES = 64

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readResolvedPane(value: unknown): ResolvedPaneResponse {
  if (!isRecord(value) || !isRecord(value.terminal)) {
    return { kind: 'invalid' }
  }
  const terminal = value.terminal
  if (
    typeof terminal.handle !== 'string' ||
    terminal.handle.length === 0 ||
    typeof terminal.tabId !== 'string' ||
    typeof terminal.leafId !== 'string' ||
    (terminal.ptyId !== null &&
      (typeof terminal.ptyId !== 'string' || terminal.ptyId.length === 0)) ||
    typeof terminal.connected !== 'boolean' ||
    typeof terminal.worktreeId !== 'string'
  ) {
    return { kind: 'invalid' }
  }
  if (!terminal.connected) {
    return { kind: 'disconnected' }
  }
  return {
    kind: 'connected',
    terminal: {
      handle: terminal.handle,
      tabId: terminal.tabId,
      leafId: terminal.leafId,
      ptyId: terminal.ptyId,
      connected: true,
      worktreeId: terminal.worktreeId
    }
  }
}

function matchesSurface(
  terminal: RuntimeTerminalResolvePane,
  surface: UnresolvedRecoverySurface,
  worktreeId: string
): boolean {
  return (
    terminal.tabId === surface.tabId &&
    terminal.leafId === surface.leafId &&
    terminal.worktreeId === worktreeId &&
    (!surface.expectedPtyId || terminal.ptyId === surface.expectedPtyId)
  )
}

function resolvedSurface(
  surface: UnresolvedRecoverySurface,
  terminal: RuntimeTerminalResolvePane
): RecoverySurface {
  return { ...surface, handle: terminal.handle }
}

async function resolveOne(args: {
  surface: UnresolvedRecoverySurface
  snapshot: RuntimeMobileSessionTabsResult
  environmentId: string
  call: RuntimeCall
  expectedEnvironmentPairingRevision?: number
  isCurrent: () => boolean
}): Promise<PaneOutcome> {
  const { surface, snapshot, environmentId, call, expectedEnvironmentPairingRevision, isCurrent } =
    args
  if (!isCurrent()) {
    return null
  }
  const cacheFailure = (): void => {
    if (isCurrent()) {
      cacheStablePaneResolutionFailure({
        environmentId,
        snapshot,
        surface,
        expectedEnvironmentPairingRevision
      })
    }
  }
  if (
    readStablePaneResolutionFailure({
      environmentId,
      snapshot,
      surface,
      expectedEnvironmentPairingRevision
    })
  ) {
    return null
  }
  let paneKey: string
  try {
    paneKey = makePaneKey(surface.tabId, surface.leafId)
  } catch {
    // Legacy/corrupt layouts cannot be safely addressed; keep the surface pending.
    cacheFailure()
    return null
  }
  try {
    const response = await runInTerminalRecoveryRpcLane(isCurrent, () =>
      call({
        selector: environmentId,
        method: 'terminal.resolvePane',
        params: {
          paneKey,
          worktreeId: snapshot.worktree
        },
        timeoutMs: 15_000,
        expectedEnvironmentPairingRevision
      })
    )
    if (!response?.ok) {
      if (response?.error.code === 'method_not_found') {
        cacheFailure()
      }
      // The host also answers this for a live leaf between PTYs, so it is an absence only when the
      // frame omits the pane too; a pending row means the host still owns it.
      if (response?.error.code === 'terminal_not_found' && surface.incoming === undefined) {
        return 'absent'
      }
      return null
    }
    const resolution = readResolvedPane(response.result)
    if (resolution.kind === 'invalid') {
      cacheFailure()
      return null
    }
    if (resolution.kind === 'disconnected') {
      // Older hosts keep resolving a closed tab's exited pane as disconnected; only the frame can
      // tell that apart from a live tab between PTYs.
      return surface.incoming === undefined ? 'absent' : 'owned'
    }
    const { terminal } = resolution
    if (!matchesSurface(terminal, surface, snapshot.worktree)) {
      return 'owned'
    }
    return resolvedSurface(surface, terminal)
  } catch {
    return null
  }
}

/** Unbound panes have no handle to list, so they are retired by pane: the host's close record for
 * the pane, or the same two consecutive authoritative absences that retire listed handles. Any
 * sign the host still owns the pane restarts the count. Retired panes are in neither result list. */
export async function resolvePersistedTerminalSurfaces(args: {
  surfaces: readonly UnresolvedRecoverySurface[]
  snapshot: RuntimeMobileSessionTabsResult
  environmentId: string
  call: RuntimeCall
  expectedEnvironmentPairingRevision?: number
  isCurrent: () => boolean
}): Promise<PaneResolution | null> {
  const { snapshot, isCurrent } = args
  const surfaces = args.surfaces.filter(
    (surface) =>
      surface.incoming !== undefined || latestTerminalRetirementProof(snapshot, surface) === null
  )
  if (surfaces.length === 0) {
    return { resolved: [], unresolved: [] }
  }
  if (surfaces.length > MAX_PANE_RESOLVES) {
    return { resolved: [], unresolved: [...surfaces] }
  }
  const outcomes = await Promise.all(
    surfaces.map(async (surface) => ({
      surface,
      resolved: await resolveOne({ ...args, surface })
    }))
  )
  if (!isCurrent()) {
    return null
  }
  const resolved: RecoverySurface[] = []
  const unresolved: UnresolvedRecoverySurface[] = []
  for (const { surface, resolved: outcome } of outcomes) {
    const evidence = { ...args, surface }
    if (outcome !== 'absent') {
      if (outcome !== null || surface.incoming !== undefined) {
        clearSurfaceInventoryAbsence(evidence)
      }
      if (outcome !== null && outcome !== 'owned') {
        resolved.push(outcome)
      } else {
        unresolved.push(surface)
      }
    } else if (
      // A frame the host did not publish affirms nothing, so it is never an absence.
      !hostSnapshotAffirmsWorktreeContents(snapshot) ||
      !confirmSurfaceInventoryAbsence(evidence)
    ) {
      unresolved.push(surface)
    }
  }
  return { resolved, unresolved }
}
