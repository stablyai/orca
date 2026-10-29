import { Delayer } from 'monaco-editor/esm/vs/base/common/async.js'

const MONACO_CANCELLATION_NAME = 'Canceled'

type MonacoDelayerInstance = {
  cancel: () => void
  completionPromise?: Promise<unknown> | null
}

type GuardedDelayerPrototype = MonacoDelayerInstance & {
  __orcaDelayerCancellationGuardInstalled?: true
}

function isMonacoCancellationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === MONACO_CANCELLATION_NAME &&
    error.message === MONACO_CANCELLATION_NAME
  )
}

export function installMonacoDelayerCancellationGuard(): void {
  const delayerPrototype = Delayer.prototype as GuardedDelayerPrototype
  if (delayerPrototype.__orcaDelayerCancellationGuardInstalled) {
    return
  }

  const originalCancel = delayerPrototype.cancel
  delayerPrototype.cancel = function cancelWithHandledCancellation(this: MonacoDelayerInstance) {
    const completionPromise = this.completionPromise
    if (completionPromise) {
      // Monaco teardown normally cancels Delayers; consume ignored trigger rejections before they surface as unhandled errors.
      void completionPromise.catch((error) => {
        if (!isMonacoCancellationError(error)) {
          throw error
        }
      })
    }
    originalCancel.call(this)
  }
  delayerPrototype.__orcaDelayerCancellationGuardInstalled = true
}
