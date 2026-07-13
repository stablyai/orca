import type {
  CrashReportBreadcrumbData,
  CrashReportDetailValue
} from '../../../shared/crash-reporting'
import { getBrowserWebviewMemoryProfile } from '../components/browser-pane/webview-registry'
import { recordRendererCrashBreadcrumb } from './crash-breadcrumb-recorder'

const RENDERER_DIAGNOSTICS_SAMPLE_INTERVAL_MS = 60_000
const BYTES_PER_MEGABYTE = 1024 * 1024

type BrowserPerformanceMemory = {
  usedJSHeapSize?: number
  totalJSHeapSize?: number
  jsHeapSizeLimit?: number
}

let rendererCrashDiagnosticsInstalled = false
let rendererDiagnosticsInterval: number | null = null

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

  recordRendererDiagnostics('startup')
  rendererDiagnosticsInterval = window.setInterval(
    () => recordRendererDiagnostics('interval'),
    RENDERER_DIAGNOSTICS_SAMPLE_INTERVAL_MS
  )
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
  if (rendererDiagnosticsInterval !== null) {
    window.clearInterval(rendererDiagnosticsInterval)
    rendererDiagnosticsInterval = null
  }
}

if (typeof import.meta !== 'undefined' && import.meta.hot) {
  // Why: Vite can replace this module without a full renderer reload. Remove
  // global diagnostics hooks so dev sessions do not accumulate listeners.
  import.meta.hot.dispose(disposeRendererCrashDiagnostics)
}

function recordRendererError(event: ErrorEvent): void {
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

function recordRendererDiagnostics(reason: string): void {
  recordRendererMemory(reason)
  recordRendererSurface(reason)
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
}

function recordRendererSurface(reason: string): void {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return
  }

  const root = document.getElementById('root')
  const rootRect = root?.getBoundingClientRect()
  const bodyRect = document.body?.getBoundingClientRect()
  const rootStyle = root ? window.getComputedStyle(root) : undefined
  const bodyStyle = document.body ? window.getComputedStyle(document.body) : undefined

  recordRendererCrashBreadcrumb(
    'renderer_surface',
    compactBreadcrumbData({
      reason,
      visibilityState: document.visibilityState,
      hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() : undefined,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      rootPresent: Boolean(root),
      rootChildElementCount: root?.childElementCount,
      rootWidth: rootRect ? Math.round(rootRect.width) : undefined,
      rootHeight: rootRect ? Math.round(rootRect.height) : undefined,
      bodyWidth: bodyRect ? Math.round(bodyRect.width) : undefined,
      bodyHeight: bodyRect ? Math.round(bodyRect.height) : undefined,
      rootDisplay: rootStyle?.display,
      rootVisibility: rootStyle?.visibility,
      rootBackgroundColor: rootStyle?.backgroundColor,
      bodyDisplay: bodyStyle?.display,
      bodyVisibility: bodyStyle?.visibility,
      bodyBackgroundColor: bodyStyle?.backgroundColor
    })
  )
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
