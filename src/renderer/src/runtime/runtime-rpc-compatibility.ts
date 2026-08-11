import type { RuntimeCapability } from '../../../shared/protocol-version'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { captureRuntimeEnvironmentRequestRevision } from './runtime-environment-revision'
import { assertRuntimeStatusCompatible } from './runtime-protocol-compat'
import { unwrapRuntimeRpcResult } from './runtime-rpc-result'

const RUNTIME_COMPATIBILITY_CACHE_MAX = 32
const RECENT_RUNTIME_COMPATIBILITY_FAILURE_TTL_MS = 60_000
const RUNTIME_CAPABILITY_STATUS_TTL_MS = 60_000

type RuntimeCompatibilityCacheEntry = {
  check: Promise<void>
  expectedEnvironmentPairingRevision: number | undefined
  failedAt: number | null
  provenCompatible: boolean
  status: RuntimeStatus | null
  statusCheckedAt: number | null
}

const runtimeCompatibilityChecks = new Map<string, RuntimeCompatibilityCacheEntry>()

export async function ensureRuntimeEnvironmentCompatible(
  environmentId: string,
  options: {
    timeoutMs?: number
    reuseRecentCompatibilityFailure?: boolean
    expectedEnvironmentPairingRevision?: number
  } = {}
): Promise<void> {
  const cached = getCachedRuntimeCompatibilityCheck(environmentId, options)
  if (cached) {
    await cached.check
    return
  }
  const entry: RuntimeCompatibilityCacheEntry = {
    check: Promise.resolve(),
    expectedEnvironmentPairingRevision: options.expectedEnvironmentPairingRevision,
    failedAt: null,
    provenCompatible: false,
    status: null,
    statusCheckedAt: null
  }
  const check = (async () => {
    const response = await window.api.runtimeEnvironments.call({
      selector: environmentId,
      method: 'status.get',
      timeoutMs: options.timeoutMs,
      expectedEnvironmentPairingRevision: options.expectedEnvironmentPairingRevision
    })
    const status = unwrapRuntimeRpcResult<RuntimeStatus>(
      response as RuntimeRpcResponse<RuntimeStatus>
    )
    assertRuntimeStatusCompatible(status)
    entry.status = status
    entry.statusCheckedAt = Date.now()
  })()
  entry.check = check
  rememberRuntimeEnvironmentCompatibility(environmentId, entry)
  try {
    await check
    if (runtimeCompatibilityChecks.get(environmentId) === entry) {
      entry.provenCompatible = true
    }
  } catch (error) {
    if (runtimeCompatibilityChecks.get(environmentId) === entry) {
      // Why: startup asks each remote for several catalogs; an offline runtime should pay one timeout per burst.
      entry.failedAt = Date.now()
    }
    throw error
  }
}

function getCachedRuntimeCompatibilityCheck(
  environmentId: string,
  options: {
    reuseRecentCompatibilityFailure?: boolean
    expectedEnvironmentPairingRevision?: number
  }
): RuntimeCompatibilityCacheEntry | null {
  const cached = runtimeCompatibilityChecks.get(environmentId)
  if (
    !cached ||
    cached.expectedEnvironmentPairingRevision !== options.expectedEnvironmentPairingRevision
  ) {
    return null
  }
  if (
    cached.failedAt !== null &&
    Date.now() - cached.failedAt >= RECENT_RUNTIME_COMPATIBILITY_FAILURE_TTL_MS
  ) {
    runtimeCompatibilityChecks.delete(environmentId)
    return null
  }
  if (cached.failedAt !== null && options.reuseRecentCompatibilityFailure !== true) {
    return null
  }
  runtimeCompatibilityChecks.delete(environmentId)
  runtimeCompatibilityChecks.set(environmentId, cached)
  return cached
}

function rememberRuntimeEnvironmentCompatibility(
  environmentId: string,
  entry: RuntimeCompatibilityCacheEntry
): void {
  runtimeCompatibilityChecks.delete(environmentId)
  runtimeCompatibilityChecks.set(environmentId, entry)
  while (runtimeCompatibilityChecks.size > RUNTIME_COMPATIBILITY_CACHE_MAX) {
    const oldest = runtimeCompatibilityChecks.keys().next().value
    if (oldest === undefined) {
      break
    }
    runtimeCompatibilityChecks.delete(oldest)
  }
}

export function clearRecentRuntimeCompatibilityFailure(
  environmentId: string,
  observedStatus?: RuntimeStatus
): void {
  const trimmed = environmentId.trim()
  if (!trimmed) {
    return
  }
  const cached = runtimeCompatibilityChecks.get(trimmed)
  if (
    cached &&
    (!cached.provenCompatible ||
      (observedStatus &&
        cached.status !== null &&
        cached.status.runtimeId !== observedStatus.runtimeId))
  ) {
    // Why: a saved endpoint can reconnect to a different runtime version; never reuse its predecessor's verdict.
    runtimeCompatibilityChecks.delete(trimmed)
  }
}

export function clearRuntimeCompatibilityCache(environmentId?: string | null): void {
  const trimmed = environmentId?.trim()
  if (trimmed) {
    runtimeCompatibilityChecks.delete(trimmed)
    return
  }
  runtimeCompatibilityChecks.clear()
}

export function markRuntimeEnvironmentCompatible(environmentId: string): void {
  const trimmed = environmentId.trim()
  if (!trimmed) {
    return
  }
  rememberRuntimeEnvironmentCompatibility(trimmed, {
    check: Promise.resolve(),
    expectedEnvironmentPairingRevision: captureRuntimeEnvironmentRequestRevision(trimmed),
    failedAt: null,
    provenCompatible: true,
    status: null,
    statusCheckedAt: null
  })
}

type RuntimeEnvironmentStatusOptions = {
  timeoutMs?: number
  expectedEnvironmentPairingRevision?: number
}

function normalizeRuntimeEnvironmentStatusOptions(
  options: number | RuntimeEnvironmentStatusOptions | undefined
): RuntimeEnvironmentStatusOptions {
  return typeof options === 'number' ? { timeoutMs: options } : (options ?? {})
}

export async function getRuntimeEnvironmentStatus(
  environmentId: string,
  options?: number | RuntimeEnvironmentStatusOptions
): Promise<RuntimeStatus> {
  const trimmed = environmentId.trim()
  const normalizedOptions = normalizeRuntimeEnvironmentStatusOptions(options)
  const expectedEnvironmentPairingRevision = captureRuntimeEnvironmentRequestRevision(
    trimmed,
    normalizedOptions.expectedEnvironmentPairingRevision
  )
  const entry: RuntimeCompatibilityCacheEntry = {
    check: Promise.resolve(),
    expectedEnvironmentPairingRevision,
    failedAt: null,
    provenCompatible: false,
    status: null,
    statusCheckedAt: null
  }
  const check = (async () => {
    const response = await window.api.runtimeEnvironments.call({
      selector: trimmed,
      method: 'status.get',
      timeoutMs: normalizedOptions.timeoutMs,
      expectedEnvironmentPairingRevision
    })
    const status = unwrapRuntimeRpcResult<RuntimeStatus>(
      response as RuntimeRpcResponse<RuntimeStatus>
    )
    assertRuntimeStatusCompatible(status)
    entry.status = status
    entry.statusCheckedAt = Date.now()
    entry.provenCompatible = true
  })()
  entry.check = check
  rememberRuntimeEnvironmentCompatibility(trimmed, entry)
  try {
    await check
  } catch (error) {
    if (runtimeCompatibilityChecks.get(trimmed) === entry) {
      runtimeCompatibilityChecks.delete(trimmed)
    }
    throw error
  }
  if (!entry.status) {
    throw new Error('Runtime status probe resolved without a status.')
  }
  return entry.status
}

export async function runtimeEnvironmentSupportsCapability(
  environmentId: string,
  capability: RuntimeCapability,
  options?: number | RuntimeEnvironmentStatusOptions
): Promise<boolean> {
  const trimmed = environmentId.trim()
  const normalizedOptions = normalizeRuntimeEnvironmentStatusOptions(options)
  const expectedEnvironmentPairingRevision = captureRuntimeEnvironmentRequestRevision(
    trimmed,
    normalizedOptions.expectedEnvironmentPairingRevision
  )
  const cached = runtimeCompatibilityChecks.get(trimmed)
  if (
    cached &&
    cached.failedAt === null &&
    cached.expectedEnvironmentPairingRevision === expectedEnvironmentPairingRevision
  ) {
    try {
      await cached.check
      if (
        runtimeCompatibilityChecks.get(trimmed) === cached &&
        cached.status &&
        cached.statusCheckedAt !== null &&
        Date.now() - cached.statusCheckedAt < RUNTIME_CAPABILITY_STATUS_TTL_MS
      ) {
        const supported = cached.status.capabilities?.includes(capability) === true
        if (!supported) {
          cached.statusCheckedAt = null
        }
        return supported
      }
    } catch {
      // Fall through to a fresh status probe.
    }
  }
  const status = await getRuntimeEnvironmentStatus(trimmed, {
    ...normalizedOptions,
    expectedEnvironmentPairingRevision
  })
  const supported = status.capabilities?.includes(capability) === true
  const resolved = runtimeCompatibilityChecks.get(trimmed)
  if (!supported && resolved?.status === status) {
    resolved.statusCheckedAt = null
  }
  return supported
}

export async function assertRuntimeEnvironmentCapability(
  environmentId: string,
  capability: RuntimeCapability,
  message: string,
  timeoutMs?: number
): Promise<void> {
  const status = await getRuntimeEnvironmentStatus(environmentId, timeoutMs)
  if (!status.capabilities?.includes(capability)) {
    throw new Error(message)
  }
}

export function clearRuntimeCompatibilityCacheForTests(): void {
  clearRuntimeCompatibilityCache()
}
