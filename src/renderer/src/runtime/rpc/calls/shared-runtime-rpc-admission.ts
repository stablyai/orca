import { createRuntimeRpcAbortError } from './abortable-runtime-environment-call'

/** A shared unary call can lose its last waiter before it has any host effects. */
export function createSharedRuntimeRpcAdmission(hasWaiters: () => boolean, forget: () => void) {
  const controller = new AbortController()
  let dispatched = false
  const check = (): void => {
    if (controller.signal.aborted || !hasWaiters()) {
      throw createRuntimeRpcAbortError()
    }
  }
  return {
    signal: controller.signal,
    check,
    beforeSend: (): void => {
      check()
      dispatched = true
    },
    onAbandon: (): void => {
      if (!dispatched && !hasWaiters()) {
        queueMicrotask(() => {
          if (!dispatched && !hasWaiters()) {
            forget()
            controller.abort()
          }
        })
      }
    }
  }
}

export type SharedRuntimeRpcAdmission = ReturnType<typeof createSharedRuntimeRpcAdmission>
