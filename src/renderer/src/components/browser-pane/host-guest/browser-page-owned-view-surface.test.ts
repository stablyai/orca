import { describe, expect, it, vi } from 'vitest'
import type {
  DesktopBrowserViewApi,
  DesktopBrowserViewCommandArgs,
  DesktopBrowserViewEvent,
  DesktopBrowserViewState
} from '../../../../../shared/desktop-browser-view-protocol'
import { createOwnedViewBrowserPageSurface } from './browser-page-owned-view-surface'

function state(
  revision: number,
  overrides: Partial<DesktopBrowserViewState> = {}
): DesktopBrowserViewState {
  return {
    browserPageId: 'page-1',
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    focused: false,
    generation: 'generation-1',
    loadError: null,
    loading: false,
    revision,
    title: `Title ${revision}`,
    url: `https://example.test/${revision}`,
    zoomLevel: 0,
    ...overrides
  }
}

function createApi(
  command: (args: DesktopBrowserViewCommandArgs) => ReturnType<DesktopBrowserViewApi['command']>
): {
  api: DesktopBrowserViewApi
  emit: (event: DesktopBrowserViewEvent) => void
  unsubscribe: ReturnType<typeof vi.fn>
} {
  let listener: ((event: DesktopBrowserViewEvent) => void) | null = null
  const unsubscribe = vi.fn(() => {
    listener = null
  })
  return {
    api: {
      captureViewport: vi.fn(async () => ({
        dataUrl: 'data:image/png;base64,AA==',
        height: 10,
        width: 20
      })),
      close: vi.fn(),
      command: vi.fn(command),
      input: vi.fn(),
      create: vi.fn(),
      onEvent: vi.fn((nextListener) => {
        listener = nextListener
        return unsubscribe
      }),
      updateLayout: vi.fn()
    },
    emit: (event) => listener?.(event),
    unsubscribe
  }
}

describe('createOwnedViewBrowserPageSurface', () => {
  it('delegates capture and stop for its exact identity', async () => {
    const initial = state(1)
    const { api } = createApi(async () => ({ state: initial }))
    const { surface } = createOwnedViewBrowserPageSurface({
      api,
      getBounds: () => null,
      initialState: initial
    })

    await expect(surface.captureViewport()).resolves.toEqual({
      dataUrl: 'data:image/png;base64,AA==',
      height: 10,
      width: 20
    })
    await surface.stop()
    expect(api.captureViewport).toHaveBeenCalledWith({
      browserPageId: 'page-1',
      generation: 'generation-1'
    })
    expect(api.command).toHaveBeenCalledWith({
      browserPageId: 'page-1',
      generation: 'generation-1',
      command: { kind: 'stop' }
    })
  })

  it('accepts only newer state for the exact page generation', () => {
    const initial = state(4)
    const { api, emit } = createApi(async () => ({ state: initial }))
    const onState = vi.fn()
    const { surface } = createOwnedViewBrowserPageSurface({
      api,
      getBounds: () => ({ height: 30, left: 1, top: 2, width: 40 }),
      initialState: initial,
      onState
    })

    emit({ kind: 'state', state: state(4, { title: 'equal' }) })
    emit({ kind: 'state', state: state(3, { title: 'older' }) })
    emit({ kind: 'state', state: state(5, { browserPageId: 'other-page', title: 'other' }) })
    emit({ kind: 'state', state: state(5, { generation: 'other-generation', title: 'other' }) })
    emit({ kind: 'state', state: state(5, { title: 'accepted' }) })

    expect(onState).toHaveBeenCalledTimes(1)
    expect(surface.getSnapshot()).toMatchObject({
      title: 'accepted',
      url: 'https://example.test/5'
    })
    expect(surface.getBounds()).toEqual({ height: 30, left: 1, top: 2, width: 40 })
  })

  it('does not let an older command response overwrite a newer event', async () => {
    let resolveSnapshot!: (value: { state: DesktopBrowserViewState }) => void
    const initial = state(1)
    const { api, emit } = createApi(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve
        })
    )
    const { surface } = createOwnedViewBrowserPageSurface({
      api,
      getBounds: () => null,
      initialState: initial
    })

    surface.refresh()
    emit({ kind: 'state', state: state(3, { title: 'newer event' }) })
    resolveSnapshot({ state: state(2, { title: 'late command' }) })
    await Promise.resolve()

    expect(surface.getSnapshot()).toMatchObject({ title: 'newer event' })
  })

  it('uses a newer accepted event rather than an older snapshot reply for zoom arithmetic', async () => {
    const initial = state(1)
    let resolveSnapshot!: (value: { state: DesktopBrowserViewState }) => void
    let revision = 3
    const { api, emit } = createApi((args) => {
      if (args.command.kind === 'snapshot') {
        return new Promise((resolve) => {
          resolveSnapshot = resolve
        })
      }
      if (args.command.kind === 'zoom') {
        return Promise.resolve({ state: state(++revision, { zoomLevel: args.command.level }) })
      }
      throw new Error(`unexpected command: ${args.command.kind}`)
    })
    const { surface } = createOwnedViewBrowserPageSurface({
      api,
      getBounds: () => null,
      initialState: initial
    })

    const zoom = surface.stepZoom('in')
    await vi.waitFor(() => expect(api.command).toHaveBeenCalledOnce())
    emit({ kind: 'state', state: state(3, { zoomLevel: 1 }) })
    resolveSnapshot({ state: state(2, { zoomLevel: 0 }) })

    await expect(zoom).resolves.toBe(1.5)
    expect(vi.mocked(api.command).mock.calls[1][0].command).toEqual({
      kind: 'zoom',
      level: 1.5
    })
  })

  it('does not report focus from a deferred reply after disposal', async () => {
    const initial = state(1)
    let resolveFocus!: (value: { state: DesktopBrowserViewState }) => void
    const { api } = createApi(
      () =>
        new Promise((resolve) => {
          resolveFocus = resolve
        })
    )
    const { dispose, surface } = createOwnedViewBrowserPageSurface({
      api,
      getBounds: () => null,
      initialState: initial
    })

    const focus = surface.focus()
    dispose()
    resolveFocus({ state: state(2, { focused: true }) })

    await expect(focus).resolves.toBe(false)
  })

  it('serializes zoom from refreshed state so rapid steps preserve increments', async () => {
    const initial = state(1)
    let revision = 1
    let zoom = 0
    const { api } = createApi(async ({ command }) => {
      if (command.kind === 'snapshot') {
        return { state: state(++revision, { zoomLevel: zoom }) }
      }
      if (command.kind === 'zoom') {
        zoom = command.level
        return { state: state(++revision, { zoomLevel: zoom }) }
      }
      return { state: state(++revision, { zoomLevel: zoom }) }
    })
    const { surface } = createOwnedViewBrowserPageSurface({
      api,
      getBounds: () => null,
      initialState: initial
    })

    await expect(Promise.all([surface.stepZoom('in'), surface.stepZoom('in')])).resolves.toEqual([
      0.5, 1
    ])
    expect(vi.mocked(api.command).mock.calls.map(([args]) => args.command)).toEqual([
      { kind: 'snapshot' },
      { kind: 'zoom', level: 0.5 },
      { kind: 'snapshot' },
      { kind: 'zoom', level: 1 }
    ])
  })

  it('matches find events to the active request, including an event delivered before its reply', async () => {
    const initial = state(1)
    let emitFromCommand: ((event: DesktopBrowserViewEvent) => void) | null = null
    const { api, emit } = createApi(async ({ command }) => {
      if (command.kind === 'find') {
        emitFromCommand?.({
          browserPageId: 'page-1',
          generation: 'generation-1',
          kind: 'found-in-page',
          result: { activeMatchOrdinal: 1, finalUpdate: false, matches: 2, requestId: 71 }
        })
        return { findRequestId: 71, state: state(2) }
      }
      return { state: state(2) }
    })
    const { surface } = createOwnedViewBrowserPageSurface({
      api,
      getBounds: () => null,
      initialState: initial
    })
    const listener = vi.fn()
    surface.subscribeFindResults(listener)
    emitFromCommand = emit

    await surface.runFind('needle', { forward: true, findNext: false, matchCase: false })
    emit({
      browserPageId: 'page-1',
      generation: 'generation-1',
      kind: 'found-in-page',
      result: { activeMatchOrdinal: 2, finalUpdate: true, matches: 2, requestId: 71 }
    })
    emit({
      browserPageId: 'page-1',
      generation: 'generation-1',
      kind: 'found-in-page',
      result: { activeMatchOrdinal: 1, finalUpdate: true, matches: 99, requestId: 72 }
    })

    expect(listener).toHaveBeenNthCalledWith(1, { activeMatchOrdinal: 1, matches: 2 })
    expect(listener).toHaveBeenNthCalledWith(2, { activeMatchOrdinal: 2, matches: 2 })
    expect(listener).toHaveBeenCalledTimes(2)
  })

  it('detaches locally without closing, and ignores late state, errors, and events after destruction', async () => {
    let rejectNavigate!: (error: Error) => void
    const initial = state(1)
    const { api, emit, unsubscribe } = createApi(
      () =>
        new Promise((_resolve, reject) => {
          rejectNavigate = reject
        })
    )
    const onDestroyed = vi.fn()
    const onError = vi.fn()
    const { dispose, surface } = createOwnedViewBrowserPageSurface({
      api,
      getBounds: () => null,
      initialState: initial,
      onDestroyed,
      onError
    })
    const pending = surface.navigate('https://next.test/')

    emit({ browserPageId: 'page-1', generation: 'generation-1', kind: 'destroyed' })
    emit({ kind: 'state', state: state(2, { title: 'must ignore' }) })
    rejectNavigate(new Error('late'))
    await expect(pending).rejects.toThrow('late')

    expect(onDestroyed).toHaveBeenCalledOnce()
    expect(onError).not.toHaveBeenCalled()
    expect(surface.isAttached()).toBe(false)
    expect(api.close).not.toHaveBeenCalled()
    expect(unsubscribe).toHaveBeenCalledOnce()

    dispose()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
