// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { BrowserPage } from '../../../../../shared/browser-workspace-types'
import { useRemoteBrowserPageNavigation } from './use-remote-browser-page-navigation'
import type { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn(async () => ({})) }))

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
      isActive: true,
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

  it('files an observed remote navigation into the URL history the address bar suggests from', () => {
    const { result } = renderNavigation()

    act(() =>
      result.current.applyRemoteTabInfo({
        url: 'https://remote.internal/docs',
        title: 'Remote docs'
      })
    )

    expect(useAppStore.getState().browserUrlHistory).toEqual([
      expect.objectContaining({ url: 'https://remote.internal/docs', title: 'Remote docs' })
    ])
  })

  it('files one entry however often the same page is re-read', () => {
    const { result } = renderNavigation()

    // Why: a settled scroll, click or keystroke re-reads tab info, so an unconditional filing
    // would rewrite the store — and re-render every address bar — on plain interaction.
    for (let index = 0; index < 20; index += 1) {
      act(() =>
        result.current.applyRemoteTabInfo({ url: 'https://remote.internal/docs', title: 'Docs' })
      )
    }

    expect(useAppStore.getState().browserUrlHistory).toEqual([
      expect.objectContaining({ url: 'https://remote.internal/docs', visitCount: 1 })
    ])
  })

  it('files again once the page really moves', () => {
    const { result } = renderNavigation()

    act(() => result.current.applyRemoteTabInfo({ url: 'https://remote.internal/a', title: 'A' }))
    act(() => result.current.applyRemoteTabInfo({ url: 'https://remote.internal/b', title: 'B' }))
    act(() => result.current.applyRemoteTabInfo({ url: 'https://remote.internal/a', title: 'A' }))

    expect(
      useAppStore.getState().browserUrlHistory.map((entry) => [entry.url, entry.visitCount])
    ).toEqual([
      ['https://remote.internal/b', 1],
      ['https://remote.internal/a', 2]
    ])
  })

  it('picks up a title that only arrives on a later read of the same page', () => {
    const { result } = renderNavigation()

    act(() => result.current.applyRemoteTabInfo({ url: 'https://remote.internal/docs', title: '' }))
    act(() =>
      result.current.applyRemoteTabInfo({
        url: 'https://remote.internal/docs',
        title: 'Remote docs'
      })
    )

    expect(useAppStore.getState().browserUrlHistory).toEqual([
      expect.objectContaining({ title: 'Remote docs' })
    ])
  })

  it('never files a blank page, which is what a new tab reports before it navigates', () => {
    const { result } = renderNavigation()

    act(() => result.current.applyRemoteTabInfo({ url: 'about:blank', title: '' }))

    expect(useAppStore.getState().browserUrlHistory).toHaveLength(0)
  })

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
