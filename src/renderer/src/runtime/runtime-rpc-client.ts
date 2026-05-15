import type { GlobalSettings } from '../../../shared/types'
import type { RuntimeRpcFailure, RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import { assertRuntimeStatusCompatible } from './runtime-protocol-compat'

export type RuntimeClientTarget = { kind: 'local' } | { kind: 'environment'; environmentId: string }

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
  const ownerId = runtimeEnvironmentId?.trim()
  return ownerId ? { activeRuntimeEnvironmentId: ownerId } : settings
}

export async function callRuntimeRpc<TResult>(
  target: RuntimeClientTarget,
  method: string,
  params?: unknown,
  options: { timeoutMs?: number } = {}
): Promise<TResult> {
  if (target.kind === 'environment' && method !== 'status.get') {
    await ensureRuntimeEnvironmentCompatible(target.environmentId, options.timeoutMs)
  }
  const response =
    target.kind === 'local'
      ? await window.api.runtime.call({ method, params })
      : await window.api.runtimeEnvironments.call({
          selector: target.environmentId,
          method,
          params,
          timeoutMs: options.timeoutMs
        })
  return unwrapRuntimeRpcResult<TResult>(response as RuntimeRpcResponse<TResult>)
}

async function ensureRuntimeEnvironmentCompatible(
  environmentId: string,
  timeoutMs?: number
): Promise<void> {
  const cached = compatibleRuntimeEnvironments.get(environmentId)
  if (cached) {
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
  compatibleRuntimeEnvironments.set(environmentId, check)
  try {
    await check
  } catch (error) {
    compatibleRuntimeEnvironments.delete(environmentId)
    throw error
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

export function clearRuntimeCompatibilityCacheForTests(): void {
  clearRuntimeCompatibilityCache()
}

export function unwrapRuntimeRpcResult<TResult>(response: RuntimeRpcResponse<TResult>): TResult {
  if (response.ok === false) {
    throw new RuntimeRpcCallError(response)
  }
  return response.result
}
