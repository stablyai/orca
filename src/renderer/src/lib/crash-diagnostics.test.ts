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
    vi.doMock('../components/browser-pane/host-guest/webview-registry', () => ({
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

  it('includes delivered and queued long tasks once in each memory sample', () => {
    let now = 0
    let deliver = (_durations: number[]): void => {}
    const pending: { duration: number }[] = []
    const observe = vi.fn()
    vi.stubGlobal('performance', { now: () => now })
    vi.stubGlobal(
      'PerformanceObserver',
      class {
        static supportedEntryTypes = ['longtask']
        constructor(callback: (list: { getEntries: () => { duration: number }[] }) => void) {
          deliver = (durations) =>
            callback({ getEntries: () => durations.map((duration) => ({ duration })) })
        }
        observe = observe
        disconnect = vi.fn()
        takeRecords = () => pending.splice(0)
      }
    )
    diagnostics.installRendererCrashDiagnostics()
    diagnostics.installRendererCrashDiagnostics()
    expect(observe).toHaveBeenCalledTimes(1)
    deliver([75, 100])
    pending.push({ duration: 125 })
    now = 90_000
    const sample = setIntervalMock.mock.calls[0][0]
    sample()
    expect(recordBreadcrumbMock).toHaveBeenLastCalledWith({
      name: 'renderer_memory',
      data: expect.objectContaining({
        longTaskMs: 300,
        longTaskCount: 3,
        longestTaskMs: 125,
        sampleWindowMs: 90_000
      })
    })
    now += 60_000
    sample()
    expect(recordBreadcrumbMock).toHaveBeenLastCalledWith({
      name: 'renderer_memory',
      data: expect.objectContaining({
        longTaskMs: 0,
        longTaskCount: 0,
        longestTaskMs: 0,
        sampleWindowMs: 60_000
      })
    })
  })

  describe('process footprint outside the heap counters', () => {
    const KB = 1024
    let readHeapStatistics: ReturnType<typeof vi.fn>
    let readProcessMemory: ReturnType<typeof vi.fn>

    const stubFootprint = (privateMB: number): void => {
      readProcessMemory.mockResolvedValue({ privateKB: privateMB * KB })
    }

    beforeEach(() => {
      readHeapStatistics = vi.fn().mockReturnValue({
        usedHeapKB: 150 * KB,
        totalHeapKB: 305 * KB,
        heapLimitKB: 4192 * KB,
        mallocedKB: 1 * KB,
        blinkAllocatedKB: 29 * KB
      })
      readProcessMemory = vi.fn().mockResolvedValue(null)
      Object.assign(window.api.crashReports as unknown as Record<string, unknown>, {
        readHeapStatistics,
        readProcessMemory
      })
      vi.stubGlobal('document', {
        getElementsByTagName: () => ({ length: 3064 }),
        querySelectorAll: () => ({ length: 24 })
      })
    })

    const flush = async (): Promise<void> => {
      await Promise.resolve()
      await Promise.resolve()
    }

    const highwaterCalls = (): { data: Record<string, unknown> }[] =>
      recordBreadcrumbMock.mock.calls
        .filter((call) => (call[0] as { name: string }).name === 'renderer_memory_highwater')
        .map((call) => call[0] as { data: Record<string, unknown> })

    it('arms the leak census on footprint even when the heap ratio never trips', async () => {
      // Low heap/limit ratio must not prevent the census that identifies native-memory growth.
      stubFootprint(618)
      diagnostics.installRendererCrashDiagnostics()
      expect(highwaterCalls()).toHaveLength(0)
      await flush()
      const tick = setIntervalMock.mock.calls[0][0] as () => void
      tick()

      expect(highwaterCalls()).toHaveLength(1)
      expect(highwaterCalls()[0].data).toMatchObject({
        thresholdPrivateMB: 600,
        privateMB: 618,
        terminalElements: 24,
        domNodes: 3064
      })
      expect(highwaterCalls()[0].data).not.toHaveProperty('thresholdPct')
    })
  })
})
