import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  noteBrowserPageGuestRegistered,
  observeBrowserPageMainFrameEvents
} from '@/components/browser-pane/host-guest/lifecycle/browser-page-main-frame-events'
import { createChangedFilePageRefreshActions } from '@/store/slices/browser/pages/changed-file-page-refresh-actions'
import {
  driveChangedFilePageRefresh,
  sameDocumentUrl,
  type ChangedFileRefreshActionResult
} from './changed-file-page-refresh-driver'
import { requestChangedFilePageRefresh } from './request-changed-file-page-refresh'
import type { BrowserSlice } from '@/store/slices/browser/browser-slice-contract'
import type { ChangedFilePageRefreshResource } from './changed-file-page-refresh-intent'

type RefreshStore = Pick<
  BrowserSlice,
  | 'changedFileRefreshByPageId'
  | 'requestChangedFilePageRefresh'
  | 'setChangedFilePageRefreshBaseline'
  | 'settleChangedFilePageRefresh'
>
const store: { state: RefreshStore | null } = vi.hoisted(() => ({ state: null }))

vi.mock('@/store/index', () => ({ useAppStore: { getState: () => store.state } }))

const FILE_URL = 'file:///repo/site/index.html'
const SIBLING_URL = 'file:///repo/site/about.html'
const OTHER_URL = 'file:///repo/site/contact.html'
const resource: ChangedFilePageRefreshResource = { kind: 'local-file', url: FILE_URL }
let pageCount = 0
let PAGE = 'page-0'

class FakeGuest extends EventTarget {
  url = FILE_URL
  loading = false
  alive = true
  crashed = false
  isCrashed(): boolean {
    return this.crashed
  }
  getWebContentsId(): number {
    if (!this.alive) {
      throw new Error('guest destroyed')
    }
    return 1
  }
  getURL(): string {
    return this.url
  }
  isLoadingMainFrame(): boolean {
    return this.loading
  }
  fire(type: string, detail: Record<string, unknown> = {}): void {
    this.dispatchEvent(Object.assign(new Event(type), detail))
  }
  start(url: string, detail: Record<string, unknown> = {}): void {
    this.loading = true
    this.fire('did-start-navigation', { url, isMainFrame: true, isInPlace: false, ...detail })
  }
  commit(url: string): void {
    this.url = url
    this.loading = false
    this.fire('did-navigate', { url })
  }
  /** A cross-document navigation that starts and commits. */
  visit(url: string): void {
    this.start(url)
    this.commit(url)
  }
}

function setUpStore(): RefreshStore {
  const state: RefreshStore = {
    changedFileRefreshByPageId: {},
    ...createChangedFilePageRefreshActions((update) => {
      Object.assign(state, update(state))
    })
  }
  store.state = state
  return state
}

/** The fake implements only what the driver and event seam call on a guest. */
function asWebview(guest: FakeGuest): Electron.WebviewTag {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the driver reads getWebContentsId/getURL/isLoadingMainFrame/isCrashed and DOM events only.
  return guest as unknown as Electron.WebviewTag
}

function newGuest(initial: Partial<Pick<FakeGuest, 'url' | 'loading' | 'alive'>> = {}): FakeGuest {
  const guest = Object.assign(new FakeGuest(), initial)
  noteBrowserPageGuestRegistered(asWebview(guest))
  observeBrowserPageMainFrameEvents(PAGE, asWebview(guest))
  return guest
}

type DriveOptions = { guestFailed?: () => boolean; pointsAtResource?: () => boolean }

function startDrive(guest: () => FakeGuest | null, options: DriveOptions = {}) {
  const reload = vi.fn((): ChangedFileRefreshActionResult => 'issued')
  const navigate = vi.fn((): ChangedFileRefreshActionResult => 'issued')
  const owner = {
    readWebview: () => {
      const current = guest()
      return current ? asWebview(current) : null
    },
    pointsAtResource: options.pointsAtResource ?? (() => true),
    isResourceUrl: (url: string) => sameDocumentUrl(url, FILE_URL),
    ...(options.guestFailed ? { guestFailed: options.guestFailed } : {}),
    reload,
    navigate
  }
  const drive = () =>
    driveChangedFilePageRefresh(PAGE, store.state!.changedFileRefreshByPageId[PAGE]!, owner)
  let handle = drive()
  return {
    reload,
    navigate,
    reevaluate: () => handle.reevaluate(),
    /** What the hook does when the intent object changes (its baseline landed). */
    restart: () => {
      handle.stop()
      handle = drive()
    }
  }
}

/** Records the intent; the returned release plays the IPC round trip returning. */
function request(): () => Promise<void> {
  let release = (): void => {}
  requestChangedFilePageRefresh(
    PAGE,
    resource,
    () => new Promise<void>((resolve) => (release = resolve))
  )
  return async () => {
    release()
    await Promise.resolve()
    await Promise.resolve()
  }
}

/** Request, let `beforeBaseline` deliver queued pre-request events, take the baseline, then drive. */
async function requestThenDrive(
  guest: () => FakeGuest | null,
  beforeBaseline: () => void = () => {},
  options: DriveOptions = {}
): Promise<ReturnType<typeof startDrive>> {
  const releaseBaseline = request()
  const drive = startDrive(guest, options)
  beforeBaseline()
  await releaseBaseline()
  drive.restart()
  return drive
}

function pending(): boolean {
  return Boolean(store.state?.changedFileRefreshByPageId[PAGE])
}

describe('changed-file page refresh driver', () => {
  let state: RefreshStore
  beforeEach(() => {
    state = setUpStore()
    PAGE = `page-${++pageCount}`
  })

  it('does nothing until the request baseline is known', () => {
    const guest = newGuest()
    request()
    const { reload } = startDrive(() => guest)
    expect(reload).not.toHaveBeenCalled()
  })

  it('reloads the existing guest once and clears on its post-request start and commit', async () => {
    const guest = newGuest()
    const { reload } = await requestThenDrive(() => guest)
    expect(reload).toHaveBeenCalledTimes(1)
    guest.start(FILE_URL)
    expect(pending()).toBe(true)
    guest.commit(`${FILE_URL}#top`)
    expect(pending()).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('navigates a guest that showed a sibling before the request back to the file', async () => {
    const guest = newGuest({ url: SIBLING_URL })
    const { reload, navigate } = await requestThenDrive(() => guest)
    expect(navigate).toHaveBeenCalledTimes(1)
    expect(reload).not.toHaveBeenCalled()
  })

  it('is not satisfied by iframe loading, subframe navigation or in-page navigation', async () => {
    const guest = newGuest()
    await requestThenDrive(() => guest)
    guest.fire('did-start-loading')
    guest.fire('did-stop-loading')
    guest.fire('did-start-navigation', {
      url: 'file:///repo/site/frame.html',
      isMainFrame: false,
      isInPlace: false
    })
    guest.fire('did-start-navigation', { url: `${FILE_URL}#s`, isMainFrame: true, isInPlace: true })
    guest.fire('did-navigate-in-page', { url: `${FILE_URL}#s`, isMainFrame: true })
    guest.fire('did-fail-load', { isMainFrame: false, errorCode: -105 })
    expect(pending()).toBe(true)
  })

  it('lets a newer request replace an older one; a stale settle or baseline cannot touch it', () => {
    const older = state.requestChangedFilePageRefresh(PAGE, resource)
    const newer = state.requestChangedFilePageRefresh(PAGE, resource)
    expect(newer).toBeGreaterThan(older)
    state.settleChangedFilePageRefresh(PAGE, older)
    state.setChangedFilePageRefreshBaseline(PAGE, older, 0)
    expect(state.changedFileRefreshByPageId[PAGE]?.seq).toBe(newer)
    expect(state.changedFileRefreshByPageId[PAGE]?.baselineSeq).toBeUndefined()
  })

  it('stops acting once a newer request supersedes the one it drives', async () => {
    const guest = newGuest()
    const { reload } = await requestThenDrive(() => guest)
    request()
    guest.visit(FILE_URL)
    expect(reload).toHaveBeenCalledTimes(1)
    expect(pending()).toBe(true)
  })

  it('does not act when the page no longer names the file', async () => {
    const guest = newGuest()
    const { reload } = await requestThenDrive(() => guest, undefined, {
      pointsAtResource: () => false
    })
    expect(reload).not.toHaveBeenCalled()
    expect(pending()).toBe(false)
  })

  it('judges a replacement guest by its own first load', async () => {
    let current: FakeGuest = newGuest()
    current.getWebContentsId()
    current.crashed = true
    const { reload } = await requestThenDrive(() => current)
    expect(reload).toHaveBeenCalledTimes(1)
    current = newGuest({ url: '', loading: true })
    expect(pending()).toBe(true)
    current.visit(FILE_URL)
    expect(pending()).toBe(false)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('waits for an attaching replacement, recovers it once if it dies, and fails on a second death', async () => {
    let current = newGuest({ alive: false })
    const { reload } = await requestThenDrive(() => current)
    expect(reload).not.toHaveBeenCalled()
    current.fire('render-process-gone')
    expect(reload).toHaveBeenCalledTimes(1)
    current = newGuest({ alive: false })
    current.fire('destroyed')
    expect(reload).toHaveBeenCalledTimes(1)
    expect(pending()).toBe(false)
  })

  it('recovers a preview that failed without any guest, once', async () => {
    let failed = false
    const { reload, reevaluate } = await requestThenDrive(() => null, undefined, {
      guestFailed: () => failed
    })
    failed = true
    reevaluate()
    expect(reload).toHaveBeenCalledTimes(1)
    reevaluate()
    expect(reload).toHaveBeenCalledTimes(1)
    expect(pending()).toBe(false)
  })

  // Every combination of what was queued before the request and what happens after it.
  describe('request interleavings', () => {
    const IN_FLIGHT = 'a load of the file still in flight'
    const preRequest: Record<string, (guest: FakeGuest) => void> = {
      'nothing queued': () => {},
      'a finished load of the file delivered late': (guest) => guest.visit(FILE_URL),
      [IN_FLIGHT]: (guest) => guest.start(FILE_URL)
    }

    const userKeeps: Record<string, (guest: FakeGuest) => void> = {
      'no other activity': () => {},
      'a fragment jump on the file': (guest) => {
        guest.fire('did-start-navigation', {
          url: `${FILE_URL}#s`,
          isMainFrame: true,
          isInPlace: true
        })
        guest.fire('did-navigate-in-page', { url: `${FILE_URL}#s`, isMainFrame: true })
      }
    }

    const userMovesOn: Record<string, (guest: FakeGuest) => void> = {
      'a sibling that committed': (guest) => guest.visit(SIBLING_URL),
      'a sibling still loading': (guest) => guest.start(SIBLING_URL),
      'a sibling reloaded (B then B)': (guest) => {
        guest.visit(SIBLING_URL)
        guest.visit(SIBLING_URL)
      },
      'a round trip (B then C then B)': (guest) => {
        guest.visit(SIBLING_URL)
        guest.visit(OTHER_URL)
        guest.visit(SIBLING_URL)
      }
    }

    for (const [queued, deliverQueued] of Object.entries(preRequest)) {
      for (const [activity, act] of Object.entries(userKeeps)) {
        it(`${queued}, then ${activity}: only its own reload proves freshness`, async () => {
          const guest = newGuest()
          const { reload, navigate } = await requestThenDrive(
            () => guest,
            () => deliverQueued(guest)
          )
          if (queued === IN_FLIGHT) {
            // The pre-request load commits after the baseline; only then does the owner act.
            expect(reload).not.toHaveBeenCalled()
            guest.commit(FILE_URL)
          }
          act(guest)
          expect(reload).toHaveBeenCalledTimes(1)
          expect(navigate).not.toHaveBeenCalled()
          expect(pending()).toBe(true)
          guest.visit(FILE_URL)
          expect(pending()).toBe(false)
        })
      }
      for (const [activity, moveOn] of Object.entries(userMovesOn)) {
        it(`${queued}, then ${activity}: the newer navigation wins`, async () => {
          const guest = newGuest()
          const { reload, navigate } = await requestThenDrive(
            () => guest,
            () => deliverQueued(guest)
          )
          // An idle guest is reloaded at once; a pre-request load in flight is waited out first.
          const reloadsBefore = reload.mock.calls.length
          expect(reloadsBefore).toBe(queued === IN_FLIGHT ? 0 : 1)
          moveOn(guest)
          expect(pending()).toBe(false)
          expect(reload).toHaveBeenCalledTimes(reloadsBefore)
          expect(navigate).not.toHaveBeenCalled()
        })
      }
    }
  })
})
