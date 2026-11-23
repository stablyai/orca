import { waitForPromiseWithSignal } from '../../../../../shared/concurrency/abort-signal-reason'
import type {
  RuntimeRpcResponse,
  RuntimeRpcSuccess
} from '../../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { RuntimeStatus } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { withBrowserPaneUiRuntimeRpcSource } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-feature-interaction-source'
import { createRuntimeRpcAbortError } from './abortable-runtime-environment-call'
import { callRuntimeEnvironmentWithRevision } from './runtime-rpc-environment-call'
import { RuntimeRpcCallError } from './runtime-rpc-result'
import { hasRecentUserGestureFor, isBackgroundRuntimeRead } from './runtime-rpc-background-read'
import { captureRuntimeEnvironmentRequestRevision } from '../environment-revisions/runtime-environment-revision'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { ensureRuntimeEnvironmentCompatible } from '../compatibility/runtime-compatibility-probe'

type RuntimeRpcCallOptions = {
  timeoutMs?: number
  suppressFeatureInteraction?: boolean
  reuseRecentCompatibilityFailure?: boolean
  skipCompatibilityCheck?: boolean
  signal?: AbortSignal
  expectedEnvironmentPairingRevision?: number
  expectedEnvironmentRuntimeId?: string
  beforeSend?: () => void
  paramsForStatus?: (status: RuntimeStatus | null) => unknown
  /** A poll or refresh the user didn't ask for: no use of an idle WSL host (#46567). */
  background?: boolean
  /** The user asked for it: it may wake a WSL host Orca stopped idle. Defaults to a recent gesture. */
  wake?: boolean
}

export async function callRuntimeRpc<TResult>(
  target: RuntimeClientTarget,
  method: string,
  params?: unknown,
  options: RuntimeRpcCallOptions = {}
): Promise<TResult> {
  return (await callRuntimeRpcResponse<TResult>(target, method, params, options)).result
}

export async function callRuntimeRpcResponse<TResult>(
  target: RuntimeClientTarget,
  method: string,
  params?: unknown,
  options: RuntimeRpcCallOptions = {}
): Promise<RuntimeRpcSuccess<TResult>> {
  if (options.signal?.aborted) {
    throw createRuntimeRpcAbortError()
  }
  const background = options.background ?? isBackgroundRuntimeRead(params)
  // Captured before any await: only a call made while the user acts may boot a stopped host.
  const wake =
    options.wake ??
    (!background && target.kind === 'environment' && hasRecentUserGestureFor(target.environmentId))
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
            expectedEnvironmentPairingRevision,
            wake
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
          background,
          wake
        })
  const envelope = response as RuntimeRpcResponse<TResult>
  if (!envelope.ok) {
    throw new RuntimeRpcCallError(envelope, target)
  }
  return envelope
}
