import { renderHook } from '@testing-library/react'
import { expect, vi } from 'vitest'
import { useAppStore } from '@/store'
import { findPage } from '@/store/slices/browser/pages/browser-page-records'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { BrowserPage } from '../../../../../shared/browser-workspace-types'
import type { BrowserTabInfo } from '../../../../../shared/browser/runtime/runtime-browser-contracts'
import { useRemoteBrowserPageNavigation } from './use-remote-browser-page-navigation'
import {
  readRemoteBrowserPage,
  readRemoteBrowserPageObservation
} from './remote-browser-page-observation'
import { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'
import type { RemoteBrowserScreencastSubscribe } from './remote-browser-screencast-subscription'

export function page(id = 'page-a'): BrowserPage {
  return {
    id,
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

export function failedTab(challengeId = 'challenge-x'): BrowserTabInfo {
  return {
    browserPageId: 'remote-page-a',
    index: 0,
    active: true,
    url: 'https://selfsigned.test/',
    title: 'TLS',
    loadError: {
      code: -202,
      description: 'ERR_CERT_AUTHORITY_INVALID',
      validatedUrl: 'https://selfsigned.test/'
    },
    certificateFailure: {
      challengeId,
      browserPageId: 'remote-page-a',
      errorCode: -202,
      error: 'ERR_CERT_AUTHORITY_INVALID',
      origin: 'https://selfsigned.test',
      displayHost: 'selfsigned.test',
      canProceed: true,
      observedAt: 1
    }
  }
}

export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

export function renderNavigation(count = 1, addressBarValue = 'about:blank') {
  const pages = Array.from({ length: count }, (_, index) =>
    page(index ? `page-${index}` : 'page-a')
  )
  const first = pages[0]
  useAppStore.setState({
    browserPagesByWorkspace: { 'workspace-a': pages },
    browserTabsByWorktree: {
      'worktree-a': [
        {
          ...first,
          id: 'workspace-a',
          activePageId: 'page-a',
          pageIds: pages.map((entry) => entry.id)
        }
      ]
    },
    unifiedTabsByWorktree: {},
    browserCertificateFailuresByPageId: {},
    browserUrlHistory: [],
    remoteBrowserPageHandlesByPageId: {
      'page-a': { environmentId: 'environment-a', remotePageId: 'remote-page-a' }
    }
  })
  const identity = { mounted: true, active: true, environmentId: 'environment-a' }
  const paneIdentity = {
    isMounted: () => identity.mounted,
    isActive: () => identity.active,
    getTabId: () => 'page-a',
    getEnvironmentId: () => identity.environmentId,
    browserPageExists: (pageId) =>
      Boolean(readRemoteBrowserPage(useAppStore.getState(), 'workspace-a', pageId))
  }
  let project: (tab: BrowserTabInfo) => void = () => {}
  const subscribe = vi.fn<RemoteBrowserScreencastSubscribe>(async () => ({ unsubscribe: vi.fn() }))
  const lifecycle = new RemoteBrowserStreamLifecycle({
    identity: paneIdentity,
    subscribeScreencast: subscribe,
    waitForViewportSize: async () => ({ width: 800, height: 600 }),
    readViewportSize: () => ({ width: 800, height: 600 }),
    syncViewport: async () => {},
    getDeviceScaleFactor: () => 1,
    setStatus: vi.fn(),
    clearFrame: vi.fn(),
    handleFrameBytes: vi.fn(),
    callRpc: callRuntimeRpc,
    getWorktreeSelector: () => 'worktree-a',
    getCurrentUrl: () => currentPage().url,
    readCurrentObservation: () =>
      readRemoteBrowserPageObservation(useAppStore.getState(), 'workspace-a', 'page-a'),
    readStoredHandle: () => ({ environmentId: 'environment-a', remotePageId: 'remote-page-a' }),
    writeStoredHandle: vi.fn(),
    removeStoredHandle: vi.fn(),
    applyTabInfo: (tab) => project(tab),
    closeMissingRemotePage: vi.fn()
  })
  const { session, tokens } = lifecycle
  tokens.setRemotePage('remote-page-a')
  const closeMissing = vi.fn()
  const busy = vi.fn()
  const notice = vi.fn()
  const hook = renderHook(() =>
    useRemoteBrowserPageNavigation({
      browserTab: first,
      stagedPage: false,
      addressBarValue,
      setAddressBarValueFromPage: vi.fn(),
      lifecycle,
      runtimeWorktree: 'worktree-a',
      runtimeTarget: () => ({ kind: 'environment', environmentId: identity.environmentId }),
      createRemoteOperationToken: () => tokens.createOperationToken(),
      isCurrentRemoteOperationToken: (token) => tokens.isCurrent(token),
      closeMissingRemotePage: closeMissing,
      onSetUrl: useAppStore.getState().setBrowserPageUrl,
      onUpdatePageState: useAppStore.getState().updateBrowserPageState,
      setPaneNotice: notice,
      setPaneBusy: busy
    })
  )
  project = (tab) => hook.result.current.applyRemoteTabInfo(tab)
  return { ...hook, lifecycle, subscribe, session, tokens, identity, busy, notice, closeMissing }
}

export function currentPage(): BrowserPage {
  return findPage(useAppStore.getState().browserPagesByWorkspace, 'page-a')!
}

export function expectPending(challengeId = 'challenge-x') {
  expect(currentPage().url).toBe('https://selfsigned.test/')
  expect(currentPage().loadError).toEqual({
    code: -202,
    description: 'ERR_CERT_AUTHORITY_INVALID',
    validatedUrl: 'https://selfsigned.test/'
  })
  expect(useAppStore.getState().browserCertificateFailuresByPageId['page-a']).toMatchObject({
    challengeId,
    browserPageId: 'remote-page-a',
    canProceed: true
  })
}
