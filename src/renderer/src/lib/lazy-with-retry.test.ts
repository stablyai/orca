// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'

import { isLazyChunkLoadError, loadLazyWithRetry } from './lazy-with-retry'
import { consumePendingRendererRecoveryNotification } from './renderer-recovery-notification'

const RELOAD_GUARD_KEY = 'orca:lazy-chunk-reload-attempted'
const RELOAD_RENDERER_BOOT_KEY = 'orca:lazy-chunk-reload-renderer-boot'
const APP_RESTART_GUARD_KEY = 'orca:lazy-chunk-app-restart-attempted:1.2.3-test'
const Comp: ComponentType = () => null
const chunkParseError = (): SyntaxError => new SyntaxError("Unexpected token ']'")
const chunkFetchError = (): TypeError =>
  new TypeError(
    'Failed to fetch dynamically imported module: https://assets.example.test/chunks/panel.js?v=secret /Users/test/orca/panel.js'
  )
const chunkLoadErrorByName = (): Error => {
  const error = new Error('async route asset request failed')
  error.name = 'ChunkLoadError'
  return error
}
const failedModuleScriptError = (): TypeError =>
  new TypeError(
    'Failed to load module script: Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text/html".'
  )

function markChunkReloadAttemptedInPriorRenderer(): void {
  window.sessionStorage.setItem(RELOAD_RENDERER_BOOT_KEY, 'previous-renderer-boot')
  window.sessionStorage.setItem(RELOAD_GUARD_KEY, '1')
}

function spyOnReload(): ReturnType<typeof vi.fn> {
  const reload = vi.fn()
  // happy-dom's location.reload is a no-op that would otherwise log; replace it.
  vi.spyOn(window.location, 'reload').mockImplementation(reload)
  return reload
}

function stubPreloadRecoveryApi(): {
  recordBreadcrumb: ReturnType<typeof vi.fn>
  reload: ReturnType<typeof vi.fn>
  restart: ReturnType<typeof vi.fn>
  getVersion: ReturnType<typeof vi.fn>
} {
  const recordBreadcrumb = vi.fn()
  const reload = vi.fn().mockResolvedValue(undefined)
  const restart = vi.fn().mockResolvedValue(undefined)
  const getVersion = vi.fn().mockResolvedValue('1.2.3-test')
  Object.assign(window, {
    api: {
      app: { reload, restart },
      crashReports: { recordBreadcrumb },
      updater: { getVersion }
    }
  })
  return { recordBreadcrumb, reload, restart, getVersion }
}

// Why: happy-dom's Storage is a Proxy that vi.spyOn cannot reliably restore, so
// override window.sessionStorage with a throwing getter and restore the saved
// descriptor in afterEach.
let savedSessionStorageDescriptor: PropertyDescriptor | undefined
let savedLocalStorageDescriptor: PropertyDescriptor | undefined

function makeSessionStorageThrow(): void {
  savedSessionStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage')
  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    get() {
      throw new Error('storage blocked')
    }
  })
}

function makeSessionStorageSetThrowAfterFirstWrite(): void {
  savedSessionStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage')
  const backingStorage = new Map<string, string>()
  let setCount = 0
  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => backingStorage.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        setCount += 1
        if (setCount > 1) {
          throw new Error('storage write blocked')
        }
        backingStorage.set(key, value)
      }),
      removeItem: vi.fn((key: string) => {
        backingStorage.delete(key)
      }),
      clear: vi.fn(() => {
        backingStorage.clear()
      }),
      get length() {
        return backingStorage.size
      }
    }
  })
}

function makeLocalStorageSetThrow(): void {
  savedLocalStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new Error('storage write blocked')
      }),
      removeItem: vi.fn(),
      clear: vi.fn(),
      get length() {
        return 0
      }
    }
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  window.sessionStorage.clear()
  window.localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  if (savedSessionStorageDescriptor) {
    Object.defineProperty(window, 'sessionStorage', savedSessionStorageDescriptor)
    savedSessionStorageDescriptor = undefined
  }
  if (savedLocalStorageDescriptor) {
    Object.defineProperty(window, 'localStorage', savedLocalStorageDescriptor)
    savedLocalStorageDescriptor = undefined
  }
  try {
    delete (window as unknown as { api?: unknown }).api
    window.sessionStorage.clear()
    window.localStorage.clear()
  } catch {
    // ignore — environment without storage
  }
})

describe('loadLazyWithRetry', () => {
  it('retries with exponential backoff (250ms, 500ms) and then resolves', async () => {
    const reload = spyOnReload()
    const factory = vi
      .fn()
      .mockRejectedValueOnce(chunkParseError())
      .mockRejectedValueOnce(chunkParseError())
      .mockResolvedValueOnce({ default: Comp })

    const loaded = loadLazyWithRetry(factory, { retries: 2, baseDelayMs: 250 })
    expect(factory).toHaveBeenCalledTimes(1) // first attempt runs synchronously

    await vi.advanceTimersByTimeAsync(200)
    expect(factory).toHaveBeenCalledTimes(1) // still inside the 250ms backoff
    await vi.advanceTimersByTimeAsync(100)
    expect(factory).toHaveBeenCalledTimes(2) // 250ms elapsed -> 2nd attempt

    await vi.advanceTimersByTimeAsync(400)
    expect(factory).toHaveBeenCalledTimes(2) // still inside the 500ms backoff
    await vi.advanceTimersByTimeAsync(100)
    expect(factory).toHaveBeenCalledTimes(3) // 500ms elapsed -> 3rd attempt

    await expect(loaded).resolves.toEqual({ default: Comp })
    expect(reload).not.toHaveBeenCalled()
  })

  it('performs exactly one guarded renderer reload after retries are exhausted', async () => {
    const reload = spyOnReload()
    const api = stubPreloadRecoveryApi()
    const factory = vi.fn(() => Promise.reject(chunkParseError()))

    const loaded = loadLazyWithRetry(factory, { retries: 2, baseDelayMs: 250 })
    let settled = false
    void loaded.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await vi.advanceTimersByTimeAsync(5000)

    expect(factory).toHaveBeenCalledTimes(3)
    expect(api.reload).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()
    expect(window.sessionStorage.getItem(RELOAD_GUARD_KEY)).toBe('1')
    expect(consumePendingRendererRecoveryNotification()).toEqual({
      reason: 'lazy-chunk-reload'
    })
    // The load promise must suspend (never settle) while the page reloads, so the
    // error boundary never flashes.
    expect(settled).toBe(false)
  })

  it('falls back to window reload when the preload reload bridge is unavailable', async () => {
    const reload = spyOnReload()
    const factory = vi.fn(() => Promise.reject(chunkParseError()))

    const loaded = loadLazyWithRetry(factory, { retries: 0, baseDelayMs: 250 })
    let settled = false
    void loaded.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await vi.advanceTimersByTimeAsync(5000)

    expect(reload).toHaveBeenCalledTimes(1)
    expect(settled).toBe(false)
  })

  it('clears partial reload guard state when the reload boot-token write fails', async () => {
    const reload = spyOnReload()
    const api = stubPreloadRecoveryApi()
    makeSessionStorageSetThrowAfterFirstWrite()
    const error = chunkParseError()
    const factory = vi.fn(() => Promise.reject(error))

    const loaded = loadLazyWithRetry(factory, { retries: 0, reloadKey: 'right-sidebar' })
    const assertion = expect(loaded).rejects.toBe(error)
    await vi.advanceTimersByTimeAsync(5000)
    await assertion

    expect(window.sessionStorage.getItem(RELOAD_GUARD_KEY)).toBeNull()
    expect(window.sessionStorage.getItem(RELOAD_RENDERER_BOOT_KEY)).toBeNull()
    expect(api.reload).not.toHaveBeenCalled()
    expect(api.restart).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  it('fails closed when the reload guard is set without a boot token', async () => {
    const reload = spyOnReload()
    const api = stubPreloadRecoveryApi()
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, '1')
    const error = chunkParseError()
    const factory = vi.fn(() => Promise.reject(error))

    const loaded = loadLazyWithRetry(factory, { retries: 0, reloadKey: 'right-sidebar' })
    const assertion = expect(loaded).rejects.toBe(error)
    await vi.advanceTimersByTimeAsync(5000)
    await assertion

    expect(api.getVersion).not.toHaveBeenCalled()
    expect(api.reload).not.toHaveBeenCalled()
    expect(api.restart).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  it('does not app-restart while the first renderer reload request is still in flight', async () => {
    const reload = spyOnReload()
    const api = stubPreloadRecoveryApi()
    const firstFactory = vi.fn(() => Promise.reject(chunkParseError()))
    const secondFactory = vi.fn(() => Promise.reject(chunkFetchError()))

    const first = loadLazyWithRetry(firstFactory, { retries: 0, reloadKey: 'first-panel' })
    let firstSettled = false
    void first.then(
      () => {
        firstSettled = true
      },
      () => {
        firstSettled = true
      }
    )
    await vi.advanceTimersByTimeAsync(0)

    expect(api.reload).toHaveBeenCalledTimes(1)
    expect(window.sessionStorage.getItem(RELOAD_GUARD_KEY)).toBe('1')
    expect(window.sessionStorage.getItem(RELOAD_RENDERER_BOOT_KEY)).toBeTruthy()

    const second = loadLazyWithRetry(secondFactory, { retries: 0, reloadKey: 'second-panel' })
    let secondSettled = false
    void second.then(
      () => {
        secondSettled = true
      },
      () => {
        secondSettled = true
      }
    )
    await vi.advanceTimersByTimeAsync(5000)

    expect(api.reload).toHaveBeenCalledTimes(1)
    expect(api.getVersion).not.toHaveBeenCalled()
    expect(api.restart).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    expect(firstSettled).toBe(false)
    expect(secondSettled).toBe(false)
  })

  it('restarts the app once when a lazy chunk still fails after renderer reload', async () => {
    const reload = spyOnReload()
    const api = stubPreloadRecoveryApi()
    markChunkReloadAttemptedInPriorRenderer()
    const factory = vi.fn(() => Promise.reject(chunkParseError()))

    const loaded = loadLazyWithRetry(factory, { retries: 2, baseDelayMs: 250 })
    let settled = false
    void loaded.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await vi.advanceTimersByTimeAsync(5000)

    expect(api.getVersion).toHaveBeenCalledTimes(1)
    expect(api.restart).toHaveBeenCalledTimes(1)
    expect(window.localStorage.getItem(APP_RESTART_GUARD_KEY)).toBe('1')
    expect(consumePendingRendererRecoveryNotification()).toEqual({
      reason: 'lazy-chunk-app-restart'
    })
    expect(reload).not.toHaveBeenCalled()
    expect(settled).toBe(false)
  })

  it('wraps chunk failures when post-reload app restart is unavailable', async () => {
    const reload = spyOnReload()
    markChunkReloadAttemptedInPriorRenderer()
    const error = chunkFetchError()
    const factory = vi.fn(() => Promise.reject(error))

    const loaded = loadLazyWithRetry(factory, { retries: 1, baseDelayMs: 100 })
    const assertion = expect(loaded).rejects.toMatchObject({
      name: 'LazyChunkLoadError',
      cause: error
    })
    await vi.advanceTimersByTimeAsync(5000)
    await assertion

    expect(reload).not.toHaveBeenCalled()
    const caught = await loaded.catch((rejection) => rejection)
    expect(isLazyChunkLoadError(caught)).toBe(true)
  })

  it.each([
    ['ChunkLoadError name', chunkLoadErrorByName],
    ['failed module script message', failedModuleScriptError]
  ])('restarts the app for post-reload %s failures', async (_label, createError) => {
    const reload = spyOnReload()
    const api = stubPreloadRecoveryApi()
    markChunkReloadAttemptedInPriorRenderer()
    const factory = vi.fn(() => Promise.reject(createError()))

    const loaded = loadLazyWithRetry(factory, { retries: 0, reloadKey: 'route-panel' })
    let settled = false
    void loaded.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await vi.advanceTimersByTimeAsync(5000)

    expect(api.getVersion).toHaveBeenCalledTimes(1)
    expect(api.restart).toHaveBeenCalledTimes(1)
    expect(window.localStorage.getItem(APP_RESTART_GUARD_KEY)).toBe('1')
    expect(consumePendingRendererRecoveryNotification()).toEqual({
      reason: 'lazy-chunk-app-restart'
    })
    expect(reload).not.toHaveBeenCalled()
    expect(settled).toBe(false)
  })

  it('does not restart the app for non-chunk lazy module failures after renderer reload', async () => {
    const reload = spyOnReload()
    const api = stubPreloadRecoveryApi()
    markChunkReloadAttemptedInPriorRenderer()
    const error = new ReferenceError('module initialization failed')
    const factory = vi.fn(() => Promise.reject(error))

    const loaded = loadLazyWithRetry(factory, { retries: 0, reloadKey: 'right-sidebar' })
    const assertion = expect(loaded).rejects.toBe(error)
    await vi.advanceTimersByTimeAsync(5000)
    await assertion

    expect(api.getVersion).not.toHaveBeenCalled()
    expect(api.restart).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(APP_RESTART_GUARD_KEY)).toBeNull()
    expect(reload).not.toHaveBeenCalled()
    const caught = await loaded.catch((rejection) => rejection)
    expect(isLazyChunkLoadError(caught)).toBe(false)
  })

  it('does not restart the app for non-chunk SyntaxError failures after renderer reload', async () => {
    const reload = spyOnReload()
    const api = stubPreloadRecoveryApi()
    markChunkReloadAttemptedInPriorRenderer()
    const error = new SyntaxError('Unexpected end of JSON input')
    const factory = vi.fn(() => Promise.reject(error))

    const loaded = loadLazyWithRetry(factory, { retries: 0, reloadKey: 'right-sidebar' })
    const assertion = expect(loaded).rejects.toBe(error)
    await vi.advanceTimersByTimeAsync(5000)
    await assertion

    expect(api.getVersion).not.toHaveBeenCalled()
    expect(api.restart).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(APP_RESTART_GUARD_KEY)).toBeNull()
    expect(reload).not.toHaveBeenCalled()
    const caught = await loaded.catch((rejection) => rejection)
    expect(isLazyChunkLoadError(caught)).toBe(false)
  })

  it('does not restart the app for JSON parse SyntaxError failures after renderer reload', async () => {
    const reload = spyOnReload()
    const api = stubPreloadRecoveryApi()
    markChunkReloadAttemptedInPriorRenderer()
    const error = new SyntaxError(`Unexpected token 'o', "oops" is not valid JSON`)
    const factory = vi.fn(() => Promise.reject(error))

    const loaded = loadLazyWithRetry(factory, { retries: 0, reloadKey: 'right-sidebar' })
    const assertion = expect(loaded).rejects.toBe(error)
    await vi.advanceTimersByTimeAsync(5000)
    await assertion

    expect(api.getVersion).not.toHaveBeenCalled()
    expect(api.restart).not.toHaveBeenCalled()
    expect(window.localStorage.getItem(APP_RESTART_GUARD_KEY)).toBeNull()
    expect(reload).not.toHaveBeenCalled()
    const caught = await loaded.catch((rejection) => rejection)
    expect(isLazyChunkLoadError(caught)).toBe(false)
  })

  it('restarts the app for truncated chunk SyntaxError failures after renderer reload', async () => {
    const reload = spyOnReload()
    const api = stubPreloadRecoveryApi()
    markChunkReloadAttemptedInPriorRenderer()
    const factory = vi.fn(() => Promise.reject(new SyntaxError('Unexpected end of input')))

    const loaded = loadLazyWithRetry(factory, { retries: 0, reloadKey: 'right-sidebar' })
    let settled = false
    void loaded.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await vi.advanceTimersByTimeAsync(5000)

    expect(api.getVersion).toHaveBeenCalledTimes(1)
    expect(api.restart).toHaveBeenCalledTimes(1)
    expect(window.localStorage.getItem(APP_RESTART_GUARD_KEY)).toBe('1')
    expect(reload).not.toHaveBeenCalled()
    expect(settled).toBe(false)
  })

  it('wraps the chunk error after renderer reload and app restart have already been attempted', async () => {
    const reload = spyOnReload()
    const api = stubPreloadRecoveryApi()
    markChunkReloadAttemptedInPriorRenderer()
    window.localStorage.setItem(APP_RESTART_GUARD_KEY, '1')
    const error = chunkParseError()
    const factory = vi.fn(() => Promise.reject(error))

    const loaded = loadLazyWithRetry(factory, { retries: 2, baseDelayMs: 250 })
    const assertion = expect(loaded).rejects.toMatchObject({
      name: 'LazyChunkLoadError',
      cause: error
    })
    await vi.advanceTimersByTimeAsync(5000)
    await assertion

    expect(api.restart).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    const caught = await loaded.catch((rejection) => rejection)
    expect(isLazyChunkLoadError(caught)).toBe(true)
  })

  it('fails closed with the original error when sessionStorage cannot prove whether renderer reload ran', async () => {
    const reload = spyOnReload()
    const api = stubPreloadRecoveryApi()
    // Private-mode / sandboxed storage makes reads throw. The guard must treat
    // this as unreadable, not as positive proof that app restart is eligible.
    makeSessionStorageThrow()
    const error = chunkParseError()
    const factory = vi.fn(() => Promise.reject(error))

    const loaded = loadLazyWithRetry(factory, { retries: 1, baseDelayMs: 100 })
    const assertion = expect(loaded).rejects.toBe(error)
    await vi.advanceTimersByTimeAsync(5000)
    await assertion

    expect(api.getVersion).not.toHaveBeenCalled()
    expect(api.restart).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
    const caught = await loaded.catch((rejection) => rejection)
    expect(isLazyChunkLoadError(caught)).toBe(false)
  })

  it('wraps the chunk error when the app version is empty', async () => {
    const api = stubPreloadRecoveryApi()
    api.getVersion.mockResolvedValue('  ')
    markChunkReloadAttemptedInPriorRenderer()
    const error = chunkParseError()
    const factory = vi.fn(() => Promise.reject(error))

    const loaded = loadLazyWithRetry(factory, { retries: 0 })
    const assertion = expect(loaded).rejects.toMatchObject({
      name: 'LazyChunkLoadError',
      cause: error
    })
    await vi.advanceTimersByTimeAsync(5000)
    await assertion

    expect(api.restart).not.toHaveBeenCalled()
    expect(window.localStorage.length).toBe(0)
  })

  it('does not burn the durable restart guard while restart is still pending', async () => {
    const api = stubPreloadRecoveryApi()
    let acceptRestart: (() => void) | undefined
    api.restart.mockReturnValue(
      new Promise<void>((resolve) => {
        acceptRestart = resolve
      })
    )
    markChunkReloadAttemptedInPriorRenderer()
    const factory = vi.fn(() => Promise.reject(chunkParseError()))

    const loaded = loadLazyWithRetry(factory, { retries: 0 })
    let settled = false
    void loaded.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await vi.advanceTimersByTimeAsync(5000)

    expect(api.restart).toHaveBeenCalledTimes(1)
    expect(window.localStorage.getItem(APP_RESTART_GUARD_KEY)).toBeNull()

    acceptRestart?.()
    await vi.advanceTimersByTimeAsync(0)

    expect(window.localStorage.getItem(APP_RESTART_GUARD_KEY)).toBe('1')
    expect(settled).toBe(false)
  })

  it('coalesces concurrent app restart recovery while the first restart is pending', async () => {
    const api = stubPreloadRecoveryApi()
    let acceptRestart: (() => void) | undefined
    api.restart.mockReturnValue(
      new Promise<void>((resolve) => {
        acceptRestart = resolve
      })
    )
    markChunkReloadAttemptedInPriorRenderer()
    const firstFactory = vi.fn(() => Promise.reject(chunkParseError()))
    const secondFactory = vi.fn(() => Promise.reject(chunkFetchError()))

    const first = loadLazyWithRetry(firstFactory, { retries: 0, reloadKey: 'first-panel' })
    const second = loadLazyWithRetry(secondFactory, { retries: 0, reloadKey: 'second-panel' })
    let firstSettled = false
    let secondSettled = false
    void first.then(
      () => {
        firstSettled = true
      },
      () => {
        firstSettled = true
      }
    )
    void second.then(
      () => {
        secondSettled = true
      },
      () => {
        secondSettled = true
      }
    )
    await vi.advanceTimersByTimeAsync(5000)

    expect(api.restart).toHaveBeenCalledTimes(1)
    const restartBreadcrumbs = api.recordBreadcrumb.mock.calls.filter(
      ([breadcrumb]) => breadcrumb.name === 'lazy_chunk_app_restart'
    )
    expect(restartBreadcrumbs).toHaveLength(1)
    expect(window.localStorage.getItem(APP_RESTART_GUARD_KEY)).toBeNull()

    acceptRestart?.()
    await vi.advanceTimersByTimeAsync(0)

    expect(window.localStorage.getItem(APP_RESTART_GUARD_KEY)).toBe('1')
    expect(firstSettled).toBe(false)
    expect(secondSettled).toBe(false)
  })

  it('does not burn the durable restart guard when restart rejects', async () => {
    const api = stubPreloadRecoveryApi()
    api.restart.mockRejectedValue(new Error('restart refused'))
    markChunkReloadAttemptedInPriorRenderer()
    const error = chunkParseError()
    const factory = vi.fn(() => Promise.reject(error))

    const loaded = loadLazyWithRetry(factory, { retries: 0 })
    const assertion = expect(loaded).rejects.toMatchObject({
      name: 'LazyChunkLoadError',
      cause: error
    })
    await vi.advanceTimersByTimeAsync(5000)
    await assertion

    expect(api.restart).toHaveBeenCalledTimes(1)
    expect(window.localStorage.getItem(APP_RESTART_GUARD_KEY)).toBeNull()
    expect(consumePendingRendererRecoveryNotification()).toBeNull()
  })

  it('fails closed before restart when the durable restart guard cannot be written', async () => {
    const api = stubPreloadRecoveryApi()
    markChunkReloadAttemptedInPriorRenderer()
    makeLocalStorageSetThrow()
    const error = chunkParseError()
    const factory = vi.fn(() => Promise.reject(error))

    const loaded = loadLazyWithRetry(factory, { retries: 0 })
    const assertion = expect(loaded).rejects.toMatchObject({
      name: 'LazyChunkLoadError',
      cause: error
    })
    await vi.advanceTimersByTimeAsync(5000)
    await assertion

    expect(api.restart).not.toHaveBeenCalled()
  })

  it('records a lazy_chunk_reload breadcrumb (with reloadKey) before reloading', async () => {
    const reload = spyOnReload()
    const { recordBreadcrumb, reload: apiReload } = stubPreloadRecoveryApi()
    const factory = vi.fn(() => Promise.reject(chunkParseError()))

    const loaded = loadLazyWithRetry(factory, { retries: 0, reloadKey: 'right-sidebar' })
    let settled = false
    void loaded.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await vi.advanceTimersByTimeAsync(5000)

    expect(recordBreadcrumb).toHaveBeenCalledTimes(1)
    expect(recordBreadcrumb).toHaveBeenCalledWith({
      name: 'lazy_chunk_reload',
      data: {
        reloadKey: 'right-sidebar',
        errorName: 'SyntaxError',
        errorCategory: 'syntax',
        messageClass: 'syntax'
      }
    })
    // The breadcrumb must land before app.reload() tears the page down.
    expect(recordBreadcrumb.mock.invocationCallOrder[0]).toBeLessThan(
      apiReload.mock.invocationCallOrder[0]
    )
    expect(reload).not.toHaveBeenCalled()
    expect(settled).toBe(false)
  })

  it('records lazy recovery breadcrumbs without raw dynamic-import error details', async () => {
    const { recordBreadcrumb } = stubPreloadRecoveryApi()
    const factory = vi.fn(() => Promise.reject(chunkFetchError()))

    const loaded = loadLazyWithRetry(factory, { retries: 0, reloadKey: 'right-sidebar' })
    void loaded.catch(() => undefined)
    await vi.advanceTimersByTimeAsync(5000)

    const breadcrumb = recordBreadcrumb.mock.calls[0]?.[0]
    expect(breadcrumb).toEqual({
      name: 'lazy_chunk_reload',
      data: {
        reloadKey: 'right-sidebar',
        errorName: 'TypeError',
        errorCategory: 'fetch',
        messageClass: 'fetch'
      }
    })
    const serializedBreadcrumb = JSON.stringify(breadcrumb)
    expect(serializedBreadcrumb).not.toContain('assets.example.test')
    expect(serializedBreadcrumb).not.toContain('secret')
    expect(serializedBreadcrumb).not.toContain('/Users/test')
    expect(serializedBreadcrumb).not.toContain('panel.js')
    expect(serializedBreadcrumb).not.toContain('Failed to fetch')
  })

  it('records a lazy_chunk_app_restart breadcrumb before restarting', async () => {
    const { recordBreadcrumb, restart } = stubPreloadRecoveryApi()
    markChunkReloadAttemptedInPriorRenderer()
    const factory = vi.fn(() => Promise.reject(chunkParseError()))

    const loaded = loadLazyWithRetry(factory, { retries: 0, reloadKey: 'update-card' })
    let settled = false
    void loaded.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await vi.advanceTimersByTimeAsync(5000)

    expect(recordBreadcrumb).toHaveBeenCalledWith({
      name: 'lazy_chunk_app_restart',
      data: {
        reloadKey: 'update-card',
        errorName: 'SyntaxError',
        errorCategory: 'syntax',
        messageClass: 'syntax',
        appVersion: '1.2.3-test'
      }
    })
    expect(recordBreadcrumb.mock.invocationCallOrder[0]).toBeLessThan(
      restart.mock.invocationCallOrder[0]
    )
    expect(settled).toBe(false)
  })

  it('re-throws without reloading when there is no window (SSR / node)', async () => {
    vi.stubGlobal('window', undefined)
    const error = chunkParseError()
    const factory = vi.fn(() => Promise.reject(error))

    const loaded = loadLazyWithRetry(factory, { retries: 1, baseDelayMs: 100 })
    const assertion = expect(loaded).rejects.toBe(error)
    await vi.advanceTimersByTimeAsync(5000)
    await assertion

    expect(factory).toHaveBeenCalledTimes(2)
    const caught = await loaded.catch((rejection) => rejection)
    expect(isLazyChunkLoadError(caught)).toBe(false)
  })

  it('keeps the reload guard set across a successful load (no second reload in one session)', async () => {
    const reload = spyOnReload()
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, '1')
    const factory = vi.fn(() => Promise.resolve({ default: Comp }))

    await loadLazyWithRetry(factory)

    // The guard must survive a healthy load — otherwise a sibling chunk's success
    // would re-arm the reload and an auto-mounted corrupt chunk would loop.
    expect(window.sessionStorage.getItem(RELOAD_GUARD_KEY)).toBe('1')
    expect(reload).not.toHaveBeenCalled()
  })
})
