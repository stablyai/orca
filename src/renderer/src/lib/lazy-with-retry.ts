import { lazy, type ComponentType, type LazyExoticComponent } from 'react'

/**
 * Resilient replacement for React.lazy.
 *
 * Why: a stale, corrupt, or truncated lazy chunk parses as invalid JavaScript and
 * rejects its dynamic import() with a native SyntaxError (e.g. "Unexpected token
 * ']'"). React.lazy permanently caches that rejection, so the error boundary's
 * "Retry" — which just re-renders the same Lazy — can never recover it; the
 * surface stays dead and reports a react-error-boundary crash. This wrapper first
 * retries transient fetch failures, then performs ONE guarded full reload to
 * refetch fresh chunk bytes and rebuild the ES module map, before finally falling
 * through to the error boundary.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirror React.lazy's own ComponentType<any> constraint so every existing call site type-checks unchanged.
type AnyComponent = ComponentType<any>

type LazyFactory<T extends AnyComponent> = () => Promise<{ default: T }>

type ReloadGuardState = 'not-attempted' | 'attempted' | 'unavailable'

export type LazyWithRetryOptions = {
  retries?: number
  baseDelayMs?: number
  /** Label surfaced in the reload breadcrumb for triage; not used for control flow. */
  reloadKey?: string
}

export class LazyChunkLoadError extends Error {
  constructor(cause: unknown) {
    super('Lazy chunk load failed after reload recovery was exhausted')
    this.name = 'LazyChunkLoadError'
    ;(this as { cause?: unknown }).cause = cause
  }
}

export function isLazyChunkLoadError(error: unknown): error is LazyChunkLoadError {
  return error instanceof LazyChunkLoadError
}

// One recovery reload per session. The guard survives the reload itself (so we
// never loop) but resets when the window/app closes, so a later launch — e.g.
// after an update ships fresh chunks — can earn another reload. sessionStorage
// (not localStorage) gives exactly that lifetime; it is never cleared mid-session,
// otherwise a sibling chunk's healthy load would re-arm the reload and an
// auto-mounted corrupt chunk would loop.
const RELOAD_GUARD_KEY = 'orca:lazy-chunk-reload-attempted'
const DEFAULT_RETRIES = 2
const DEFAULT_BASE_DELAY_MS = 250

function readChunkReloadGuardState(): ReloadGuardState {
  if (typeof window === 'undefined') {
    return 'unavailable'
  }
  try {
    return window.sessionStorage.getItem(RELOAD_GUARD_KEY) === '1' ? 'attempted' : 'not-attempted'
  } catch {
    // Why: when storage is blocked we cannot prove a reload happened, but still
    // fail closed on reloads so a broken chunk never loops.
    return 'unavailable'
  }
}

function markChunkReloadAttempted(): boolean {
  try {
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, '1')
    return true
  } catch {
    // A reload without a durable guard can loop, so treat write failure as unavailable.
    return false
  }
}

function recordReloadBreadcrumb(reloadKey: string, message: string): void {
  // Inlined rather than importing crash-diagnostics so this low-level recovery
  // primitive stays free of the renderer/webview module graph (keeps it SSR- and
  // unit-test-friendly). Mirrors crash-diagnostics' best-effort breadcrumb call.
  try {
    const api = (window as Window & { api?: Window['api'] }).api
    api?.crashReports.recordBreadcrumb({ name: 'lazy_chunk_reload', data: { reloadKey, message } })
  } catch {
    // Crash evidence is best-effort and must never mask the original failure.
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Suspends the React.lazy boundary while window.location.reload() tears the page
// down, so the error fallback never flashes in the moment before the reload lands.
const SUSPEND_UNTIL_RELOAD = new Promise<never>(() => undefined)

function isKnownDynamicImportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  if (error.name === 'ChunkLoadError') {
    return true
  }

  return [
    /failed to fetch dynamically imported module/i,
    /error loading dynamically imported module/i,
    /importing a module script failed/i,
    /failed to load module script/i,
    /loading chunk .+ failed/i
  ].some((pattern) => pattern.test(error.message))
}

export async function loadLazyWithRetry<T extends AnyComponent>(
  factory: LazyFactory<T>,
  options: LazyWithRetryOptions = {}
): Promise<{ default: T }> {
  const retries = options.retries ?? DEFAULT_RETRIES
  const baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS

  let lastError: unknown
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await factory()
    } catch (error) {
      lastError = error
      if (attempt < retries) {
        // Exponential backoff absorbs transient fetch hiccups (HTTP / relay / SSH).
        await wait(baseDelayMs * 2 ** attempt)
      }
    }
  }

  const reloadGuardState = readChunkReloadGuardState()
  if (typeof window !== 'undefined' && reloadGuardState === 'not-attempted') {
    if (!markChunkReloadAttempted()) {
      throw lastError
    }
    recordReloadBreadcrumb(
      options.reloadKey ?? 'unknown',
      lastError instanceof Error ? lastError.message : String(lastError)
    )
    window.location.reload()
    return SUSPEND_UNTIL_RELOAD
  }

  if (reloadGuardState === 'attempted' && isKnownDynamicImportFailure(lastError)) {
    throw new LazyChunkLoadError(lastError)
  }

  // No proven reload attempt (SSR / node / blocked storage) or unknown failure:
  // re-throw the original error so normal error reporting semantics stay intact.
  throw lastError
}

export function lazyWithRetry<T extends AnyComponent>(
  factory: LazyFactory<T>,
  options?: LazyWithRetryOptions
): LazyExoticComponent<T> {
  return lazy(() => loadLazyWithRetry(factory, options))
}
