import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { callRuntimeEnvironmentWithRevision } from './runtime-rpc-environment-call'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import {
  cacheRetainedSurfaces,
  claimSurfaces,
  isAdoptionResult,
  isRpcResponse,
  isStableAdoptionFailure,
  mergeAdoptionResponse,
  mergeFailedAdoption,
  retainedSharesClaimedTab
} from './web-session-terminal-orphan-recovery-adoption'
import {
  buildTopologyCandidates,
  isRemovedSnapshot,
  isValidReadySurface,
  prepareTerminalOrphanRecovery,
  mergeRetainedTerminalSurfaces,
  captureTerminalRecoveryTopologyToken,
  surfaceKey,
  terminalRowsBySurface,
  type AnyRecoverySurface,
  type TerminalOrphanRecoveryState
} from './web-session-terminal-orphan-recovery-surface'
import { resolveTerminalOrphanInventory } from './web-session-terminal-orphan-recovery-inventory'
import { resolvePersistedTerminalSurfaces } from './web-session-terminal-orphan-recovery-pane'
import {
  clearCachedSurfaceResolutions,
  clearSurfaceInventoryAbsence
} from './web-session-terminal-orphan-recovery-cache'
import {
  clearTerminalRecoveryQueues,
  enqueueLatestTerminalRecovery,
  supersedeTerminalRecovery
} from './web-session-terminal-orphan-recovery-queue'
import {
  clearTerminalRecoveryRpcLaneForTests,
  runInTerminalRecoveryRpcLane
} from './web-session-terminal-orphan-recovery-rpc-lane'
import { isWebTerminalSurfaceTabId, toHostSessionTabId } from './web-terminal-surface-id'
import { buildWebTerminalOrphanTopologyProposal } from './web-session-terminal-orphan-topology'

export type { TerminalOrphanRecoveryState } from './web-session-terminal-orphan-recovery-surface'

type RuntimeCall = (args: {
  selector: string
  method: string
  params: unknown
  timeoutMs: number
  expectedEnvironmentPairingRevision?: number
}) => Promise<RuntimeRpcResponse<unknown>>

export type TerminalOrphanRecoveryOptions = {
  expectedEnvironmentPairingRevision?: number
  call?: RuntimeCall
  /** Reads live renderer topology so an RPC cannot apply a stale local claim. */
  getCurrentState?: () => TerminalOrphanRecoveryState
}

function recoveryKey(
  environmentId: string,
  worktreeId: string,
  expectedEnvironmentPairingRevision: number | undefined
): string {
  return `${environmentId}\0${expectedEnvironmentPairingRevision ?? 'unknown'}\0${worktreeId}`
}

async function recoverTerminalOrphans(
  state: TerminalOrphanRecoveryState,
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  call: RuntimeCall,
  expectedEnvironmentPairingRevision: number | undefined,
  isCurrent: () => boolean,
  getCurrentState: (() => TerminalOrphanRecoveryState) | undefined
): Promise<RuntimeMobileSessionTabsResult | null> {
  const recoveryState = getCurrentState?.() ?? state
  const topologyToken = captureTerminalRecoveryTopologyToken(recoveryState, snapshot.worktree)
  const localTopologyIsCurrent = (): boolean =>
    !getCurrentState ||
    captureTerminalRecoveryTopologyToken(getCurrentState(), snapshot.worktree) === topologyToken
  const isRecoveryCurrent = (): boolean => isCurrent() && localTopologyIsCurrent()
  const prepared = prepareTerminalOrphanRecovery(recoveryState, snapshot, environmentId)
  if (
    prepared.candidates.length === 0 &&
    prepared.unresolved.length === 0 &&
    prepared.retained.length === 0
  ) {
    return snapshot
  }
  const paneResolution = await resolvePersistedTerminalSurfaces({
    surfaces: prepared.unresolved,
    snapshot,
    environmentId,
    call,
    expectedEnvironmentPairingRevision,
    isCurrent
  })
  if (!paneResolution || !isRecoveryCurrent()) {
    return null
  }
  const candidates = [...prepared.candidates, ...paneResolution.resolved]
  const unresolved = paneResolution.unresolved
  const retainedSurfaces: AnyRecoverySurface[] = [...prepared.retained, ...unresolved]
  if (candidates.length === 0) {
    return mergeRetainedTerminalSurfaces(snapshot, retainedSurfaces)
  }
  const inventory = await resolveTerminalOrphanInventory({
    candidates,
    snapshot,
    environmentId,
    call,
    expectedEnvironmentPairingRevision,
    isCurrent
  })
  if (!inventory || !isRecoveryCurrent()) {
    return null
  }
  const { retained, removed, claims } = inventory
  retainedSurfaces.push(...retained)
  if (claims.length === 0) {
    return mergeRetainedTerminalSurfaces(snapshot, retainedSurfaces, removed)
  }

  const localActiveTabId = recoveryState.activeTabIdByWorktree[snapshot.worktree]
  const activeTabId =
    localActiveTabId && isWebTerminalSurfaceTabId(localActiveTabId)
      ? toHostSessionTabId(localActiveTabId)
      : undefined
  const activeGroupId = recoveryState.activeGroupIdByWorktree[snapshot.worktree] ?? undefined
  const topology = !retainedSharesClaimedTab(retainedSurfaces, claims)
    ? buildWebTerminalOrphanTopologyProposal(
        recoveryState,
        snapshot.worktree,
        buildTopologyCandidates(candidates, claims),
        claims
      )
    : undefined
  const claimedSurfaces = claimSurfaces(candidates, claims)
  const retainAfterAdoptionFailure = (cache: boolean): RuntimeMobileSessionTabsResult => {
    if (cache) {
      cacheRetainedSurfaces(
        environmentId,
        snapshot,
        claimedSurfaces,
        expectedEnvironmentPairingRevision
      )
    }
    return mergeFailedAdoption(snapshot, candidates, retainedSurfaces, claims, removed)
  }
  let adoptionResponse: unknown = undefined
  let adoptionThrew = false
  let thrownAdoptionError: unknown
  try {
    if (!localTopologyIsCurrent()) {
      return null
    }
    adoptionResponse = await runInTerminalRecoveryRpcLane(isCurrent, () =>
      call({
        selector: environmentId,
        method: 'terminal.adoptOrphans',
        params: {
          worktree: toRuntimeWorktreeSelector(snapshot.worktree),
          expectedTopologyRevision: inventory.topologyRevision,
          claims,
          ...(activeTabId ? { activeTabId } : {}),
          ...(activeGroupId ? { activeGroupId } : {}),
          ...(topology ? { topology } : {})
        },
        timeoutMs: 15_000,
        expectedEnvironmentPairingRevision
      })
    )
  } catch (error) {
    adoptionThrew = true
    thrownAdoptionError = error
  }
  if (!isCurrent()) {
    return null
  }
  // Adoption mutates host ownership. If the local pane disappeared or moved
  // while it was in flight, never publish the response against old topology.
  if (!localTopologyIsCurrent()) {
    return null
  }
  // A lane refusal (queue pressure or supersession) is transient. Do not
  // turn it into an inventory retain entry that would suppress the next frame.
  if (adoptionResponse === null) {
    return retainAfterAdoptionFailure(false)
  }
  if (adoptionThrew) {
    return retainAfterAdoptionFailure(isStableAdoptionFailure(thrownAdoptionError))
  }
  if (!isRpcResponse(adoptionResponse)) {
    // A malformed envelope/result is a stable protocol incompatibility for
    // this exact semantic frame, so bounded deduplication is safe.
    return retainAfterAdoptionFailure(true)
  }
  if (!isCurrent()) {
    return null
  }
  if (!adoptionResponse.ok) {
    return retainAfterAdoptionFailure(isStableAdoptionFailure(adoptionResponse))
  }
  if (!isAdoptionResult(adoptionResponse.result)) {
    return retainAfterAdoptionFailure(true)
  }
  if (adoptionResponse.result.snapshot.worktree !== snapshot.worktree) {
    // A valid response for another worktree is stale routing evidence; retry
    // on the next replay instead of pinning this surface as a protocol fault.
    return retainAfterAdoptionFailure(false)
  }

  const adoptedSnapshot = adoptionResponse.result.snapshot
  const adoptedRows = terminalRowsBySurface(adoptedSnapshot)
  const missingClaims = claimedSurfaces.filter((surface) => {
    const rows = adoptedRows.get(surfaceKey(surface.tabId, surface.leafId))
    return !rows?.some(isValidReadySurface)
  })
  cacheRetainedSurfaces(environmentId, snapshot, missingClaims, expectedEnvironmentPairingRevision)
  return mergeAdoptionResponse(adoptedSnapshot, retainedSurfaces, missingClaims, removed)
}

function normalizeOptions(
  optionsOrCall: TerminalOrphanRecoveryOptions | RuntimeCall | undefined
): TerminalOrphanRecoveryOptions {
  return typeof optionsOrCall === 'function' ? { call: optionsOrCall } : (optionsOrCall ?? {})
}

export function recoverWebSessionTerminalOrphansBeforeApply(
  state: TerminalOrphanRecoveryState,
  snapshot: RuntimeMobileSessionTabsResult,
  environmentId: string,
  optionsOrCall?: TerminalOrphanRecoveryOptions | RuntimeCall
): Promise<RuntimeMobileSessionTabsResult | null> {
  const options = normalizeOptions(optionsOrCall)
  const key = recoveryKey(
    environmentId,
    snapshot.worktree,
    options.expectedEnvironmentPairingRevision
  )
  if (isRemovedSnapshot(snapshot)) {
    supersedeTerminalRecovery(key)
    return Promise.resolve(snapshot)
  }
  const prepared = prepareTerminalOrphanRecovery(state, snapshot, environmentId)
  for (const surface of prepared.observed) {
    clearSurfaceInventoryAbsence({
      environmentId,
      snapshot,
      surface,
      expectedEnvironmentPairingRevision: options.expectedEnvironmentPairingRevision
    })
  }
  if (
    prepared.candidates.length === 0 &&
    prepared.unresolved.length === 0 &&
    prepared.retained.length === 0
  ) {
    supersedeTerminalRecovery(key)
    return Promise.resolve(snapshot)
  }
  if (prepared.candidates.length === 0 && prepared.unresolved.length === 0) {
    // Preserve stale off-tree evidence while superseding any older recovery
    // queued for this worktree.
    supersedeTerminalRecovery(key)
    return Promise.resolve(mergeRetainedTerminalSurfaces(snapshot, prepared.retained))
  }
  const call: RuntimeCall =
    options.call ??
    ((args) =>
      callRuntimeEnvironmentWithRevision({
        environmentId,
        method: args.method,
        params: args.params,
        timeoutMs: args.timeoutMs,
        expectedEnvironmentPairingRevision: options.expectedEnvironmentPairingRevision
      }) as Promise<RuntimeRpcResponse<unknown>>)
  return enqueueLatestTerminalRecovery(key, (isCurrent) =>
    recoverTerminalOrphans(
      state,
      snapshot,
      environmentId,
      call,
      options.expectedEnvironmentPairingRevision,
      isCurrent,
      options.getCurrentState
    )
  )
}

export function clearWebSessionTerminalOrphanRecoveryForTests(): void {
  clearTerminalRecoveryQueues()
  clearCachedSurfaceResolutions()
  clearTerminalRecoveryRpcLaneForTests()
}
