// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { RemoteBrowserInputQueue } from './remote-browser-input-queue'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('remote browser input queue', () => {
  it('runs a click after the moves made before it, without waiting for movement to stop', async () => {
    const queue = new RemoteBrowserInputQueue()
    const sent: string[] = []
    const inFlight: (() => void)[] = []
    const hover = queue.latest<string>({
      merge: (_pending, next) => next,
      send: (point) => {
        sent.push(point)
        const send = deferred()
        inFlight.push(send.resolve)
        return send.promise
      }
    })
    hover.push('A')
    await settle()
    hover.push('B')
    hover.push('C')
    void queue.enqueue(async () => {
      sent.push('click')
    })
    hover.push('D')

    // The slow link answers one move at a time while the pointer keeps moving.
    for (let turn = 0; turn < 3; turn += 1) {
      await settle()
      inFlight.shift()?.()
    }
    await settle()

    expect(sent).toEqual(['A', 'C', 'click', 'D'])
  })

  it('sends input parked for a frame before an operation queued after it', async () => {
    const queue = new RemoteBrowserInputQueue()
    const sent: string[] = []
    const wheel = queue.latest<number>({
      perFrame: true,
      merge: (pending, next) => (pending ?? 0) + next,
      send: async (delta) => {
        sent.push(`wheel ${delta}`)
      }
    })
    wheel.push(40)
    wheel.push(60)
    await queue.enqueue(async () => {
      sent.push('key')
    })

    expect(sent).toEqual(['wheel 100', 'key'])
  })
})
