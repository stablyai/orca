import type * as BrowserFocusModule from '@/components/browser-pane/host-guest/browser-focus'
import { requestBrowserFocus } from '@/components/browser-pane/host-guest/browser-focus'
import { afterEach, beforeEach, expect, it, vi, type Mock } from 'vitest'
import { toast } from 'sonner'
import { createStoreCascadesMockApi } from '@/store/slices/store-cascades-test-harness'
import {
  createBrowserLinkTestStore,
  WORKSPACE,
  URL_TO_OPEN
} from './browser-link-open.test-fixture'
import {
  registerHttpLinkStoreAccessor,
  registerWorkspaceHttpLinkBrowserOpener,
  type HttpLinkBrowserCompletion
} from './http-link-routing'
import { openRoutedHttpLink, type WorkspaceHttpLinkBrowserOpener } from './http-link-destinations'
import { openWorkspaceBrowserTabForLink } from './workspace-browser-tab-open'
import { beginLinkOpenRequest } from './link-open-request'
const mocks = vi.hoisted(() => ({ getState: vi.fn() }))
vi.mock('@/store', () => ({ useAppStore: { getState: () => mocks.getState() } }))
vi.mock('@/components/browser-pane/host-guest/browser-focus', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserFocusModule>()),
  requestBrowserFocus: vi.fn()
}))
vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() }
}))
createStoreCascadesMockApi()
let store: ReturnType<typeof createBrowserLinkTestStore>
let cleanups: number
let resume: () => void
let completed: Promise<void>
let finish: () => void
let released: Promise<void>
let opening: Mock<WorkspaceHttpLinkBrowserOpener>
beforeEach(() => {
  store = createBrowserLinkTestStore()
  mocks.getState.mockImplementation(() => store.getState())
  cleanups = 0
  released = new Promise<void>((resolve) => {
    resume = resolve
  })
  completed = new Promise<void>((resolve) => {
    finish = resolve
  })
  registerHttpLinkStoreAccessor(
    () => store.getState(),
    (listener) => {
      const off = store.subscribe(listener)
      return () => {
        off()
        cleanups++
        finish()
      }
    }
  )
  opening = vi.fn<WorkspaceHttpLinkBrowserOpener>(
    async (
      request: Parameters<
        NonNullable<Parameters<typeof registerWorkspaceHttpLinkBrowserOpener>[0]>
      >[0]
    ) => {
      await released
      if (!request.linkContext) {
        throw new Error('Missing real link context')
      }
      const result = await openWorkspaceBrowserTabForLink({
        ...request,
        linkContext: request.linkContext
      })
      return result.status === 'opened' ? result.result.browserPageId : null
    }
  )
  registerWorkspaceHttpLinkBrowserOpener(opening)
  Object.assign(window.api, { shell: { openUrl: vi.fn(async () => {}) } })
})
afterEach(() => {
  registerWorkspaceHttpLinkBrowserOpener(null)
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

it.each([false, true])(
  'reports actual materialization with its background setting (%s) and discharges the captured reveal observer',
  async (background) => {
    store.setState((state) => ({
      settings: { ...state.settings!, openLinksInAppInBackground: background }
    }))
    const results: HttpLinkBrowserCompletion[] = []
    openRoutedHttpLink(URL_TO_OPEN, {
      worktreeId: WORKSPACE,
      sourceTabId: 'source',
      sourceOwner: { kind: 'local' },
      forceDestination: 'orca',
      onBrowserOpenComplete: (result) => results.push(result)
    })
    expect(results).toEqual([])
    expect(cleanups).toBe(0)
    resume()
    await completed
    expect(results).toEqual([{ pageId: expect.any(String), background }])
    const pageId = results[0]!.pageId
    if (background) {
      expect(requestBrowserFocus).not.toHaveBeenCalled()
    } else {
      expect(requestBrowserFocus).toHaveBeenCalledExactlyOnceWith({ pageId, target: 'webview' })
    }
    expect(
      Object.values(store.getState().browserPagesByWorkspace)
        .flat()
        .some((page) => page.id === pageId && page.url === URL_TO_OPEN)
    ).toBe(true)
    expect(cleanups).toBe(1)
  }
)

it.each(['refused', 'superseded'] as const)(
  'does not invent success when the actual browser route is %s',
  async (outcome) => {
    const complete = vi.fn()
    openRoutedHttpLink(URL_TO_OPEN, {
      worktreeId: WORKSPACE,
      sourceTabId: 'source',
      forceDestination: 'orca',
      openInSourceGroup: true,
      onBrowserOpenComplete: complete
    })
    if (outcome === 'superseded') {
      beginLinkOpenRequest()
    } else {
      store.setState({ groupsByWorktree: { [WORKSPACE]: [] }, layoutByWorktree: {} })
    }
    resume()
    await completed
    expect(complete).toHaveBeenCalledExactlyOnceWith({ pageId: null, background: false })
    expect(store.getState().browserPagesByWorkspace).toEqual({})
    expect(cleanups).toBe(1)
  }
)

it('does not notify browser completion for system opening and keeps unknown-owner refusal', async () => {
  const complete = vi.fn()
  openRoutedHttpLink(URL_TO_OPEN, {
    worktreeId: WORKSPACE,
    sourceOwner: { kind: 'unknown' },
    forceDestination: 'system',
    onBrowserOpenComplete: complete
  })
  expect(window.api.shell.openUrl).not.toHaveBeenCalled()
  openRoutedHttpLink(URL_TO_OPEN, {
    worktreeId: WORKSPACE,
    sourceOwner: { kind: 'local' },
    forceDestination: 'system',
    onBrowserOpenComplete: complete
  })
  expect(window.api.shell.openUrl).toHaveBeenCalledExactlyOnceWith(URL_TO_OPEN)
  expect(opening).not.toHaveBeenCalled()
  expect(complete).not.toHaveBeenCalled()
})

it.each([false, true])(
  'preserves the existing failure presentation and captured cleanup with optional completion=%s',
  async (withCompletion) => {
    registerWorkspaceHttpLinkBrowserOpener(async () => {
      await released
      throw new Error('browser unavailable')
    })
    const complete = vi.fn()
    openRoutedHttpLink(URL_TO_OPEN, {
      worktreeId: WORKSPACE,
      sourceTabId: 'source',
      forceDestination: 'orca',
      ...(withCompletion ? { onBrowserOpenComplete: complete } : {})
    })
    resume()
    await completed
    expect(toast.error).toHaveBeenCalledExactlyOnceWith('browser unavailable')
    expect(cleanups).toBe(1)
    expect(complete).not.toHaveBeenCalled()
  }
)
