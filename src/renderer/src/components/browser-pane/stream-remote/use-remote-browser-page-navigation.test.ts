// @vitest-environment happy-dom
import { act, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import '@/runtime/web-session-tabs-sync/snapshots/snapshot-api'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { BrowserTabInfo } from '../../../../../shared/browser/runtime/runtime-browser-contracts'

import {
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

  it.each(['browser.goto', 'browser.reload'] as const)(
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

  it("files the host's favicon in history only for the document that carries it", () => {
    const { result } = renderNavigation()
    const tab = (url: string): BrowserTabInfo => ({
      browserPageId: 'remote-page-a',
      index: 0,
      active: true,
      url,
      title: 'Example'
    })
    act(() => {
      useAppStore.getState().updateBrowserPageState('page-a', {
        faviconUrl: 'https://example.test/icon.png'
      })
      useAppStore.getState().setBrowserPageUrl('page-a', 'https://example.test/')
    })
    act(() => result.current.applyRemoteTabInfo(tab('https://example.test/')))
    act(() => result.current.applyRemoteTabInfo(tab('https://other.test/')))

    expect(
      useAppStore
        .getState()
        .browserUrlHistory.map(({ url, faviconUrl }) => ({ url, faviconUrl: faviconUrl ?? null }))
    ).toEqual([
      { url: 'https://other.test/', faviconUrl: null },
      { url: 'https://example.test/', faviconUrl: 'https://example.test/icon.png' }
    ])
  })

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
    act(() => result.current.abandonRemoteNavigation())
    expect(currentPage().loading).toBe(false)
    await act(async () => {
      reload.reject(new Error('connection lost before reaching host'))
      await pending
    })
    expectPending()
    expect(currentPage().loading).toBe(false)
  })

  it('Stop releases a pending reload and stops the host page', async () => {
    const { result, busy } = renderNavigation()
    const reload = deferred<unknown>()
    const calls: string[] = []
    vi.mocked(callRuntimeRpc).mockImplementation(async (_target, method, params) => {
      calls.push(`${String(method)} ${JSON.stringify(params)}`)
      return method === 'browser.reload' ? reload.promise : undefined
    })
    let pending!: Promise<void>
    await act(async () => {
      pending = result.current.runRemoteNavigation('browser.reload', undefined, true)
    })
    expect(currentPage().loading).toBe(true)
    await act(() => result.current.stopRemotePage())
    expect(currentPage().loading).toBe(false)
    expect(busy).toHaveBeenLastCalledWith(false)
    await act(async () => {
      reload.resolve({ url: 'https://example.test/', title: 'Example' })
      await pending
    })
    expect(currentPage().loading).toBe(false)
    expect(calls.filter((call) => !call.startsWith('browser.tabShow'))).toEqual([
      'browser.reload {"worktree":"worktree-a","page":"remote-page-a","ignoreCache":true}',
      'browser.stop {"worktree":"worktree-a","page":"remote-page-a"}'
    ])
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
})
