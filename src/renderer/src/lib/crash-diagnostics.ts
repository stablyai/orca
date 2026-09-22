import { compactBreadcrumbData, describeUnknownValue } from './crash-breadcrumb-data'
import { recordRendererCrashBreadcrumb } from './crash-breadcrumb-recorder'
import {
  readHeapMetrics,
  recordRendererMemorySample,
  resetRendererMemorySampling,
  setRendererMemorySamplingSurface,
  type RendererSurface
} from './renderer-memory-sampling'

const RENDERER_MEMORY_SAMPLE_INTERVAL_MS = 60_000

let rendererCrashDiagnosticsInstalled = false
let rendererMemoryInterval: number | null = null

// Why re-exported from a leaf module: terminal modules and their e2e-visible
// import chains need breadcrumb recording without this file's import.meta /
// webview-registry baggage. See crash-breadcrumb-recorder.ts.
export { recordRendererCrashBreadcrumb } from './crash-breadcrumb-recorder'

export function installRendererCrashDiagnostics(surface: RendererSurface = 'main'): void {
  if (rendererCrashDiagnosticsInstalled || typeof window === 'undefined') {
    return
  }

  rendererCrashDiagnosticsInstalled = true
  setRendererMemorySamplingSurface(surface)
  window.addEventListener('error', recordRendererError)
  window.addEventListener('unhandledrejection', recordRendererUnhandledRejection)

  if (readHeapMetrics()) {
    recordRendererMemorySample('startup')
    rendererMemoryInterval = window.setInterval(
      () => recordRendererMemorySample('interval'),
      RENDERER_MEMORY_SAMPLE_INTERVAL_MS
    )
  }
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
  resetRendererMemorySampling()
}

if (import.meta !== undefined && import.meta.hot) {
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
