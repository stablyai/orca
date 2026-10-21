// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPage } from '../../../../../shared/browser-workspace-types'
import { createHarness } from './remote-browser-stream-lifecycle-test-harness'
import { useRemoteBrowserPageNavigation } from './use-remote-browser-page-navigation'

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn(async () => ({})) }))

function page(): BrowserPage {
  return {
    id: 'page-a',
    workspaceId: 'workspace-a',
    worktreeId: 'worktree-a',
    url: 'https://remote.internal/a',
    title: 'A',
    loading: false,
    faviconUrl: null,
    canGoBack: true,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

describe('useRemoteBrowserPageNavigation failures', () => {
  afterEach(() => cleanup())

  it('reports a dropped runtime while resolving the page instead of rejecting', async () => {
    const { lifecycle } = createHarness()
    vi.spyOn(lifecycle.session, 'ensureRemotePage').mockRejectedValue(
      new Error('Runtime connection lost')
    )
    const setPaneNotice = vi.fn()
    const setPaneBusy = vi.fn()
    const { result } = renderHook(() =>
      useRemoteBrowserPageNavigation({
        browserTab: page(),
        stagedPage: false,
        addressBarValue: 'https://remote.internal/a',
        setAddressBarValueFromPage: vi.fn(),
        lifecycle,
        runtimeWorktree: 'worktree-a',
        runtimeTarget: () => ({ kind: 'environment', environmentId: 'env-1' }),
        createRemoteOperationToken: (remotePageId) =>
          lifecycle.tokens.createOperationToken(remotePageId),
        isCurrentRemoteOperationToken: () => true,
        closeMissingRemotePage: vi.fn(),
        onSetUrl: vi.fn(),
        onUpdatePageState: vi.fn(),
        setPaneNotice,
        setPaneBusy
      })
    )

    await act(async () => {
      await expect(result.current.runRemoteNavigation('browser.back')).resolves.toBeUndefined()
    })

    expect(setPaneNotice).toHaveBeenCalledWith({
      kind: 'consequence',
      text: 'Runtime connection lost'
    })
    expect(setPaneBusy).not.toHaveBeenCalled()
  })
})
