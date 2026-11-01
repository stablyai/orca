import { sharedPromiseSettlementWaiters } from '../../../shared/promise-settlement-waiters'
import { createRuntimeRpcAbortError } from './abortable-runtime-environment-call'

export function withLocalRuntimeRpcDeadline<T>(
  pending: Promise<T>,
  method: string,
  options: { timeoutMs?: number; signal?: AbortSignal }
): Promise<T> {
  if (options.timeoutMs === undefined && options.signal === undefined) {
    return pending
  }
  return sharedPromiseSettlementWaiters(pending).wait({
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    createAbortError: createRuntimeRpcAbortError,
    createTimeoutError: () => new Error(`Runtime request timed out before ${method} completed`)
  })
}
