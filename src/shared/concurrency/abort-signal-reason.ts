import { sharedPromiseSettlementWaiters } from './promise-settlement-waiters'

export function abortSignalReason(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) {
    return signal.reason
  }
  return Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
}

/** The signal's own reason, thrown: the abort itself, not a failure it raced. */
export function isAbortSignalReason(signal: AbortSignal | undefined, error: unknown): boolean {
  return signal?.aborted === true && error === abortSignalReason(signal)
}

export function throwIfSignalAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw abortSignalReason(signal)
  }
}

export function waitForPromiseWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) {
    return promise
  }
  return sharedPromiseSettlementWaiters(promise).wait({
    signal,
    deferSettled: true,
    createAbortError: () => abortSignalReason(signal)
  })
}
