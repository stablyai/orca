import type {
  RuntimeMobileSessionTabsResult,
  RuntimeTerminalListResult,
  RuntimeTerminalOrphanAdoptionClaim
} from '../../../shared/runtime-types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import { isTerminalListResult } from './web-session-terminal-orphan-recovery-inventory-validation'
import {
  clearSurfaceInventoryAbsence,
  confirmSurfaceInventoryAbsence,
  readStableSurfaceRecoveryFailure
} from './web-session-terminal-orphan-recovery-cache'
import {
  hasExactTerminalRetirementProof,
  hasStrongOrphanIdentity,
  type RecoveryDisposition,
  type RecoverySurface
} from './web-session-terminal-orphan-recovery-surface'
import { runInTerminalRecoveryRpcLane } from './web-session-terminal-orphan-recovery-rpc-lane'

type RuntimeCall = (args: {
  selector: string
  method: string
  params: unknown
  timeoutMs: number
  expectedEnvironmentPairingRevision?: number
}) => Promise<RuntimeRpcResponse<unknown>>

export type TerminalOrphanInventoryResolution = {
  retained: RecoverySurface[]
  removed: Set<string>
  claims: RuntimeTerminalOrphanAdoptionClaim[]
  topologyRevision: number
}

function fallback(
  retainedBeforeListing: readonly RecoverySurface[],
  inventorySurfaces: readonly RecoverySurface[],
  removed: ReadonlySet<string>
): TerminalOrphanInventoryResolution {
  return {
    retained: [...retainedBeforeListing, ...inventorySurfaces],
    removed: new Set(removed),
    claims: [],
    topologyRevision: 0
  }
}

export async function resolveTerminalOrphanInventory(args: {
  candidates: readonly RecoverySurface[]
  snapshot: RuntimeMobileSessionTabsResult
  environmentId: string
  call: RuntimeCall
  expectedEnvironmentPairingRevision?: number
  isCurrent: () => boolean
}): Promise<TerminalOrphanInventoryResolution | null> {
  const {
    candidates,
    snapshot,
    environmentId,
    call,
    expectedEnvironmentPairingRevision,
    isCurrent
  } = args
  const retiredSurfaces = candidates.filter((surface) =>
    hasExactTerminalRetirementProof(snapshot, surface)
  )
  const provenRemoved = new Set(retiredSurfaces.map((surface) => surface.surfaceKey))
  const recoverableCandidates = candidates.filter(
    (surface) => !hasExactTerminalRetirementProof(snapshot, surface)
  )
  const surfacesByHandle = new Map<string, RecoverySurface[]>()
  for (const surface of recoverableCandidates) {
    const grouped = surfacesByHandle.get(surface.handle) ?? []
    grouped.push(surface)
    surfacesByHandle.set(surface.handle, grouped)
  }
  const duplicateHandles = new Set(
    [...surfacesByHandle.entries()]
      .filter(([, surfaces]) => surfaces.length > 1)
      .map(([handle]) => handle)
  )
  const duplicateSurfaces = recoverableCandidates.filter((surface) =>
    duplicateHandles.has(surface.handle)
  )
  const listableSurfaces = recoverableCandidates.filter(
    (surface) => !duplicateHandles.has(surface.handle)
  )
  const stableRetained: RecoverySurface[] = []
  const inventorySurfaces: RecoverySurface[] = []
  for (const surface of listableSurfaces) {
    const target = readStableSurfaceRecoveryFailure({
      environmentId,
      snapshot,
      surface,
      expectedEnvironmentPairingRevision
    })
      ? stableRetained
      : inventorySurfaces
    target.push(surface)
  }
  const retainedBeforeListing = [...duplicateSurfaces, ...stableRetained]
  if (inventorySurfaces.length > 64) {
    return {
      retained: [...retainedBeforeListing, ...inventorySurfaces],
      removed: provenRemoved,
      claims: [],
      topologyRevision: 0
    }
  }
  if (inventorySurfaces.length === 0) {
    return {
      retained: retainedBeforeListing,
      removed: provenRemoved,
      claims: [],
      topologyRevision: 0
    }
  }
  if (!isCurrent()) {
    return null
  }
  const inventoryHandles = [...new Set(inventorySurfaces.map((surface) => surface.handle))]
  let listedResponse: RuntimeRpcResponse<unknown> | null
  try {
    listedResponse = await runInTerminalRecoveryRpcLane(isCurrent, () =>
      call({
        selector: environmentId,
        method: 'terminal.list',
        params: {
          worktree: toRuntimeWorktreeSelector(snapshot.worktree),
          handles: inventoryHandles,
          requireFreshPtyLiveness: true,
          includeVisualLayouts: false
        },
        timeoutMs: 15_000,
        expectedEnvironmentPairingRevision
      })
    )
  } catch {
    listedResponse = null
  }
  if (listedResponse === null) {
    return isCurrent() ? fallback(retainedBeforeListing, inventorySurfaces, provenRemoved) : null
  }
  if (!isCurrent()) {
    return null
  }
  if (!listedResponse.ok || !isTerminalListResult(listedResponse.result)) {
    return fallback(retainedBeforeListing, inventorySurfaces, provenRemoved)
  }
  const listed = listedResponse.result
  const inventoryHandleSet = new Set(inventoryHandles)
  const listedByHandle = new Map<string, RuntimeTerminalListResult['terminals'][number]>()
  const duplicateListedHandles = new Set<string>()
  for (const terminal of listed.terminals) {
    if (!inventoryHandleSet.has(terminal.handle)) {
      continue
    }
    if (listedByHandle.has(terminal.handle)) {
      duplicateListedHandles.add(terminal.handle)
    } else {
      listedByHandle.set(terminal.handle, terminal)
    }
  }
  // Older hosts omit hostScope entirely; an unscoped absence cannot prove a PTY exited.
  const hostScopeUnverifiable =
    listed.hostScope === undefined || listed.hostScope.omittedHostIds.length > 0
  const dispositions = new Map<string, RecoveryDisposition>()
  const claims: RuntimeTerminalOrphanAdoptionClaim[] = []
  for (const surface of inventorySurfaces) {
    const terminal = listedByHandle.get(surface.handle)
    let disposition: RecoveryDisposition = 'retain'
    if (terminal || surface.pending) {
      clearSurfaceInventoryAbsence({
        environmentId,
        snapshot,
        surface,
        expectedEnvironmentPairingRevision
      })
    }
    if (duplicateListedHandles.has(surface.handle)) {
      disposition = 'retain'
    } else if (!terminal) {
      if (surface.pending) {
        disposition = 'retain'
      } else if (listed.truncated || hostScopeUnverifiable) {
        disposition = 'retain'
      } else {
        disposition = confirmSurfaceInventoryAbsence({
          environmentId,
          snapshot,
          surface,
          expectedEnvironmentPairingRevision
        })
          ? 'remove'
          : 'retain'
      }
    } else if (
      surface.pending &&
      (!surface.expectedPtyId || typeof terminal.ptyId !== 'string' || terminal.ptyId.length === 0)
    ) {
      disposition = 'retain'
    } else if (surface.pending && terminal.ptyId !== surface.expectedPtyId) {
      // Rebind, never retire. `expectedPtyId` is the ptyId of the *snapshot frame's* pending row;
      // `terminal.ptyId` is the answer to a `terminal.list` with `requireFreshPtyLiveness: true`, so
      // the host has just attested this handle is live under a different PTY. A PTY id changing
      // across a host relaunch is the normal case, not evidence of death (#11495). Retaining emits a
      // ready row bound to the host's handle, which is the rebind — the handle is the identity, the
      // ptyId behind it is the host's business. Removal here needs what the two branches around it
      // already require: an explicit `retiredTerminalSurfaces` entry, or two authoritative
      // inventories omitting the identity. See docs/reference/ssh-execution-boundary.md.
      disposition = 'retain'
    } else if (!hasStrongOrphanIdentity(terminal, surface, snapshot.worktree)) {
      disposition = 'retain'
    } else {
      const ptyId = terminal.ptyId
      const incarnationId = terminal.incarnationId
      if (
        typeof ptyId !== 'string' ||
        ptyId.length === 0 ||
        typeof incarnationId !== 'string' ||
        incarnationId.length === 0
      ) {
        disposition = 'retain'
        dispositions.set(surface.surfaceKey, disposition)
        continue
      }
      disposition = 'claim'
      claims.push({
        terminal: terminal.handle,
        ptyId,
        incarnationId,
        tabId: surface.tabId,
        leafId: surface.leafId
      })
    }
    dispositions.set(surface.surfaceKey, disposition)
  }
  const retainedAfterListing = inventorySurfaces.filter(
    (surface) => dispositions.get(surface.surfaceKey) === 'retain'
  )
  const removed = new Set(
    [
      ...retiredSurfaces,
      ...inventorySurfaces.filter((surface) => dispositions.get(surface.surfaceKey) === 'remove')
    ].map((surface) => surface.surfaceKey)
  )
  return {
    retained: [...retainedBeforeListing, ...retainedAfterListing],
    removed,
    claims,
    topologyRevision: listed.topologyRevisions?.[snapshot.worktree] ?? 0
  }
}
