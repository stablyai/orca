import { createNonSecureContextUuid as createBrowserUuid } from '../../../../../shared/non-secure-context-uuid'
import type { RuntimeRpcResponse } from '../../../../../shared/runtime-rpc-envelope'

import { callAbortableRuntime, createRuntimeRpcAbortError } from '../../abortable-runtime-call'
export { createRuntimeRpcAbortError } from '../../abortable-runtime-call'

export async function callAbortableRuntimeEnvironment(
  environmentId: string,
  method: string,
  params: unknown,
  timeoutMs: number | undefined,
  signal: AbortSignal,
  expectedEnvironmentPairingRevision?: number,
  expectedEnvironmentRuntimeId?: string
): Promise<RuntimeRpcResponse<unknown>> {
  if (signal.aborted) {
    throw createRuntimeRpcAbortError()
  }
  const subscriptionId = createBrowserUuid()
  return callAbortableRuntime({
    method,
    timeoutMs,
    signal,
    subscribe: (callbacks) =>
      window.api.runtimeEnvironments.subscribe(
        {
          subscriptionId,
          selector: environmentId,
          method,
          params,
          timeoutMs,
          expectedEnvironmentPairingRevision,
          expectedEnvironmentRuntimeId
        },
        callbacks
      ),
    cancelPending: () => {
      void window.api.runtimeEnvironments
        .cancelSubscription({ subscriptionId })
        .catch(() => undefined)
    }
  })
}
