import { expect, it } from 'vitest'
import { runBotThreadOpen } from './bot-thread-open-lifecycle'

function holdOpen(): { promise: Promise<void>; finish: () => void } {
  let finish!: () => void
  const promise = new Promise<void>((resolve) => {
    finish = resolve
  })
  return { promise, finish }
}

it('an earlier open cannot retire the newer open after it is canceled', async () => {
  const earlier = holdOpen()
  const newer = holdOpen()
  let earlierSignal: AbortSignal | undefined
  const first = runBotThreadOpen('first thread', (signal) => {
    earlierSignal = signal
    return earlier.promise
  })
  const second = runBotThreadOpen('second thread', () => newer.promise)
  expect(earlierSignal?.aborted).toBe(true)

  earlier.finish()
  await first
  const duplicate = runBotThreadOpen('second thread', () => Promise.resolve())
  expect(duplicate).toBe(second)

  newer.finish()
  await second
})
