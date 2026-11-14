import { afterEach, describe, expect, it, vi } from 'vitest'
import { atom, read, set } from './declarative-atoms'
import { h } from './declarative-elements'
import { createOrcaDeclarativeRuntime, type OrcaBridge } from './declarative-renderer'

function booted() {
  const posted: { event: string; payload: unknown }[] = []
  const handlers = new Map<string, (payload: unknown) => void>()
  const bridge: OrcaBridge = {
    on: (name, handler) => {
      handlers.set(name, handler)
      return { dispose: () => handlers.delete(name) }
    }
  }
  const runtime = createOrcaDeclarativeRuntime({
    post: (event, payload) => posted.push({ event, payload }),
    schedule: (flush) => queueMicrotask(flush),
    bridge,
    awaitHydration: true
  })
  const send = (name: string, payload: unknown) => handlers.get(name)?.(payload)
  const retained = () =>
    posted.filter((entry) => entry.event === 'ui.retain').map((entry) => entry.payload)
  return { runtime, posted, send, retained }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('dev hot reload of keyed memory atoms', () => {
  it('seeds keyed memory atoms from the hand-over, dropping a key whose version changed', async () => {
    const { runtime, send } = booted()
    const draft = atom('hot.draft', '')
    const bumped = atom('hot.bumped', { n: 0 }, { version: 2, migrate: () => ({ n: 99 }) })
    send('ui.hydrate', {
      memory: {
        'hot.draft': { version: 1, value: 'half a thought' },
        'hot.bumped': { version: 1, value: 7 }
      }
    })
    // A version bump starts the atom over; migrate is for persisted values only.
    expect(read(bumped)).toEqual({ n: 0 })
    expect(read(draft)).toBe('half a thought')
    await runtime.boot({ default: () => h('Text', null, read(draft)) })
    runtime.dispose()
  })

  it('posts keyed memory changes only once Orca asks, and non-JSON values as a drop', () => {
    vi.useFakeTimers()
    const { runtime, send, retained } = booted()
    const count = atom('hot.count', 0)
    const handle = atom<unknown>('hot.handle', null)
    const anonymous = atom(0)
    send('ui.hydrate', {})
    set(count, 1)
    vi.advanceTimersByTime(100)
    expect(retained()).toEqual([])

    send('ui.hydrate', { retain: true })
    set(count, 2)
    set(count, 3)
    set(handle, () => undefined)
    set(anonymous, 5)
    vi.advanceTimersByTime(100)
    expect(retained()).toEqual([
      {
        document: runtime.document,
        entries: [
          { key: 'hot.count', version: 1, value: 3 },
          { key: 'hot.handle', version: 1 }
        ]
      }
    ])
    // Dispose flushes what is still pending, then stops watching.
    set(count, 4)
    runtime.dispose()
    expect(retained().at(-1)).toEqual({
      document: runtime.document,
      entries: [{ key: 'hot.count', version: 1, value: 4 }]
    })
    set(count, 5)
    vi.advanceTimersByTime(100)
    expect(retained()).toHaveLength(2)
  })
})
