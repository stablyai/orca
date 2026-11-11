// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { applyWebSessionTabsSnapshot } from '@/runtime/web-session-tabs-sync/snapshot-api'
import { findPage } from '@/store/slices/browser/pages/browser-page-records'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { BrowserPage } from '../../../../../shared/browser-workspace-types'
import type { BrowserTabInfo } from '../../../../../shared/browser/runtime/runtime-browser-contracts'
import { useRemoteBrowserPageNavigation } from './use-remote-browser-page-navigation'
import { createRemoteBrowserPageObservation } from './remote-browser-page-observation'
import { RemoteBrowserPageSession } from './remote-browser-page-session'
import { RemoteBrowserOperationTokens } from './remote-browser-stream-tokens'
import type { RemoteBrowserStreamLifecycle } from './remote-browser-stream-lifecycle'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: vi.fn() }))

function page(id = 'page-a'): BrowserPage {
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

function failedTab(challengeId = 'challenge-x'): BrowserTabInfo {
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

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

function renderNavigation(count = 1) {
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
  const observation = createRemoteBrowserPageObservation({
    readState: useAppStore.getState,
    getWorkspaceId: () => 'workspace-a',
    getPageId: () => 'page-a'
  })
  const tokens = new RemoteBrowserOperationTokens({
    isMounted: () => identity.mounted,
    isActive: () => identity.active,
    getTabId: () => 'page-a',
    getEnvironmentId: () => identity.environmentId,
    browserPageExists: observation.browserPageExists
  })
  tokens.setRemotePage('remote-page-a')
  let project: (tab: BrowserTabInfo) => void = () => {}
  const session = new RemoteBrowserPageSession({
    tokens,
    callRpc: callRuntimeRpc,
    getWorktreeSelector: () => 'worktree-a',
    getCurrentUrl: () => currentPage().url,
    readCurrentObservation: observation.readCurrentObservation,
    readStoredHandle: () => ({ environmentId: 'environment-a', remotePageId: 'remote-page-a' }),
    writeStoredHandle: vi.fn(),
    removeStoredHandle: vi.fn(),
    applyTabInfo: (tab) => project(tab),
    closeMissingRemotePage: vi.fn()
  })
  const busy = vi.fn()
  const notice = vi.fn()
  const hook = renderHook(() =>
    useRemoteBrowserPageNavigation({
      browserTab: first,
      stagedPage: false,
      addressBarValue: 'about:blank',
      setAddressBarValueFromPage: vi.fn(),
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this hook reads only the real session; stream transport is outside this fixture.
      lifecycle: { session } as unknown as RemoteBrowserStreamLifecycle,
      runtimeWorktree: 'worktree-a',
      runtimeTarget: () => ({ kind: 'environment', environmentId: identity.environmentId }),
      createRemoteOperationToken: () => tokens.createOperationToken(),
      isCurrentRemoteOperationToken: (token) => tokens.isCurrent(token),
      closeMissingRemotePage: vi.fn(),
      onSetUrl: useAppStore.getState().setBrowserPageUrl,
      onUpdatePageState: useAppStore.getState().updateBrowserPageState,
      setPaneNotice: notice,
      setPaneBusy: busy
    })
  )
  project = (tab) => hook.result.current.applyRemoteTabInfo(tab)
  return { ...hook, session, tokens, identity, busy, notice }
}

function currentPage(): BrowserPage {
  return findPage(useAppStore.getState().browserPagesByWorkspace, 'page-a')!
}

function expectPending(challengeId = 'challenge-x') {
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

beforeEach(() => vi.mocked(callRuntimeRpc).mockReset())
afterEach(cleanup)

describe('remote browser authoritative page state', () => {
  it('projects a pending host challenge through local actions and clears an old full snapshot without fields', () => {
    const { result } = renderNavigation()
    act(() => result.current.applyRemoteTabInfo(failedTab()))
    expectPending()
    act(() =>
      result.current.applyRemoteTabInfo({
        browserPageId: 'remote-page-a',
        index: 0,
        active: true,
        url: 'https://example.test/',
        title: 'Example'
      })
    )
    expect(currentPage().loadError).toBeNull()
    expect(useAppStore.getState().browserCertificateFailuresByPageId['page-a']).toBeUndefined()
  })

  it('redacts a Kagi session token before it reaches history', () => {
    const { result } = renderNavigation()
    act(() =>
      result.current.applyRemoteTabInfo({
        browserPageId: 'remote-page-a',
        index: 0,
        active: true,
        url: 'https://kagi.com/search?q=orca&token=secret-session',
        title: 'Kagi'
      })
    )
    expect(useAppStore.getState().browserUrlHistory[0].url).not.toContain('secret-session')
  })

  it.each(['browser.goto', 'browser.back', 'browser.forward', 'browser.reload'] as const)(
    'reads authoritative state after %s rejects or resolves, without a pre-command read',
    async (method) => {
      const { result, busy, notice } = renderNavigation()
      const calls: string[] = []
      vi.mocked(callRuntimeRpc).mockImplementation(async (_target, called) => {
        if (typeof called !== 'string' || !called.startsWith('browser.')) {
          return undefined
        }
        calls.push(called)
        if (called === 'browser.tabShow') {
          return { tab: failedTab('challenge-y') }
        }
        if (called === 'browser.goto') {
          throw new Error('ERR_CERT_AUTHORITY_INVALID (-202)')
        }
        return { url: 'chrome-error://chromewebdata/', title: 'Error' }
      })
      await act(() => result.current.runRemoteNavigation(method, 'https://selfsigned.test/'))
      expect(calls).toEqual([method, 'browser.tabShow'])
      expectPending('challenge-y')
      expect(currentPage().loading).toBe(false)
      expect(busy).toHaveBeenLastCalledWith(false)
      expect(notice).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'consequence' }))
      expect(
        useAppStore
          .getState()
          .browserUrlHistory.some((entry) => entry.url.startsWith('chrome-error:'))
      ).toBe(false)
    }
  )

  it('keeps a pending failure when a resolved reload outcome read times out', async () => {
    const { result } = renderNavigation()
    act(() => result.current.applyRemoteTabInfo(failedTab()))
    vi.mocked(callRuntimeRpc).mockImplementation(async (_target, method) => {
      if (method === 'browser.tabShow') {
        throw new Error('request timed out')
      }
      return { url: 'chrome-error://chromewebdata/', title: 'Error' }
    })
    await act(() => result.current.runRemoteNavigation('browser.reload'))
    expectPending()
    expect(currentPage().loading).toBe(false)
  })

  it('does not let a command settling after Proceed overwrite the native success or start another read', async () => {
    const { result, busy, notice } = renderNavigation()
    act(() => result.current.applyRemoteTabInfo(failedTab()))
    const command = deferred<unknown>()
    vi.mocked(callRuntimeRpc).mockReturnValue(command.promise)
    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.runRemoteNavigation('browser.reload')
      await Promise.resolve()
    })
    act(() => {
      result.current.prepareCertificateProceed()
      useAppStore.getState().updateBrowserPageState('page-a', { loadError: null, loading: false })
    })
    const publications = busy.mock.calls.length
    await act(async () => {
      command.resolve({ url: 'chrome-error://chromewebdata/', title: 'Old' })
      await pending
    })
    expect(currentPage().loadError).toBeNull()
    expect(useAppStore.getState().browserCertificateFailuresByPageId['page-a']).toBeUndefined()
    expect(vi.mocked(callRuntimeRpc).mock.calls.map((call) => call[1])).toEqual(['browser.reload'])
    expect(busy.mock.calls.length).toBe(publications)
    expect(notice).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'consequence' }))
  })

  it('rejects a late read after native replacement/clear, another action, host switch, or unmount, then accepts a current read', async () => {
    const { result, session, tokens, identity } = renderNavigation()
    act(() => result.current.applyRemoteTabInfo(failedTab()))
    for (const supersede of [
      () =>
        useAppStore
          .getState()
          .setBrowserPageCertificateFailure('page-a', failedTab('challenge-y').certificateFailure!),
      () => useAppStore.getState().updateBrowserPageState('page-a', { loadError: null }),
      () => session.invalidateTabInfoReads(),
      () => {
        identity.environmentId = 'environment-b'
      },
      () => {
        identity.mounted = false
      }
    ]) {
      const response = deferred<unknown>()
      vi.mocked(callRuntimeRpc).mockReturnValueOnce(response.promise)
      const read = session.refreshTabInfo(tokens.createOperationToken('remote-page-a')!)
      act(supersede)
      response.resolve({ tab: failedTab() })
      expect(await read).toBeNull()
      identity.environmentId = 'environment-a'
      identity.mounted = true
    }
    vi.mocked(callRuntimeRpc).mockResolvedValueOnce({ tab: failedTab('challenge-z') })
    await act(() => session.refreshTabInfo(tokens.createOperationToken('remote-page-a')!))
    expectPending('challenge-z')
  })

  it('keeps the second navigation loading when an older outcome read rejects', async () => {
    const { result, busy, notice } = renderNavigation()
    const stale = deferred<unknown>()
    const second = deferred<unknown>()
    vi.mocked(callRuntimeRpc)
      .mockResolvedValueOnce({ url: 'about:blank' })
      .mockReturnValueOnce(stale.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce({ tab: failedTab('challenge-y') })
    let first!: Promise<void>
    let next!: Promise<void>
    await act(async () => {
      first = result.current.runRemoteNavigation('browser.reload')
      await Promise.resolve()
      await Promise.resolve()
      next = result.current.runRemoteNavigation('browser.back')
      await Promise.resolve()
    })
    await act(async () => {
      stale.reject(new Error('stale read failed'))
      await first
    })
    expect(currentPage().loading).toBe(true)
    expect(busy).toHaveBeenLastCalledWith(true)
    expect(notice).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'consequence' }))
    await act(async () => {
      second.resolve({ url: 'chrome-error://chromewebdata/' })
      await next
    })
    expectPending('challenge-y')
    expect(currentPage().loading).toBe(false)
  })

  it.each(['success', 'failure'] as const)(
    'accepts a later native mirror %s after an early Proceed observation and rejects the older read',
    async (outcome) => {
      const { result, session, tokens } = renderNavigation()
      act(() => result.current.applyRemoteTabInfo(failedTab()))
      expectPending()
      act(() => {
        result.current.prepareCertificateProceed()
        result.current.applyRemoteTabInfo({
          ...failedTab(),
          certificateFailure: null
        })
      })
      const stale = deferred<unknown>()
      vi.mocked(callRuntimeRpc).mockReturnValueOnce(stale.promise)
      const read = session.refreshTabInfo(tokens.createOperationToken('remote-page-a')!)
      const failure = outcome === 'failure' ? failedTab('challenge-y') : null
      act(() =>
        useAppStore.setState((state) =>
          applyWebSessionTabsSnapshot(
            state,
            {
              worktree: 'worktree-a',
              publicationEpoch: 'tls-test',
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
                  url: 'https://selfsigned.test/',
                  title: 'TLS',
                  loading: false,
                  canGoBack: false,
                  canGoForward: false,
                  isActive: true,
                  loadError: failure?.loadError ?? null,
                  certificateFailure: failure?.certificateFailure ?? null
                }
              ]
            },
            'environment-a',
            100
          )
        )
      )
      stale.resolve({ tab: failedTab() })
      expect(await read).toBeNull()
      if (outcome === 'failure') {
        expectPending('challenge-y')
      } else {
        expect(currentPage().loadError).toBeNull()
        expect(useAppStore.getState().browserCertificateFailuresByPageId['page-a']).toBeUndefined()
      }
    }
  )

  it.each([null, undefined])(
    'keeps an explicit native clear but retains the legacy omitted-error fallback (%s)',
    async (loadError) => {
      const { result } = renderNavigation()
      act(() => result.current.applyRemoteTabInfo(failedTab()))
      vi.mocked(callRuntimeRpc).mockImplementation(async (_target, method) => {
        if (typeof method !== 'string') {
          return undefined
        }
        if (method === 'browser.tabShow') {
          return {
            tab: {
              ...failedTab(),
              url: 'https://loaded.test/',
              loadError,
              certificateFailure: null
            }
          }
        }
        throw new Error('ERR_TIMED_OUT (-7)')
      })
      await act(() => result.current.runRemoteNavigation('browser.goto', 'https://loaded.test/'))
      expect(currentPage().url).toBe('https://loaded.test/')
      expect(useAppStore.getState().browserCertificateFailuresByPageId['page-a']).toBeUndefined()
      if (loadError === null) {
        expect(currentPage().loadError).toBeNull()
      } else {
        expect(currentPage().loadError).toEqual({
          code: -7,
          description: 'ERR_TIMED_OUT',
          validatedUrl: 'https://loaded.test/'
        })
      }
    }
  )

  it('retains parsed command failure when its authoritative read also fails', async () => {
    const { result } = renderNavigation()
    vi.mocked(callRuntimeRpc).mockImplementation(async (_target, method) => {
      if (typeof method !== 'string') {
        return undefined
      }
      throw new Error(method === 'browser.tabShow' ? 'read timed out' : 'ERR_TIMED_OUT (-7)')
    })
    await act(() => result.current.runRemoteNavigation('browser.goto', 'https://loaded.test/'))
    expect(currentPage().loadError).toEqual({
      code: -7,
      description: 'ERR_TIMED_OUT',
      validatedUrl: 'https://loaded.test/'
    })
    expect(currentPage().loading).toBe(false)
  })

  it('does not reinstall X after native clear-to-failure-to-clear at the same URL', async () => {
    const { result, session, tokens } = renderNavigation()
    act(() =>
      result.current.applyRemoteTabInfo({
        ...failedTab(),
        loadError: null,
        certificateFailure: null
      })
    )
    const response = deferred<unknown>()
    vi.mocked(callRuntimeRpc).mockReturnValueOnce(response.promise)
    const pending = session.refreshTabInfo(tokens.createOperationToken('remote-page-a')!)
    act(() => {
      useAppStore.getState().updateBrowserPageState('page-a', { loadError: failedTab().loadError })
      useAppStore
        .getState()
        .setBrowserPageCertificateFailure('page-a', failedTab().certificateFailure!)
      useAppStore.getState().updateBrowserPageState('page-a', { loadError: null })
    })
    response.resolve({ tab: failedTab() })
    expect(await pending).toBeNull()
    expect(currentPage().loadError).toBeNull()
    vi.mocked(callRuntimeRpc).mockResolvedValueOnce({ tab: failedTab('challenge-y') })
    await act(() => session.refreshTabInfo(tokens.createOperationToken('remote-page-a')!))
    expectPending('challenge-y')
  })

  it('applies admitted state before resolving, so a queued native clear remains final', async () => {
    const { session, tokens } = renderNavigation()
    const response = deferred<unknown>()
    vi.mocked(callRuntimeRpc).mockReturnValueOnce(response.promise)
    const pending = session.refreshTabInfo(tokens.createOperationToken('remote-page-a')!)
    const nativeClear = response.promise.then(() =>
      queueMicrotask(() =>
        useAppStore.getState().updateBrowserPageState('page-a', { loadError: null })
      )
    )
    await act(async () => {
      response.resolve({ tab: failedTab() })
      await pending
      await nativeClear
    })
    expect(currentPage().loadError).toBeNull()
    expect(useAppStore.getState().browserCertificateFailuresByPageId['page-a']).toBeUndefined()
  })

  it.each([100, 1000])(
    'drops an obsolete read without visiting %i unrelated workspace pages after map replacement',
    async (count) => {
      const { result, session, tokens } = renderNavigation()
      act(() => result.current.applyRemoteTabInfo(failedTab()))
      const response = deferred<unknown>()
      vi.mocked(callRuntimeRpc).mockReturnValueOnce(response.promise)
      const pending = session.refreshTabInfo(tokens.createOperationToken('remote-page-a')!)
      let visits = 0
      let copies = 0
      const unrelated = Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `other-${index}`,
          new Proxy([page(`other-${index}`)], {
            get(target, key, receiver) {
              if (key === 'map') {
                copies += 1
              }
              if (typeof key === 'string' && /^\d+$/.test(key)) {
                visits += 1
              }
              return Reflect.get(target, key, receiver)
            }
          })
        ])
      )
      useAppStore.setState((state) => ({
        browserPagesByWorkspace: { ...state.browserPagesByWorkspace, ...unrelated }
      }))
      session.invalidateTabInfoReads()
      response.resolve({ tab: failedTab('stale') })
      expect(await pending).toBeNull()
      expect(visits).toBe(0)
      expect(copies).toBe(0)
      expectPending()
      vi.mocked(callRuntimeRpc).mockResolvedValueOnce({ tab: failedTab('challenge-y') })
      await act(() => session.refreshTabInfo(tokens.createOperationToken('remote-page-a')!))
      expectPending('challenge-y')
    }
  )

  it.each([100, 1000])(
    'publishes no work for identical decoded failure observations among %i pages',
    async (count) => {
      const { result, session, tokens } = renderNavigation(count)
      const failures = Object.fromEntries(
        Array.from({ length: count }, (_, index) => [
          `page-${index}`,
          failedTab(`other-${index}`).certificateFailure!
        ])
      )
      useAppStore.setState({ browserCertificateFailuresByPageId: failures })
      act(() => result.current.applyRemoteTabInfo(failedTab()))
      let enumerations = 0
      let copies = 0
      let visits = 0
      const state = useAppStore.getState()
      const counted = <T extends object>(value: T): T =>
        new Proxy(value, {
          ownKeys(target) {
            enumerations += 1
            return Reflect.ownKeys(target)
          }
        })
      const countedPages = new Proxy(state.browserPagesByWorkspace['workspace-a'], {
        get(target, key, receiver) {
          if (key === 'map') {
            copies += 1
          }
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            visits += 1
          }
          return Reflect.get(target, key, receiver)
        }
      })
      useAppStore.setState({
        browserPagesByWorkspace: counted({
          ...state.browserPagesByWorkspace,
          'workspace-a': countedPages
        }),
        browserCertificateFailuresByPageId: counted(state.browserCertificateFailuresByPageId)
      })
      currentPage()
      const before = useAppStore.getState()
      enumerations = 0
      copies = 0
      visits = 0
      const changed = vi.fn()
      const unsubscribe = useAppStore.subscribe(changed)
      vi.mocked(callRuntimeRpc).mockResolvedValueOnce({
        tab: JSON.parse(JSON.stringify(failedTab()))
      })
      await act(async () => {
        await session.refreshTabInfo(tokens.createOperationToken('remote-page-a')!)
      })
      unsubscribe()
      expect(changed).not.toHaveBeenCalled()
      expect(enumerations).toBe(0)
      expect(copies).toBe(0)
      expect(visits).toBeLessThanOrEqual(count + 20)
      expect(useAppStore.getState()).toBe(before)
      const unrelated = before.browserPagesByWorkspace['workspace-a'][1]
      act(() => result.current.applyRemoteTabInfo(failedTab('challenge-y')))
      expectPending('challenge-y')
      expect(useAppStore.getState().browserPagesByWorkspace['workspace-a'][1]).toBe(unrelated)
    }
  )
})
