// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'

import { prepareRendererForAppRestart } from './renderer-restart-preparation'

describe('prepareRendererForAppRestart', () => {
  it('waits for the durable checkpoint write before the restart proceeds', async () => {
    const eventTarget = new EventTarget()
    const order: string[] = []
    let releaseCheckpoint!: () => void
    eventTarget.addEventListener('beforeunload', () => order.push('staged'))

    const prepared = prepareRendererForAppRestart(eventTarget, {
      startedEventName: 'restart-started',
      abortedEventName: 'restart-aborted',
      awaitCheckpoint: () =>
        new Promise<void>((resolve) => {
          order.push('awaiting-flush')
          releaseCheckpoint = () => {
            order.push('flushed')
            resolve()
          }
        })
    })
    let settled = false
    void prepared.then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(settled).toBe(false)

    releaseCheckpoint()
    await prepared
    expect(order).toEqual(['staged', 'awaiting-flush', 'flushed'])
  })
})
