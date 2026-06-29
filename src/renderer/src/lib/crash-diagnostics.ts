import type {
  CrashReportBreadcrumbData,
  CrashReportDetailValue
} from '../../../shared/crash-reporting'
import { getBrowserWebviewMemoryProfile } from '../components/browser-pane/webview-registry'
import { markRendererRecoveryNotificationPending } from './renderer-recovery-notification'

const RENDERER_MEMORY_SAMPLE_INTERVAL_MS = 60_000
const BYTES_PER_MEGABYTE = 1024 * 1024
// Why: recover only after sustained high heap usage, avoiding reloads for small
// heaps or one-off spikes while still acting before likely renderer loss.
const CRITICAL_HEAP_USAGE_RATIO = 0.85
const CRITICAL_HEAP_MIN_MB = 512
const CRITICAL_HEAP_SAMPLES_BEFORE_RELOAD = 2
const MEMORY_PRESSURE_RELOAD_GUARD_KEY = 'orca:renderer-memory-pressure-reload-attempted'

type BrowserPerformanceMemory = {
  usedJSHeapSize?: number
  totalJSHeapSize?: number
  jsHeapSizeLimit?: number
}

let rendererCrashDiagnosticsInstalled = false
let rendererMemoryInterval: number | null = null
let criticalHeapPressureSampleCount = 0

export function recordRendererCrashBreadcrumb(
  name: string,
  data?: CrashReportBreadcrumbData
): void {
  if (typeof window === 'undefined') {
    return
  }

  try {
    // Why: crash diagnostics must never create or mask renderer startup failures.
    const api = (window as Window & { api?: Window['api'] }).api
    api?.crashReports.recordBreadcrumb({ name, ...(data ? { data } : {}) })
  } catch {
    // Best-effort crash evidence only.
  }
}

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
  criticalHeapPressureSampleCount = 0
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

function recordRendererMemory(reason: string): void {
  const memory = getPerformanceMemory()
  if (!memory) {
    return
  }
  const browserWebviews = getBrowserWebviewMemoryProfile()
  const usedHeapMB = toMegabytes(memory.usedJSHeapSize)
  const totalHeapMB = toMegabytes(memory.totalJSHeapSize)
  const heapLimitMB = toMegabytes(memory.jsHeapSizeLimit)

  recordRendererCrashBreadcrumb(
    'renderer_memory',
    compactBreadcrumbData({
      reason,
      usedHeapMB,
      totalHeapMB,
      heapLimitMB,
      browserWebviews: browserWebviews.browserWebviewCount,
      registeredBrowserGuests: browserWebviews.registeredBrowserGuestCount
    })
  )
  maybeReloadForCriticalHeapPressure({
    reason,
    usedHeapMB,
    totalHeapMB,
    heapLimitMB,
    browserWebviews: browserWebviews.browserWebviewCount,
    registeredBrowserGuests: browserWebviews.registeredBrowserGuestCount
  })
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

function maybeReloadForCriticalHeapPressure({
  reason,
  usedHeapMB,
  totalHeapMB,
  heapLimitMB,
  browserWebviews,
  registeredBrowserGuests
}: {
  reason: string
  usedHeapMB: number | undefined
  totalHeapMB: number | undefined
  heapLimitMB: number | undefined
  browserWebviews: number
  registeredBrowserGuests: number
}): void {
  if (
    usedHeapMB === undefined ||
    heapLimitMB === undefined ||
    heapLimitMB <= 0 ||
    usedHeapMB < CRITICAL_HEAP_MIN_MB ||
    usedHeapMB / heapLimitMB < CRITICAL_HEAP_USAGE_RATIO
  ) {
    criticalHeapPressureSampleCount = 0
    return
  }

  criticalHeapPressureSampleCount += 1
  if (
    criticalHeapPressureSampleCount < CRITICAL_HEAP_SAMPLES_BEFORE_RELOAD ||
    hasAttemptedMemoryPressureReload()
  ) {
    return
  }

  if (!markMemoryPressureReloadAttempted()) {
    return
  }
  recordRendererCrashBreadcrumb(
    'renderer_memory_pressure_reload',
    compactBreadcrumbData({
      reason,
      usedHeapMB,
      totalHeapMB,
      heapLimitMB,
      heapUsageRatio: Math.round((usedHeapMB / heapLimitMB) * 100) / 100,
      browserWebviews,
      registeredBrowserGuests
    })
  )
  markRendererRecoveryNotificationPending('memory-pressure-reload', 'session')
  reloadRendererForMemoryPressure()
}

function hasAttemptedMemoryPressureReload(): boolean {
  try {
    return window.sessionStorage.getItem(MEMORY_PRESSURE_RELOAD_GUARD_KEY) === '1'
  } catch {
    // Why: without session-scoped storage we cannot prove a reload already ran,
    // so fail closed rather than risking a reload loop during memory pressure.
    return true
  }
}

function markMemoryPressureReloadAttempted(): boolean {
  try {
    window.sessionStorage.setItem(MEMORY_PRESSURE_RELOAD_GUARD_KEY, '1')
    return true
  } catch {
    // Why: without a written session guard, memory-pressure recovery could loop.
    return false
  }
}

function reloadRendererForMemoryPressure(): void {
  try {
    const reload = window.api?.app.reload
    if (typeof reload === 'function') {
      void reload().catch(() => window.location.reload())
      return
    }
  } catch {
    // Fall through to the browser primitive when the preload bridge is gone.
  }
  window.location.reload()
}
