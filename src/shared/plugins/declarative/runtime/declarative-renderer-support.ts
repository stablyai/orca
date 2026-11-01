import { describePluginError } from './declarative-error-location'

// Why: an update loop must not flood the host; ~one render per display frame is plenty.
export const MIN_RENDER_INTERVAL_MS = 16
// Renders the host has not acknowledged yet whose callbacks stay resolvable.
export const MAX_RETAINED_RENDERS = 32
// Why a ceiling: an older host never answers `ui.ready`, and the panel must still appear.
export const HYDRATION_TIMEOUT_MS = 3000

export function errorMessage(error: unknown): string {
  return describePluginError(error).slice(0, 4096)
}

export function defaultSchedule(flush: () => void, delayMs: number): void {
  if (delayMs > 0) {
    setTimeout(flush, delayMs)
  } else {
    queueMicrotask(flush)
  }
}

export function newDocumentId(now: number): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function isCallable(value: unknown): value is (...args: unknown[]) => unknown {
  return typeof value === 'function'
}
