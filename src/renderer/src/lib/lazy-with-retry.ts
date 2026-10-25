import {
  createElement,
  lazy,
  useState,
  type ComponentProps,
  type ComponentType,
  type LazyExoticComponent,
  type ReactNode
} from 'react'

import {
  requestLazyChunkRecoveryReload,
  type LazyChunkRecoveryReloadOutcome
} from './lazy-chunk-recovery-reload'

/** React.lazy caches rejected imports permanently; retry transient failures, then request a guarded restart-prepared reload so stale/corrupt chunks can recover before the boundary. */

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirror React.lazy's own ComponentType<any> constraint so every existing call site type-checks unchanged.
type AnyComponent = ComponentType<any>

type LazyFactory<T extends AnyComponent> = () => Promise<{ default: T }>

type ReloadGuardState = 'not-attempted' | 'reload-landed' | 'reload-not-landed' | 'unavailable'

export type LazyWithRetryOptions = {
  retries?: number
  baseDelayMs?: number
  /** Names the call site on the reload breadcrumbs and on LazyChunkLoadError; never control flow. */
  reloadKey?: string
}

export class LazyChunkLoadError extends Error {
  /** Which lazy call site failed; carried on the error so reports name it without a breadcrumb. */
  readonly reloadKey: string

  constructor(cause: unknown, reloadKey = 'unknown') {
    super('Lazy chunk load failed after reload recovery was exhausted')
    this.name = 'LazyChunkLoadError'
    this.reloadKey = reloadKey
    ;(this as { cause?: unknown }).cause = cause
  }
}

export function isLazyChunkLoadError(error: unknown): error is LazyChunkLoadError {
  return error instanceof LazyChunkLoadError
}

// Keep the session guard across landed reloads, but let a surviving document clear its own token for another bounded attempt.
const RELOAD_GUARD_KEY = 'orca:lazy-chunk-reload-attempted'
// Reloading reevaluates this fallback, giving the new document a different token.
const FALLBACK_RELOAD_TOKEN = `doc-${Math.random().toString(36).slice(2)}`
const DEFAULT_RETRIES = 2
const DEFAULT_BASE_DELAY_MS = 250

// A matching token proves this document requested a reload that never landed.
function currentDocumentReloadToken(): string {
  const timeOrigin = typeof performance === 'undefined' ? Number.NaN : performance.timeOrigin
  return Number.isFinite(timeOrigin) && timeOrigin > 0 ? String(timeOrigin) : FALLBACK_RELOAD_TOKEN
}

function readChunkReloadGuardState(): ReloadGuardState {
  if (typeof window === 'undefined') {
    return 'unavailable'
  }
  try {
    const stored = window.sessionStorage.getItem(RELOAD_GUARD_KEY)
    if (stored === null) {
      return 'not-attempted'
    }
    return stored === currentDocumentReloadToken() ? 'reload-not-landed' : 'reload-landed'
  } catch {
    // Blocked storage cannot prove prior recovery; refuse reload to prevent corrupt-chunk loops.
    return 'unavailable'
  }
}

function markChunkReloadAttempted(): boolean {
  try {
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, currentDocumentReloadToken())
    return true
  } catch {
    // A reload without a durable guard can loop, so treat write failure as unavailable.
    return false
  }
}

function clearChunkReloadGuard(): void {
  try {
    window.sessionStorage.removeItem(RELOAD_GUARD_KEY)
  } catch {
    // Best effort: a document that cannot clear the guard just forfeits its retry.
  }
}

// A per-document cap prevents repeated vetoes from creating a reload loop.
const MAX_RELOAD_REQUESTS_PER_DOCUMENT = 2
let reloadRequestsThisDocument = 0
let reloadRequestInFlight = false

export function resetLazyChunkReloadRequestsForTest(): void {
  reloadRequestsThisDocument = 0
  reloadRequestInFlight = false
}

type ReloadBreadcrumbName = 'lazy_chunk_reload' | 'lazy_chunk_reload_vetoed'

function recordReloadBreadcrumb(
  name: ReloadBreadcrumbName,
  reloadKey: string,
  message: string,
  outcome?: string
): void {
  // Inline best-effort breadcrumbs to keep low-level recovery free of renderer/webview imports for SSR and unit tests.
  try {
    const api = (window as Window & { api?: Window['api'] }).api
    api?.crashReports.recordBreadcrumb({
      name,
      data: { reloadKey, message, ...(outcome === undefined ? {} : { outcome }) }
    })
  } catch {
    // Crash evidence is best-effort and must never mask the original failure.
  }
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Recovery is spent, so name the failure in the one way the boundary can contain. */
function containedChunkFailure(lastError: unknown, reloadKey: string): unknown {
  return isKnownDynamicImportFailure(lastError)
    ? new LazyChunkLoadError(lastError, reloadKey)
    : lastError
}

function isKnownDynamicImportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false
  }

  if (error.name === 'ChunkLoadError') {
    return true
  }

  // Contain import-time SyntaxError from corrupt chunks; top-level evaluation errors such as JSON.parse are indistinguishable. Stack-frame heuristics vary by V8 and could silently restore crashes.
  if (error.name === 'SyntaxError') {
    return true
  }

  return [
    /failed to fetch dynamically imported module/i,
    /error loading dynamically imported module/i,
    /importing a module script failed/i,
    /failed to load module script/i,
    /loading chunk .+ failed/i,
    /unexpected token/i,
    /unexpected end of (input|script|json)/i
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

  const reloadKey = options.reloadKey ?? 'unknown'
  const failureMessage = lastError instanceof Error ? lastError.message : String(lastError)
  const reloadGuardState = readChunkReloadGuardState()

  if (
    typeof window !== 'undefined' &&
    reloadGuardState === 'not-attempted' &&
    reloadRequestsThisDocument < MAX_RELOAD_REQUESTS_PER_DOCUMENT
  ) {
    if (!markChunkReloadAttempted()) {
      // No recovery was attempted, so keep normal reporting rather than containing.
      throw lastError
    }
    reloadRequestsThisDocument += 1
    reloadRequestInFlight = true
    recordReloadBreadcrumb('lazy_chunk_reload', reloadKey, failureMessage)
    let outcome: LazyChunkRecoveryReloadOutcome = 'request-failed'
    try {
      // A landed reload tears down this document before the promise settles.
      outcome = await requestLazyChunkRecoveryReload(window)
    } finally {
      reloadRequestInFlight = false
      clearChunkReloadGuard()
      recordReloadBreadcrumb('lazy_chunk_reload_vetoed', reloadKey, failureMessage, outcome)
    }
    // This was the document’s final recovery for the chunk even if reload was refused or never navigated.
    throw containedChunkFailure(lastError, reloadKey)
  }

  if (reloadGuardState === 'reload-landed') {
    throw containedChunkFailure(lastError, reloadKey)
  }

  if (reloadGuardState === 'reload-not-landed') {
    // Only this request may clear its guard; sibling failures during pending reload cannot reset it.
    if (!reloadRequestInFlight && isKnownDynamicImportFailure(lastError)) {
      // Record the veto before the ring can evict it; the failure is then contained.
      clearChunkReloadGuard()
      recordReloadBreadcrumb(
        'lazy_chunk_reload_vetoed',
        reloadKey,
        failureMessage,
        'guard-not-landed'
      )
    }
    throw containedChunkFailure(lastError, reloadKey)
  }

  if (reloadGuardState === 'not-attempted') {
    // The per-document reload cap is spent; further failures cannot recover.
    throw containedChunkFailure(lastError, reloadKey)
  }

  // Without window/storage, no recovery was attempted; retain normal error reporting.
  throw lastError
}

export function lazyWithRetry<T extends AnyComponent>(
  factory: LazyFactory<T>,
  options?: LazyWithRetryOptions
): LazyExoticComponent<T> {
  return lazy(() => loadLazyWithRetry(factory, options))
}

export type PreloadableLazyComponent<T extends AnyComponent> = ComponentType<ComponentProps<T>> & {
  /** Loads the chunk ahead of first render; failures stay silent so the real render owns recovery. */
  preload: () => void
}

/** Preload resolved modules directly so first render avoids React.lazy’s new Suspense reveal delay (up to 300ms). */
export function lazyWithPreload<T extends AnyComponent>(
  factory: LazyFactory<T>,
  options?: LazyWithRetryOptions
): PreloadableLazyComponent<T> {
  let loaded: T | null = null
  const LazyComponent = lazyWithRetry(
    () =>
      factory().then((module) => {
        loaded ??= module.default
        return module
      }),
    options
  )
  function PreloadableComponent(props: ComponentProps<T>): ReactNode {
    // Pin element type per mount or resolution mid-life would remount the subtree.
    const [Component] = useState(() => loaded ?? LazyComponent)
    return createElement(Component, props)
  }
  PreloadableComponent.preload = (): void => {
    if (loaded) {
      return
    }
    factory().then(
      (module) => {
        loaded ??= module.default
      },
      () => undefined
    )
  }
  return PreloadableComponent
}
