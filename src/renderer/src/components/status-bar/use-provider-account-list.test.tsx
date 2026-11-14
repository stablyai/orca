// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { refreshProviderAccountLists, useProviderAccountList } from './use-provider-account-list'
import {
  emptyCodexAccountsState,
  type ProviderAccountsSnapshot
} from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// Real hook and real snapshot client; only the host stream is a stand-in answered by hand.
function setup(environmentId: string) {
  const streams: { send: (snapshot: ProviderAccountsSnapshot) => void; fail: () => void }[] = []
  vi.stubGlobal('api', {
    runtimeEnvironments: {
      subscribe: async (
        _args: unknown,
        callbacks: {
          onResponse: (response: unknown) => void
          onError: (error: { code: string; message: string }) => void
        }
      ) => {
        streams.push({
          send: (snapshot) =>
            callbacks.onResponse({ ok: true, result: { type: 'snapshot', snapshot } }),
          fail: () => callbacks.onError({ code: 'unreachable', message: 'host unreachable' })
        })
        return { unsubscribe: () => {} }
      }
    }
  })
  const target = { kind: 'environment', environmentId } as const
  const mount = () =>
    renderHook(() => useProviderAccountList('codex', target, '', emptyCodexAccountsState()))
  const hostReports = (activeAccountId: string): ProviderAccountsSnapshot => ({
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: [], activeAccountId },
    rateLimits: null
  })
  return { streams, target, mount, hostReports }
}

it.each(['before', 'after'] as const)(
  'keeps a selection result when an earlier shared read resolves %s a fresh read',
  async (order) => {
    const { streams, mount, hostReports } = setup(`selection-${order}`)
    const { result } = mount()
    await act(async () => {})
    const staleRead = streams[0]
    act(() => result.current.setAccounts(hostReports('selected').codex))

    const reload = result.current.loadAccounts()
    await act(async () => {})
    if (order === 'before') {
      await act(async () => staleRead.send(hostReports('stale')))
      expect(result.current.accounts.activeAccountId).toBe('selected')
    }
    // The retired request settling must not evict the newer one from sharing: this read is answered by it.
    const sharedReload = result.current.loadAccounts()
    await act(async () => {})
    await act(async () => {
      streams[1].send(hostReports('selected'))
      await Promise.all([reload, sharedReload])
    })
    if (order === 'after') {
      await act(async () => staleRead.send(hostReports('stale')))
    }
    expect(result.current.accounts.activeAccountId).toBe('selected')
    expect(result.current.accountsLoaded).toBe(true)
  }
)

it.each(['before', 'after'] as const)(
  'shows what the host reports after an uncertain owner menu opens when the older read resolves %s',
  async (order) => {
    const { streams, target, mount, hostReports } = setup(`open-${order}`)
    const { result } = mount()
    await act(async () => streams[0].send(hostReports('initial')))
    act(() => refreshProviderAccountLists(target, 'codex', 'unknown'))
    await act(async () => {})
    const olderRead = streams[1]
    // The host applies the change here, after the older read was issued.
    act(() => result.current.reloadUncertainAccountsOnOpen())
    await act(async () => {})
    const openRead = streams[2]
    // A read issued after the open is as fresh as it, so the open's answer serves it.
    const follower = result.current.loadAccounts()
    await act(async () => {})
    if (order === 'before') {
      await act(async () => olderRead.send(hostReports('before-change')))
      expect(result.current.accounts.activeAccountId).toBe('initial')
    }
    await act(async () => {
      openRead.send(hostReports('after-change'))
      await follower
    })
    if (order === 'after') {
      await act(async () => olderRead.send(hostReports('before-change')))
    }
    expect(result.current.accounts.activeAccountId).toBe('after-change')
  }
)

it.each(['answered', 'failed'] as const)(
  'reads again at the first open after an uncertain owner read %s before a late change',
  async (earlierRead) => {
    const { streams, target, mount, hostReports } = setup(`late-${earlierRead}`)
    const { result } = mount()
    await act(async () => streams[0].send(hostReports('before-change')))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    act(() => refreshProviderAccountLists(target, 'codex', 'unknown'))
    await act(async () => {})
    await act(async () =>
      earlierRead === 'answered' ? streams[1].send(hostReports('before-change')) : streams[1].fail()
    )
    expect(result.current.accounts.activeAccountId).toBe('before-change')
    // The selection applies on the host only now, long after that read settled.
    act(() => result.current.reloadUncertainAccountsOnOpen())
    await act(async () => {})
    await act(async () => streams[2].send(hostReports('after-change')))
    expect(result.current.accounts.activeAccountId).toBe('after-change')
  }
)

it.each(['before', 'after'] as const)(
  'shows what the host reports when a menu mounted for an uncertain owner first opens %s a late change',
  async (opens) => {
    const { streams, target, mount, hostReports } = setup(`mounted-${opens}`)
    mount()
    await act(async () => {})
    act(() => refreshProviderAccountLists(target, 'codex', 'unknown'))
    await act(async () => {})
    const olderRead = streams[1]
    const returned = mount()
    await act(async () => {})
    // Anything already asked of the host answers with the roster from before the change.
    const askedBeforeOpen = [...streams]
    if (opens === 'after') {
      await act(async () =>
        askedBeforeOpen.forEach((read) => read.send(hostReports('before-change')))
      )
    }
    act(() => returned.result.current.reloadUncertainAccountsOnOpen())
    await act(async () => {})
    if (opens === 'before') {
      await act(async () => olderRead.send(hostReports('before-change')))
    }
    const openRead = streams.find((read) => !askedBeforeOpen.includes(read))!
    await act(async () => openRead.send(hostReports('after-change')))
    expect(returned.result.current.accounts.activeAccountId).toBe('after-change')
  }
)
