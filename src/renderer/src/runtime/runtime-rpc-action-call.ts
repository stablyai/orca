import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import { withBrowserPaneUiRuntimeRpcSource } from '../../../shared/runtime-rpc-feature-interaction-source'
import { createRuntimeRpcAbortError } from './abortable-runtime-environment-call'
import { captureRuntimeEnvironmentRequestRevision } from './runtime-environment-revision'
import { callRuntimeEnvironmentWithRevision } from './runtime-rpc-environment-call'
import { unwrapRuntimeRpcResult } from './runtime-rpc-result'
import type { RuntimeClientTarget } from './runtime-client-target'
import {
  isRemoteGitRuntimeMethod,
  RuntimeRpcActionDeadline,
  withRuntimeGitOperationTimeout
} from './runtime-rpc-action-deadline'

export type RuntimeRpcCallOptions = {
  timeoutMs?: number
  compatibilityTimeoutMs?: number
  suppressFeatureInteraction?: boolean
  reuseRecentCompatibilityFailure?: boolean
  skipCompatibilityCheck?: boolean
  signal?: AbortSignal
  expectedEnvironmentPairingRevision?: number
}

type RuntimeRpcActionCallDependencies = {
  ensureCompatible: (
    environmentId: string,
    options: {
      timeoutMs?: number
      reuseRecentCompatibilityFailure?: boolean
      expectedEnvironmentPairingRevision?: number
    }
  ) => Promise<void>
  configuredGitTimeoutMs: (environmentId: string) => number | undefined
}

export async function callRuntimeRpcWithDeadline<TResult>(
  target: RuntimeClientTarget,
  method: string,
  params: unknown,
  options: RuntimeRpcCallOptions,
  dependencies: RuntimeRpcActionCallDependencies
): Promise<TResult> {
  const hasGitActionDeadline = isRemoteGitRuntimeMethod(method)
  const deadline = new RuntimeRpcActionDeadline(
    hasGitActionDeadline ? options.timeoutMs : undefined
  )
  const call = async (): Promise<TResult> => {
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
      await dependencies.ensureCompatible(target.environmentId, {
        ...options,
        timeoutMs: hasGitActionDeadline
          ? deadline.boundedPhaseMs(options.compatibilityTimeoutMs ?? options.timeoutMs)
          : (options.compatibilityTimeoutMs ?? options.timeoutMs),
        expectedEnvironmentPairingRevision
      })
    }
    if (target.kind === 'environment' && isRemoteGitRuntimeMethod(method)) {
      deadline.applyConfiguredTimeout(dependencies.configuredGitTimeoutMs(target.environmentId))
    }
    if (options.signal?.aborted) {
      throw createRuntimeRpcAbortError()
    }
    const transportTimeoutMs = hasGitActionDeadline ? deadline.remainingMs() : options.timeoutMs
    const operationParams = withRuntimeGitOperationTimeout(method, params, transportTimeoutMs)
    const nextParams = options.suppressFeatureInteraction
      ? withBrowserPaneUiRuntimeRpcSource(operationParams)
      : operationParams
    const response =
      target.kind === 'local'
        ? await window.api.runtime.call({ method, params: nextParams })
        : await callRuntimeEnvironmentWithRevision({
            environmentId: target.environmentId,
            method,
            params: nextParams,
            timeoutMs: transportTimeoutMs,
            signal: options.signal,
            expectedEnvironmentPairingRevision
          })
    return unwrapRuntimeRpcResult<TResult>(response as RuntimeRpcResponse<TResult>)
  }
  try {
    const request = call()
    return await (hasGitActionDeadline ? deadline.run(request) : request)
  } finally {
    deadline.dispose()
  }
}
