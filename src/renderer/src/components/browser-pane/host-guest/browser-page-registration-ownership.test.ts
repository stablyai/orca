// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserLoadError } from '../../../../../shared/browser-workspace-types'
import {
  createBrowserPageWebviewGuestSession,
  type BrowserPageWebviewGuestSession
} from './browser-page-webview-guest-session'
import {
  destroyPersistentWebview,
  registerPersistentWebview,
  registeredWebContentsIds,
  webviewRegistry
} from './webview-registry'

vi.mock('../describe-page/browser-page-load-error', () => ({ browserPageExists: () => true }))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { resolve, reject, promise }
}
const replies: ReturnType<typeof deferred<boolean>>[] = []
const registrations = vi.fn(() => {
  const reply = deferred<boolean>()
  replies.push(reply)
  return reply.promise
})
const isRegistered = vi.fn(async () => true)
const repair = vi.fn(async () => true)
const unregister = vi.fn(async () => true)
type RegistrationTestPage = {
  id: string
  webview: Electron.WebviewTag
  webviewRef: { current: Electron.WebviewTag | null }
  session: BrowserPageWebviewGuestSession
  sync: ReturnType<typeof vi.fn>
  update: ReturnType<typeof vi.fn>
  pending: { current: boolean }
  paintable: { current: boolean }
  loadFailure: { current: BrowserLoadError | null }
  setId: (next: number) => void
}
const sessions: RegistrationTestPage[] = []

function createWebview(): Electron.WebviewTag {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The fixture installs the Electron webview methods exercised by guest registration and teardown on this DOM element.
  return document.createElement('webview') as Electron.WebviewTag
}

function createSession(
  id: string,
  guestId: number,
  previous?: RegistrationTestPage
): RegistrationTestPage {
  const webview = previous?.webview ?? createWebview()
  let liveGuestId = guestId
  webview.getWebContentsId = () => liveGuestId
  webview.getZoomLevel = () => 0
  webview.setZoomLevel = vi.fn()
  if (!previous) {
    document.body.appendChild(webview)
    registerPersistentWebview(id, webview)
  }
  const ref = <T>(current: T) => ({ current })
  const webviewRef = previous?.webviewRef ?? ref<Electron.WebviewTag | null>(webview)
  webviewRef.current = webview
  const sync = vi.fn()
  const update = vi.fn()
  const pending = ref(false)
  const paintable = ref(true)
  const loadFailure = ref<BrowserLoadError | null>(null)
  const session = createBrowserPageWebviewGuestSession({
    webview,
    browserTabId: id,
    workspaceId: 'browser-1',
    worktreeId: 'wt-1',
    sessionProfileId: null,
    webviewRef,
    isPaintableRef: paintable,
    guestRecoveryPendingRef: pending,
    browserTabUrlRef: ref('https://example.test'),
    addressBarValueRef: ref('https://example.test'),
    activeLoadFailureRef: loadFailure,
    recoveryNavigationValidationRef: ref(null),
    keepAddressBarFocusRef: ref(false),
    paneZoomLevelRef: ref(0),
    viewportPresetIdRef: ref(null),
    onUpdatePageStateRef: ref(update),
    setGuestRecoveryGeneration: vi.fn(),
    setBrowserZoomPercent: vi.fn(),
    focusAddressBarNow: () => false,
    syncNavigationState: vi.fn(),
    syncBrowserAnnotationViewportBridge: sync
  })
  const result = {
    id,
    webview,
    webviewRef,
    session,
    sync,
    update,
    pending,
    paintable,
    loadFailure,
    setId: (next: number) => {
      liveGuestId = next
    }
  }
  sessions.push(result)
  return result
}

async function flush() {
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0))
}

beforeEach(() => {
  registrations.mockClear()
  isRegistered.mockReset().mockResolvedValue(true)
  repair.mockReset().mockResolvedValue(true)
  unregister.mockClear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      browser: {
        registerGuest: registrations,
        unregisterGuest: unregister,
        isGuestRegistered: isRegistered,
        repairGuestRegistration: repair,
        setViewportOverride: vi.fn(async () => true)
      }
    }
  })
})

afterEach(async () => {
  for (const reply of replies.splice(0)) {
    reply.resolve(false)
  }
  for (const page of sessions.splice(0)) {
    page.session.guestRecovery.dispose()
    page.webviewRef.current = null
    await destroyPersistentWebview(page.id)
    page.webview.remove()
  }
  registeredWebContentsIds.clear()
})

describe('renderer registration completion ownership', () => {
  it('does not restore 1000 closed IDs from delayed successful replies', async () => {
    for (let i = 0; i < 1000; i++) {
      const page = createSession(`closed-${i}`, i + 1)
      page.session.handleDidAttach()
      page.session.guestRecovery.dispose()
      page.webviewRef.current = null
      await destroyPersistentWebview(page.id)
    }
    for (const reply of replies) {
      reply.resolve(true)
    }
    await flush()
    expect(webviewRegistry.size).toBe(0)
    expect(registeredWebContentsIds.size).toBe(0)
    expect(sessions.reduce((count, page) => count + page.sync.mock.calls.length, 0)).toBe(0)
    expect(unregister).toHaveBeenCalledTimes(1000)
  })

  it('keeps the replacement ID after an older reply arrives', async () => {
    const old = createSession('page', 1)
    old.session.handleDidAttach()
    old.session.guestRecovery.dispose()
    await destroyPersistentWebview('page')
    const replacement = createSession('page', 2)
    replacement.session.handleDidAttach()
    replies[1].resolve(true)
    await flush()
    replies[0].resolve(true)
    await flush()
    expect(registeredWebContentsIds.get('page')).toBe(2)
    expect(old.sync).not.toHaveBeenCalled()
    expect(replacement.sync).toHaveBeenCalledOnce()
    expect(unregister).toHaveBeenCalledOnce()
  })

  it('keeps a new ID when the same DOM webview swaps its guest', async () => {
    const page = createSession('page', 1)
    page.session.handleDidAttach()
    page.setId(2)
    page.session.handleDidAttach()
    replies[1].resolve(true)
    await flush()
    replies[0].resolve(true)
    await flush()
    expect(registeredWebContentsIds.get('page')).toBe(2)
    expect(page.sync).toHaveBeenCalledOnce()
    expect(unregister).not.toHaveBeenCalled()
  })

  it('a new session retries a disposed session registration on the same persistent guest and ref', async () => {
    const old = createSession('page', 1)
    old.session.handleDidAttach()
    old.session.guestRecovery.dispose()
    old.webviewRef.current = null
    replies[0].resolve(true)
    await flush()
    expect(registeredWebContentsIds.has('page')).toBe(false)
    expect(webviewRegistry.get('page')).toBe(old.webview)
    const replacement = createSession('page', 1, old)
    replacement.session.guestRecovery.validateAfterResume()
    expect(registrations).toHaveBeenCalledTimes(2)
    replies[1].resolve(true)
    await flush()
    expect(registeredWebContentsIds.get('page')).toBe(1)
    expect(old.sync).not.toHaveBeenCalled()
    expect(unregister).not.toHaveBeenCalled()
  })

  it('a disposed listener cannot act after the same guest and ref are reused', async () => {
    const old = createSession('page', 1)
    old.session.handleDomReady()
    old.session.guestRecovery.dispose()
    const replacement = createSession('page', 1, old)
    replacement.pending.current = true
    replies[0].resolve(true)
    await flush()
    expect(registeredWebContentsIds.has('page')).toBe(false)
    expect(old.sync).not.toHaveBeenCalled()
    expect(replacement.pending.current).toBe(true)
  })

  it.each(['attach', 'ready'] as const)('keeps successful current %s replies', async (event) => {
    const page = createSession('page', 1)
    if (event === 'attach') {
      page.session.handleDidAttach()
    } else {
      page.session.handleDomReady()
    }
    replies[0].resolve(true)
    await flush()
    expect(registeredWebContentsIds.get('page')).toBe(1)
    expect(page.sync).toHaveBeenCalledOnce()
    expect(unregister).not.toHaveBeenCalled()
  })

  it.each(['false', 'reject'] as const)(
    'preserves inconclusive current registration %s',
    async (result) => {
      const page = createSession('page', 1)
      page.session.handleDidAttach()
      if (result === 'false') {
        replies[0].resolve(false)
      } else {
        replies[0].reject(new Error('attach race'))
      }
      await flush()
      expect(registeredWebContentsIds.has('page')).toBe(false)
      expect(page.sync).toHaveBeenCalledOnce()
      expect(unregister).not.toHaveBeenCalled()
    }
  )

  it('does not restore a registry-removed guest before listener disposal runs', async () => {
    const page = createSession('page', 1)
    page.session.handleDidAttach()
    await destroyPersistentWebview('page')
    replies[0].resolve(true)
    await flush()
    expect(registeredWebContentsIds.has('page')).toBe(false)
    expect(page.sync).not.toHaveBeenCalled()
  })

  it('does not restore metadata when the current listener ref has moved', async () => {
    const page = createSession('page', 1)
    page.session.handleDidAttach()
    page.webviewRef.current = null
    replies[0].resolve(true)
    await flush()
    expect(registeredWebContentsIds.has('page')).toBe(false)
    expect(page.sync).not.toHaveBeenCalled()
    expect(webviewRegistry.get('page')).toBe(page.webview)
    expect(unregister).not.toHaveBeenCalled()
  })

  it('accepts a current registration while its persistent guest is hidden', async () => {
    const page = createSession('page', 1)
    page.paintable.current = false
    page.session.handleDidAttach()
    replies[0].resolve(true)
    await flush()
    expect(registeredWebContentsIds.get('page')).toBe(1)
    expect(page.sync).toHaveBeenCalledOnce()
    expect(unregister).not.toHaveBeenCalled()
  })

  it('ignores a reply after reading the guest identity starts throwing', async () => {
    const page = createSession('page', 1)
    page.session.handleDidAttach()
    page.webview.getWebContentsId = () => {
      throw new Error('guest detached')
    }
    replies[0].resolve(true)
    await flush()
    expect(registeredWebContentsIds.has('page')).toBe(false)
    expect(page.sync).not.toHaveBeenCalled()
  })

  it('does not issue repair after a pending validation outlives its owner', async () => {
    const reply = deferred<boolean>()
    isRegistered.mockReturnValue(reply.promise)
    const page = createSession('page', 1)
    registeredWebContentsIds.set('page', 1)
    page.session.guestRecovery.validateAfterResume()
    page.session.guestRecovery.dispose()
    await destroyPersistentWebview('page')
    reply.resolve(false)
    await flush()
    expect(repair).not.toHaveBeenCalled()
    expect(unregister).toHaveBeenCalledOnce()
  })

  it('still repairs an inconclusive current registration', async () => {
    isRegistered.mockResolvedValue(false)
    const page = createSession('page', 1)
    registeredWebContentsIds.set('page', 1)
    page.session.guestRecovery.validateAfterResume()
    await flush()
    expect(repair).toHaveBeenCalledExactlyOnceWith({
      browserPageId: 'page',
      workspaceId: 'browser-1',
      worktreeId: 'wt-1',
      sessionProfileId: null,
      webContentsId: 1
    })
  })

  it('does not clear a newer guest recovery error from a pending old repair reply', async () => {
    const reply = deferred<boolean>()
    repair.mockReturnValue(reply.promise)
    isRegistered.mockResolvedValue(false)
    const page = createSession('page', 1)
    registeredWebContentsIds.set('page', 1)
    page.session.guestRecovery.validateAfterResume()
    await flush()
    expect(repair).toHaveBeenCalledOnce()
    page.setId(2)
    const failure = {
      code: -10_000,
      description: 'Replacement guest recovery failed',
      validatedUrl: 'https://example.test'
    }
    page.loadFailure.current = failure
    reply.resolve(true)
    await flush()
    expect(page.loadFailure.current).toBe(failure)
    expect(page.update).not.toHaveBeenCalled()
  })
})
