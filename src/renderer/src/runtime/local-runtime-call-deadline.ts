import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'

/**
 * Runs a desktop (local) runtime RPC, honouring a deadline the caller asked for.
 *
 * Only an explicitly requested `timeoutMs` is applied. There is deliberately no default: a blanket
 * local deadline would reach `agentSession.send`, whose transport-shaped failures are classified as
 * delivery-unknown, and elapsed time is not evidence that a message was not delivered.
 *
 * Like the remote one-shot path, this bounds the caller only -- the main-process work keeps running
 * and its per-session queue stays parked; `StructuredAgentSessionTaskQueue` is what reports that.
 */
export async function callLocalRuntimeWithDeadline(
  method: string,
  params: unknown,
  timeoutMs: number | undefined
): Promise<RuntimeRpcResponse<unknown>> {
  const call = window.api.runtime.call({ method, params })
  if (timeoutMs === undefined) {
    return call
  }
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      call,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(
          () => reject(new Error(`Runtime request timed out before ${method} completed`)),
          timeoutMs
        )
      })
    ])
  } finally {
    clearTimeout(deadline)
  }
}
