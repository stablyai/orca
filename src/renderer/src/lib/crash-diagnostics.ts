import type {
  CrashReportBreadcrumbData,
  CrashReportDetailValue
} from '../../../shared/crash-reporting'
import {
  getBrowserWebviewMemoryProfile,
  type BrowserWebviewMemoryProfile
} from '../components/browser-pane/webview-registry'
import { recordRendererCrashBreadcrumb } from './crash-breadcrumb-recorder'
import { collectRendererMemoryProfileCounts } from './renderer-memory-profile'

const RENDERER_MEMORY_SAMPLE_INTERVAL_MS = 60_000
const BYTES_PER_MEGABYTE = 1024 * 1024
// Why: one detailed breadcrumb per threshold names what grew before an OOM.
const RENDERER_MEMORY_HIGHWATER_RATIOS = [0.6, 0.8] as const

type RendererSurface = 'main' | 'dashboard-popout'

type BrowserPerformanceMemory = {
  usedJSHeapSize?: number
  totalJSHeapSize?: number
  jsHeapSizeLimit?: number
}

let rendererCrashDiagnosticsInstalled = false
let rendererMemoryInterval: number | null = null
let rendererSurface: RendererSurface = 'main'
const emittedHighwaterRatios = new Set<number>()

// Why re-exported from a leaf module: terminal modules and their e2e-visible
// import chains need breadcrumb recording without this file's import.meta /
// webview-registry baggage. See crash-breadcrumb-recorder.ts.
export { recordRendererCrashBreadcrumb } from './crash-breadcrumb-recorder'

export function installRendererCrashDiagnostics(surface: RendererSurface = 'main'): void {
  if (rendererCrashDiagnosticsInstalled || typeof window === 'undefined') {
    return
  }

  rendererCrashDiagnosticsInstalled = true
  rendererSurface = surface
  window.addEventListener('error', recordRendererError)
  window.addEventListener('unhandledrejection', recordRendererUnhandledRejection)

  if (getPerformanceMemory()) {
    recordRendererMemory('startup')
    rendererMemoryInterval = window.setInterval(
      () => recordRendererMemory('interval'),
      RENDERER_MEMORY_SAMPLE_INTERVAL_MS
    )
  }
}

export function _disposeRendererCrashDiagnosticsForTests(): void {
  disposeRendererCrashDiagnostics()
}

function disposeRendererCrashDiagnostics(): void {
  if (!rendererCrashDiagnosticsInstalled || typeof window === 'undefined') {
    return
  }
  rendererCrashDiagnosticsInstalled = false
  window.removeEventListener('error', recordRendererError)
  window.removeEventListener('unhandledrejection', recordRendererUnhandledRejection)
  if (rendererMemoryInterval !== null) {
    window.clearInterval(rendererMemoryInterval)
    rendererMemoryInterval = null
  }
  emittedHighwaterRatios.clear()
  rendererSurface = 'main'
}

if (typeof import.meta !== 'undefined' && import.meta.hot) {
  // Why: Vite can replace this module without a full renderer reload. Remove
  // global diagnostics hooks so dev sessions do not accumulate listeners.
  import.meta.hot.dispose(disposeRendererCrashDiagnostics)
}

function recordRendererError(event: ErrorEvent): void {
  // Why: "ResizeObserver loop completed" is a benign, self-resolving Chromium
  // quirk. Recording it fills the breadcrumb buffer and inflates the error
  // count without diagnostic value, contributing to renderer heap growth (#8260).
  if (
    /^ResizeObserver loop (?:limit exceeded|completed with undelivered notifications)\.?$/i.test(
      event.message
    )
  ) {
    event.preventDefault()
    return
  }
  recordRendererCrashBreadcrumb(
    'renderer_error',
    compactBreadcrumbData({
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      ...describeUnknownValue('error', event.error)
    })
  )
}

function recordRendererUnhandledRejection(event: PromiseRejectionEvent): void {
  recordRendererCrashBreadcrumb(
    'renderer_unhandled_rejection',
    compactBreadcrumbData(describeUnknownValue('reason', event.reason))
  )
}

function recordRendererMemory(reason: string): void {
  const memory = getPerformanceMemory()
  if (!memory) {
    return
  }
  const browserWebviews = getBrowserWebviewMemoryProfile()

  recordRendererCrashBreadcrumb(
    'renderer_memory',
    compactBreadcrumbData({
      reason,
      usedHeapMB: toMegabytes(memory.usedJSHeapSize),
      totalHeapMB: toMegabytes(memory.totalJSHeapSize),
      heapLimitMB: toMegabytes(memory.jsHeapSizeLimit),
      browserWebviews: browserWebviews.browserWebviewCount,
      registeredBrowserGuests: browserWebviews.registeredBrowserGuestCount
    })
  )
  recordRendererMemoryHighwater(memory, browserWebviews)
}

function recordRendererMemoryHighwater(
  memory: BrowserPerformanceMemory,
  browserWebviews: BrowserWebviewMemoryProfile
): void {
  const used = memory.usedJSHeapSize
  const limit = memory.jsHeapSizeLimit
  // Why: NaN would satisfy `ratio < threshold` for nothing, emitting both
  // levels spuriously and disarming the one-shot for the session.
  if (!isFiniteHeapBytes(used) || !isFiniteHeapBytes(limit) || limit <= 0) {
    return
  }
  const ratio = used / limit
  let crossedThreshold = false
  for (const threshold of RENDERER_MEMORY_HIGHWATER_RATIOS) {
    if (ratio >= threshold && !emittedHighwaterRatios.has(threshold)) {
      crossedThreshold = true
      break
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
    domNodes: document.getElementsByTagName('*').length,
    terminalElements: document.querySelectorAll('.xterm').length,
    browserWebviews: browserWebviews.browserWebviewCount,
    registeredBrowserGuests: browserWebviews.registeredBrowserGuestCount,
    ...collectRendererMemoryProfileCounts()
  })
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

function isFiniteHeapBytes(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function getPerformanceMemory(): BrowserPerformanceMemory | undefined {
  if (typeof window === 'undefined') {
    return undefined
  }
  return (window.performance as Performance & { memory?: BrowserPerformanceMemory }).memory
}

function describeUnknownValue(
  prefix: string,
  value: unknown
): Record<string, CrashReportDetailValue | undefined> {
  if (value === null) {
    return { [`${prefix}Type`]: 'null' }
  }
  if (value === undefined) {
    return { [`${prefix}Type`]: 'undefined' }
  }
  if (typeof value === 'object' || typeof value === 'function') {
    const candidate = value as {
      name?: unknown
      message?: unknown
      stack?: unknown
      constructor?: { name?: string }
    }
    return {
      [`${prefix}Type`]: typeof value === 'function' ? 'function' : candidate.constructor?.name,
      [`${prefix}Name`]: typeof candidate.name === 'string' ? candidate.name : undefined,
      [`${prefix}Message`]: typeof candidate.message === 'string' ? candidate.message : undefined,
      [`${prefix}Stack`]: typeof candidate.stack === 'string' ? candidate.stack : undefined
    }
  }

  return {
    [`${prefix}Type`]: typeof value,
    [`${prefix}Message`]: stringifyUnknown(value)
  }
}

function stringifyUnknown(value: unknown): string {
  try {
    return String(value)
  } catch {
    return '[unstringifiable]'
  }
}

function compactBreadcrumbData(
  data: Record<string, CrashReportDetailValue | undefined>
): CrashReportBreadcrumbData {
  const compacted: CrashReportBreadcrumbData = {}
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' || typeof value === 'boolean' || value === null) {
      compacted[key] = value
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      compacted[key] = value
    }
  }
  return compacted
}

function toMegabytes(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value / BYTES_PER_MEGABYTE)
    : undefined
}
