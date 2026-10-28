/** Emit periodic renderer_memory samples and one-shot renderer_memory_highwater subsystem censuses. */
import type { CrashReportDetailValue } from '../../../shared/crash-reporting'
import type { RendererProcessMemory } from '../../../shared/renderer-process-memory'
import {
  getBrowserWebviewMemoryProfile,
  type BrowserWebviewMemoryProfile
} from '../components/browser-pane/host-guest/webview-registry'
import { recordRendererCrashBreadcrumb } from './crash-breadcrumb-recorder'
import { compactBreadcrumbData, toMegabytes } from './crash-breadcrumb-data'
import { collectRendererMemoryProfileCounts } from './renderer-memory-profile'

const BYTES_PER_KILOBYTE = 1024
// Why: one detailed breadcrumb per threshold names what grew before an OOM.
const RENDERER_MEMORY_HIGHWATER_RATIOS = [0.6, 0.8] as const
/** Footprint thresholds catch growth outside V8, including scrollback backing stores/GL atlases. A reported 618MB renderer held only 150MB of a 4192MB heap limit, too low for heap-ratio census to fire. */
const RENDERER_PRIVATE_HIGHWATER_MB = [600, 1000] as const

export type RendererSurface = 'main' | 'dashboard-popout'

type BrowserPerformanceMemory = {
  usedJSHeapSize?: number
  totalJSHeapSize?: number
  jsHeapSizeLimit?: number
}

/** Heap sizes in bytes, tagged with whether they are exact or Blink-quantized. */
type HeapMetrics = BrowserPerformanceMemory & {
  mallocedBytes?: number
  blinkAllocatedBytes?: number
  exact: boolean
}

const emittedHighwaterRatios = new Set<number>()
const emittedPrivateHighwaterMarks = new Set<number>()
let lastProcessFootprint: RendererProcessMemory | null = null
let processFootprintReadGeneration = 0
let processFootprintReadInFlight = false
let rendererSurface: RendererSurface = 'main'
let longTaskObserver: PerformanceObserver | null = null
let longTasks = { longTaskMs: 0, longTaskCount: 0, longestTaskMs: 0 }
let longTaskSampleStartedAt = 0

function accumulateLongTasks(entries: PerformanceEntry[]): void {
  for (const entry of entries) {
    longTasks.longTaskMs += entry.duration
    longTasks.longTaskCount += 1
    longTasks.longestTaskMs = Math.max(longTasks.longestTaskMs, entry.duration)
  }
}

export function startRendererLongTaskSampling(): void {
  if (
    longTaskObserver ||
    typeof PerformanceObserver === 'undefined' ||
    !PerformanceObserver.supportedEntryTypes?.includes('longtask')
  ) {
    return
  }
  longTaskSampleStartedAt = performance.now()
  longTaskObserver = new PerformanceObserver((list) => accumulateLongTasks(list.getEntries()))
  longTaskObserver.observe({ type: 'longtask' })
}

export function setRendererMemorySamplingSurface(surface: RendererSurface): void {
  rendererSurface = surface
}

export function resetRendererMemorySampling(): void {
  longTaskObserver?.disconnect()
  longTaskObserver = null
  longTasks = { longTaskMs: 0, longTaskCount: 0, longestTaskMs: 0 }
  emittedHighwaterRatios.clear()
  emittedPrivateHighwaterMarks.clear()
  lastProcessFootprint = null
  processFootprintReadGeneration += 1
  processFootprintReadInFlight = false
  rendererSurface = 'main'
}

export function recordRendererMemorySample(reason: string): void {
  const memory = readHeapMetrics()
  if (!memory) {
    return
  }
  const browserWebviews = getBrowserWebviewMemoryProfile()
  // Refresh async footprint in background and use the last answer to keep samples nonreentrant. One interval’s staleness is harmless for trends; first sample omits it.
  const footprint = lastProcessFootprint
  refreshProcessFootprint()

  let longTaskSample: (typeof longTasks & { sampleWindowMs: number }) | undefined
  if (longTaskObserver) {
    // Charge whole tasks to the sample that collects them, including queued deliveries.
    accumulateLongTasks(longTaskObserver.takeRecords())
    const now = performance.now()
    longTaskSample = { ...longTasks, sampleWindowMs: now - longTaskSampleStartedAt }
    longTasks = { longTaskMs: 0, longTaskCount: 0, longestTaskMs: 0 }
    longTaskSampleStartedAt = now
  }

  recordRendererCrashBreadcrumb(
    'renderer_memory',
    compactBreadcrumbData({
      reason,
      rendererSurface,
      ...longTaskSample,
      usedHeapMB: toMegabytes(memory.usedJSHeapSize),
      totalHeapMB: toMegabytes(memory.totalJSHeapSize),
      heapLimitMB: toMegabytes(memory.jsHeapSizeLimit),
      heapSource: memory.exact ? 'v8' : 'quantized',
      mallocedMB: toMegabytes(memory.mallocedBytes),
      blinkAllocatedMB: toMegabytes(memory.blinkAllocatedBytes),
      ...describeProcessFootprint(memory, footprint),
      browserWebviews: browserWebviews.browserWebviewCount,
      registeredBrowserGuests: browserWebviews.registeredBrowserGuestCount
    })
  )
  recordRendererMemoryHighwater(memory, browserWebviews, footprint)
}

/** Stays null on shells without the bridge, or when the runtime withholds it. */
function refreshProcessFootprint(): void {
  const read = window.api?.crashReports?.readProcessMemory
  if (!read || processFootprintReadInFlight) {
    return
  }
  const generation = processFootprintReadGeneration
  processFootprintReadInFlight = true
  const settle = (footprint: RendererProcessMemory | null): void => {
    if (generation !== processFootprintReadGeneration) {
      return
    }
    lastProcessFootprint = footprint
    processFootprintReadInFlight = false
  }
  try {
    void read().then(
      (footprint) => settle(footprint ?? null),
      () => settle(null)
    )
  } catch {
    settle(null)
  }
}

/** outsideHeapMB subtracts V8/Blink holdings from OS footprint to distinguish JS leaks from scrollback/atlas growth. */
function describeProcessFootprint(
  memory: HeapMetrics,
  footprint: RendererProcessMemory | null
): Record<string, CrashReportDetailValue | undefined> {
  if (!footprint) {
    return {}
  }
  const privateMB = toMegabytes(footprint.privateKB * BYTES_PER_KILOBYTE)
  const accountedBytes =
    (memory.usedJSHeapSize ?? 0) + (memory.mallocedBytes ?? 0) + (memory.blinkAllocatedBytes ?? 0)
  return {
    privateMB,
    residentMB:
      footprint.residentKB === undefined
        ? undefined
        : toMegabytes(footprint.residentKB * BYTES_PER_KILOBYTE),
    outsideHeapMB:
      privateMB === undefined
        ? undefined
        : Math.max(0, privateMB - (toMegabytes(accountedBytes) ?? 0))
  }
}

function recordRendererMemoryHighwater(
  memory: HeapMetrics,
  browserWebviews: BrowserWebviewMemoryProfile,
  footprint: RendererProcessMemory | null = null
): void {
  const used = memory.usedJSHeapSize
  const limit = memory.jsHeapSizeLimit
  // Reject NaN before comparisons or it spuriously crosses both one-shot thresholds.
  const ratio =
    isFiniteHeapBytes(used) && isFiniteHeapBytes(limit) && limit > 0 ? used / limit : null
  const privateMB =
    footprint === null ? null : (toMegabytes(footprint.privateKB * BYTES_PER_KILOBYTE) ?? null)
  let crossedThreshold = false
  if (ratio !== null) {
    for (const threshold of RENDERER_MEMORY_HIGHWATER_RATIOS) {
      if (ratio >= threshold && !emittedHighwaterRatios.has(threshold)) {
        crossedThreshold = true
        break
      }
    }
  }
  if (privateMB !== null) {
    for (const mark of RENDERER_PRIVATE_HIGHWATER_MB) {
      if (privateMB >= mark && !emittedPrivateHighwaterMarks.has(mark)) {
        crossedThreshold = true
        break
      }
    }
  }
  if (!crossedThreshold) {
    return
  }
  // One sample can cross both thresholds; collect the census only once.
  const profile = compactBreadcrumbData({
    rendererSurface,
    usedHeapMB: toMegabytes(used),
    totalHeapMB: toMegabytes(memory.totalJSHeapSize),
    heapLimitMB: toMegabytes(limit),
    heapSource: memory.exact ? 'v8' : 'quantized',
    mallocedMB: toMegabytes(memory.mallocedBytes),
    blinkAllocatedMB: toMegabytes(memory.blinkAllocatedBytes),
    ...describeProcessFootprint(memory, footprint),
    domNodes: document.getElementsByTagName('*').length,
    terminalElements: document.querySelectorAll('.xterm').length,
    browserWebviews: browserWebviews.browserWebviewCount,
    registeredBrowserGuests: browserWebviews.registeredBrowserGuestCount,
    ...collectRendererMemoryProfileCounts()
  })
  if (ratio !== null) {
    for (const threshold of RENDERER_MEMORY_HIGHWATER_RATIOS) {
      if (ratio < threshold || emittedHighwaterRatios.has(threshold)) {
        continue
      }
      emittedHighwaterRatios.add(threshold)
      recordRendererCrashBreadcrumb('renderer_memory_highwater', {
        ...profile,
        thresholdPct: Math.round(threshold * 100)
      })
    }
  }
  if (privateMB !== null) {
    for (const mark of RENDERER_PRIVATE_HIGHWATER_MB) {
      if (privateMB < mark || emittedPrivateHighwaterMarks.has(mark)) {
        continue
      }
      emittedPrivateHighwaterMarks.add(mark)
      recordRendererCrashBreadcrumb('renderer_memory_highwater', {
        ...profile,
        thresholdPrivateMB: mark
      })
    }
  }
}

function isFiniteHeapBytes(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function getPerformanceMemory(): BrowserPerformanceMemory | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }
  return (window.performance as Performance & { memory?: BrowserPerformanceMemory }).memory
}

/** Prefer exact V8 bytes, falling back to performance.memory on older/unsupported shells; keep units compatible with earlier breadcrumbs. */
export function readHeapMetrics(): HeapMetrics | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }
  const exact = window.api?.crashReports?.readHeapStatistics?.()
  if (exact) {
    return {
      usedJSHeapSize: exact.usedHeapKB * BYTES_PER_KILOBYTE,
      totalJSHeapSize: exact.totalHeapKB * BYTES_PER_KILOBYTE,
      jsHeapSizeLimit: exact.heapLimitKB * BYTES_PER_KILOBYTE,
      mallocedBytes: exact.mallocedKB * BYTES_PER_KILOBYTE,
      // Why guarded: undefined * 1024 is NaN, which would emit a junk field.
      blinkAllocatedBytes:
        exact.blinkAllocatedKB === undefined
          ? undefined
          : exact.blinkAllocatedKB * BYTES_PER_KILOBYTE,
      exact: true
    }
  }
  const fallback = getPerformanceMemory()
  return fallback ? { ...fallback, exact: false } : undefined
}
