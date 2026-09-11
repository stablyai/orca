import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RendererMemorySampling from './renderer-memory-sampling'

type SamplingModule = typeof RendererMemorySampling

const KB = 1024
const SAMPLE_INTERVAL_MS = 60_000
const WEBVIEW_REGISTRY = '../components/browser-pane/host-guest/webview-registry'

describe('renderer memory highwater census re-arming', () => {
  let sampling: SamplingModule
  let recordBreadcrumbMock: ReturnType<typeof vi.fn>
  let readProcessMemory: ReturnType<typeof vi.fn>
  let heapStats: Record<string, number>
  let webviewProfile: { browserWebviewCount: number; registeredBrowserGuestCount: number }
  let nowMs: number

  const stubFootprint = (privateMB: number): void => {
    readProcessMemory.mockResolvedValue({ privateKB: privateMB * KB })
  }

  /** One 60s sampling tick; the async footprint read settles before the next. */
  const tick = async (): Promise<void> => {
    nowMs += SAMPLE_INTERVAL_MS
    sampling.recordRendererMemorySample('interval')
    await Promise.resolve()
    await Promise.resolve()
  }

  const censuses = (): Record<string, unknown>[] =>
    recordBreadcrumbMock.mock.calls
      .filter((call) => (call[0] as { name: string }).name === 'renderer_memory_highwater')
      .map((call) => (call[0] as { data: Record<string, unknown> }).data)

  beforeEach(async () => {
    vi.resetModules()
    nowMs = 0
    recordBreadcrumbMock = vi.fn()
    readProcessMemory = vi.fn().mockResolvedValue(null)
    // Why 150MB of a 4192MB limit: 3.6% of the ratio ladder, so only the
    // private-footprint marks can arm and the ratio marks stay out of the way.
    heapStats = {
      usedHeapKB: 150 * KB,
      totalHeapKB: 305 * KB,
      heapLimitKB: 4192 * KB,
      mallocedKB: 1 * KB,
      blinkAllocatedKB: 215 * KB
    }
    webviewProfile = { browserWebviewCount: 0, registeredBrowserGuestCount: 0 }
    vi.stubGlobal('performance', { now: () => nowMs })
    vi.stubGlobal('window', {
      performance: {},
      api: {
        crashReports: {
          recordBreadcrumb: recordBreadcrumbMock,
          readProcessMemory,
          readHeapStatistics: () => heapStats
        }
      }
    })
    vi.stubGlobal('document', {
      getElementsByTagName: () => ({ length: 2376 }),
      querySelectorAll: () => ({ length: 12 })
    })
    vi.doMock(WEBVIEW_REGISTRY, () => ({
      getBrowserWebviewMemoryProfile: () => webviewProfile
    }))
    sampling = (await import('./renderer-memory-sampling')) as SamplingModule
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock(WEBVIEW_REGISTRY)
  })

  it('emits nothing until a mark is crossed, then exactly one census', async () => {
    stubFootprint(420)
    await tick()
    await tick()
    expect(censuses()).toHaveLength(0)

    stubFootprint(658)
    await tick()
    await tick()
    expect(censuses()).toHaveLength(1)
    expect(censuses()[0]).toMatchObject({ thresholdPrivateMB: 600, privateMB: 658 })
  })

  it('re-emits the census while a renderer plateaus above a mark for 21 hours', async () => {
    // Field: crashes fb476b1c / d4d32680 crossed 600MB, emitted one census,
    // then ran 21 more hours and died at 577MB without re-crossing — so both
    // reports carried a byte-identical census describing a 21h-old workload.
    stubFootprint(658)
    await tick()
    await tick()
    expect(censuses()).toHaveLength(1)
    expect(censuses()[0]).toMatchObject({
      thresholdPrivateMB: 600,
      privateMB: 658,
      blinkAllocatedMB: 215,
      browserWebviews: 0
    })

    // The workload the stale census could not describe: a browser guest opened,
    // Blink's own allocation collapsed, and the growth moved outside the heap.
    webviewProfile.browserWebviewCount = 1
    heapStats.blinkAllocatedKB = 21 * KB
    stubFootprint(640)
    for (let minute = 0; minute < 21 * 60; minute += 1) {
      await tick()
    }

    expect(censuses().length).toBeGreaterThan(1)
    expect(censuses().at(-1)).toMatchObject({
      thresholdPrivateMB: 600,
      privateMB: 640,
      blinkAllocatedMB: 21,
      browserWebviews: 1
    })
    // Anti-spam: 1260 samples must not become 1260 censuses.
    expect(censuses().length).toBeLessThanOrEqual(90)
  })

  // The literal fb476b1c ending: crossed 600MB, then spent 21h BELOW the mark and died at 577MB.
  // A re-census gated on the current value never fires here, which was the whole defect.
  it('re-censuses a renderer that crossed a mark and then settled back below it', async () => {
    stubFootprint(658)
    await tick()
    await tick()
    expect(censuses()).toHaveLength(1)
    const firstCensus = censuses()[0]

    // New workload, permanently below the mark, for 21 hours.
    stubFootprint(577)
    heapStats.blinkAllocatedKB = 21 * KB
    webviewProfile = { browserWebviewCount: 1, registeredBrowserGuestCount: 1 }
    for (let minute = 0; minute < 1260; minute += 1) {
      await tick()
    }

    expect(censuses().length).toBeGreaterThan(1)
    expect(censuses().at(-1)).not.toBe(firstCensus)
    expect(censuses().at(-1)).toMatchObject({
      thresholdPrivateMB: 600,
      privateMB: 577,
      blinkAllocatedMB: 21,
      browserWebviews: 1
    })
    expect(censuses().length).toBeLessThanOrEqual(90)
  })

  // The retained crumb is one slot per mark, so a refresh overwrites the peak census. A renderer
  // that released its memory must keep the peak evidence rather than ship privateMB:50 under a
  // thresholdPrivateMB:600 label.
  it('keeps the peak census when a renderer releases its memory', async () => {
    stubFootprint(1200)
    heapStats.blinkAllocatedKB = 900 * KB
    await tick()
    await tick()
    // 1200MB crosses both private marks, so both slots are censused at the peak.
    expect(censuses()).toHaveLength(2)

    // Leak released: 6 hours far below the mark.
    stubFootprint(50)
    heapStats.blinkAllocatedKB = 1 * KB
    for (let minute = 0; minute < 360; minute += 1) {
      await tick()
    }

    // No refresh fired, so the retained censuses still describe the peak.
    expect(censuses()).toHaveLength(2)
    expect(censuses().map((c) => c.privateMB)).toEqual([1200, 1200])
  })

  // A refresh replaces the retained crumb's own createdAt, so the census must carry how long the
  // renderer has been over the mark — that is the axis that identified the 21h-stale census.
  it('reports minutes near the mark across refreshes', async () => {
    stubFootprint(658)
    await tick()
    await tick()
    expect(censuses().at(-1)).toMatchObject({ thresholdPrivateMB: 600, nearMarkMinutes: 0 })

    stubFootprint(577)
    for (let minute = 0; minute < 120; minute += 1) {
      await tick()
    }

    // Still over the band, so it refreshed — and it says how long it has been up there.
    expect(censuses().length).toBeGreaterThan(1)
    expect(censuses().at(-1)).toMatchObject({ thresholdPrivateMB: 600, nearMarkMinutes: 120 })
  })

  // Sawtooth (build, GC, build) is the ordinary shape of renderer memory. Two spikes hours apart
  // must not read as sustained pressure, or triage starts a leak hunt that has no leak.
  it('re-anchors minutes-near-mark after a long observed spell below the band', async () => {
    stubFootprint(658)
    await tick()
    await tick()
    expect(censuses().at(-1)).toMatchObject({ nearMarkMinutes: 0 })

    // 10 hours far below the band, then back up.
    stubFootprint(100)
    for (let minute = 0; minute < 600; minute += 1) {
      await tick()
    }
    stubFootprint(700)
    await tick()
    await tick()

    // Not 602: the renderer spent those 600 minutes at 100MB.
    expect(censuses().at(-1)).toMatchObject({ thresholdPrivateMB: 600 })
    expect(censuses().at(-1)?.nearMarkMinutes).toBeLessThanOrEqual(2)
  })

  // A wedged main thread or a suspend stops the 60s sampler. That is not the renderer leaving the
  // band — and it is exactly when the renderer is sickest, so the clock must not reset.
  it('does not reset the clock when sampling itself stalls', async () => {
    stubFootprint(658)
    await tick()
    await tick()
    for (let minute = 0; minute < 30; minute += 1) {
      await tick()
    }
    const beforeGap = censuses().at(-1)?.nearMarkMinutes as number
    expect(beforeGap).toBeGreaterThanOrEqual(30)

    // Sampler stalls for 8 hours, then resumes with the renderer still heavy.
    nowMs += 8 * 60 * 60_000
    await tick()
    await tick()

    expect(censuses().at(-1)?.nearMarkMinutes as number).toBeGreaterThan(beforeGap + 400)
  })

  // A short trough is still a trough. 40 one-minute spikes separated by 14 minutes at 100MB is
  // not 10 hours of sustained pressure, and reporting it as such sends triage on a leak hunt.
  it('counts only samples actually seen near the mark, not elapsed time', async () => {
    stubFootprint(658)
    await tick()
    await tick()

    for (let cycle = 0; cycle < 40; cycle += 1) {
      stubFootprint(100)
      for (let minute = 0; minute < 14; minute += 1) {
        await tick()
      }
      stubFootprint(620)
      await tick()
    }

    // ~40 in-band samples out of ~602 minutes elapsed.
    const reported = censuses().at(-1)?.nearMarkMinutes as number
    expect(reported).toBeLessThanOrEqual(60)
  })

  it('emits at most one census per mark while a renderer oscillates around it', async () => {
    stubFootprint(601)
    await tick()
    await tick()
    expect(censuses()).toHaveLength(1)

    for (let minute = 0; minute < 14; minute += 1) {
      stubFootprint(minute % 2 === 0 ? 599 : 601)
      await tick()
    }

    expect(censuses()).toHaveLength(1)
  })
})
