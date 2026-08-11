import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPendingRendererYieldCountForTesting, yieldToEventLoop } from './event-loop-yield'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('yieldToEventLoop', () => {
  it('uses setImmediate in Node runtimes', async () => {
    const scheduleImmediate = vi.fn((callback: () => void) => queueMicrotask(callback))
    vi.stubEnv('VITEST', 'false')
    vi.stubGlobal('window', undefined)
    vi.stubGlobal('setImmediate', scheduleImmediate)

    await yieldToEventLoop()

    expect(scheduleImmediate).toHaveBeenCalledOnce()
  })

  it('releases callbacks during sustained concurrent renderer yields', async () => {
    const postMessage = vi.fn()
    let peakPendingAfterResolution = 0
    vi.stubEnv('VITEST', 'false')
    vi.stubGlobal('window', {})
    vi.stubGlobal(
      'MessageChannel',
      class {
        port1: { onmessage: ((event: MessageEvent) => void) | null } = { onmessage: null }
        port2 = {
          postMessage: (data: unknown): void => {
            postMessage(data)
            setTimeout(() => this.port1.onmessage?.({ data } as MessageEvent), 0)
          }
        }
      }
    )

    const runProducer = async (): Promise<void> => {
      for (let index = 0; index < 20; index += 1) {
        await yieldToEventLoop()
        peakPendingAfterResolution = Math.max(
          peakPendingAfterResolution,
          getPendingRendererYieldCountForTesting()
        )
      }
    }
    await Promise.all([runProducer(), runProducer()])

    expect(postMessage).toHaveBeenCalledTimes(40)
    expect(peakPendingAfterResolution).toBeLessThanOrEqual(1)
    expect(getPendingRendererYieldCountForTesting()).toBe(0)
  })
})
