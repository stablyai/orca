import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CrashDiagnostics from './crash-diagnostics'

type DiagnosticsModule = typeof CrashDiagnostics
type Listener = (event: unknown) => void

describe('renderer crash diagnostics', () => {
  let diagnostics: DiagnosticsModule
  let listeners: Map<string, Listener[]>
  let recordBreadcrumbMock: ReturnType<typeof vi.fn>
  let setIntervalMock: ReturnType<typeof vi.fn>
  let clearIntervalMock: ReturnType<typeof vi.fn>
  let removeEventListenerMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    listeners = new Map()
    recordBreadcrumbMock = vi.fn()
    setIntervalMock = vi.fn(() => 1)
    clearIntervalMock = vi.fn()
    removeEventListenerMock = vi.fn((type: string, listener: Listener) => {
      listeners.set(
        type,
        (listeners.get(type) ?? []).filter((candidate) => candidate !== listener)
      )
    })
    vi.stubGlobal('window', {
      api: {
        crashReports: {
          recordBreadcrumb: recordBreadcrumbMock
        }
      },
      addEventListener: vi.fn((type: string, listener: Listener) => {
        const current = listeners.get(type) ?? []
        current.push(listener)
        listeners.set(type, current)
      }),
      removeEventListener: removeEventListenerMock,
      setInterval: setIntervalMock,
      clearInterval: clearIntervalMock,
      performance: {
        memory: {
          usedJSHeapSize: 32 * 1024 * 1024,
          totalJSHeapSize: 64 * 1024 * 1024,
          jsHeapSizeLimit: 512 * 1024 * 1024
        }
      }
    })
    vi.doMock('../components/browser-pane/webview-registry', () => ({
      getBrowserWebviewMemoryProfile: () => ({
        browserWebviewCount: 4,
        registeredBrowserGuestCount: 3
      })
    }))
    diagnostics = (await import('./crash-diagnostics')) as DiagnosticsModule
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('records renderer breadcrumbs through preload', () => {
    diagnostics.recordRendererCrashBreadcrumb('renderer_bootstrap_started', { dev: true })

    expect(recordBreadcrumbMock).toHaveBeenCalledWith({
      name: 'renderer_bootstrap_started',
      data: { dev: true }
    })
  })

  it('installs startup, error, rejection, and memory breadcrumbs once', () => {
    diagnostics.installRendererCrashDiagnostics()
    diagnostics.installRendererCrashDiagnostics()

    expect(window.addEventListener).toHaveBeenCalledTimes(2)
    expect(setIntervalMock).toHaveBeenCalledTimes(1)
    expect(recordBreadcrumbMock).toHaveBeenCalledWith({
      name: 'renderer_memory',
      data: {
        reason: 'startup',
        usedHeapMB: 32,
        totalHeapMB: 64,
        heapLimitMB: 512,
        browserWebviews: 4,
        registeredBrowserGuests: 3
      }
    })

    listeners.get('error')?.[0]?.({
      message: 'boom',
      filename: '/Users/test/project/src/main.tsx',
      lineno: 42,
      colno: 7,
      error: new TypeError('bad renderer state')
    })
    expect(recordBreadcrumbMock).toHaveBeenCalledWith({
      name: 'renderer_error',
      data: expect.objectContaining({
        message: 'boom',
        filename: '/Users/test/project/src/main.tsx',
        lineno: 42,
        colno: 7,
        errorType: 'TypeError',
        errorName: 'TypeError',
        errorMessage: 'bad renderer state'
      })
    })

    listeners.get('unhandledrejection')?.[0]?.({ reason: 'missing startup dependency' })
    expect(recordBreadcrumbMock).toHaveBeenCalledWith({
      name: 'renderer_unhandled_rejection',
      data: {
        reasonType: 'string',
        reasonMessage: 'missing startup dependency'
      }
    })
  })

  it('suppresses benign ResizeObserver loop errors instead of recording them', () => {
    diagnostics.installRendererCrashDiagnostics()
    recordBreadcrumbMock.mockClear()

    const preventDefault = vi.fn()
    listeners.get('error')?.[0]?.({
      message: 'ResizeObserver loop completed with undelivered notifications.',
      preventDefault
    })
    listeners.get('error')?.[0]?.({
      message: 'ResizeObserver loop limit exceeded',
      preventDefault
    })

    expect(preventDefault).toHaveBeenCalledTimes(2)
    expect(recordBreadcrumbMock).not.toHaveBeenCalled()
  })

  it('records application errors that only mention a ResizeObserver loop', () => {
    diagnostics.installRendererCrashDiagnostics()
    recordBreadcrumbMock.mockClear()

    const preventDefault = vi.fn()
    listeners.get('error')?.[0]?.({
      message: 'ResizeObserver loop failed while rendering the terminal',
      preventDefault
    })

    expect(preventDefault).not.toHaveBeenCalled()
    expect(recordBreadcrumbMock).toHaveBeenCalledWith({
      name: 'renderer_error',
      data: expect.objectContaining({
        message: 'ResizeObserver loop failed while rendering the terminal'
      })
    })
  })

  it('disposes global listeners and the memory interval', () => {
    diagnostics.installRendererCrashDiagnostics()

    diagnostics._disposeRendererCrashDiagnosticsForTests()

    expect(removeEventListenerMock).toHaveBeenCalledWith('error', expect.any(Function))
    expect(removeEventListenerMock).toHaveBeenCalledWith('unhandledrejection', expect.any(Function))
    expect(clearIntervalMock).toHaveBeenCalledWith(1)
    expect(listeners.get('error')).toHaveLength(0)
    expect(listeners.get('unhandledrejection')).toHaveLength(0)
  })

  it('does not throw when preload is unavailable', () => {
    vi.stubGlobal('window', {})

    expect(() =>
      diagnostics.recordRendererCrashBreadcrumb('renderer_bootstrap_started')
    ).not.toThrow()
  })

  it('emits one-shot renderer_memory_highwater breadcrumbs with profile counts', async () => {
    const memory = (window.performance as unknown as { memory: Record<string, number> }).memory
    memory.usedJSHeapSize = 0.7 * memory.jsHeapSizeLimit
    const getElementsByTagName = vi.fn(() => ({ length: 4321 }))
    const querySelectorAll = vi.fn(() => ({ length: 6 }))
    vi.stubGlobal('document', {
      getElementsByTagName,
      querySelectorAll
    })
    const profile = await import('./renderer-memory-profile')
    const unregister = profile.registerRendererMemoryProfileContributor('store', () => ({
      worktrees: 12
    }))

    diagnostics.installRendererCrashDiagnostics()
    const highwaterCalls = (): unknown[] =>
      recordBreadcrumbMock.mock.calls.filter(
        (call) => (call[0] as { name: string }).name === 'renderer_memory_highwater'
      )
    expect(highwaterCalls()).toHaveLength(1)
    expect(recordBreadcrumbMock).toHaveBeenCalledWith({
      name: 'renderer_memory_highwater',
      data: expect.objectContaining({
        thresholdPct: 60,
        rendererSurface: 'main',
        domNodes: 4321,
        terminalElements: 6,
        browserWebviews: 4,
        registeredBrowserGuests: 3,
        'store.worktrees': 12
      })
    })

    // Why: the interval sampler must not re-emit an already-crossed threshold.
    const tick = setIntervalMock.mock.calls[0][0] as () => void
    tick()
    expect(highwaterCalls()).toHaveLength(1)

    memory.usedJSHeapSize = 0.85 * memory.jsHeapSizeLimit
    tick()
    expect(highwaterCalls()).toHaveLength(2)
    expect(recordBreadcrumbMock).toHaveBeenCalledWith({
      name: 'renderer_memory_highwater',
      data: expect.objectContaining({ thresholdPct: 80 })
    })

    // Why: a heap that jumps straight past 80% must emit both levels at once.
    diagnostics._disposeRendererCrashDiagnosticsForTests()
    recordBreadcrumbMock.mockClear()
    diagnostics.installRendererCrashDiagnostics()
    expect(highwaterCalls()).toHaveLength(2)
    expect(getElementsByTagName).toHaveBeenCalledTimes(3)
    expect(querySelectorAll).toHaveBeenCalledTimes(3)

    unregister()
  })

  it('skips highwater emission when heap readings are not finite', () => {
    const memory = (window.performance as unknown as { memory: Record<string, number> }).memory
    memory.usedJSHeapSize = Number.NaN

    diagnostics.installRendererCrashDiagnostics()

    expect(
      recordBreadcrumbMock.mock.calls.some(
        (call) => (call[0] as { name: string }).name === 'renderer_memory_highwater'
      )
    ).toBe(false)
  })
})
