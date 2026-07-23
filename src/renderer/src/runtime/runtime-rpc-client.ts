import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { RuntimeCapability } from '../../../shared/protocol-version'
import { withBrowserPaneUiRuntimeRpcSource } from '../../../shared/runtime-rpc-feature-interaction-source'
import { assertRuntimeStatusCompatible } from './runtime-protocol-compat'
import { createRuntimeRpcAbortError } from './abortable-runtime-environment-call'
import { callRuntimeEnvironmentWithRevision } from './runtime-rpc-environment-call'
import { RuntimeRpcCallError, unwrapRuntimeRpcResult } from './runtime-rpc-result'
import { captureRuntimeEnvironmentRequestRevision } from './runtime-environment-revision'
import type { RuntimeClientTarget } from './runtime-client-target'

export {
  getActiveRuntimeTarget,
  settingsForRuntimeOwner,
  type RuntimeClientTarget
} from './runtime-client-target'
export { RuntimeRpcCallError, unwrapRuntimeRpcResult } from './runtime-rpc-result'

const RUNTIME_COMPATIBILITY_CACHE_MAX = 32
const RECENT_RUNTIME_COMPATIBILITY_FAILURE_TTL_MS = 60_000
// Why: capability verdicts must eventually follow a saved environment's version changes.
const RUNTIME_CAPABILITY_STATUS_TTL_MS = 60_000

type RuntimeCompatibilityCacheEntry = {
  check: Promise<void>
  failedAt: number | null
  // False while probing so recovery can drop a doomed pending compatibility check.
  provenCompatible: boolean
  status: RuntimeStatus | null
  statusCheckedAt: number | null
}

const runtimeCompatibilityChecks = new Map<string, RuntimeCompatibilityCacheEntry>()

// Why: mobile-scope device tokens are denied non-allowlisted runtime methods
// with code 'forbidden'. Callers use this to surface one scope-mismatch banner
// instead of silently swallowing the failure into empty/retry-looping UI.
export function isRuntimeScopeForbiddenError(error: unknown): boolean {
  return error instanceof RuntimeRpcCallError && error.code === 'forbidden'
}

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
  } = {}
): Promise<TResult> {
  const expectedEnvironmentPairingRevision =
    target.kind === 'environment'
      ? captureRuntimeEnvironmentRequestRevision(
          target.environmentId,
          options.expectedEnvironmentPairingRevision
        )
      : undefined
  if (
    target.kind === 'environment' &&
    method !== 'status.get' &&
    options.skipCompatibilityCheck !== true
  ) {
    await ensureRuntimeEnvironmentCompatible(target.environmentId, {
      ...options,
      expectedEnvironmentPairingRevision
    })
  }
  if (options.signal?.aborted) {
    throw createRuntimeRpcAbortError()
  }
  const nextParams = options.suppressFeatureInteraction
    ? withBrowserPaneUiRuntimeRpcSource(params)
    : params
  const response =
    target.kind === 'local'
      ? await window.api.runtime.call({ method, params: nextParams })
      : await callRuntimeEnvironmentWithRevision({
          environmentId: target.environmentId,
          method,
          params: nextParams,
          timeoutMs: options.timeoutMs,
          signal: options.signal,
          expectedEnvironmentPairingRevision
        })
  return unwrapRuntimeRpcResult<TResult>(response as RuntimeRpcResponse<TResult>)
}

async function ensureRuntimeEnvironmentCompatible(
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
      // Why: startup asks each remote for repos, groups, then folders; an
      // offline runtime should pay one timeout during that burst, not three.
      entry.failedAt = Date.now()
    }
    throw error
  }
}

function getCachedRuntimeCompatibilityCheck(
  environmentId: string,
  options: { reuseRecentCompatibilityFailure?: boolean }
): RuntimeCompatibilityCacheEntry | null {
  const cached = runtimeCompatibilityChecks.get(environmentId)
  if (!cached) {
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
  // Why: saved/removed remote runtimes can churn through unique ids in long
  // renderer sessions; compatibility cache entries should not grow forever.
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

// Why: a live status answer invalidates failures and pending probes from the
// dropped connection; only proven-compatible successes remain reusable.
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
    // Why: a saved endpoint can reconnect to a different runtime version; its predecessor's
    // positive capability verdict must not route a structured request to the replacement.
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
    failedAt: null,
    provenCompatible: true,
    status: null,
    statusCheckedAt: null
  })
}

export async function getRuntimeEnvironmentStatus(
  environmentId: string,
  timeoutMs?: number
): Promise<RuntimeStatus> {
  const trimmed = environmentId.trim()
  const entry: RuntimeCompatibilityCacheEntry = {
    check: Promise.resolve(),
    failedAt: null,
    provenCompatible: false,
    status: null,
    statusCheckedAt: null
  }
  // Why: publish the in-flight probe before awaiting so concurrent cold-cache
  // capability lookups coalesce onto this one status.get (via the cache-hit path
  // in runtimeEnvironmentSupportsCapability) instead of each firing their own.
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
    entry.provenCompatible = true
  })()
  entry.check = check
  rememberRuntimeEnvironmentCompatibility(trimmed, entry)
  try {
    await check
  } catch (error) {
    // Why: this probe always re-fetches, so a failure must not linger as a
    // cached verdict; drop the entry so the next call re-probes cleanly.
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

export async function runtimeEnvironmentSupportsCapability(
  environmentId: string,
  capability: RuntimeCapability,
  timeoutMs?: number
): Promise<boolean> {
  const trimmed = environmentId.trim()
  const cached = runtimeCompatibilityChecks.get(trimmed)
  // Why: callRuntimeRpc re-probes after failed status checks by default. Capability
  // lookups must not pin to a rejected cache promise or they block recovery for
  // the full failure TTL even though the next RPC would re-probe successfully.
  if (cached && cached.failedAt === null) {
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
          // Why: retain protocol proof for this legacy dispatch, but force the
          // next capability decision to observe an in-place host upgrade.
          cached.statusCheckedAt = null
        }
        return supported
      }
    } catch {
      // Fall through to a fresh status.get that refreshes the cache.
    }
  }
  const status = await getRuntimeEnvironmentStatus(trimmed, timeoutMs)
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
