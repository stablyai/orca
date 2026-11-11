// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { BrowserPage } from '../../../../../shared/browser-workspace-types'
import { useRemoteBrowserPageNavigation } from './use-remote-browser-page-navigation'
import type { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: vi.fn(async () => ({}))
}))

function page(): BrowserPage {
  return {
    id: 'page-a',
    workspaceId: 'workspace-a',
    worktreeId: 'worktree-a',
    url: 'about:blank',
    title: 'New Tab',
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

function renderNavigation(): ReturnType<
  typeof renderHook<ReturnType<typeof useRemoteBrowserPageNavigation>, void>
> {
  return renderHook(() =>
    useRemoteBrowserPageNavigation({
      browserTab: page(),
      stagedPage: false,
      addressBarValue: 'about:blank',
      setAddressBarValueFromPage: vi.fn(),
      lifecycle: {
        session: { ensureRemotePage: vi.fn(), scheduleTabInfoRefresh: vi.fn() }
      } as unknown as RemoteBrowserStreamLifecycle,
      runtimeWorktree: 'worktree-a',
      runtimeTarget: () => null,
      createRemoteOperationToken: () => null,
      isCurrentRemoteOperationToken: () => false,
      closeMissingRemotePage: vi.fn(),
      onSetUrl: vi.fn(),
      onUpdatePageState: vi.fn(),
      setPaneNotice: vi.fn(),
      setPaneBusy: vi.fn()
    })
  )
}

describe('useRemoteBrowserPageNavigation history recording', () => {
  beforeEach(() => {
    useAppStore.setState({ browserUrlHistory: [] })
  })

  afterEach(() => cleanup())

  it('redacts a Kagi session token before it reaches history', () => {
    const { result } = renderNavigation()

    act(() =>
      result.current.applyRemoteTabInfo({
        url: 'https://kagi.com/search?q=orca&token=secret-session',
        title: 'Kagi'
      })
    )

    const [entry] = useAppStore.getState().browserUrlHistory
    expect(entry.url).not.toContain('secret-session')
  })
})
