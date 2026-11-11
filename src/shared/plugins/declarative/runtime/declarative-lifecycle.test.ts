import { afterEach, describe, expect, it, vi } from 'vitest'
import { atom, read, set } from './declarative-atoms'
import { h } from './declarative-elements'
import {
  createOrcaDeclarativeRuntime,
  type OrcaBridge,
  type OrcaPanelContext
} from './declarative-renderer'

function hostBridge() {
  const handlers = new Map<string, (payload: unknown) => void>()
  const bridge: OrcaBridge = {
    on: (name, handler) => {
      handlers.set(name, handler)
      return { dispose: () => handlers.delete(name) }
    }
  }
  return { bridge, send: (name: string, payload: unknown) => handlers.get(name)?.(payload) }
}

function booted() {
  const posted: { event: string; payload: unknown }[] = []
  const host = hostBridge()
  const runtime = createOrcaDeclarativeRuntime({
    post: (event, payload) => posted.push({ event, payload }),
    schedule: (flush) => queueMicrotask(flush),
    bridge: host.bridge,
    awaitHydration: true
  })
  return { runtime, posted, host }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('components panel lifecycle', () => {
  it('asks for state, renders only after hydration, and hydrates keyed atoms first', async () => {
    const { runtime, posted, host } = booted()
    const count = atom('lifecycle.count', 1, { persist: 'plugin' })
    expect(posted).toEqual([{ event: 'ui.ready', payload: { document: runtime.document } }])
    const booting = runtime.boot({ default: () => h('Text', null, String(read(count))) })
    await Promise.resolve()
    expect(posted).toHaveLength(1)
    host.send('ui.hydrate', {
      panel: { id: 'todos' },
      plugin: { 'lifecycle.count': { version: 1, value: 41 } }
    })
    await booting
    expect(posted.at(-1)).toMatchObject({
      event: 'ui.render',
      payload: { tree: { children: ['41'] } }
    })
  })

  it('migrates or drops a stored value of another version, and resets workspace atoms on switch', () => {
    const { runtime, host } = booted()
    const migrated = atom(
      'lifecycle.migrated',
      { n: 0 },
      {
        persist: 'plugin',
        version: 2,
        migrate: (stored) => ({ n: Number(stored) })
      }
    )
    const dropped = atom('lifecycle.dropped', 'initial', { persist: 'plugin', version: 3 })
    const filter = atom('lifecycle.filter', 'all', { persist: 'workspace' })
    host.send('ui.hydrate', {
      plugin: {
        'lifecycle.migrated': { version: 1, value: 7 },
        'lifecycle.dropped': { version: 1, value: 'old' }
      },
      workspace: { 'lifecycle.filter': { version: 1, value: 'open' } }
    })
    expect(read(migrated)).toEqual({ n: 7 })
    expect(read(dropped)).toBe('initial')
    expect(read(filter)).toBe('open')
    host.send('ui.hydrate', { workspace: {} })
    expect(read(filter)).toBe('all')
    runtime.dispose()
  })

  it('posts persisted changes, debounced, and only plain JSON', async () => {
    vi.useFakeTimers()
    const { runtime, posted, host } = booted()
    const theme = atom('lifecycle.persisted', 'a', { persist: 'workspace' })
    const transient = atom('lifecycle.transient', 'x')
    host.send('ui.hydrate', {})
    set(theme, 'b')
    set(theme, 'c')
    set(transient, 'y')
    vi.advanceTimersByTime(500)
    expect(posted.filter((entry) => entry.event === 'ui.persist')).toEqual([
      {
        event: 'ui.persist',
        payload: {
          document: runtime.document,
          entries: [{ scope: 'workspace', key: 'lifecycle.persisted', version: 1, value: 'c' }]
        }
      }
    ])
    const dated = atom<unknown>('lifecycle.dated', null, { persist: 'plugin' })
    set(dated, new Date(0))
    runtime.flush()
    expect(posted.at(-1)).toMatchObject({
      event: 'ui.error',
      payload: { message: expect.stringContaining('plain JSON') }
    })
    runtime.dispose()
  })

  it('posts an edit made just before a workspace switch with its own workspace’s hydration', () => {
    vi.useFakeTimers()
    const { runtime, posted, host } = booted()
    const draft = atom('lifecycle.switchDraft', '', { persist: 'workspace' })
    host.send('ui.hydrate', { hydration: 1, workspace: {} })
    set(draft, 'typed in A')
    vi.advanceTimersByTime(200)
    host.send('ui.hydrate', {
      hydration: 2,
      workspace: { 'lifecycle.switchDraft': { version: 1, value: 'B saved' } }
    })
    vi.advanceTimersByTime(500)
    expect(read(draft)).toBe('B saved')
    expect(posted.filter((entry) => entry.event === 'ui.persist')).toEqual([
      {
        event: 'ui.persist',
        payload: {
          document: runtime.document,
          hydration: 1,
          entries: [
            { scope: 'workspace', key: 'lifecycle.switchDraft', version: 1, value: 'typed in A' }
          ]
        }
      }
    ])
    runtime.dispose()
  })

  it('flushes plugin-scope edits before a hydrate and tags only writes made after a numbered one', () => {
    vi.useFakeTimers()
    const { runtime, posted, host } = booted()
    const shared = atom('lifecycle.switchShared', 0, { persist: 'plugin' })
    const draft = atom('lifecycle.switchUntagged', '', { persist: 'workspace' })
    // Before any numbered hydrate (an older host) a write carries no hydration at all.
    host.send('ui.hydrate', { workspace: {} })
    set(draft, 'untagged')
    vi.advanceTimersByTime(500)
    host.send('ui.hydrate', { hydration: 3, workspace: {} })
    set(shared, 7)
    set(draft, 'in 3')
    host.send('ui.hydrate', {
      hydration: 4,
      plugin: { 'lifecycle.switchShared': { version: 1, value: 7 } }
    })
    vi.advanceTimersByTime(500)
    const keyed = (key: string) => expect.objectContaining({ key })
    const persists = posted.filter((entry) => entry.event === 'ui.persist')
    expect(persists.map((entry) => entry.payload)).toStrictEqual([
      { document: runtime.document, entries: [keyed('lifecycle.switchUntagged')] },
      {
        document: runtime.document,
        hydration: 3,
        entries: [keyed('lifecycle.switchShared'), keyed('lifecycle.switchUntagged')]
      }
    ])
    expect(read(shared)).toBe(7)
    runtime.dispose()
  })

  it('runs setup with its context and cleans everything up on dispose', async () => {
    const { runtime, host } = booted()
    const disposed = vi.fn()
    const cleanup = vi.fn()
    // An object, not `let`s: TS cannot see the callback assign them before the checks.
    const seen: { signal?: AbortSignal; visible?: boolean } = {}
    host.send('ui.hydrate', { panel: { id: 'todos' }, visible: false })
    await runtime.boot({
      setup: (ctx: OrcaPanelContext) => {
        expect(ctx.panel).toEqual({ id: 'todos' })
        ctx.subscriptions.push({ dispose: disposed })
        seen.signal = ctx.signal
        seen.visible = read(ctx.visible)
        return cleanup
      },
      default: () => h('Text', null, 'x')
    })
    expect(seen.visible).toBe(false)
    runtime.dispose()
    expect(disposed).toHaveBeenCalledOnce()
    expect(cleanup).toHaveBeenCalledOnce()
    expect(seen.signal?.aborted).toBe(true)
  })
})
