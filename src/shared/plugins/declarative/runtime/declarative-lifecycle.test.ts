import { afterEach, describe, expect, it, vi } from 'vitest'
import { atom, read, set } from './declarative-atoms'
import { h } from './declarative-elements'
import {
  createOrcaDeclarativeRuntime,
  type OrcaBridge,
  type OrcaPanelContext
} from './declarative-renderer'
import { createOrcaSdk } from './declarative-sdk'

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

  it('says clearly when the module has no component', async () => {
    const { runtime, host } = booted()
    host.send('ui.hydrate', {})
    await expect(runtime.boot({ default: 'nope' })).rejects.toThrow(
      /must export a component function as its default export \(got string\)/
    )
  })

  it('refuses duplicate atom keys', () => {
    atom('lifecycle.once', 1)
    expect(() => atom('lifecycle.once', 2)).toThrow(/already used/)
    expect(() => atom('bad key!', 1)).toThrow(/atom key/)
  })
})

describe('orca SDK facade', () => {
  it('times out host calls, and keeps wire events out of on()', async () => {
    vi.useFakeTimers()
    const call = vi.fn(
      (_method: string, _params?: unknown, options?: unknown) =>
        new Promise((_resolve, reject) => {
          const signal: unknown =
            typeof options === 'object' && options !== null && 'signal' in options
              ? options.signal
              : null
          if (signal instanceof AbortSignal) {
            signal.addEventListener('abort', () => reject(new Error('cancelled')))
          }
        })
    )
    const on = vi.fn(() => ({ dispose: () => undefined }))
    const sdk = createOrcaSdk({
      bridge: () => ({ host: { call, has: (name) => name === 'notifications.show' }, on }),
      theme: () => ({ colorScheme: 'dark' })
    })
    const pending = sdk.host.call('workspace.readContext', undefined, { timeoutMs: 50 })
    vi.advanceTimersByTime(60)
    await expect(pending).rejects.toMatchObject({ code: 'timeout', retryable: true })
    expect(sdk.host.has('notifications.show')).toBe(true)
    expect(() => sdk.on('ui.event', () => undefined)).toThrow(/not an event/)
    expect(() => sdk.on('editor.flush', () => undefined)).toThrow(/not an event/)
    sdk.on('theme', () => undefined)
    expect(on).toHaveBeenCalledOnce()
    expect(sdk.ui.has('Input', 'defaultValue')).toBe(true)
    expect(sdk.ui.has('Input', '$edit')).toBe(false)
    expect(sdk.ui.has('Carousel')).toBe(false)
    // Catalog 2 (Orca 1.4.247).
    expect(sdk.ui.catalog).toBe(3)
    expect(sdk.ui.has('RelativeTime', 'format')).toBe(true)
    expect(sdk.ui.has('Table')).toBe(true)
    expect(sdk.ui.has('Table', 'onLoadMore')).toBe(true)
    expect(sdk.ui.has('Button', 'tooltip')).toBe(true)
    expect(sdk.ui.has('Tree', '$edit')).toBe(false)
    expect(sdk.env).toMatchObject({
      locale: 'en',
      client: 'desktop',
      theme: { colorScheme: 'dark' }
    })
    void sdk.shell.openExternal('https://example.com')
    void sdk.files.saveAs({ suggestedName: 'a.bin', data: new Uint8Array([1, 2, 3]).subarray(1) })
    expect(call).toHaveBeenCalledWith(
      'shell.openExternal',
      { url: 'https://example.com' },
      undefined
    )
    const saveParams = call.mock.calls.at(-1)?.[1]
    expect(call.mock.calls.at(-1)?.[0]).toBe('files.saveAs')
    expect(saveParams).toMatchObject({ suggestedName: 'a.bin' })
    const data: unknown =
      typeof saveParams === 'object' && saveParams !== null && 'data' in saveParams
        ? saveParams.data
        : null
    expect(data instanceof ArrayBuffer && [...new Uint8Array(data)]).toEqual([2, 3])
  })
})
