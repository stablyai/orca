import { expect, it } from 'vitest'
import {
  bindPendingBotThreadHost,
  noteBotThreadPaneActivation,
  runBotThreadOpen
} from './bot-thread-open-lifecycle'

function holdOpen(): { promise: Promise<void>; finish: () => void } {
  let finish!: () => void
  const promise = new Promise<void>((resolve) => {
    finish = resolve
  })
  return { promise, finish }
}

it('an earlier pairing cannot absorb or retire a replacement click', async () => {
  const earlier = holdOpen()
  const newer = holdOpen()
  let earlierSignal!: AbortSignal
  let samePairing = true
  const first = runBotThreadOpen('linked thread', (signal) => {
    earlierSignal = signal
    return earlier.promise
  })
  bindPendingBotThreadHost(earlierSignal, () => samePairing)
  const duplicateBeforePairing = runBotThreadOpen('linked thread', () => Promise.resolve())
  expect(duplicateBeforePairing).toBe(first)
  samePairing = false
  const second = runBotThreadOpen('linked thread', () => newer.promise)
  expect(earlierSignal.aborted).toBe(true)

  earlier.finish()
  await first
  const duplicate = runBotThreadOpen('linked thread', () => Promise.resolve())
  expect(duplicate).toBe(second)

  newer.finish()
  await second
})

it.each([true, false])(
  'only deliberate focus confirms a pane reached by hover while a link is pending (pane changes: %s)',
  async (paneChanged) => {
    const held = holdOpen()
    let signal!: AbortSignal
    const open = runBotThreadOpen('linked thread', (openSignal) => {
      signal = openSignal
      return held.promise
    })
    try {
      noteBotThreadPaneActivation('terminal', 'left', 'user', false)
      expect(signal.aborted).toBe(false)

      noteBotThreadPaneActivation('terminal', 'right', 'hover', paneChanged)
      expect(signal.aborted).toBe(false)

      noteBotThreadPaneActivation('terminal', 'right', 'user', false)
      expect(signal.aborted).toBe(true)
    } finally {
      held.finish()
      await open
    }
  }
)
