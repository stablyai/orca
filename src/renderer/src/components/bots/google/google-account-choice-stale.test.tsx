// @vitest-environment happy-dom
import { act } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { botFailure } from '../../../../../shared/bots/bot-failure-copy'
import { useGoogleAccountChoice } from './GoogleAccountsChoice'

// The bot as its host has it: another window took b@x.com off after this picker opened.
const host = vi.hoisted((): { googleAccounts: string[] } => ({ googleAccounts: ['a@x.com'] }))
const toastError = vi.hoisted(() => vi.fn())
const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((entry) => b.includes(entry))

vi.mock('sonner', () => ({ toast: { error: toastError } }))
vi.mock('@/lib/bot-host-refresh', () => ({ refreshBotHost: async () => {} }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: async (
    _target: unknown,
    method: string,
    params: { basedOn?: { accounts?: string[] }; accounts?: string[] }
  ) => {
    if (method === 'google.status') {
      const account = (email: string) => ({
        email,
        status: 'connected',
        services: [],
        connectedAt: 0
      })
      return { client: null, accounts: ['a@x.com', 'b@x.com', 'c@x.com'].map(account), bots: [] }
    }
    if (method === 'bots.list') {
      return {
        bots: [{ id: 'scout', hostId: 'local', google: true, googleAccounts: host.googleAccounts }]
      }
    }
    // google.bot.set, checked the way the host checks basedOn.
    if (!sameSet(params.basedOn?.accounts ?? [], host.googleAccounts)) {
      throw new RuntimeRpcCallError({
        id: '1',
        ok: false as const,
        error: {
          code: 'invalid_argument',
          message: 'changed',
          data: { botFailure: botFailure('googleAccountsChanged') }
        },
        _meta: { runtimeId: 'r' }
      })
    }
    host.googleAccounts = params.accounts ?? []
    return {}
  }
}))

beforeEach(() => vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true))
afterEach(() => vi.unstubAllGlobals())

describe('a picker saved after the bot changed elsewhere', () => {
  it('says so once, reloads to the host’s list, and the next save keeps the newer edit', async () => {
    const opened = {
      id: 'scout',
      name: 'Scout',
      hostId: 'local' as const,
      members: [],
      google: true,
      googleAccounts: ['a@x.com', 'b@x.com']
    }
    const { result } = renderHook(() => useGoogleAccountChoice(opened))
    await waitFor(() => expect(result.current.ready).toBe(true))
    act(() => result.current.setChosen((chosen) => [...chosen, 'c@x.com']))
    await act(async () => {
      await expect(result.current.save()).resolves.toBe(false)
    })
    expect(toastError).toHaveBeenCalledTimes(1)
    expect(toastError).toHaveBeenCalledWith(
      expect.stringContaining('changed since you opened them')
    )
    expect(host.googleAccounts).toEqual(['a@x.com'])
    // Back to the host's list, not the stale ticks.
    expect(result.current.chosen).toEqual(['a@x.com'])

    act(() => result.current.setChosen((chosen) => [...chosen, 'c@x.com']))
    await act(async () => {
      await expect(result.current.save()).resolves.toBe(true)
    })
    expect(host.googleAccounts).toEqual(['a@x.com', 'c@x.com'])
    expect(toastError).toHaveBeenCalledTimes(1)
  })
})
