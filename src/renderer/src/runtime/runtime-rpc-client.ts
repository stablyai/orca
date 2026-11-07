import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { RuntimeCapability } from '../../../shared/protocol-version'
import { withBrowserPaneUiRuntimeRpcSource } from '../../../shared/runtime-rpc-feature-interaction-source'
import { assertRuntimeStatusCompatible } from './runtime-protocol-compat'
import { createRuntimeRpcAbortError } from './abortable-runtime-environment-call'
import { callRuntimeEnvironmentWithRevision } from './runtime-rpc-environment-call'
import { unwrapRuntimeRpcResult } from './runtime-rpc-result'
import { captureRuntimeEnvironmentRequestRevision } from './runtime-environment-revision'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  clearRuntimeCompatibilityCache,
  compatibilityEntry,
  type RuntimeCompatibilityCacheEntry,
  getCachedRuntimeCompatibilityCheck,
  rememberRuntimeEnvironmentCompatibility,
  runtimeCompatibilityChecks,
  selectionOfStatusResult,
  RUNTIME_CAPABILITY_STATUS_TTL_MS
} from './runtime-compatibility-cache'

export {
  clearRecentRuntimeCompatibilityFailure,
  clearRuntimeCompatibilityCache,
  markRuntimeEnvironmentCompatible,
  peekRuntimeEnvironmentCapability
} from './runtime-compatibility-cache'

export async function callRuntimeRpc<TResult>(
  target: RuntimeClientTarget,
  method: string,
  params?: unknown,
  options: {
    timeoutMs?: number
    suppressFeatureInteraction?: boolean
    reuseRecentCompatibilityFailure?: boolean
    skipCompatibilityCheck?: boolean
    signal?: AbortSignal
    /** Null: captured earlier as unknown, so it is not read again now. */
    expectedEnvironmentPairingRevision?: number | null
    expectedEnvironmentRuntimeId?: string
    beforeSend?: () => void
    paramsForStatus?: (status: RuntimeStatus | null) => unknown
    /** Local only, never sent: the window's accepted generated request this call carries. */
    generatedInputOperationId?: string
    /** Local only, never sent: that request's own end on this machine. */
    generatedInputEnd?: number
  } = {}
): Promise<TResult> {
  if (options.signal?.aborted) {
    throw createRuntimeRpcAbortError()
  }
  const expectedEnvironmentPairingRevision =
    target.kind === 'environment'
      ? captureRuntimeEnvironmentRequestRevision(
          target.environmentId,
          options.expectedEnvironmentPairingRevision
        )
      : undefined
  const compatibilityStatus =
    target.kind === 'environment' &&
    method !== 'status.get' &&
    options.skipCompatibilityCheck !== true
      ? await waitForPromiseWithSignal(
          ensureRuntimeEnvironmentCompatible(target.environmentId, {
            ...options,
            expectedEnvironmentPairingRevision
          }),
          options.signal
        )
      : null
  if (options.signal?.aborted) {
    throw createRuntimeRpcAbortError()
  }
  const selectedParams = options.paramsForStatus
    ? options.paramsForStatus(compatibilityStatus)
    : params
  const nextParams = options.suppressFeatureInteraction
    ? withBrowserPaneUiRuntimeRpcSource(selectedParams)
    : selectedParams
  options.beforeSend?.()
  const response =
    target.kind === 'local'
      ? await window.api.runtime.call({ method, params: nextParams })
      : await callRuntimeEnvironmentWithRevision({
          environmentId: target.environmentId,
          method,
          params: nextParams,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          expectedEnvironmentPairingRevision,
          expectedEnvironmentRuntimeId:
            options.expectedEnvironmentRuntimeId ??
            (options.paramsForStatus ? compatibilityStatus?.runtimeId : undefined),
          ...(options.generatedInputOperationId
            ? { generatedInputOperationId: options.generatedInputOperationId }
            : {}),
          ...(options.generatedInputEnd === undefined
            ? {}
            : { generatedInputEnd: options.generatedInputEnd })
        })
  return unwrapRuntimeRpcResult<TResult>(response as RuntimeRpcResponse<TResult>)
}

export async function ensureRuntimeEnvironmentCompatible(
  environmentId: string,
  options: {
    timeoutMs?: number
    reuseRecentCompatibilityFailure?: boolean
    expectedEnvironmentPairingRevision?: number
  } = {}
): Promise<RuntimeStatus | null> {
  const cached = getCachedRuntimeCompatibilityCheck(environmentId, options)
  if (cached) {
    await cached.check
    return cached.status
  }
  const entry = compatibilityEntry()
  const check = (async () => {
    const response = await callRuntimeEnvironmentWithRevision({
      environmentId,
      method: 'status.get',
      params: undefined,
      timeoutMs: options.timeoutMs,
      expectedEnvironmentPairingRevision: options.expectedEnvironmentPairingRevision
    })
    const status = unwrapRuntimeRpcResult<RuntimeStatus>(
      response as RuntimeRpcResponse<RuntimeStatus>
    )
    assertRuntimeStatusCompatible(status)
    entry.selection = selectionOfStatusResult(response, options.expectedEnvironmentPairingRevision)
    entry.status = status
    entry.statusCheckedAt = Date.now()
    entry.statusObservedAt = entry.statusCheckedAt
  })()
  entry.check = check
  rememberRuntimeEnvironmentCompatibility(environmentId, entry)
  try {
    await check
    if (runtimeCompatibilityChecks.get(environmentId) === entry) {
      entry.provenCompatible = true
    }
    return entry.status
  } catch (error) {
    if (runtimeCompatibilityChecks.get(environmentId) === entry) {
      // Startup repo/group/folder bursts should pay one offline-host timeout, not three.
      entry.failedAt = Date.now()
    }
    throw error
  }
}

/** What a status call is for, local only: the pairing its caller captured and the window's
 *  accepted generated request it selects a route for, so main fixes that request's pairing. */
export type RuntimeStatusCallOrigin = {
  expectedEnvironmentPairingRevision?: number
  generatedInputOperationId?: string
}

export async function getRuntimeEnvironmentStatus(
  environmentId: string,
  timeoutMs?: number,
  origin: RuntimeStatusCallOrigin = {}
): Promise<RuntimeStatus> {
  return (await getRuntimeEnvironmentStatusEntry(environmentId.trim(), timeoutMs, origin)).status
}

async function getRuntimeEnvironmentStatusEntry(
  trimmed: string,
  timeoutMs: number | undefined,
  origin: RuntimeStatusCallOrigin
): Promise<{ status: RuntimeStatus; entry: RuntimeCompatibilityCacheEntry }> {
  const entry = compatibilityEntry()
  // Publish before awaiting so concurrent cold capability reads share this status probe.
  const check = (async () => {
    const response = await window.api.runtimeEnvironments.call({
      selector: trimmed,
      method: 'status.get',
      timeoutMs,
      ...origin
    })
    const status = unwrapRuntimeRpcResult<RuntimeStatus>(
      response as RuntimeRpcResponse<RuntimeStatus>
    )
    assertRuntimeStatusCompatible(status)
    entry.selection = selectionOfStatusResult(response, origin.expectedEnvironmentPairingRevision)
    entry.status = status
    entry.statusCheckedAt = Date.now()
    entry.statusObservedAt = entry.statusCheckedAt
    entry.provenCompatible = true
  })()
  entry.check = check
  rememberRuntimeEnvironmentCompatibility(trimmed, entry)
  try {
    await check
  } catch (error) {
    // Always-refetched probe failures must not remain cached verdicts; let next call retry.
    if (runtimeCompatibilityChecks.get(trimmed) === entry) {
      runtimeCompatibilityChecks.delete(trimmed)
    }
    throw error
  }
  if (!entry.status) {
    // Unreachable: a resolved probe always assigns status; narrows the type.
    throw new Error('Runtime status probe resolved without a status.')
  }
  return { status: entry.status, entry }
}

/** The capability as last probed, without waiting (for synchronous terminal replies); null before
 *  the environment's first status probe. */
export function readCachedRuntimeEnvironmentCapability(
  environmentId: string,
  capability: RuntimeCapability
): boolean | null {
  const status = runtimeCompatibilityChecks.get(environmentId.trim())?.status
  return status ? status.capabilities?.includes(capability) === true : null
}

/** The status one generated request is routed by, chosen once before anything is awaited: the
 *  environment's fresh or still-pending answer, else one ordinary status read. The chosen entry is
 *  that request's from then on, whatever later replaces or drops the reusable cache slot for
 *  other readers; its failure ends this selection rather than starting another. */
export async function selectRuntimeEnvironmentStatus(
  environmentId: string,
  timeoutMs?: number,
  origin: RuntimeStatusCallOrigin = {}
): Promise<{ status: RuntimeStatus; entry: RuntimeCompatibilityCacheEntry }> {
  const trimmed = environmentId.trim()
  const cached = runtimeCompatibilityChecks.get(trimmed)
  const pending = cached?.status === null && !cached.provenCompatible
  const fresh =
    !!cached?.status &&
    cached.statusCheckedAt !== null &&
    Date.now() - cached.statusCheckedAt < RUNTIME_CAPABILITY_STATUS_TTL_MS
  if (!cached || cached.failedAt !== null || (!pending && !fresh)) {
    return getRuntimeEnvironmentStatusEntry(trimmed, timeoutMs, origin)
  }
  await cached.check
  if (!cached.status) {
    // Unreachable: a resolved status check always assigns its status; narrows the type.
    throw new Error('Runtime status check resolved without a status.')
  }
  return { status: cached.status, entry: cached }
}

/** One status every capability decision of a call reads, with the cache entry it came from: the
 *  fresh cached answer, or one ordinary status probe shared with concurrent readers. */
export async function getRuntimeEnvironmentCapabilityStatus(
  environmentId: string,
  timeoutMs?: number,
  origin: RuntimeStatusCallOrigin = {}
): Promise<{ status: RuntimeStatus; entry: RuntimeCompatibilityCacheEntry }> {
  const trimmed = environmentId.trim()
  const cached = runtimeCompatibilityChecks.get(trimmed)
  // Capability reads must discard rejected probes like ordinary RPCs or a recovered host stays blocked until failure TTL.
  if (cached && cached.failedAt === null) {
    try {
      await cached.check
      if (
        runtimeCompatibilityChecks.get(trimmed) === cached &&
        cached.status &&
        cached.statusCheckedAt !== null &&
        Date.now() - cached.statusCheckedAt < RUNTIME_CAPABILITY_STATUS_TTL_MS
      ) {
        return { status: cached.status, entry: cached }
      }
    } catch {
      // Fall through to a fresh status.get that refreshes the cache.
    }
  }
  return getRuntimeEnvironmentStatusEntry(trimmed, timeoutMs, origin)
}

export {
  assertRuntimeEnvironmentCapability,
  forgetMissingRuntimeCapability,
  runtimeEnvironmentCapabilityProof,
  runtimeEnvironmentSupportsCapabilities,
  runtimeEnvironmentSupportsCapability,
  type RuntimeCapabilityProof
} from './runtime-environment-capability-decisions'

export function clearRuntimeCompatibilityCacheForTests(): void {
  clearRuntimeCompatibilityCache()
}
