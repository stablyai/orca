import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLUGIN_FRAME_RESERVED_SEGMENT } from '../../frames/plugin-frame-guest'
import { atom, read, set } from './declarative-atoms'
import { h } from './declarative-elements'
import {
  describePluginError,
  ORCA_RESERVED_PATH_PREFIX,
  pluginErrorLocation
} from './declarative-error-location'
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

function entryKeys(payload: unknown): unknown[] {
  const entries =
    typeof payload === 'object' && payload !== null && 'entries' in payload ? payload.entries : null
  return Array.isArray(entries)
    ? entries.map((each: unknown) =>
        typeof each === 'object' && each !== null && 'key' in each ? each.key : null
      )
    : []
}

afterEach(() => {
  vi.useRealTimers()
})

describe('dev hot reload of keyed memory atoms', () => {
  it('seeds keyed memory atoms from the hand-over, dropping a key whose version changed', async () => {
    const { runtime, send } = booted()
    const draft = atom('hot.draft', '')
    const bumped = atom('hot.bumped', { n: 0 }, { version: 2, migrate: () => ({ n: 99 }) })
    const unkeyed = atom('kept out')
    send('ui.hydrate', {
      memory: {
        'hot.draft': { version: 1, value: 'half a thought' },
        'hot.bumped': { version: 1, value: 7 }
      }
    })
    // A version bump starts the atom over; migrate is for persisted values only.
    expect(read(bumped)).toEqual({ n: 0 })
    expect(read(draft)).toBe('half a thought')
    expect(read(unkeyed)).toBe('kept out')
    // Atoms created after hydration (a lazily imported module) seed from it too.
    expect(read(atom('hot.late', 'initial'))).toBe('initial')
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

  it('never posts persisted atoms as retained, nor memory atoms as persisted', () => {
    vi.useFakeTimers()
    const { runtime, send, posted } = booted()
    const saved = atom('hot.saved', 'a', { persist: 'plugin' })
    const kept = atom('hot.kept', 'a')
    send('ui.hydrate', { retain: true })
    set(saved, 'b')
    set(kept, 'b')
    vi.advanceTimersByTime(500)
    const keysOf = (event: string) =>
      posted.filter((entry) => entry.event === event).flatMap((entry) => entryKeys(entry.payload))
    expect(keysOf('ui.persist')).toEqual(['hot.saved'])
    expect(keysOf('ui.retain')).toEqual(['hot.kept'])
    runtime.dispose()
  })
})

describe('plugin error locations', () => {
  const base = 'orca-plugin-frame://0123456789abcdef/'

  it('names the first plugin stack frame, skipping Orca runtime frames', () => {
    const stack = [
      'TypeError: x is undefined',
      `    at evaluate (${base}__orca/orca-runtime.mjs:120:7)`,
      `    at Panel (${base}src/my%20panel.tsx:12:5)`,
      `    at ${base}src/other.ts:1:1`
    ].join('\n')
    expect(pluginErrorLocation(stack, base)).toBe('src/my panel.tsx:12:5')
    const error = Object.assign(new TypeError('x is undefined'), { stack })
    expect(describePluginError(error, base)).toBe('src/my panel.tsx:12:5: x is undefined')
  })

  it("keeps a message that already names its file (Orca's transpile errors)", () => {
    const error = Object.assign(new Error('src/panel.tsx:3:5: Unexpected token'), {
      stack: `Error: src/panel.tsx:3:5: Unexpected token\n    at ${base}src/panel.tsx:1:7`
    })
    expect(describePluginError(error, base)).toBe('src/panel.tsx:3:5: Unexpected token')
  })

  it('falls back to the bare message outside a guest or without a plugin frame', () => {
    expect(describePluginError(new Error('boom'), null)).toBe('boom')
    expect(describePluginError('thrown string', base)).toBe('thrown string')
    expect(ORCA_RESERVED_PATH_PREFIX).toBe(`/${PLUGIN_FRAME_RESERVED_SEGMENT}/`)
  })
})
