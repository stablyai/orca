// @vitest-environment happy-dom

// Reproduces the chunk failure that happens *during* a committed update install.
//
// Verified mechanism (2026-08-07, isolated Orca build, CDP): the renderer reads
// its 778 lazy chunks by byte offset out of a single app.asar. Once the installer
// replaces that archive, the old offsets land inside a different file, so an
// import that succeeded a moment earlier returns unparseable JavaScript:
//   before swap  -> LOADED_OK
//   after swap   -> SyntaxError: Unexpected token '}'   (also ':', 'Unexpected string')
//   name changed -> TypeError: Failed to fetch dynamically imported module
// Those are the exact messages in the shipped reports, and `overlay.update-card`
// — the surface hosting the restart button — is one of the failing boundaries.
//
// Requesting a recovery reload in that window is worse than useless: the process
// is already being torn down and the bundle underneath it has been swapped.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT } from '../../../shared/updater-renderer-events'

import {
  isLazyChunkLoadError,
  loadLazyWithRetry,
  resetLazyChunkReloadRequestsForTest
} from './lazy-with-retry'

const RELOAD_GUARD_KEY = 'orca:lazy-chunk-reload-attempted'

// The dominant crash-time message across the shipped bundles.
const CORRUPT_CHUNK_ERROR = (): SyntaxError => new SyntaxError("Unexpected token '}'")

type Breadcrumb = { name: string; data: Record<string, unknown> }

let mainSaysCommitted = false

function installBreadcrumbSink(): Breadcrumb[] {
  const breadcrumbs: Breadcrumb[] = []
  const api = (window as unknown as { api: Record<string, unknown> }).api
  api.crashReports = {
    recordBreadcrumb: (crumb: Breadcrumb) => {
      breadcrumbs.push(crumb)
    }
  }
  return breadcrumbs
}

/** Main is the authority; preload buffers it, so every renderer reads it live. */
function broadcastInstallCommitted(committed: boolean): void {
  mainSaysCommitted = committed
}

describe('loadLazyWithRetry during a committed update install', () => {
  beforeEach(() => {
    window.sessionStorage.clear()
    resetLazyChunkReloadRequestsForTest()
    vi.spyOn(window.location, 'reload').mockImplementation(() => undefined)
    mainSaysCommitted = false
    ;(window as unknown as { api: { updater: unknown } }).api = {
      ...(window as unknown as { api?: Record<string, unknown> }).api,
      updater: { isInstallCommittedNow: () => mainSaysCommitted }
    } as never
  })

  afterEach(() => {
    vi.restoreAllMocks()
    window.sessionStorage.clear()
    resetLazyChunkReloadRequestsForTest()
    delete (window as unknown as { api?: unknown }).api
  })

  // Main is the authority; preload buffers it for every document.
  const commitUpdateInstall = (): void => {
    broadcastInstallCommitted(true)
  }

  it('does not request a recovery reload once the installer is committed', async () => {
    installBreadcrumbSink()
    commitUpdateInstall()

    await expect(
      loadLazyWithRetry(() => Promise.reject(CORRUPT_CHUNK_ERROR()), {
        retries: 0,
        reloadKey: 'overlay.update-card'
      })
    ).rejects.toSatisfy(isLazyChunkLoadError)

    expect(window.location.reload).not.toHaveBeenCalled()
  })

  it('contains the failure so the boundary suppresses it instead of filing a crash', async () => {
    installBreadcrumbSink()
    commitUpdateInstall()

    const error = await loadLazyWithRetry(() => Promise.reject(CORRUPT_CHUNK_ERROR()), {
      retries: 0,
      reloadKey: 'overlay.update-card'
    }).catch((e: unknown) => e)

    expect(isLazyChunkLoadError(error)).toBe(true)
  })

  it('records why recovery was skipped, naming the call site', async () => {
    const breadcrumbs = installBreadcrumbSink()
    commitUpdateInstall()

    await loadLazyWithRetry(() => Promise.reject(CORRUPT_CHUNK_ERROR()), {
      retries: 0,
      reloadKey: 'overlay.update-card'
    }).catch(() => undefined)

    const skipped = breadcrumbs.find((crumb) => crumb.name === 'lazy_chunk_reload_skipped')
    expect(skipped?.data.reloadKey).toBe('overlay.update-card')
    expect(skipped?.data.outcome).toBe('update-install-in-progress')
  })

  it('leaves no reload guard behind, so a later real failure can still recover', async () => {
    installBreadcrumbSink()
    commitUpdateInstall()

    await loadLazyWithRetry(() => Promise.reject(CORRUPT_CHUNK_ERROR()), {
      retries: 0,
      reloadKey: 'overlay.update-card'
    }).catch(() => undefined)

    expect(window.sessionStorage.getItem(RELOAD_GUARD_KEY)).toBeNull()
  })

  it('does not mistake an in-flight ordinary recovery reload for an update install', async () => {
    // The ordinary recovery path announces itself with ORCA_APP_RESTART_STARTED_EVENT,
    // which also marks the shared "intentional restart" flag. Only an updater install
    // swaps app.asar, so keying off the shared flag would mislabel this failure — and
    // hide, behind an update-shaped outcome, a chunk failure that has nothing to do
    // with updating.
    const breadcrumbs = installBreadcrumbSink()

    const first = loadLazyWithRetry(() => Promise.reject(CORRUPT_CHUNK_ERROR()), {
      retries: 0,
      reloadKey: 'chunk-a'
    }).catch(() => undefined)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    await loadLazyWithRetry(() => Promise.reject(CORRUPT_CHUNK_ERROR()), {
      retries: 0,
      reloadKey: 'chunk-b'
    }).catch(() => undefined)

    const mislabelled = breadcrumbs.filter(
      (crumb) => crumb.data.reloadKey === 'chunk-b' && crumb.data.outcome === 'update-install-in-progress'
    )
    expect(mislabelled).toEqual([])
    await first
  })

  it('restores ordinary recovery when the install aborts', async () => {
    // A cancelled or failed install must not leave chunk recovery disabled for the
    // rest of the session — the bundle was never swapped.
    installBreadcrumbSink()
    commitUpdateInstall()
    // Only main can stand the archive down again.
    broadcastInstallCommitted(false)

    await loadLazyWithRetry(() => Promise.reject(CORRUPT_CHUNK_ERROR()), {
      retries: 0,
      reloadKey: 'right-sidebar'
    }).catch(() => undefined)

    expect(window.location.reload).toHaveBeenCalled()
  })

  it('skips recovery in a renderer that never dispatched the local event (popout)', async () => {
    // The dashboard popout has its own JS context and never invokes quitAndInstall,
    // so only main's broadcast can reach it. Its chunks come from the same archive.
    installBreadcrumbSink()
    broadcastInstallCommitted(true)

    await loadLazyWithRetry(() => Promise.reject(CORRUPT_CHUNK_ERROR()), {
      retries: 0,
      reloadKey: 'agent-kanban-board'
    }).catch(() => undefined)

    expect(window.location.reload).not.toHaveBeenCalled()
  })

  it('covers a window opened mid-install, which never saw a broadcast', async () => {
    installBreadcrumbSink()
    broadcastInstallCommitted(true)

    await loadLazyWithRetry(() => Promise.reject(CORRUPT_CHUNK_ERROR()), {
      retries: 0,
      reloadKey: 'agent-map'
    }).catch(() => undefined)

    expect(window.location.reload).not.toHaveBeenCalled()
  })

  it('keeps skipping when an unrelated updater error fires mid-install', async () => {
    // Reviewer blocker 3: the preload relay treats any updater error status as an
    // abort. Main owns the committed state, so an unrelated failed check during the
    // Linux revalidation window must not stand the archive back up.
    installBreadcrumbSink()
    broadcastInstallCommitted(true)
    window.dispatchEvent(new Event(ORCA_UPDATER_QUIT_AND_INSTALL_ABORTED_EVENT))

    await loadLazyWithRetry(() => Promise.reject(CORRUPT_CHUNK_ERROR()), {
      retries: 0,
      reloadKey: 'overlay.update-card'
    }).catch(() => undefined)

    expect(window.location.reload).not.toHaveBeenCalled()
  })

  it('still serves a chunk already cached in the module map during an install', async () => {
    // The guard sits after the retry loop on purpose: an already-evaluated module
    // resolves from Chromium's module map with no disk read, so a panel that would
    // have worked must keep working. Placing the guard earlier breaks this.
    installBreadcrumbSink()
    broadcastInstallCommitted(true)
    let calls = 0
    const factory = (): Promise<{ default: () => null }> => {
      calls += 1
      return calls === 1
        ? Promise.reject(CORRUPT_CHUNK_ERROR())
        : Promise.resolve({ default: () => null })
    }

    const loaded = await loadLazyWithRetry(factory, { retries: 1, baseDelayMs: 0 })

    expect(calls).toBe(2)
    expect(loaded.default).toBeTypeOf('function')
  })

  it('touches sessionStorage not at all on the skipped path', async () => {
    installBreadcrumbSink()
    broadcastInstallCommitted(true)
    const getItem = vi.spyOn(window.sessionStorage, 'getItem')
    const setItem = vi.spyOn(window.sessionStorage, 'setItem')
    const removeItem = vi.spyOn(window.sessionStorage, 'removeItem')

    await loadLazyWithRetry(() => Promise.reject(CORRUPT_CHUNK_ERROR()), {
      retries: 0,
      reloadKey: 'overlay.update-card'
    }).catch(() => undefined)

    // A write-then-remove leaves the key null too, so assert the path, not the key.
    expect(setItem).not.toHaveBeenCalled()
    expect(removeItem).not.toHaveBeenCalled()
    expect(getItem).not.toHaveBeenCalled()
  })

  it('skips recovery in a document born mid-install, before any registration', async () => {
    // Every reload/reopen path lands here: View -> Reload, force reload, the
    // app:reload IPC, renderer-crash recovery, dock activation, a new popout. The
    // fresh document never saw a broadcast, and its async seed can never be
    // answered while the Linux package install blocks main inside spawnSync. The
    // synchronous preload capture is the only thing that can be true this early —
    // note this test deliberately does NOT call registerUpdaterInstallCommitment.
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      crashReports: { recordBreadcrumb: () => undefined },
      updater: { isInstallCommittedNow: () => true }
    } as never

    await loadLazyWithRetry(() => Promise.reject(CORRUPT_CHUNK_ERROR()), {
      retries: 0,
      reloadKey: 'app.root'
    }).catch(() => undefined)

    expect(window.location.reload).not.toHaveBeenCalled()
  })

  it('still requests recovery when no install is committed', async () => {
    installBreadcrumbSink()

    await loadLazyWithRetry(() => Promise.reject(CORRUPT_CHUNK_ERROR()), {
      retries: 0,
      reloadKey: 'right-sidebar'
    }).catch(() => undefined)

    // Positive control: the ordinary recovery path must stay alive, or this fix
    // would silently disable chunk recovery everywhere.
    expect(window.location.reload).toHaveBeenCalled()
  })
})
