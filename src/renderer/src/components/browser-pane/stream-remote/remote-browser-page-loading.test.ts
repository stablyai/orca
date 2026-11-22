// @vitest-environment happy-dom
import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { applyWebSessionTabsSnapshot } from '@/runtime/web-session-tabs-sync/snapshots/snapshot-api'
import { recordBrowserInitializationReceipt } from '@/runtime/web-session-tabs-sync/tab-projection/browser-initialization-presentation'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { BrowserTabInfo } from '../../../../../shared/browser/runtime/runtime-browser-contracts'
import {
  currentPage,
  deferred,
  failedTab,
  renderNavigation
} from './remote-browser-page-navigation.test-fixture'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: vi.fn() }))
vi.mock('@/runtime/browser/client-hosting/browser-client-host-identity', () => ({
  readBrowserClientHostId: () => 'loading-client'
}))
beforeEach(() => vi.mocked(callRuntimeRpc).mockReset())
afterEach(cleanup)

function applyNativeLoading(loading: boolean, pendingOnClient = false): void {
  const snapshot: RuntimeMobileSessionTabsResult = {
    worktree: 'worktree-a',
    publicationEpoch: 'loading-test',
    snapshotVersion: pendingOnClient ? 2 : 1,
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
        certificateFailure: null,
        ...(pendingOnClient
          ? {
              initializationState: 'pending',
              placement: {
                kind: 'client',
                browserHostClientId: 'loading-client',
                browserHostGeneration: 1,
                pageHostGeneration: 0
              }
            }
          : {})
      }
    ]
  }
  if (pendingOnClient) {
    recordBrowserInitializationReceipt('environment-a', snapshot, 2)
  }
  useAppStore.setState((state) =>
    applyWebSessionTabsSnapshot(state, snapshot, 'environment-a', 100)
  )
}

describe('remote command loading ownership', () => {
  it('keeps initialization loading when an older remote command retires', async () => {
    const { session, tokens } = renderNavigation()
    act(() => applyNativeLoading(false))
    const token = tokens.createOperationToken('remote-page-a')!
    act(() => session.setPageLoading(token, true, useAppStore.getState().updateBrowserPageState))
    const read = deferred<{ tab: BrowserTabInfo }>()
    vi.mocked(callRuntimeRpc).mockReturnValueOnce(read.promise)
    const pending = session.refreshTabInfo(token)
    act(() => applyNativeLoading(true, true))
    await act(async () => {
      read.resolve({ tab: failedTab('stale') })
      expect(await pending).toBeNull()
      session.setPageLoading(token, false, useAppStore.getState().updateBrowserPageState)
    })
    expect(currentPage().loading).toBe(true)
    expect(currentPage().loadError).toBeNull()
    expect(useAppStore.getState().browserCertificateFailuresByPageId['page-a']).toBeUndefined()
  })

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
})
