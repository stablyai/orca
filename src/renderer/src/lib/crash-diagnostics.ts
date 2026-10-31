import { compactBreadcrumbData, describeUnknownValue } from './crash-breadcrumb-data'
import { recordRendererCrashBreadcrumb } from './crash-breadcrumb-recorder'
import {
  readHeapMetrics,
  recordRendererMemorySample,
  resetRendererMemorySampling,
  setRendererMemorySamplingSurface,
  startRendererLongTaskSampling,
  type RendererSurface
} from './renderer-memory-sampling'

const RENDERER_MEMORY_SAMPLE_INTERVAL_MS = 60_000

let rendererCrashDiagnosticsInstalled = false
let rendererMemoryInterval: number | null = null

// Re-export the leaf recorder so terminal/E2E imports avoid this module’s import.meta and webview dependencies.
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
    startRendererLongTaskSampling()
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
  // Remove global hooks on Vite replacement so HMR cannot accumulate diagnostics listeners.
  import.meta.hot.dispose(disposeRendererCrashDiagnostics)
}

function recordRendererError(event: ErrorEvent): void {
  // Ignore benign self-resolving ResizeObserver loop errors; recording them floods evidence and increases heap use (#8260).
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
