import { describe, expect, it } from 'vitest'
import { Delayer } from 'monaco-editor/esm/vs/base/common/async.js'
import { DisposableStore } from 'monaco-editor/esm/vs/base/common/lifecycle.js'
import { installMonacoDelayerCancellationGuard } from './monaco-delayer-cancellation-guard'

const UNHANDLED_REJECTION_SETTLE_MS = 20

async function collectUnhandledRejections(run: () => void): Promise<unknown[]> {
  const reasons: unknown[] = []
  const onUnhandledRejection = (reason: unknown): void => {
    reasons.push(reason)
  }

  process.on('unhandledRejection', onUnhandledRejection)
  try {
    run()
    await new Promise((resolve) => setTimeout(resolve, UNHANDLED_REJECTION_SETTLE_MS))
  } finally {
    process.off('unhandledRejection', onUnhandledRejection)
  }

  return reasons
}

describe('installMonacoDelayerCancellationGuard', () => {
  it('marks DisposableStore Delayer cancellation as handled when the trigger promise is ignored', async () => {
    installMonacoDelayerCancellationGuard()
    installMonacoDelayerCancellationGuard()

    const unhandledRejections = await collectUnhandledRejections(() => {
      const store = new DisposableStore()
      const delayer = store.add(new Delayer(1000))
      delayer.trigger(() => undefined)

      store.dispose()
    })

    expect(unhandledRejections).toEqual([])
  })

  it('keeps cancellation visible to callers that await the trigger promise', async () => {
    installMonacoDelayerCancellationGuard()

    const delayer = new Delayer(1000)
    const promise = delayer.trigger(() => undefined)
    delayer.cancel()

    await expect(promise).rejects.toMatchObject({
      name: 'Canceled',
      message: 'Canceled'
    })
  })
})
