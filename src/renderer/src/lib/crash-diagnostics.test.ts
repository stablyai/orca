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
        // Why: without this tag a reader cannot tell an exact heap number from a
        // Blink-quantized one, which is what made earlier bundles unanalyzable.
        heapSource: 'quantized',
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
    vi.resetModules()
    recordBreadcrumbMock.mockClear()
    diagnostics = (await import('./crash-diagnostics')) as DiagnosticsModule
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

  describe('exact V8 heap statistics', () => {
    const KB = 1024
    let readHeapStatistics: ReturnType<typeof vi.fn>

    const stubHeap = (usedMB: number, limitMB = 512): void => {
      readHeapStatistics.mockReturnValue({
        usedHeapKB: usedMB * KB,
        totalHeapKB: usedMB * KB * 2,
        heapLimitKB: limitMB * KB,
        mallocedKB: 3 * KB,
        blinkAllocatedKB: 7 * KB
      })
    }

    beforeEach(() => {
      readHeapStatistics = vi.fn()
      ;(window.api.crashReports as unknown as { readHeapStatistics: unknown }).readHeapStatistics =
        readHeapStatistics
    })

    it('prefers exact statistics over performance.memory and labels the source', () => {
      stubHeap(101)

      diagnostics.installRendererCrashDiagnostics()

      // Why: performance.memory still says 32MB here. Reporting 101 proves the
      // exact reading wins rather than merely being recorded alongside.
      expect(recordBreadcrumbMock).toHaveBeenCalledWith({
        name: 'renderer_memory',
        data: expect.objectContaining({
          usedHeapMB: 101,
          heapLimitMB: 512,
          heapSource: 'v8',
          mallocedMB: 3,
          blinkAllocatedMB: 7
        })
      })
    })

    it('observes growth that performance.memory quantizes away', () => {
      // Why: this is the whole point. Blink pins usedJSHeapSize to a bucket and
      // caches it ~20min, so a real climb reports byte-identical values and a
      // highwater threshold never fires. Exact stats must still cross it.
      const quantized = (window.performance as unknown as { memory: Record<string, number> }).memory
      quantized.usedJSHeapSize = 32 * 1024 * 1024
      stubHeap(100)
      vi.stubGlobal('document', {
        getElementsByTagName: () => ({ length: 1 }),
        querySelectorAll: () => ({ length: 0 })
      })

      diagnostics.installRendererCrashDiagnostics()
      const highwaterCalls = (): unknown[] =>
        recordBreadcrumbMock.mock.calls.filter(
          (call) => (call[0] as { name: string }).name === 'renderer_memory_highwater'
        )
      expect(highwaterCalls()).toHaveLength(0)

      stubHeap(400) // 78% of 512 — past the 60% threshold, still below 80%.
      const tick = setIntervalMock.mock.calls[0][0] as () => void
      tick()

      expect(quantized.usedJSHeapSize).toBe(32 * 1024 * 1024)
      expect(highwaterCalls()).toHaveLength(1)
      expect(recordBreadcrumbMock).toHaveBeenCalledWith({
        name: 'renderer_memory_highwater',
        data: expect.objectContaining({ thresholdPct: 60, usedHeapMB: 400, heapSource: 'v8' })
      })
    })

    it('omits the Blink field instead of emitting a junk value for it', () => {
      // Why: `undefined * 1024` is NaN. The breadcrumb must carry no
      // blinkAllocatedMB at all rather than a meaningless number.
      readHeapStatistics.mockReturnValue({
        usedHeapKB: 77 * KB,
        totalHeapKB: 154 * KB,
        heapLimitKB: 512 * KB,
        mallocedKB: 3 * KB,
        blinkAllocatedKB: undefined
      })

      diagnostics.installRendererCrashDiagnostics()

      const call = recordBreadcrumbMock.mock.calls.find(
        ([entry]) => (entry as { name: string }).name === 'renderer_memory'
      )?.[0] as { data: Record<string, unknown> }
      expect(call.data).toMatchObject({ usedHeapMB: 77, heapSource: 'v8', mallocedMB: 3 })
      expect(call.data).not.toHaveProperty('blinkAllocatedMB')
    })

    it('falls back to performance.memory when the bridge returns null', () => {
      readHeapStatistics.mockReturnValue(null)

      diagnostics.installRendererCrashDiagnostics()

      expect(recordBreadcrumbMock).toHaveBeenCalledWith({
        name: 'renderer_memory',
        data: expect.objectContaining({ usedHeapMB: 32, heapSource: 'quantized' })
      })
    })

    it('samples on an older shell whose preload lacks the bridge', () => {
      ;(window.api.crashReports as unknown as Record<string, unknown>).readHeapStatistics =
        undefined

      expect(() => diagnostics.installRendererCrashDiagnostics()).not.toThrow()
      expect(recordBreadcrumbMock).toHaveBeenCalledWith({
        name: 'renderer_memory',
        data: expect.objectContaining({ usedHeapMB: 32, heapSource: 'quantized' })
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

    const memoryCalls = (): { data: Record<string, unknown> }[] =>
      recordBreadcrumbMock.mock.calls
        .filter((call) => (call[0] as { name: string }).name === 'renderer_memory')
        .map((call) => call[0] as { data: Record<string, unknown> })

    const highwaterCalls = (): { data: Record<string, unknown> }[] =>
      recordBreadcrumbMock.mock.calls
        .filter((call) => (call[0] as { name: string }).name === 'renderer_memory_highwater')
        .map((call) => call[0] as { data: Record<string, unknown> })

    it('reports the private footprint and what it holds outside the heap counters', async () => {
      // Why these numbers: Windows crash 36048e26 — a 618MB private renderer
      // whose V8 heap was 150MB. 438MB of it is xterm scrollback and glyph
      // atlases, which no V8 or Blink counter reports.
      stubFootprint(618)
      diagnostics.installRendererCrashDiagnostics()
      await flush()
      const tick = setIntervalMock.mock.calls[0][0] as () => void
      tick()

      const latest = memoryCalls().at(-1)!
      expect(latest.data).toMatchObject({
        usedHeapMB: 150,
        privateMB: 618,
        outsideHeapMB: 438
      })
    })

    it('arms the leak census on footprint even when the heap ratio never trips', async () => {
      // Why: 150MB of a 4192MB limit is 3.6% — far below the 60% ratio mark, so
      // before this the census that names the leak never reached a report.
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

    it('emits each footprint mark once and both when one sample clears them', async () => {
      stubFootprint(618)
      diagnostics.installRendererCrashDiagnostics()
      await flush()
      const tick = setIntervalMock.mock.calls[0][0] as () => void
      tick()
      expect(highwaterCalls()).toHaveLength(1)

      await flush()
      tick()
      expect(highwaterCalls()).toHaveLength(1)

      stubFootprint(1200)
      await flush()
      tick()
      await flush()
      tick()
      expect(highwaterCalls()).toHaveLength(2)
      expect(highwaterCalls().at(-1)!.data).toMatchObject({ thresholdPrivateMB: 1000 })
    })

    it('keeps sampling when the shell has no footprint bridge at all', async () => {
      ;(window.api.crashReports as unknown as Record<string, unknown>).readProcessMemory = undefined

      expect(() => diagnostics.installRendererCrashDiagnostics()).not.toThrow()
      await flush()
      const latest = memoryCalls().at(-1)!
      expect(latest.data).toMatchObject({ usedHeapMB: 150 })
      expect(latest.data).not.toHaveProperty('privateMB')
      expect(highwaterCalls()).toHaveLength(0)
    })

    it('does not let a rejected footprint read break the heap sample', async () => {
      readProcessMemory.mockRejectedValue(new Error('bridge gone'))

      diagnostics.installRendererCrashDiagnostics()
      await flush()
      const tick = setIntervalMock.mock.calls[0][0] as () => void
      expect(() => tick()).not.toThrow()
      expect(memoryCalls().at(-1)!.data).toMatchObject({ usedHeapMB: 150 })
    })

    it('does not overlap footprint reads while the previous read is pending', async () => {
      let resolveRead: (value: { privateKB: number } | null) => void = () => undefined
      readProcessMemory.mockImplementation(
        () =>
          new Promise<{ privateKB: number } | null>((resolve) => {
            resolveRead = resolve
          })
      )

      diagnostics.installRendererCrashDiagnostics()
      const tick = setIntervalMock.mock.calls[0][0] as () => void
      tick()
      tick()
      expect(readProcessMemory).toHaveBeenCalledTimes(1)

      resolveRead({ privateKB: 618 * KB })
      await flush()
      tick()
      expect(readProcessMemory).toHaveBeenCalledTimes(2)
    })
  })
})
