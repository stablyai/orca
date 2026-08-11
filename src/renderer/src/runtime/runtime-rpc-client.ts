import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { withBrowserPaneUiRuntimeRpcSource } from '../../../shared/runtime-rpc-feature-interaction-source'
import { createRuntimeRpcAbortError } from './abortable-runtime-environment-call'
import { captureRuntimeEnvironmentRequestRevision } from './runtime-environment-revision'
import type { RuntimeClientTarget } from './runtime-client-target'
import { ensureRuntimeEnvironmentCompatible } from './runtime-rpc-compatibility'
import { callRuntimeEnvironmentWithRevision } from './runtime-rpc-environment-call'
import { RuntimeRpcCallError, unwrapRuntimeRpcResult } from './runtime-rpc-result'

export {
  getActiveRuntimeTarget,
  settingsForRuntimeOwner,
  type RuntimeClientTarget
} from './runtime-client-target'
export {
  assertRuntimeEnvironmentCapability,
  clearRecentRuntimeCompatibilityFailure,
  clearRuntimeCompatibilityCache,
  clearRuntimeCompatibilityCacheForTests,
  getRuntimeEnvironmentStatus,
  markRuntimeEnvironmentCompatible,
  runtimeEnvironmentSupportsCapability
} from './runtime-rpc-compatibility'
export {
  hasRuntimeRpcErrorCode,
  RuntimeRpcCallError,
  unwrapRuntimeRpcResult
} from './runtime-rpc-result'

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
