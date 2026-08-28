/**
 * Renderer memory sampling for crash reports: the periodic `renderer_memory`
 * crumb, and the one-shot `renderer_memory_highwater` crumbs that carry the
 * subsystem census naming whatever grew.
 */
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
/**
 * Private-footprint marks that arm the same profile when the growth is NOT in
 * the JS heap. Windows crash 36048e26 reported a 618MB private renderer whose
 * V8 heap sat at 150MB of a 4192MB limit — 3.6% of the ratio the marks above
 * need, so the census that would have named the leak never fired. xterm
 * scrollback (`Uint32Array` backing stores) and WebGL glyph atlases both live
 * outside every heap counter, so footprint is the only mark that sees them.
 */
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

export function setRendererMemorySamplingSurface(surface: RendererSurface): void {
  rendererSurface = surface
}

export function resetRendererMemorySampling(): void {
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
  // Why the previous read: the footprint bridge is async, and awaiting it here
  // would make every sample (and its highwater arming) reentrant. Refresh in the
  // background and annotate with the last answer instead — one sample interval
  // of staleness is irrelevant to a footprint trend, and the first sample of a
  // session simply carries no footprint.
  const footprint = lastProcessFootprint
  refreshProcessFootprint()

  recordRendererCrashBreadcrumb(
    'renderer_memory',
    compactBreadcrumbData({
      reason,
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

/**
 * Names the memory the heap counters cannot see. `outsideHeapMB` is the field
 * that distinguishes a JS leak from scrollback/atlas growth: it is what the OS
 * charges this renderer minus everything V8 and Blink admit to holding.
 */
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
  // Why: NaN would satisfy `ratio < threshold` for nothing, emitting both
  // levels spuriously and disarming the one-shot for the session.
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
  // Why: a single sample can cross both thresholds; profile the large heap once.
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

/**
 * Prefers V8's exact numbers; falls back to `performance.memory` only when the
 * preload bridge is unavailable (older shell, or a surface without it).
 *
 * Both are normalized to bytes so callers and the emitted MB fields stay
 * comparable with breadcrumbs recorded before this bridge existed.
 */
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
