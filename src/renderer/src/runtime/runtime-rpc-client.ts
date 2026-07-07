import type { GlobalSettings } from '../../../shared/types'
import type { RuntimeRpcFailure, RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { RuntimeCapability } from '../../../shared/protocol-version'
import { withBrowserPaneUiRuntimeRpcSource } from '../../../shared/runtime-rpc-feature-interaction-source'
import { assertRuntimeStatusCompatible } from './runtime-protocol-compat'

export type RuntimeClientTarget = { kind: 'local' } | { kind: 'environment'; environmentId: string }

const RUNTIME_COMPATIBILITY_CACHE_MAX = 32
const RECENT_RUNTIME_COMPATIBILITY_FAILURE_TTL_MS = 60_000

type RuntimeCompatibilityCacheEntry = {
  check: Promise<void>
  failedAt: number | null
  reuseFailure: boolean
}

const runtimeCompatibilityChecks = new Map<string, RuntimeCompatibilityCacheEntry>()

export class RuntimeRpcCallError extends Error {
  readonly code: string
  readonly response: RuntimeRpcFailure

  constructor(response: RuntimeRpcFailure) {
    super(response.error.message)
    this.name = 'RuntimeRpcCallError'
    this.code = response.error.code
    this.response = response
  }
}

// Why: mobile-scope device tokens are denied non-allowlisted runtime methods
// with code 'forbidden'. Callers use this to surface one scope-mismatch banner
// instead of silently swallowing the failure into empty/retry-looping UI.
export function isRuntimeScopeForbiddenError(error: unknown): boolean {
  return error instanceof RuntimeRpcCallError && error.code === 'forbidden'
}

export function getActiveRuntimeTarget(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined
): RuntimeClientTarget {
  const environmentId = settings?.activeRuntimeEnvironmentId?.trim()
  if (!environmentId) {
    return { kind: 'local' }
  }
  return { kind: 'environment', environmentId }
}

export function settingsForRuntimeOwner(
  settings: Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined,
  runtimeEnvironmentId: string | null | undefined
): Pick<GlobalSettings, 'activeRuntimeEnvironmentId'> | null | undefined {
  if (runtimeEnvironmentId === null) {
    return { activeRuntimeEnvironmentId: null }
  }
  const ownerId = runtimeEnvironmentId?.trim()
  return ownerId ? { activeRuntimeEnvironmentId: ownerId } : settings
}

export async function callRuntimeRpc<TResult>(
  target: RuntimeClientTarget,
  method: string,
  params?: unknown,
  options: {
    timeoutMs?: number
    suppressFeatureInteraction?: boolean
    reuseRecentCompatibilityFailure?: boolean
  } = {}
): Promise<TResult> {
  if (target.kind === 'environment' && method !== 'status.get') {
    await ensureRuntimeEnvironmentCompatible(target.environmentId, options)
  }
  const nextParams = addFeatureInteractionSource(params, options)
  const response =
    target.kind === 'local'
      ? await window.api.runtime.call({ method, params: nextParams })
      : await window.api.runtimeEnvironments.call({
          selector: target.environmentId,
          method,
          params: nextParams,
          timeoutMs: options.timeoutMs
        })
  return unwrapRuntimeRpcResult<TResult>(response as RuntimeRpcResponse<TResult>)
}

function addFeatureInteractionSource(
  params: unknown,
  options: { suppressFeatureInteraction?: boolean }
): unknown {
  if (!options.suppressFeatureInteraction) {
    return params
  }
  return withBrowserPaneUiRuntimeRpcSource(params)
}

async function ensureRuntimeEnvironmentCompatible(
  environmentId: string,
  options: { timeoutMs?: number; reuseRecentCompatibilityFailure?: boolean } = {}
): Promise<void> {
  const cached = getCachedRuntimeCompatibilityCheck(environmentId, options)
  if (cached) {
    await cached.check
    return
  }
  const entry: RuntimeCompatibilityCacheEntry = {
    check: Promise.resolve(),
    failedAt: null,
    reuseFailure: options.reuseRecentCompatibilityFailure === true
  }
  const check = (async () => {
    const response = await window.api.runtimeEnvironments.call({
      selector: environmentId,
      method: 'status.get',
      timeoutMs: options.timeoutMs
    })
    const status = unwrapRuntimeRpcResult<RuntimeStatus>(
      response as RuntimeRpcResponse<RuntimeStatus>
    )
    assertRuntimeStatusCompatible(status)
  })()
  entry.check = check
  rememberRuntimeEnvironmentCompatibility(environmentId, entry)
  try {
    await check
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
  if (
    cached.failedAt !== null &&
    (!cached.reuseFailure || options.reuseRecentCompatibilityFailure !== true)
  ) {
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
    reuseFailure: false
  })
}

export async function getRuntimeEnvironmentStatus(
  environmentId: string,
  timeoutMs?: number
): Promise<RuntimeStatus> {
  const response = await window.api.runtimeEnvironments.call({
    selector: environmentId,
    method: 'status.get',
    timeoutMs
  })
  const status = unwrapRuntimeRpcResult<RuntimeStatus>(
    response as RuntimeRpcResponse<RuntimeStatus>
  )
  assertRuntimeStatusCompatible(status)
  markRuntimeEnvironmentCompatible(environmentId)
  return status
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

export function unwrapRuntimeRpcResult<TResult>(response: RuntimeRpcResponse<TResult>): TResult {
  if (response.ok === false) {
    throw new RuntimeRpcCallError(response)
  }
  return response.result
}
