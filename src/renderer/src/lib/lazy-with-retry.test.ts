// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  isLazyChunkLoadError,
  loadLazyWithRetry,
  resetLazyChunkReloadRequestsForTest
} from './lazy-with-retry'
import { preventUnloadAndScheduleShutdownCheckpointReset } from './shutdown-checkpoint-guard'
import {
  isIntentionalAppRestartInProgress,
  registerUpdaterBeforeUnloadBypass
} from './updater-beforeunload'
import { ORCA_RENDERER_UNLOAD_PREVENTED_EVENT } from '../../../shared/renderer-shutdown-events'
import { ORCA_APP_RESTART_ABORTED_EVENT } from '../../../shared/updater-renderer-events'
import {
  ORCA_EDITOR_PREPARE_HOT_EXIT_EVENT,
  type EditorPrepareHotExitDetail
} from '../../../shared/editor-save-events'

const RELOAD_GUARD_KEY = 'orca:lazy-chunk-reload-attempted'
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

// Replace the sessionStorage descriptor: happy-dom’s proxy cannot reliably restore vi.spyOn.
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
  resetLazyChunkReloadRequestsForTest()
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
  } catch {}
})

describe('loadLazyWithRetry', () => {
  it('fails closed with the original error when sessionStorage reads throw', async () => {
    const reload = spyOnReload()
    // Blocked storage must fail closed against reload loops.
    makeSessionStorageThrow()
    const error = chunkParseError()
    const factory = vi.fn(() => Promise.reject(error))

    const loaded = loadLazyWithRetry(factory, { retries: 1, baseDelayMs: 100 })
    const assertion = expect(loaded).rejects.toBe(error)
    await vi.advanceTimersByTimeAsync(5000)
    await assertion

    expect(reload).not.toHaveBeenCalled()
    const caught = await loaded.catch((rejection) => rejection)
    expect(isLazyChunkLoadError(caught)).toBe(false)
  })
})

describe('loadLazyWithRetry recovery reload vs the dirty-editor-tab unload veto', () => {
  type Harness = {
    navigations: string[]
    hotExitBackups: number
    restartLatchAtNavigation: boolean
  }

  let cleanupHarness: (() => void) | undefined

  function installDirtyEditorTab(options: { hotExitBackupFails?: boolean } = {}): Harness {
    const harness: Harness = {
      navigations: [],
      hotExitBackups: 0,
      restartLatchAtNavigation: false
    }
    const cleanupBypass = registerUpdaterBeforeUnloadBypass()

    const dirtyTabGuard = (event: Event): void => {
      if (isIntentionalAppRestartInProgress()) {
        return
      }
      preventUnloadAndScheduleShutdownCheckpointReset(event, window)
    }
    const hotExitBackup = (event: Event): void => {
      const detail = (event as CustomEvent<EditorPrepareHotExitDetail>).detail
      detail.claim()
      harness.hotExitBackups += 1
      if (options.hotExitBackupFails === true) {
        detail.reject('Some unsaved editor changes cannot be backed up before restart.')
        return
      }
      detail.resolve()
    }

    window.addEventListener('beforeunload', dirtyTabGuard)
    window.addEventListener(ORCA_EDITOR_PREPARE_HOT_EXIT_EVENT, hotExitBackup)
    vi.spyOn(window.location, 'reload').mockImplementation(() => {
      harness.restartLatchAtNavigation = isIntentionalAppRestartInProgress()
      const accepted = window.dispatchEvent(new Event('beforeunload', { cancelable: true }))
      harness.navigations.push(accepted ? 'landed' : 'cancelled')
      if (!accepted) {
        window.dispatchEvent(new Event(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT))
      }
    })

    cleanupHarness = () => {
      window.removeEventListener('beforeunload', dirtyTabGuard)
      window.removeEventListener(ORCA_EDITOR_PREPARE_HOT_EXIT_EVENT, hotExitBackup)
      cleanupBypass()
    }
    return harness
  }

  beforeEach(() => {
    vi.useFakeTimers()
    window.sessionStorage.clear()
    resetLazyChunkReloadRequestsForTest()
  })

  afterEach(() => {
    cleanupHarness?.()
    cleanupHarness = undefined
    vi.restoreAllMocks()
    vi.useRealTimers()
    delete (window as unknown as { api?: unknown }).api
    window.sessionStorage.clear()
  })

  it('lands the recovery reload despite an unsaved editor tab', async () => {
    const harness = installDirtyEditorTab()
    const error = chunkParseError()

    const loaded = loadLazyWithRetry(() => Promise.reject(error), { retries: 0 })
    let settled: unknown = 'pending'
    void loaded.then(
      (value) => {
        settled = value
      },
      (rejection: unknown) => {
        settled = rejection
      }
    )
    await vi.advanceTimersByTimeAsync(5000)

    expect(harness.navigations).toEqual(['landed'])
    expect(harness.restartLatchAtNavigation).toBe(true)
    expect(harness.hotExitBackups).toBe(1)
    expect(settled).toBe('pending')
  })

  it('refuses to reload when unsaved buffers cannot be backed up', async () => {
    const harness = installDirtyEditorTab({ hotExitBackupFails: true })
    const recordBreadcrumb = stubCrashReportsBreadcrumb()
    const restartAborted = vi.fn()
    window.addEventListener(ORCA_APP_RESTART_ABORTED_EVENT, restartAborted)
    const error = chunkParseError()

    const loaded = loadLazyWithRetry(() => Promise.reject(error), {
      retries: 0,
      reloadKey: 'rich-markdown-editor'
    })
    let settled: unknown = 'pending'
    void loaded.then(
      (value) => {
        settled = value
      },
      (rejection: unknown) => {
        settled = rejection
      }
    )
    await vi.advanceTimersByTimeAsync(5000)

    expect(harness.navigations).toEqual([])
    expect(isLazyChunkLoadError(settled)).toBe(true)
    expect(settled).toMatchObject({ cause: error })
    expect(restartAborted).toHaveBeenCalled()
    expect(isIntentionalAppRestartInProgress()).toBe(false)
    expect(recordBreadcrumb).toHaveBeenCalledWith({
      name: 'lazy_chunk_reload_vetoed',
      data: {
        reloadKey: 'rich-markdown-editor',
        message: "Unexpected token ']'",
        outcome: 'checkpoint-refused'
      }
    })
    window.removeEventListener(ORCA_APP_RESTART_ABORTED_EVENT, restartAborted)
  })

  it('clears recovery state when the host rejects the reload request', async () => {
    const harness = installDirtyEditorTab()
    const recordBreadcrumb = stubCrashReportsBreadcrumb()
    vi.mocked(window.location.reload).mockImplementation(() => {
      throw new Error('reload unavailable')
    })
    const error = chunkParseError()

    const settled = await loadLazyWithRetry(() => Promise.reject(error), {
      retries: 0,
      reloadKey: 'rich-markdown-editor'
    }).catch((rejection: unknown) => rejection)

    expect(isLazyChunkLoadError(settled)).toBe(true)
    expect(settled).toMatchObject({ cause: error })
    expect(harness.hotExitBackups).toBe(1)
    expect(isIntentionalAppRestartInProgress()).toBe(false)
    expect(window.sessionStorage.getItem(RELOAD_GUARD_KEY)).toBeNull()
    expect(vi.getTimerCount()).toBe(0)
    expect(recordBreadcrumb).toHaveBeenCalledWith({
      name: 'lazy_chunk_reload_vetoed',
      data: {
        reloadKey: 'rich-markdown-editor',
        message: "Unexpected token ']'",
        outcome: 'request-failed'
      }
    })
  })

  it('settles on the unload-prevented signal instead of waiting out the blind grace window', async () => {
    vi.spyOn(window.location, 'reload').mockImplementation(() => {
      window.dispatchEvent(new Event(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT))
    })
    const error = chunkParseError()

    const loaded = loadLazyWithRetry(() => Promise.reject(error), { retries: 0 })
    let settled: unknown = 'pending'
    void loaded.then(
      (value) => {
        settled = value
      },
      (rejection: unknown) => {
        settled = rejection
      }
    )
    await vi.advanceTimersByTimeAsync(50)

    expect(isLazyChunkLoadError(settled)).toBe(true)
    expect(settled).toMatchObject({ cause: error })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('drops the stale guard after a vetoed reload but caps re-arming per document', async () => {
    const reload = vi.fn(() => {
      window.dispatchEvent(new Event(ORCA_RENDERER_UNLOAD_PREVENTED_EVENT))
    })
    vi.spyOn(window.location, 'reload').mockImplementation(reload)
    const error = chunkParseError()
    const attempt = async (): Promise<unknown> => {
      let settled: unknown = 'pending'
      void loadLazyWithRetry(() => Promise.reject(error), { retries: 0 }).then(
        (value) => {
          settled = value
        },
        (rejection: unknown) => {
          settled = rejection
        }
      )
      await vi.advanceTimersByTimeAsync(50)
      return settled
    }

    expect(isLazyChunkLoadError(await attempt())).toBe(true)
    expect(window.sessionStorage.getItem(RELOAD_GUARD_KEY)).toBeNull()

    expect(isLazyChunkLoadError(await attempt())).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)

    expect(isLazyChunkLoadError(await attempt())).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
  })
})
