import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as CrashDiagnostics from './crash-diagnostics'
import { consumePendingRendererRecoveryNotification } from './renderer-recovery-notification'

type DiagnosticsModule = typeof CrashDiagnostics
type Listener = (event: unknown) => void

describe('renderer crash diagnostics', () => {
  let diagnostics: DiagnosticsModule
  let listeners: Map<string, Listener[]>
  let recordBreadcrumbMock: ReturnType<typeof vi.fn>
  let setIntervalMock: ReturnType<typeof vi.fn>
  let clearIntervalMock: ReturnType<typeof vi.fn>
  let removeEventListenerMock: ReturnType<typeof vi.fn>
  let intervalCallback: (() => void) | null
  let performanceMemory: {
    usedJSHeapSize: number
    totalJSHeapSize: number
    jsHeapSizeLimit: number
  }
  let reloadMock: ReturnType<typeof vi.fn>
  let sessionStorageValues: Map<string, string>

  beforeEach(async () => {
    vi.resetModules()
    listeners = new Map()
    recordBreadcrumbMock = vi.fn()
    intervalCallback = null
    performanceMemory = {
      usedJSHeapSize: 32 * 1024 * 1024,
      totalJSHeapSize: 64 * 1024 * 1024,
      jsHeapSizeLimit: 512 * 1024 * 1024
    }
    reloadMock = vi.fn()
    sessionStorageValues = new Map()
    setIntervalMock = vi.fn((callback: () => void) => {
      intervalCallback = callback
      return 1
    })
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
      sessionStorage: {
        getItem: vi.fn((key: string) => sessionStorageValues.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => {
          sessionStorageValues.set(key, value)
        }),
        removeItem: vi.fn((key: string) => {
          sessionStorageValues.delete(key)
        })
      },
      location: {
        reload: reloadMock
      },
      performance: {
        memory: performanceMemory
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

  it('reloads once when renderer heap pressure stays near the limit', () => {
    diagnostics.installRendererCrashDiagnostics()
    performanceMemory.usedJSHeapSize = 920 * 1024 * 1024
    performanceMemory.totalJSHeapSize = 1024 * 1024 * 1024
    performanceMemory.jsHeapSizeLimit = 1024 * 1024 * 1024

    intervalCallback?.()
    expect(reloadMock).not.toHaveBeenCalled()

    intervalCallback?.()

    expect(recordBreadcrumbMock).toHaveBeenCalledWith({
      name: 'renderer_memory_pressure_reload',
      data: {
        reason: 'interval',
        usedHeapMB: 920,
        totalHeapMB: 1024,
        heapLimitMB: 1024,
        heapUsageRatio: 0.9,
        browserWebviews: 4,
        registeredBrowserGuests: 3
      }
    })
    expect(reloadMock).toHaveBeenCalledTimes(1)
    expect(consumePendingRendererRecoveryNotification()).toEqual({
      reason: 'memory-pressure-reload'
    })

    intervalCallback?.()
    expect(reloadMock).toHaveBeenCalledTimes(1)
  })

  it('lets a critical startup sample and first interval sample trigger heap recovery', () => {
    performanceMemory.usedJSHeapSize = 920 * 1024 * 1024
    performanceMemory.totalJSHeapSize = 1024 * 1024 * 1024
    performanceMemory.jsHeapSizeLimit = 1024 * 1024 * 1024

    diagnostics.installRendererCrashDiagnostics()
    expect(reloadMock).not.toHaveBeenCalled()

    intervalCallback?.()

    expect(recordBreadcrumbMock).toHaveBeenCalledWith({
      name: 'renderer_memory_pressure_reload',
      data: {
        reason: 'interval',
        usedHeapMB: 920,
        totalHeapMB: 1024,
        heapLimitMB: 1024,
        heapUsageRatio: 0.9,
        browserWebviews: 4,
        registeredBrowserGuests: 3
      }
    })
    expect(reloadMock).toHaveBeenCalledTimes(1)
    expect(consumePendingRendererRecoveryNotification()).toEqual({
      reason: 'memory-pressure-reload'
    })
  })

  it('uses the preload app reload bridge for renderer heap pressure recovery', () => {
    const appReloadMock = vi.fn().mockResolvedValue(undefined)
    ;(window as unknown as { api: { app: { reload: ReturnType<typeof vi.fn> } } }).api.app = {
      reload: appReloadMock
    }

    diagnostics.installRendererCrashDiagnostics()
    performanceMemory.usedJSHeapSize = 920 * 1024 * 1024
    performanceMemory.totalJSHeapSize = 1024 * 1024 * 1024
    performanceMemory.jsHeapSizeLimit = 1024 * 1024 * 1024

    intervalCallback?.()
    intervalCallback?.()

    expect(appReloadMock).toHaveBeenCalledTimes(1)
    expect(reloadMock).not.toHaveBeenCalled()
    expect(consumePendingRendererRecoveryNotification()).toEqual({
      reason: 'memory-pressure-reload'
    })
  })

  it('fails closed when heap recovery cannot write its reload guard', () => {
    const sessionStorage = (
      window as unknown as {
        sessionStorage: { setItem: ReturnType<typeof vi.fn> }
      }
    ).sessionStorage
    sessionStorage.setItem.mockImplementation(() => {
      throw new Error('storage write blocked')
    })

    diagnostics.installRendererCrashDiagnostics()
    performanceMemory.usedJSHeapSize = 920 * 1024 * 1024
    performanceMemory.totalJSHeapSize = 1024 * 1024 * 1024
    performanceMemory.jsHeapSizeLimit = 1024 * 1024 * 1024

    intervalCallback?.()
    intervalCallback?.()

    expect(recordBreadcrumbMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'renderer_memory_pressure_reload' })
    )
    expect(reloadMock).not.toHaveBeenCalled()
    expect(consumePendingRendererRecoveryNotification()).toBeNull()
  })

  it('resets critical heap pressure count after a healthy sample', () => {
    diagnostics.installRendererCrashDiagnostics()
    performanceMemory.usedJSHeapSize = 920 * 1024 * 1024
    performanceMemory.totalJSHeapSize = 1024 * 1024 * 1024
    performanceMemory.jsHeapSizeLimit = 1024 * 1024 * 1024
    intervalCallback?.()

    performanceMemory.usedJSHeapSize = 256 * 1024 * 1024
    performanceMemory.totalJSHeapSize = 512 * 1024 * 1024
    intervalCallback?.()

    performanceMemory.usedJSHeapSize = 920 * 1024 * 1024
    performanceMemory.totalJSHeapSize = 1024 * 1024 * 1024
    intervalCallback?.()

    expect(reloadMock).not.toHaveBeenCalled()
    expect(consumePendingRendererRecoveryNotification()).toBeNull()
  })

  it.each([
    {
      label: 'below the critical heap ratio',
      usedHeapMB: 860,
      totalHeapMB: 1024,
      heapLimitMB: 1024
    },
    {
      label: 'above the critical ratio but below the minimum heap size',
      usedHeapMB: 480,
      totalHeapMB: 512,
      heapLimitMB: 512
    },
    {
      label: 'with an unavailable heap limit',
      usedHeapMB: 920,
      totalHeapMB: 1024,
      heapLimitMB: 0
    }
  ])('does not reload for $label', ({ usedHeapMB, totalHeapMB, heapLimitMB }) => {
    diagnostics.installRendererCrashDiagnostics()
    performanceMemory.usedJSHeapSize = usedHeapMB * 1024 * 1024
    performanceMemory.totalJSHeapSize = totalHeapMB * 1024 * 1024
    performanceMemory.jsHeapSizeLimit = heapLimitMB * 1024 * 1024

    intervalCallback?.()
    intervalCallback?.()

    expect(recordBreadcrumbMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'renderer_memory_pressure_reload' })
    )
    expect(reloadMock).not.toHaveBeenCalled()
    expect(consumePendingRendererRecoveryNotification()).toBeNull()
  })

  it('does not reload for one isolated critical heap sample', () => {
    diagnostics.installRendererCrashDiagnostics()
    performanceMemory.usedJSHeapSize = 920 * 1024 * 1024
    performanceMemory.totalJSHeapSize = 1024 * 1024 * 1024
    performanceMemory.jsHeapSizeLimit = 1024 * 1024 * 1024

    intervalCallback?.()

    expect(recordBreadcrumbMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'renderer_memory_pressure_reload' })
    )
    expect(reloadMock).not.toHaveBeenCalled()
    expect(consumePendingRendererRecoveryNotification()).toBeNull()
  })
})
