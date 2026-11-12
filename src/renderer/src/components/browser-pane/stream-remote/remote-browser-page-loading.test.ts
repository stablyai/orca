// @vitest-environment happy-dom
import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { applyWebSessionTabsSnapshot } from '@/runtime/web-session-tabs-sync/snapshot-api'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { BrowserTabInfo } from '../../../../../shared/browser/runtime/runtime-browser-contracts'
import {
  currentPage,
  deferred,
  failedTab,
  renderNavigation,
  page
} from './remote-browser-page-navigation.test-fixture'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: vi.fn() }))
beforeEach(() => vi.mocked(callRuntimeRpc).mockReset())
afterEach(cleanup)

function applyNativeLoading(loading: boolean): void {
  useAppStore.setState((state) =>
    applyWebSessionTabsSnapshot(
      state,
      {
        worktree: 'worktree-a',
        publicationEpoch: 'loading-test',
        snapshotVersion: 1,
        activeTabType: 'browser',
        activeTabId: 'host-tab',
        activeGroupId: 'host-group',
        tabs: [
          {
            type: 'browser',
            id: 'host-tab',
            browserWorkspaceId: 'workspace-a',
            browserPageId: 'remote-page-a',
            url: 'about:blank',
            title: 'New Tab',
            loading,
            canGoBack: false,
            canGoForward: false,
            isActive: true,
            loadError: null,
            certificateFailure: null
          }
        ]
      },
      'environment-a',
      100
    )
  )
}

describe('remote command loading ownership', () => {
  it.each([
    ['synthetic', true, false],
    ['explicit', true, true],
    ['native', true, true],
    ['native', false, true]
  ] as const)(
    'settles only %s loading after local updates=%s',
    async (owner, edit, expectedLoading) => {
      const { result, busy } = renderNavigation(1, 'mailto:help@example.test')
      act(() => applyNativeLoading(false))
      const read = deferred<{ tab: BrowserTabInfo }>()
      vi.mocked(callRuntimeRpc).mockImplementation(async (_target, method) => {
        if (method === 'browser.reload') {
          return { url: 'about:blank', title: 'New Tab' }
        }
        if (method === 'browser.tabShow') {
          return read.promise
        }
        return undefined
      })
      let command!: Promise<void>
      await act(async () => {
        command = result.current.runRemoteNavigation('browser.reload')
      })
      expect(currentPage().loading).toBe(true)
      const before = useAppStore.getState()
      const changed = vi.fn()
      const unsubscribe = useAppStore.subscribe(changed)
      act(() => {
        if (owner === 'native') {
          applyNativeLoading(true)
        }
        if (owner === 'explicit') {
          useAppStore.getState().updateBrowserPageState('page-a', { loading: true })
        }
      })
      unsubscribe()
      expect(useAppStore.getState().browserPagesByWorkspace).toBe(before.browserPagesByWorkspace)
      expect(useAppStore.getState().browserTabsByWorktree).toBe(before.browserTabsByWorktree)
      expect(changed).not.toHaveBeenCalled()
      if (edit) {
        act(() => {
          result.current.submitAddressBar()
          useAppStore.getState().setBrowserPageViewportPreset('page-a', 'mobile-s')
        })
        expect(currentPage().loadError).toMatchObject({
          code: 0,
          validatedUrl: 'mailto:help@example.test'
        })
      }
      await act(async () => {
        read.resolve({ tab: { ...failedTab('stale'), title: 'Stale result' } })
        await command
      })
      expect(currentPage().loading).toBe(expectedLoading)
      expect(currentPage().title).toBe('New Tab')
      expect(currentPage().url).toBe('about:blank')
      expect(busy).toHaveBeenLastCalledWith(false)
      expect(useAppStore.getState().browserCertificateFailuresByPageId['page-a']).toBeUndefined()
      if (edit) {
        expect(currentPage().loadError).toMatchObject({
          code: 0,
          validatedUrl: 'mailto:help@example.test'
        })
        expect(currentPage().viewportPresetId).toBe('mobile-s')
      }
    }
  )

  it('discharges synthetic loading across external ABA without admitting the old read', async () => {
    const { session, tokens } = renderNavigation()
    const token = tokens.createOperationToken('remote-page-a')!
    act(() => session.setPageLoading(token, true, useAppStore.getState().updateBrowserPageState))
    const read = deferred<{ tab: BrowserTabInfo }>()
    vi.mocked(callRuntimeRpc).mockReturnValueOnce(read.promise)
    const pending = session.refreshTabInfo(token)
    act(() => {
      useAppStore.getState().updateBrowserPageState('page-a', { loadError: failedTab().loadError })
      useAppStore.getState().updateBrowserPageState('page-a', { loadError: null })
      session.setPageLoading(token, false, useAppStore.getState().updateBrowserPageState)
    })
    await act(async () => {
      read.resolve({ tab: failedTab('stale') })
      expect(await pending).toBeNull()
    })
    expect(currentPage().loading).toBe(false)
    expect(currentPage().loadError).toBeNull()
    expect(currentPage().url).toBe('about:blank')
  })

  it('does not claim an explicit equal loading write from a synchronous store subscriber', () => {
    const { session, tokens } = renderNavigation()
    const token = tokens.createOperationToken('remote-page-a')!
    const unsubscribe = useAppStore.subscribe(() => {
      useAppStore.getState().updateBrowserPageState('page-a', { loading: true })
    })
    act(() => session.setPageLoading(token, true, useAppStore.getState().updateBrowserPageState))
    unsubscribe()
    act(() => session.setPageLoading(token, false, useAppStore.getState().updateBrowserPageState))
    expect(currentPage().loading).toBe(true)
  })

  it.each([100, 1000])('native takeover visits no unrelated records at N=%s', async (count) => {
    const { session, tokens } = renderNavigation()
    act(() => applyNativeLoading(false))
    const token = tokens.createOperationToken('remote-page-a')!
    act(() => session.setPageLoading(token, true, useAppStore.getState().updateBrowserPageState))
    const read = deferred<{ tab: BrowserTabInfo }>()
    vi.mocked(callRuntimeRpc).mockReturnValueOnce(read.promise)
    const pending = session.refreshTabInfo(token)
    const unrelated = Object.fromEntries(
      Array.from({ length: count }, (_, index) => {
        const workspaceId = `unrelated-${index}`
        return [workspaceId, [{ ...page(`other-${index}`), workspaceId, worktreeId: 'other' }]]
      })
    )
    let enumerations = 0
    let unrelatedReads = 0
    const pages = new Proxy(
      { ...useAppStore.getState().browserPagesByWorkspace, ...unrelated },
      {
        ownKeys(target) {
          enumerations += 1
          return Reflect.ownKeys(target)
        },
        get(target, key, receiver) {
          if (typeof key === 'string' && key.startsWith('unrelated-')) {
            unrelatedReads += 1
          }
          // SAFETY: preserve ordinary record access while counting unrelated lookups.
          return Reflect.get(target, key, receiver)
        }
      }
    )
    useAppStore.setState({ browserPagesByWorkspace: pages })
    const changed = vi.fn()
    const unsubscribe = useAppStore.subscribe(changed)
    act(() => applyNativeLoading(true))
    unsubscribe()
    expect(enumerations).toBe(0)
    expect(unrelatedReads).toBe(0)
    expect(useAppStore.getState().browserPagesByWorkspace).toBe(pages)
    expect(changed).not.toHaveBeenCalled()
    await act(async () => {
      read.resolve({ tab: failedTab('stale') })
      expect(await pending).toBeNull()
      session.setPageLoading(token, false, useAppStore.getState().updateBrowserPageState)
    })
    expect(currentPage().loading).toBe(true)
    expect(currentPage().loadError).toBeNull()
  })
})
