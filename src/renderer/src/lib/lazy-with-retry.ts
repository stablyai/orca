import { lazy, type ComponentType, type LazyExoticComponent } from 'react'
import {
  describeLazyChunkError,
  isAppRestartEligibleLazyChunkError,
  type LazyChunkErrorBreadcrumbData
} from './lazy-chunk-error-classification'
import {
  clearRendererRecoveryNotificationPending,
  markRendererRecoveryNotificationPending
} from './renderer-recovery-notification'

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

// One recovery reload per renderer session. The guard survives the reload itself
// (so we never loop) but resets when the window/app closes, so a later launch can
// earn another reload. sessionStorage (not localStorage) gives exactly that
// lifetime; it is never cleared mid-session, otherwise a sibling chunk's healthy
// load would re-arm the reload and an auto-mounted corrupt chunk would loop.
const RELOAD_GUARD_KEY = 'orca:lazy-chunk-reload-attempted'
const RELOAD_RENDERER_BOOT_KEY = 'orca:lazy-chunk-reload-renderer-boot'
const APP_RESTART_GUARD_KEY_PREFIX = 'orca:lazy-chunk-app-restart-attempted:'
const DEFAULT_RETRIES = 2
const DEFAULT_BASE_DELAY_MS = 250
const appRestartInFlightByVersion = new Map<string, Promise<boolean>>()
const CURRENT_RENDERER_BOOT_ID = createRendererBootId()

type ReloadGuardStatus =
  | 'attempted-after-reload'
  | 'reload-requested'
  | 'not-attempted'
  | 'unreadable'

function readChunkReloadGuard(): ReloadGuardStatus {
  try {
    if (window.sessionStorage.getItem(RELOAD_GUARD_KEY) !== '1') {
      return 'not-attempted'
    }
    const reloadRequestBootId = window.sessionStorage.getItem(RELOAD_RENDERER_BOOT_KEY)
    if (!reloadRequestBootId) {
      return 'unreadable'
    }
    return reloadRequestBootId === CURRENT_RENDERER_BOOT_ID
      ? 'reload-requested'
      : 'attempted-after-reload'
  } catch {
    // Why: app restart is only safe after we can positively prove that the
    // renderer reload already happened in this session.
    return 'unreadable'
  }
}

function markChunkReloadAttempted(): boolean {
  try {
    window.sessionStorage.setItem(RELOAD_RENDERER_BOOT_KEY, CURRENT_RENDERER_BOOT_ID)
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, '1')
    return true
  } catch {
    clearChunkReloadAttempt()
    // Why: without a written session guard, a corrupt auto-mounted chunk could
    // reload-loop instead of falling through to the boundary.
    return false
  }
}

function clearChunkReloadAttempt(): void {
  try {
    window.sessionStorage.removeItem(RELOAD_GUARD_KEY)
    window.sessionStorage.removeItem(RELOAD_RENDERER_BOOT_KEY)
  } catch {
    // Best effort: the caller still fails closed.
  }
}

function createRendererBootId(): string {
  try {
    const randomUUID = globalThis.crypto?.randomUUID
    if (typeof randomUUID === 'function') {
      return randomUUID.call(globalThis.crypto)
    }
  } catch {
    // Fall back to a process-local token below.
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function recordReloadBreadcrumb(data: LazyChunkErrorBreadcrumbData): void {
  // Inlined rather than importing crash-diagnostics so this low-level recovery
  // primitive stays free of the renderer/webview module graph (keeps it SSR- and
  // unit-test-friendly). Mirrors crash-diagnostics' best-effort breadcrumb call.
  try {
    const api = (window as Window & { api?: Window['api'] }).api
    api?.crashReports.recordBreadcrumb({ name: 'lazy_chunk_reload', data })
  } catch {
    // Crash evidence is best-effort and must never mask the original failure.
  }
}

function recordRestartBreadcrumb(data: LazyChunkErrorBreadcrumbData, appVersion: string): void {
  try {
    const api = (window as Window & { api?: Window['api'] }).api
    api?.crashReports.recordBreadcrumb({
      name: 'lazy_chunk_app_restart',
      data: { ...data, appVersion }
    })
  } catch {
    // Crash evidence is best-effort and must never mask the original failure.
  }
}

function reloadRenderer(): void {
  try {
    const reload = (window as Window & { api?: Window['api'] }).api?.app.reload
    if (typeof reload === 'function') {
      void reload().catch(() => window.location.reload())
      return
    }
  } catch {
    // Fall through to the browser primitive when the preload bridge is gone.
  }
  window.location.reload()
}

async function getAppVersionForRecovery(): Promise<string | null> {
  try {
    const getVersion = (window as Window & { api?: Window['api'] }).api?.updater.getVersion
    const version = typeof getVersion === 'function' ? await getVersion() : null
    return typeof version === 'string' && version.trim() ? version.trim() : null
  } catch {
    return null
  }
}

function getAppRestartGuardKey(appVersion: string): string {
  return `${APP_RESTART_GUARD_KEY_PREFIX}${appVersion}`
}

function hasAttemptedAppRestart(appVersion: string): boolean {
  try {
    return window.localStorage.getItem(getAppRestartGuardKey(appVersion)) === '1'
  } catch {
    // Why: this guard must survive an app restart. If persistent storage is not
    // readable, fail closed rather than risking a restart loop.
    return true
  }
}

function markAppRestartAttempted(appVersion: string): boolean {
  try {
    window.localStorage.setItem(getAppRestartGuardKey(appVersion), '1')
    return true
  } catch {
    // Why: without a durable guard, the same installed version could restart-loop.
    return false
  }
}

function canWriteAppRestartGuard(appVersion: string): boolean {
  const probeKey = `${getAppRestartGuardKey(appVersion)}:probe`
  try {
    window.localStorage.setItem(probeKey, '1')
    window.localStorage.removeItem(probeKey)
    return true
  } catch {
    // Why: app restart recovery needs a durable post-restart loop guard.
    return false
  }
}

async function restartAppForChunkRecovery(data: LazyChunkErrorBreadcrumbData): Promise<boolean> {
  let restart: (() => Promise<void>) | undefined
  try {
    restart = (window as Window & { api?: Window['api'] }).api?.app.restart
  } catch {
    return false
  }
  if (typeof restart !== 'function') {
    return false
  }

  const appVersion = await getAppVersionForRecovery()
  if (!appVersion) {
    return false
  }
  if (hasAttemptedAppRestart(appVersion)) {
    return false
  }
  const inFlightRestart = appRestartInFlightByVersion.get(appVersion)
  if (inFlightRestart) {
    return inFlightRestart
  }
  if (!canWriteAppRestartGuard(appVersion)) {
    return false
  }
  recordRestartBreadcrumb(data, appVersion)
  markRendererRecoveryNotificationPending('lazy-chunk-app-restart', 'local')

  const restartAttempt = restart()
    .then(() => markAppRestartAttempted(appVersion))
    .catch(() => false)
  appRestartInFlightByVersion.set(appVersion, restartAttempt)
  const restarted = await restartAttempt
  if (!restarted) {
    clearRendererRecoveryNotificationPending('lazy-chunk-app-restart')
  }
  appRestartInFlightByVersion.delete(appVersion)
  return restarted
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Suspends the React.lazy boundary while reload/restart tears the page down, so
// the error fallback never flashes in the moment before recovery lands.
const SUSPEND_UNTIL_RECOVERY = new Promise<never>(() => undefined)

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
  const errorData = describeLazyChunkError(reloadKey, lastError)
  const reloadGuardStatus = typeof window === 'undefined' ? 'unreadable' : readChunkReloadGuard()
  if (reloadGuardStatus === 'not-attempted') {
    if (!markChunkReloadAttempted()) {
      throw lastError
    }
    recordReloadBreadcrumb(errorData)
    markRendererRecoveryNotificationPending('lazy-chunk-reload', 'session')
    reloadRenderer()
    return SUSPEND_UNTIL_RECOVERY
  }

  if (reloadGuardStatus === 'reload-requested') {
    return SUSPEND_UNTIL_RECOVERY
  }

  if (
    reloadGuardStatus === 'attempted-after-reload' &&
    isAppRestartEligibleLazyChunkError(errorData)
  ) {
    if (await restartAppForChunkRecovery(errorData)) {
      return SUSPEND_UNTIL_RECOVERY
    }
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
