import type {
  CrashReportBreadcrumbData,
  CrashReportDetailValue
} from '../../../shared/crash-reporting'
import { getBrowserWebviewMemoryProfile } from '../components/browser-pane/webview-registry'
import { recordRendererCrashBreadcrumb } from './crash-breadcrumb-recorder'

const RENDERER_MEMORY_SAMPLE_INTERVAL_MS = 60_000
const BYTES_PER_MEGABYTE = 1024 * 1024

// Why: production OOMs sit at the heap ceiling for a long time before dying, so
// a census taken once the heap crosses this fraction of its limit still lands in
// the bundle. Throttled so a pegged renderer emits it periodically, not every sample.
const HEAP_CENSUS_HIGH_WATER_FRACTION = 0.85
const HEAP_CENSUS_MIN_INTERVAL_MS = 5 * 60_000
let lastHeapCensusAt = 0

type BrowserPerformanceMemory = {
  usedJSHeapSize?: number
  totalJSHeapSize?: number
  jsHeapSizeLimit?: number
}

let rendererCrashDiagnosticsInstalled = false
let rendererMemoryInterval: number | null = null

// Why re-exported from a leaf module: terminal modules and their e2e-visible
// import chains need breadcrumb recording without this file's import.meta /
// webview-registry baggage. See crash-breadcrumb-recorder.ts.
export { recordRendererCrashBreadcrumb } from './crash-breadcrumb-recorder'

export function installRendererCrashDiagnostics(): void {
  if (rendererCrashDiagnosticsInstalled || typeof window === 'undefined') {
    return
  }

  rendererCrashDiagnosticsInstalled = true
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

  maybeRecordHeapCensus(memory, nowMs())
}

// Exposed for tests; real callers pass nowMs() (monotonic performance.now()).
// lastCensusAt === 0 means "never censused this renderer" → fire immediately so a
// fast leak (or a post-crash reload that re-inflates within 5 min) isn't missed.
export function shouldRecordHeapCensus(
  memory: BrowserPerformanceMemory,
  now: number,
  lastCensusAt: number
): boolean {
  const used = memory.usedJSHeapSize
  const limit = memory.jsHeapSizeLimit
  if (typeof used !== 'number' || typeof limit !== 'number' || limit <= 0) {
    return false
  }
  if (used / limit < HEAP_CENSUS_HIGH_WATER_FRACTION) {
    return false
  }
  return lastCensusAt === 0 || now - lastCensusAt >= HEAP_CENSUS_MIN_INTERVAL_MS
}

function maybeRecordHeapCensus(memory: BrowserPerformanceMemory, now: number): void {
  if (!shouldRecordHeapCensus(memory, now, lastHeapCensusAt)) {
    return
  }
  lastHeapCensusAt = now
  // Why: dynamic import keeps the census's store dependency off this leaf
  // module's hot import chain (terminal modules import this file — see below).
  void import('./renderer-heap-census')
    .then(({ collectRendererHeapCensus }) => {
      recordRendererCrashBreadcrumb('renderer_heap_census', collectRendererHeapCensus())
    })
    .catch(() => {
      // Census is best-effort diagnostics; never let it disrupt the sampler.
    })
}

function nowMs(): number {
  return typeof performance !== 'undefined' ? Math.round(performance.now()) : Date.now()
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
