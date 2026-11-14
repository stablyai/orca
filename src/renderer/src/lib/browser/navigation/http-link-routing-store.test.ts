import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { requestBrowserFocus } from '@/components/browser-pane/host-guest/browser-focus'
import type * as BrowserFocusModule from '@/components/browser-pane/host-guest/browser-focus'
import { useAppStore } from '@/store/index'
import { createStoreCascadesMockApi } from '@/store/testing/app-store-cascade-api.test-fixture'
import '@/store/testing/app-store-test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../../shared/constants'
import { seedBrowserLinkTestStore, WORKSPACE, URL_TO_OPEN } from './browser-link-open.test-fixture'
import '../../links/placement/link-open-intent'
import { openRoutedHttpLink } from './http-link-destinations'
import { openHttpLink } from './http-link-routing'
import '../workspace/workspace-browser-tab-open'

const OTHER_WORKSPACE = 'repo1::/other'

vi.mock('@/components/browser-pane/host-guest/browser-focus', async (importOriginal) => ({
  ...(await importOriginal<typeof BrowserFocusModule>()),
  requestBrowserFocus: vi.fn()
}))

beforeEach(() => {
  createStoreCascadesMockApi()
  seedBrowserLinkTestStore(useAppStore)
  useAppStore.setState({
    activeView: 'activity',
    settings: { ...getDefaultSettings('/home/test'), openLinksInApp: true }
  })
  useAppStore.setState((state) => ({
    worktreesByRepo: {
      repo1: [
        ...state.worktreesByRepo.repo1!,
        makeWorktree({ id: OTHER_WORKSPACE, repoId: 'repo1', path: '/other', hostId: 'local' })
      ]
    },
    tabsByWorktree: {
      [WORKSPACE]: state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) => ({
        id: tab.entityId,
        ptyId: null,
        worktreeId: WORKSPACE,
        title: 'Terminal',
        customTitle: null,
        color: null,
        sortOrder: tab.sortOrder,
        createdAt: tab.createdAt
      }))
    }
  }))
  vi.mocked(requestBrowserFocus).mockClear()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('reports where an opened link went', () => {
  const openUrl = vi.fn(async () => undefined)
  vi.stubGlobal('window', { ...window, api: { ...window.api, shell: { openUrl } } })

  expect(openHttpLink(URL_TO_OPEN, { worktreeId: WORKSPACE })).toBe('orca-browser')
  expect(openHttpLink(URL_TO_OPEN, { worktreeId: WORKSPACE, forceSystemBrowser: true })).toBe(
    'system-browser'
  )
  expect(openUrl).toHaveBeenCalledExactlyOnceWith(URL_TO_OPEN)
  expect(
    openHttpLink(URL_TO_OPEN, { worktreeId: WORKSPACE, sourceOwner: { kind: 'unknown' } })
  ).toBe('none')
})

it('opens a floating link beside the source without selecting the source browser layout', async () => {
  const before = useAppStore.getState().unifiedTabsByWorktree[WORKSPACE]!.map((tab) => tab.id)
  openRoutedHttpLink('https://example.com/floating-link', {
    worktreeId: WORKSPACE,
    sourceTabId: 'source',
    sourceOwner: { kind: 'local' },
    forceDestination: 'orca',
    floatingWorkspace: true
  })
  await vi.waitFor(() =>
    expect(
      useAppStore.getState().browserTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]
    ).toHaveLength(1)
  )
  const state = useAppStore.getState()
  expect(state.unifiedTabsByWorktree[WORKSPACE]!.map((tab) => tab.id)).toEqual(before)
  expect(state.browserTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID]?.[0]?.url).toBe(
    'https://example.com/floating-link'
  )
  expect(state.activeWorktreeId).toBe(WORKSPACE)
})
