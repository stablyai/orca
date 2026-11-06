import { waitForPromiseWithSignal } from '../../../shared/abort-signal-reason'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { RuntimeCapability } from '../../../shared/protocol-version'
import { withBrowserPaneUiRuntimeRpcSource } from '../../../shared/runtime-rpc-feature-interaction-source'
import { assertRuntimeStatusCompatible } from './runtime-protocol-compat'
import { createRuntimeRpcAbortError } from './abortable-runtime-environment-call'
import { callRuntimeEnvironmentWithRevision } from './runtime-rpc-environment-call'
import { unwrapRuntimeRpcResult } from './runtime-rpc-result'
import {
  captureRuntimeEnvironmentRequestRevision,
  getRuntimeEnvironmentRevision,
  resolveContinuedRuntimeEnvironmentRevision
} from './runtime-environment-revision'
import { runtimeEnvironmentPairingChangedError } from './runtime-environment-pairing-refresh'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  clearRuntimeCompatibilityCache,
  compatibilityEntry,
  getCachedRuntimeCompatibilityCheck,
  rememberRuntimeEnvironmentCompatibility,
  runtimeCompatibilityChecks,
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
    expectedEnvironmentPairingRevision?: number
    expectedEnvironmentRuntimeId?: string
    beforeSend?: () => void
    paramsForStatus?: (status: RuntimeStatus | null) => unknown
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
            (options.paramsForStatus ? compatibilityStatus?.runtimeId : undefined)
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

export async function getRuntimeEnvironmentStatus(
  environmentId: string,
  timeoutMs?: number
): Promise<RuntimeStatus> {
  const trimmed = environmentId.trim()
  const entry = compatibilityEntry()
  // Publish before awaiting so concurrent cold capability reads share this status probe.
  const check = (async () => {
    const response = await window.api.runtimeEnvironments.call({
      selector: trimmed,
      method: 'status.get',
      timeoutMs
    })
    const status = unwrapRuntimeRpcResult<RuntimeStatus>(
      response as RuntimeRpcResponse<RuntimeStatus>
    )
    assertRuntimeStatusCompatible(status)
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
  return entry.status
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

export async function runtimeEnvironmentSupportsCapability(
  environmentId: string,
  capability: RuntimeCapability,
  timeoutMs?: number
): Promise<boolean> {
  const [supported] = await runtimeEnvironmentSupportsCapabilities(
    environmentId,
    [capability],
    timeoutMs
  )
  return supported
}

export async function runtimeEnvironmentSupportsCapabilities(
  environmentId: string,
  capabilities: readonly RuntimeCapability[],
  timeoutMs?: number
): Promise<boolean[]> {
  return (await resolveRuntimeEnvironmentCapabilities(environmentId, capabilities, timeoutMs))
    .supported
}

export type RuntimeCapabilityProof = {
  supported: boolean
  runtimeId: string
  pairingRevision: number | undefined
}

/** A capability answer bound to the runtime and pairing that gave it, so a call can be pinned to them. */
export async function runtimeEnvironmentCapabilityProof(
  environmentId: string,
  capability: RuntimeCapability,
  timeoutMs?: number
): Promise<RuntimeCapabilityProof> {
  const trimmed = environmentId.trim()
  const pairingRevision = captureRuntimeEnvironmentRequestRevision(trimmed)
  const { supported, status } = await resolveRuntimeEnvironmentCapabilities(
    trimmed,
    [capability],
    timeoutMs
  )
  // A re-pair while the status was in flight voids its answer, negative included.
  if (
    resolveContinuedRuntimeEnvironmentRevision(trimmed, pairingRevision) !==
    getRuntimeEnvironmentRevision(trimmed)
  ) {
    throw runtimeEnvironmentPairingChangedError()
  }
  return { supported: supported[0], runtimeId: status.runtimeId, pairingRevision }
}

async function resolveRuntimeEnvironmentCapabilities(
  environmentId: string,
  capabilities: readonly RuntimeCapability[],
  timeoutMs?: number
): Promise<{ supported: boolean[]; status: RuntimeStatus }> {
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
        const status = cached.status
        const supported = capabilities.map(
          (capability) => status.capabilities?.includes(capability) === true
        )
        if (supported.includes(false)) {
          // Keep protocol proof for this legacy call; next capability decision must observe in-place upgrades.
          cached.statusCheckedAt = null
        }
        return { supported, status }
      }
    } catch {
      // Fall through to a fresh status.get that refreshes the cache.
    }
  }
  const status = await getRuntimeEnvironmentStatus(trimmed, timeoutMs)
  const supported = capabilities.map(
    (capability) => status.capabilities?.includes(capability) === true
  )
  const resolved = runtimeCompatibilityChecks.get(trimmed)
  // Why runtimeId: a status publication may have replaced the entry with its own copy.
  if (supported.includes(false) && resolved?.status?.runtimeId === status.runtimeId) {
    resolved.statusCheckedAt = null
  }
  return { supported, status }
}

export async function assertRuntimeEnvironmentCapability(
  environmentId: string,
  capability: RuntimeCapability,
  message: string,
  timeoutMs?: number
): Promise<void> {
  if (!(await runtimeEnvironmentSupportsCapability(environmentId, capability, timeoutMs))) {
    throw new Error(message)
  }
}

export function clearRuntimeCompatibilityCacheForTests(): void {
  clearRuntimeCompatibilityCache()
}
