import { describe, expect, it, vi } from 'vitest'
import { createStructuredAgentSessionSubscribeAsks } from './structured-agent-session-subscribe-asks'

function viewer(supported: Promise<boolean> | boolean, shown: boolean) {
  const calls: { viewerId: string; shown: boolean }[] = []
  const listeners = new Set<() => void>()
  const state = { shown }
  return {
    calls,
    show: (next: boolean): void => {
      state.shown = next
      listeners.forEach((listener) => listener())
    },
    viewer: {
      supported,
      shown: () => state.shown,
      subscribeShown: (changed: () => void) => {
        listeners.add(changed)
        return () => listeners.delete(changed)
      },
      setShown: async (viewerId: string, next: boolean) => {
        calls.push({ viewerId, shown: next })
      }
    }
  }
}

describe('a live-text viewer', () => {
  it('opens with whether it is shown, and tells the host each change once its stream is up', () => {
    const reader = viewer(true, false)
    const asks = createStructuredAgentSessionSubscribeAsks({ liveTextViewer: reader.viewer })
    const ask = asks.read()
    if (ask instanceof Promise) {
      throw new Error('a local viewer opens in the same turn')
    }
    const id = ask.capabilities?.liveTextViewer?.id
    expect(ask.capabilities?.liveTextViewer).toEqual({ id: expect.any(String), shown: false })

    // Shown before the host registered the stream: sent once it is.
    reader.show(true)
    expect(reader.calls).toEqual([])
    asks.registered()
    expect(reader.calls).toEqual([{ viewerId: id, shown: true }])

    reader.show(true)
    reader.show(false)
    expect(reader.calls).toEqual([
      { viewerId: id, shown: true },
      { viewerId: id, shown: false }
    ])

    asks.dispose()
    reader.show(true)
    expect(reader.calls).toHaveLength(2)
  })

  it('asks nothing and tells nothing when its host lacks the call', async () => {
    const reader = viewer(Promise.resolve(false), true)
    const asks = createStructuredAgentSessionSubscribeAsks({ liveTextViewer: reader.viewer })
    expect((await asks.read()).capabilities).toBeUndefined()
    asks.registered()
    reader.show(false)
    reader.show(true)
    expect(reader.calls).toEqual([])
  })

  it('says it again when a report fails, so the host does not keep the old state', async () => {
    vi.useFakeTimers()
    try {
      const reader = viewer(true, false)
      let failures = 1
      const sent: boolean[] = []
      reader.viewer.setShown = async (_viewerId: string, next: boolean) => {
        sent.push(next)
        if (failures-- > 0) {
          throw new Error('call lost')
        }
      }
      const asks = createStructuredAgentSessionSubscribeAsks({ liveTextViewer: reader.viewer })
      asks.read()
      asks.registered()
      reader.show(true)
      await vi.advanceTimersByTimeAsync(999)
      expect(sent).toEqual([true])
      await vi.advanceTimersByTimeAsync(1)
      expect(sent).toEqual([true, true])
      await vi.advanceTimersByTimeAsync(60_000)
      expect(sent).toEqual([true, true])
      asks.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
