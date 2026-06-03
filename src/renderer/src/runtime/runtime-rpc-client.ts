import type { GlobalSettings } from '../../../shared/types'
import type { RuntimeRpcFailure, RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { withBrowserPaneUiRuntimeRpcSource } from '../../../shared/runtime-rpc-feature-interaction-source'
import { assertRuntimeStatusCompatible } from './runtime-protocol-compat'

export type RuntimeClientTarget = { kind: 'local' } | { kind: 'environment'; environmentId: string }

const RUNTIME_COMPATIBILITY_CACHE_MAX = 32
const compatibleRuntimeEnvironments = new Map<string, Promise<void>>()

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
  options: { timeoutMs?: number; suppressFeatureInteraction?: boolean } = {}
): Promise<TResult> {
  if (target.kind === 'environment' && method !== 'status.get') {
    await ensureRuntimeEnvironmentCompatible(target.environmentId, options.timeoutMs)
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
  timeoutMs?: number
): Promise<void> {
  const cached = compatibleRuntimeEnvironments.get(environmentId)
  if (cached) {
    compatibleRuntimeEnvironments.delete(environmentId)
    compatibleRuntimeEnvironments.set(environmentId, cached)
    await cached
    return
  }
  const check = (async () => {
    const response = await window.api.runtimeEnvironments.call({
      selector: environmentId,
      method: 'status.get',
      timeoutMs
    })
    const status = unwrapRuntimeRpcResult<RuntimeStatus>(
      response as RuntimeRpcResponse<RuntimeStatus>
    )
    assertRuntimeStatusCompatible(status)
  })()
  rememberRuntimeEnvironmentCompatibility(environmentId, check)
  try {
    await check
  } catch (error) {
    if (compatibleRuntimeEnvironments.get(environmentId) === check) {
      compatibleRuntimeEnvironments.delete(environmentId)
    }
    throw error
  }
}

function rememberRuntimeEnvironmentCompatibility(
  environmentId: string,
  check: Promise<void>
): void {
  // Why: saved/removed remote runtimes can churn through unique ids in long
  // renderer sessions; successful compatibility promises should not grow forever.
  compatibleRuntimeEnvironments.delete(environmentId)
  compatibleRuntimeEnvironments.set(environmentId, check)
  while (compatibleRuntimeEnvironments.size > RUNTIME_COMPATIBILITY_CACHE_MAX) {
    const oldest = compatibleRuntimeEnvironments.keys().next().value
    if (oldest === undefined) {
      break
    }
    compatibleRuntimeEnvironments.delete(oldest)
  }
}

export function clearRuntimeCompatibilityCache(environmentId?: string | null): void {
  const trimmed = environmentId?.trim()
  if (trimmed) {
    compatibleRuntimeEnvironments.delete(trimmed)
    return
  }
  compatibleRuntimeEnvironments.clear()
}

export function markRuntimeEnvironmentCompatible(environmentId: string): void {
  const trimmed = environmentId.trim()
  if (!trimmed) {
    return
  }
  rememberRuntimeEnvironmentCompatibility(trimmed, Promise.resolve())
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
