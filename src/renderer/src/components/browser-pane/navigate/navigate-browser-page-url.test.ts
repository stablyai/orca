import { describe, expect, it, vi } from 'vitest'
import type { MutableRefObject } from 'react'
import { BROWSER_GUEST_RECOVERY_ERROR_CODE } from '../host-guest/browser-page-guest-recovery'
import type { BrowserPageSurface } from '../host-guest/browser-page-surface'
import { navigateBrowserPageToUrl } from './navigate-browser-page-url'

vi.mock('@/store', () => ({ useAppStore: { getState: vi.fn() } }))
vi.mock('@/lib/connection-context', () => ({ getConnectionId: () => null }))
vi.mock('@/runtime/runtime-file-client', () => ({
  isRemoteRuntimeFileOperation: () => false,
  statRuntimePath: vi.fn()
}))

const ref = <T>(current: T): MutableRefObject<T> => ({ current })

function surface(overrides: Partial<BrowserPageSurface> = {}): BrowserPageSurface {
  const value = {
    isAttached: () => true,
    navigate: vi.fn(),
    ...overrides
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: navigation only accesses isAttached and navigate from this controlled surface fixture.
  return value as BrowserPageSurface
}

function createHarness(
  overrides: Partial<{
    activeLoadError: { code: number; description: string; validatedUrl: string } | null
    lastKnown: string | null
    surface: BrowserPageSurface
  }> = {}
) {
  const onSetUrl = vi.fn()
  const onUpdate = vi.fn()
  const setAddressBarValue = vi.fn()
  const setResourceNotice = vi.fn()
  const focusWebviewNow = vi.fn(() => true)
  const retry = vi.fn()
  const result = {
    activeLoadFailureRef: ref(overrides.activeLoadError ?? null),
    lastKnownWebviewUrlRef: ref<string | null>(overrides.lastKnown ?? null),
    trackNextLoadingEventRef: ref(false),
    recoveryNavigationValidationRef: ref(null),
    webviewRef: ref<Electron.WebviewTag | null>(null),
    surface: overrides.surface ?? surface(),
    retryGuestRecoveryRef: ref(retry),
    onSetUrlRef: ref(onSetUrl),
    onUpdatePageStateRef: ref(onUpdate),
    setAddressBarValue,
    setResourceNotice,
    focusWebviewNow
  }
  return {
    ...result,
    onSetUrl,
    onUpdate,
    setAddressBarValue,
    setResourceNotice,
    focusWebviewNow,
    retry
  }
}

function navigate(h: ReturnType<typeof createHarness>, url: string): void {
  navigateBrowserPageToUrl({
    url,
    browserTabId: 'tab',
    worktreeId: 'worktree',
    ...h
  })
}

function deferred<T>() {
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((_resolve, fail) => {
    reject = fail
  })
  return { promise, reject }
}

describe('navigateBrowserPageToUrl', () => {
  it('retains a submitted URL in chrome state while an initial owned surface is unattached', () => {
    const navigateSurface = surface({ isAttached: () => false })
    const h = createHarness({ surface: navigateSurface })

    navigate(h, 'https://pending.test/path')

    expect(h.onSetUrl).toHaveBeenCalledWith('tab', 'https://pending.test/path')
    expect(h.onUpdate).toHaveBeenCalledWith('tab', expect.objectContaining({ loading: true }))
    expect(h.lastKnownWebviewUrlRef.current).toBeNull()
    expect(h.trackNextLoadingEventRef.current).toBe(false)
    expect(navigateSurface.navigate).not.toHaveBeenCalled()
    expect(h.focusWebviewNow).not.toHaveBeenCalled()
  })

  it('navigates an attached surface synchronously and preserves the recovery target', () => {
    const navigateSurface = surface()
    const target = 'https://recover.test/path'
    const h = createHarness({
      surface: navigateSurface,
      activeLoadError: {
        code: BROWSER_GUEST_RECOVERY_ERROR_CODE,
        description: 'guest stopped',
        validatedUrl: target
      }
    })

    navigate(h, target)

    expect(navigateSurface.navigate).toHaveBeenCalledWith(target)
    expect(h.lastKnownWebviewUrlRef.current).toBe(target)
    expect(h.recoveryNavigationValidationRef.current).toEqual({
      committed: false,
      started: false,
      targetUrl: target
    })
    expect(h.focusWebviewNow).toHaveBeenCalledOnce()
  })

  it('recovers a synchronous navigation failure and clears only its own pending URL', () => {
    const navigateSurface = surface({
      navigate: () => {
        throw new Error('surface retired')
      }
    })
    const h = createHarness({ surface: navigateSurface })

    navigate(h, 'https://throw.test/')

    expect(h.lastKnownWebviewUrlRef.current).toBeNull()
    expect(h.retry).toHaveBeenCalledOnce()
    expect(h.setResourceNotice).toHaveBeenCalledWith('surface retired')
  })

  it('retains a newer pending URL when an earlier asynchronous navigation rejects', async () => {
    const first = deferred<void>()
    const navigateSurface = surface({ navigate: vi.fn(() => first.promise) })
    const h = createHarness({ surface: navigateSurface })

    navigate(h, 'https://first.test/')
    h.lastKnownWebviewUrlRef.current = 'https://newer.test/'
    first.reject(new Error('first failed'))
    await Promise.resolve()
    await Promise.resolve()

    expect(h.lastKnownWebviewUrlRef.current).toBe('https://newer.test/')
    expect(h.retry).toHaveBeenCalledOnce()
    expect(h.setResourceNotice).toHaveBeenCalledWith('first failed')
  })
})
