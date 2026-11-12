// @vitest-environment happy-dom
import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { applyWebSessionTabsSnapshot } from '@/runtime/web-session-tabs-sync/snapshot-api'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { BrowserTabInfo } from '../../../../../shared/browser/runtime/runtime-browser-contracts'

import {
  page,
  failedTab,
  deferred,
  renderNavigation,
  currentPage,
  expectPending
} from './remote-browser-page-navigation.test-fixture'

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: vi.fn() }))

beforeEach(() => vi.mocked(callRuntimeRpc).mockReset())
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

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

  it.each(['older-first', 'newer-first', 'newer-fails'] as const)(
    'retains current outcomes across command cleanup with %s settlement',
    async (order) => {
      const { result, session, tokens } = renderNavigation()
      act(() => result.current.applyRemoteTabInfo(failedTab()))
      const older = deferred<{ tab: BrowserTabInfo }>()
      const newer = deferred<{ tab: BrowserTabInfo }>()
      vi.mocked(callRuntimeRpc)
        .mockResolvedValueOnce({ url: 'https://selfsigned.test/', title: 'Reload' })
        .mockReturnValueOnce(older.promise)
        .mockReturnValueOnce(newer.promise)
      let command!: Promise<void>
      await act(async () => {
        command = result.current.runRemoteNavigation('browser.reload')
      })
      const refresh = session.refreshTabInfo(tokens.createOperationToken('remote-page-a')!)
      if (order === 'newer-fails') {
        await act(async () => {
          newer.reject(new Error('input read unavailable'))
          await expect(refresh).rejects.toThrow('input read unavailable')
        })
      } else if (order === 'newer-first') {
        await act(async () => {
          newer.resolve({ tab: { ...failedTab('challenge-z'), title: 'Current input' } })
          await refresh
        })
      }
      await act(async () => {
        older.resolve({ tab: { ...failedTab('challenge-y'), title: 'Reload outcome' } })
        await command
      })
      if (order === 'older-first') {
        await act(async () => {
          newer.resolve({ tab: { ...failedTab('challenge-z'), title: 'Current input' } })
          await refresh
        })
      }
      expectPending(order === 'newer-fails' ? 'challenge-y' : 'challenge-z')
      expect(currentPage().title).toBe(order === 'newer-fails' ? 'Reload outcome' : 'Current input')
      expect(currentPage().loading).toBe(false)
    }
  )

  it('releases retired Reload loading before failed Proceed without a native wake', async () => {
    const { result } = renderNavigation()
    act(() => result.current.applyRemoteTabInfo(failedTab()))
    const reload = deferred<unknown>()
    vi.mocked(callRuntimeRpc).mockImplementation(async (_target, method) =>
      method === 'browser.reload' ? reload.promise : undefined
    )
    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.runRemoteNavigation('browser.reload')
    })
    expect(currentPage().loading).toBe(true)
    act(() => result.current.prepareCertificateProceed())
    expect(currentPage().loading).toBe(false)
    await act(async () => {
      reload.reject(new Error('connection lost before reaching host'))
      await pending
    })
    expectPending()
    expect(currentPage().loading).toBe(false)
  })

  it('does not bless external ABA or clear native-owned loading during local cleanup', async () => {
    const { session, tokens, result } = renderNavigation()
    act(() => result.current.applyRemoteTabInfo(failedTab()))
    const token = tokens.createOperationToken('remote-page-a')!
    act(() => session.setPageLoading(token, true, useAppStore.getState().updateBrowserPageState))
    const response = deferred<{ tab: BrowserTabInfo }>()
    vi.mocked(callRuntimeRpc).mockReturnValue(response.promise)
    const pending = session.refreshTabInfo(token)
    act(() => {
      useAppStore.getState().updateBrowserPageState('page-a', { loadError: null })
      result.current.applyRemoteTabInfo(failedTab())
      useAppStore.getState().updateBrowserPageState('page-a', { loading: true })
      session.setPageLoading(token, false, useAppStore.getState().updateBrowserPageState)
    })
    await act(async () => {
      response.resolve({ tab: failedTab('stale') })
      await pending
    })
    expectPending()
    expect(currentPage().loading).toBe(true)
  })

  it.each(['initial-open', 'restart'] as const)(
    'preserves command failure when %s fails before ready',
    async (phase) => {
      vi.useFakeTimers()
      const { lifecycle, subscribe, result } = renderNavigation()
      const status = deferred<{ capabilities: string[] }>()
      const read = deferred<{ tab: BrowserTabInfo }>()
      let held = phase === 'initial-open'
      let commandStarted = false
      vi.mocked(callRuntimeRpc).mockImplementation(async (_target, method) => {
        if (method === 'status.get') {
          return held ? status.promise : { capabilities: ['browser.screencast.v1'] }
        }
        if (method === 'browser.goto') {
          commandStarted = true
          throw new Error('ERR_NAME_NOT_RESOLVED (-105)')
        }
        if (method === 'browser.tabShow') {
          return commandStarted ? read.promise : { tab: failedTab() }
        }
        return undefined
      })
      try {
        lifecycle.open()
        await act(() => vi.advanceTimersByTimeAsync(0))
        if (phase === 'restart') {
          const callbacks = subscribe.mock.calls[0][1]
          callbacks.onResponse({
            id: 'stream-1',
            ok: true,
            result: {
              type: 'ready',
              subscriptionId: 'stream-1',
              browserPageId: 'remote-page-a',
              format: 'jpeg',
              tab: failedTab()
            },
            _meta: { runtimeId: 'host-a' }
          })
          held = true
          callbacks.onClose?.()
          await act(() => vi.runOnlyPendingTimersAsync())
        }
        let command!: Promise<void>
        await act(async () => {
          command = result.current.runRemoteNavigation('browser.goto', 'https://missing.test/')
        })
        subscribe.mockRejectedValueOnce(
          Object.assign(new Error('stream unavailable'), { code: 'browser_screencast_unsupported' })
        )
        await act(async () => {
          status.resolve({ capabilities: ['browser.screencast.v1'] })
          await vi.advanceTimersByTimeAsync(0)
        })
        await act(async () => {
          read.reject(new Error('outcome read unavailable'))
          await command
        })
        expect(currentPage().loadError).toEqual({
          code: -105,
          description: 'ERR_NAME_NOT_RESOLVED',
          validatedUrl: 'https://missing.test/'
        })
        expect(currentPage().loading).toBe(false)
      } finally {
        lifecycle.dispose()
      }
    }
  )

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

  it.each(['rejected', 'resolved', 'missing'] as const)(
    'keeps a queued native replacement after an admitted %s read failure',
    async (outcome) => {
      const { result, notice, closeMissing } = renderNavigation()
      act(() => result.current.applyRemoteTabInfo(failedTab()))
      const read = deferred<unknown>()
      vi.mocked(callRuntimeRpc).mockImplementation((_target, method) => {
        if (typeof method !== 'string') {
          return Promise.resolve(undefined)
        }
        if (method === 'browser.tabShow') {
          return read.promise
        }
        if (outcome === 'rejected') {
          return Promise.reject(new Error('ERR_CERT_AUTHORITY_INVALID (-202)'))
        }
        return Promise.resolve({ url: 'https://old.test/', title: 'Old' })
      })
      let pending!: Promise<void>
      await act(async () => {
        pending = result.current.runRemoteNavigation('browser.goto', 'https://old.test/')
        await Promise.resolve()
        await Promise.resolve()
      })
      const native = read.promise.catch(() =>
        queueMicrotask(() => {
          useAppStore.getState().setBrowserPageUrl('page-a', 'https://native.test/')
          useAppStore
            .getState()
            .updateBrowserPageState('page-a', { loadError: null, loading: false, title: 'Native' })
          notice.mockClear()
          closeMissing.mockClear()
        })
      )
      await act(async () => {
        read.reject(
          outcome === 'missing'
            ? Object.assign(new Error('page missing'), { code: 'browser_tab_not_found' })
            : new Error('read timed out')
        )
        await pending
        await native
      })
      expect(currentPage().url).toBe('https://native.test/')
      expect(currentPage().title).toBe('Native')
      expect(currentPage().loadError).toBeNull()
      expect(useAppStore.getState().browserCertificateFailuresByPageId['page-a']).toBeUndefined()
      expect(notice).not.toHaveBeenCalled()
      expect(closeMissing).not.toHaveBeenCalled()
    }
  )

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
              // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy must forward array access unchanged while counting visits.
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
          // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy must forward array access unchanged while counting visits.
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
