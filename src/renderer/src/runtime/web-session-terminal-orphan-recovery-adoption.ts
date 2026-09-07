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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isAdoptionResult(value: unknown): value is RuntimeTerminalOrphanAdoptionResult {
  if (!isRecord(value) || !isRecord(value.snapshot)) {
    return false
  }
  const snapshot = value.snapshot
  return (
    typeof value.adopted === 'boolean' &&
    Number.isSafeInteger(value.topologyRevision) &&
    typeof snapshot.worktree === 'string' &&
    snapshot.worktree.length > 0 &&
    typeof snapshot.publicationEpoch === 'string' &&
    Number.isSafeInteger(snapshot.snapshotVersion) &&
    Array.isArray(snapshot.tabs) &&
    snapshot.tabs.every(isRecord)
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
  const readyKeys = new Set(
    [...terminalRowsBySurface(snapshot).entries()]
      .filter(([, rows]) => rows.some(isValidReadySurface))
      .map(([key]) => key)
  )
  const effectiveRemoved = new Set([...removed].filter((key) => !readyKeys.has(key)))
  return mergeRetainedTerminalSurfaces(snapshot, [...retained, ...missingClaims], effectiveRemoved)
}
