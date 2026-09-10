import type {
  RuntimeMobileSessionTabsResult,
  RuntimeTerminalOrphanAdoptionClaim,
  RuntimeTerminalOrphanAdoptionResult
} from '../../../shared/runtime-types'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  isRecoverableRemoteRuntimeConnectionError,
  toRemoteRuntimeClientErrorLike
} from '../../../shared/remote-runtime-client-error-classification'
import { hasRuntimeRpcErrorCode } from '../../../shared/runtime-rpc-error-code'
import { cacheStableSurfaceRecoveryFailure } from './web-session-terminal-orphan-recovery-cache'
import { runInTerminalRecoveryRpcLane } from './web-session-terminal-orphan-recovery-rpc-lane'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import { getSessionTabsRuntimeIdFromResponse } from './web-session-tabs-sync/publisher-identity-fences'
import { hasTerminalHandleRetirementProof } from './web-session-terminal-orphan-recovery-surface-index'
import { isTerminalRecoverySnapshot } from './web-session-terminal-recovery-snapshot-validation'
import {
  mergeRetainedTerminalSurfaces,
  isValidReadySurface,
  terminalRowsBySurface,
  type AnyRecoverySurface,
  type RecoverySurface
} from './web-session-terminal-orphan-recovery-surface'

// Request/protocol failures are stable; host state and transport failures can recover.
const STABLE_ADOPTION_FAILURE_CODES = new Set([
  'method_not_found',
  'capability_unsupported',
  'invalid_runtime_response'
])

export type TerminalOrphanRecoveryCall = (args: {
  selector: string
  method: string
  params: unknown
  timeoutMs: number
  expectedEnvironmentPairingRevision?: number
}) => Promise<RuntimeRpcResponse<unknown>>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isAdoptionResult(value: unknown): value is RuntimeTerminalOrphanAdoptionResult {
  return (
    isRecord(value) &&
    typeof value.adopted === 'boolean' &&
    Number.isSafeInteger(value.topologyRevision) &&
    isTerminalRecoverySnapshot(value.snapshot)
  )
}

export function isStableAdoptionFailure(error: unknown): boolean {
  const errorPayload = isRecord(error) && isRecord(error.error) ? error.error : error
  const clientError = toRemoteRuntimeClientErrorLike(errorPayload)
  if (isRecoverableRemoteRuntimeConnectionError(clientError)) {
    return false
  }
  return [...STABLE_ADOPTION_FAILURE_CODES].some((code) => hasRuntimeRpcErrorCode(error, code))
}

export function isRpcResponse(value: unknown): value is RuntimeRpcResponse<unknown> {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    return false
  }
  if (value.ok) {
    return 'result' in value
  }
  const error = value.error
  return isRecord(error) && typeof error.code === 'string' && typeof error.message === 'string'
}

export async function readClientSessionSnapshotAfterAdoption(args: {
  environmentId: string
  worktreeId: string
  expectedEnvironmentPairingRevision?: number
  expectedRuntimeId?: string
  call: TerminalOrphanRecoveryCall
  isCurrent: () => boolean
}): Promise<RuntimeMobileSessionTabsResult | null> {
  try {
    // Adoption returns host-private epochs; only the caller's session-tab projection may enter its mirror.
    const response = await runInTerminalRecoveryRpcLane(args.isCurrent, () =>
      args.call({
        selector: args.environmentId,
        method: 'session.tabs.list',
        params: { worktree: toRuntimeWorktreeSelector(args.worktreeId) },
        timeoutMs: 15_000,
        expectedEnvironmentPairingRevision: args.expectedEnvironmentPairingRevision
      })
    )
    return isRpcResponse(response) &&
      response.ok &&
      (args.expectedRuntimeId === undefined ||
        getSessionTabsRuntimeIdFromResponse(response) === args.expectedRuntimeId) &&
      isTerminalRecoverySnapshot(response.result) &&
      response.result.worktree === args.worktreeId
      ? response.result
      : null
  } catch {
    return null
  }
}

export function claimSurfaces(
  candidates: readonly RecoverySurface[],
  claims: readonly RuntimeTerminalOrphanAdoptionClaim[]
): RecoverySurface[] {
  return candidates.filter((surface) =>
    claims.some((claim) => claim.tabId === surface.tabId && claim.leafId === surface.leafId)
  )
}

export function retainedSharesClaimedTab(
  retained: readonly AnyRecoverySurface[],
  claims: readonly RuntimeTerminalOrphanAdoptionClaim[]
): boolean {
  const claimedTabIds = new Set(claims.map((claim) => claim.tabId))
  return retained.some((surface) => claimedTabIds.has(surface.tabId))
}

export function cacheRetainedSurfaces(
  environmentId: string,
  snapshot: RuntimeMobileSessionTabsResult,
  surfaces: readonly RecoverySurface[],
  expectedEnvironmentPairingRevision: number | undefined
): void {
  for (const surface of surfaces) {
    cacheStableSurfaceRecoveryFailure({
      environmentId,
      snapshot,
      surface,
      expectedEnvironmentPairingRevision
    })
  }
}

export function mergeFailedAdoption(
  snapshot: RuntimeMobileSessionTabsResult,
  candidates: readonly RecoverySurface[],
  retained: readonly AnyRecoverySurface[],
  claims: readonly RuntimeTerminalOrphanAdoptionClaim[],
  removed: ReadonlySet<string>
): RuntimeMobileSessionTabsResult {
  return mergeRetainedTerminalSurfaces(
    snapshot,
    [...retained, ...claimSurfaces(candidates, claims)],
    removed
  )
}

export function mergeAdoptionResponse(
  snapshot: RuntimeMobileSessionTabsResult,
  retained: readonly AnyRecoverySurface[],
  missingClaims: readonly RecoverySurface[],
  removed: ReadonlySet<string>
): RuntimeMobileSessionTabsResult {
  const rowsBySurface = terminalRowsBySurface(snapshot)
  const readyKeys = new Set(
    [...rowsBySurface.entries()]
      .filter(([, rows]) => rows.some(isValidReadySurface))
      .map(([key]) => key)
  )
  const effectiveRemoved = new Set([...removed].filter((key) => !rowsBySurface.has(key)))
  // A later host rebind or exact retirement outranks the pre-adoption inventory.
  const retainedSurfaces = [...retained, ...missingClaims].filter((surface) => {
    if (readyKeys.has(surface.surfaceKey)) {
      return false
    }
    if (
      surface.handle &&
      hasTerminalHandleRetirementProof(snapshot, {
        tabId: surface.tabId,
        leafId: surface.leafId,
        handle: surface.handle
      })
    ) {
      if (!rowsBySurface.has(surface.surfaceKey)) {
        effectiveRemoved.add(surface.surfaceKey)
      }
      return false
    }
    return !effectiveRemoved.has(surface.surfaceKey)
  })
  return mergeRetainedTerminalSurfaces(snapshot, retainedSurfaces, effectiveRemoved)
}
