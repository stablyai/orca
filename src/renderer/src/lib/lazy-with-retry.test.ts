// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'

import { loadLazyWithRetry } from './lazy-with-retry'

const RELOAD_GUARD_KEY = 'orca:lazy-chunk-reload-attempted'
const Comp: ComponentType = () => null
const chunkParseError = (): SyntaxError => new SyntaxError("Unexpected token ']'")

function spyOnReload(): ReturnType<typeof vi.fn> {
  const reload = vi.fn()
  // happy-dom's location.reload is a no-op that would otherwise log; replace it.
  vi.spyOn(window.location, 'reload').mockImplementation(reload)
  return reload
}

function stubCrashReportsBreadcrumb(): ReturnType<typeof vi.fn> {
  const recordBreadcrumb = vi.fn()
  Object.assign(window, { api: { crashReports: { recordBreadcrumb } } })
  return recordBreadcrumb
}

// Why: happy-dom's Storage is a Proxy that vi.spyOn cannot reliably restore, so
// override window.sessionStorage with a throwing getter and restore the saved
// descriptor in afterEach.
let savedSessionStorageDescriptor: PropertyDescriptor | undefined

function makeSessionStorageThrow(): void {
  savedSessionStorageDescriptor = Object.getOwnPropertyDescriptor(window, 'sessionStorage')
  Object.defineProperty(window, 'sessionStorage', {
    configurable: true,
    get() {
      throw new Error('storage blocked')
    }
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  window.sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  if (savedSessionStorageDescriptor) {
    Object.defineProperty(window, 'sessionStorage', savedSessionStorageDescriptor)
    savedSessionStorageDescriptor = undefined
  }
  try {
    delete (window as unknown as { api?: unknown }).api
    window.sessionStorage.clear()
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

  it('performs exactly one guarded reload after retries are exhausted', async () => {
    const reload = spyOnReload()
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
    expect(reload).toHaveBeenCalledTimes(1)
    expect(window.sessionStorage.getItem(RELOAD_GUARD_KEY)).toBe('1')
    // The load promise must suspend (never settle) while the page reloads, so the
    // error boundary never flashes.
    expect(settled).toBe(false)
  })

  it('does NOT reload twice — re-throws once the guard is already set', async () => {
    const reload = spyOnReload()
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, '1')
    const error = chunkParseError()
    const factory = vi.fn(() => Promise.reject(error))

    const loaded = loadLazyWithRetry(factory, { retries: 2, baseDelayMs: 250 })
    const assertion = expect(loaded).rejects.toBe(error)
    await vi.advanceTimersByTimeAsync(5000)
    await assertion

    expect(reload).not.toHaveBeenCalled()
  })

  it('fails closed (re-throws, never reloads) when sessionStorage reads throw', async () => {
    const reload = spyOnReload()
    // Private-mode / sandboxed storage makes reads throw. The guard must treat
    // this as "already reloaded" so a broken chunk can NEVER cause a reload loop.
    makeSessionStorageThrow()
    const error = chunkParseError()
    const factory = vi.fn(() => Promise.reject(error))

    const loaded = loadLazyWithRetry(factory, { retries: 1, baseDelayMs: 100 })
    const assertion = expect(loaded).rejects.toBe(error)
    await vi.advanceTimersByTimeAsync(5000)
    await assertion

    expect(reload).not.toHaveBeenCalled()
  })

  it('records a lazy_chunk_reload breadcrumb (with reloadKey) before reloading', async () => {
    const reload = spyOnReload()
    const recordBreadcrumb = stubCrashReportsBreadcrumb()
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
      data: { reloadKey: 'right-sidebar', message: "Unexpected token ']'" }
    })
    // The breadcrumb must land before window.location.reload() tears the page down.
    expect(recordBreadcrumb.mock.invocationCallOrder[0]).toBeLessThan(
      reload.mock.invocationCallOrder[0]
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
