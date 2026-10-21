import { getEventListeners } from 'node:events'
import { describe, expect, it } from 'vitest'
import { createPtyPreconnectInputBuffer } from './pty-preconnect-input-buffer'
import { createDeferred } from './pty-connection-test-async'

describe('preconnect input lifetime', () => {
  it('releases abort listeners after repeated successful flushes', async () => {
    const controller = new AbortController()
    const delivered: string[] = []
    for (let index = 0; index < 50; index += 1) {
      const buffer = createPtyPreconnectInputBuffer()
      const text = `paste-${index}`
      const accepted = buffer.enqueueAccepted(text, 'driving', undefined, {
        signal: controller.signal
      })
      await buffer.flush({
        isCurrent: () => true,
        sendInput: () => true,
        sendInputImmediate: () => true,
        sendInputAccepted: async (data) => {
          delivered.push(data)
          return true
        }
      })
      await expect(accepted).resolves.toBe(true)
      expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    }
    expect(delivered).toHaveLength(50)
    controller.abort()
    expect(delivered).toHaveLength(50)
  })

  it('releases queued and active paste listeners on clear while a write is stalled', async () => {
    const controller = new AbortController()
    const buffer = createPtyPreconnectInputBuffer()
    const started = createDeferred<void>()
    const writing = createDeferred<boolean>()
    const first = buffer.enqueueAccepted('active', 'driving', undefined, {
      signal: controller.signal
    })
    const second = buffer.enqueueAccepted('queued', 'driving', undefined, {
      signal: controller.signal
    })
    const flush = buffer.flush({
      isCurrent: () => true,
      sendInput: () => true,
      sendInputImmediate: () => true,
      sendInputAccepted: () => {
        started.resolve()
        return writing.promise
      }
    })
    await started.promise
    buffer.clear()
    await expect(first).resolves.toBe(false)
    await expect(second).resolves.toBe(false)
    await flush
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
    writing.resolve(true)
  })

  it('withdraws an aborted paste without dropping the following input', async () => {
    const controller = new AbortController()
    const buffer = createPtyPreconnectInputBuffer()
    const accepted = buffer.enqueueAccepted('cancelled', 'driving', undefined, {
      signal: controller.signal
    })
    buffer.enqueue('following', 'ordinary', 'driving')
    controller.abort()
    await expect(accepted).resolves.toBe(false)
    const delivered: string[] = []
    await buffer.flush({
      isCurrent: () => true,
      sendInput: (text) => (delivered.push(text), true),
      sendInputImmediate: () => true
    })
    expect(delivered).toEqual(['following'])
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  })
})
