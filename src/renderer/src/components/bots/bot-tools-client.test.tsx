// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const bots: { id: string; hostId: string; agent: string }[] = []
  return { rpc: vi.fn(), openUrl: vi.fn(), bots }
})
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('@/lib/bot-catalog', () => ({ useBots: () => mocks.bots }))

import { connectBotTool, useBotToolSignIn } from './bot-tools-client'
import { useBotTools } from './bot-tool-checks'

const methodsCalled = () => mocks.rpc.mock.calls.map(([, method]) => method)

describe('waiting on a tool sign-in', () => {
  let status: string
  beforeEach(() => {
    vi.useFakeTimers()
    status = 'pending'
    mocks.rpc
      .mockReset()
      .mockImplementation(async (_target: unknown, method: string) =>
        method === 'bots.tools.connect'
          ? { authorizationUrl: 'https://example.com/authorize' }
          : { status }
      )
    Object.assign(window, { api: { shell: { openUrl: mocks.openUrl } } })
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('asks only for its status, once for a row and a card together, and stops when it ends', async () => {
    await connectBotTool({ hostId: 'local', id: 'bot-1' }, 'notion')
    const row = renderHook(() => useBotToolSignIn({ hostId: 'local', id: 'bot-1' }, 'notion'))
    renderHook(() => useBotToolSignIn({ hostId: 'local', id: 'bot-1' }, 'notion'))
    expect(row.result.current.active).toBe(true)

    await act(() => vi.advanceTimersByTimeAsync(4_100))
    expect(methodsCalled().filter((method) => method === 'bots.tools.signInStatus')).toHaveLength(2)
    expect(methodsCalled()).not.toContain('bots.tools.problems')

    status = 'done'
    await act(() => vi.advanceTimersByTimeAsync(2_100))
    expect(row.result.current.active).toBe(false)
    const asked = methodsCalled().length
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    expect(methodsCalled()).toHaveLength(asked)
  })

  it('stops asking when the last row or card showing it goes away', async () => {
    await connectBotTool({ hostId: 'local', id: 'bot-1' }, 'linear')
    const card = renderHook(() => useBotToolSignIn({ hostId: 'local', id: 'bot-1' }, 'linear'))
    await act(() => vi.advanceTimersByTimeAsync(2_100))
    card.unmount()
    const asked = methodsCalled().length
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    expect(methodsCalled()).toHaveLength(asked)
  })

  it('keeps waiting while its Connect is still starting, whatever an earlier try left', async () => {
    status = 'failed'
    const connect = Promise.withResolvers<{ authorizationUrl: string | null }>()
    mocks.rpc.mockImplementation(async (_target: unknown, method: string) =>
      method === 'bots.tools.connect' ? connect.promise : { status }
    )
    const connecting = connectBotTool({ hostId: 'local', id: 'bot-1' }, 'slow')
    const row = renderHook(() => useBotToolSignIn({ hostId: 'local', id: 'bot-1' }, 'slow'))
    await act(() => vi.advanceTimersByTimeAsync(6_100))
    expect(row.result.current.active).toBe(true)

    status = 'pending'
    connect.resolve({ authorizationUrl: null })
    await act(() => connecting)
    status = 'done'
    await act(() => vi.advanceTimersByTimeAsync(2_100))
    expect(row.result.current.active).toBe(false)
  })
})

describe('a bot’s tools after it switches agent', () => {
  afterEach(cleanup)

  it('checks sign-ins again with the new agent, whose CLI holds its own', async () => {
    mocks.bots = [{ id: 'bot-2', hostId: 'local', agent: 'claude' }]
    mocks.rpc.mockReset().mockImplementation(async (_target: unknown, method: string) =>
      method === 'bots.tools.list'
        ? {
            agent: mocks.bots[0]!.agent,
            own: [{ name: 'vercel', detail: 'https://mcp.vercel.com', remote: true }],
            inherited: []
          }
        : { problems: mocks.bots[0]!.agent === 'codex' ? { vercel: { kind: 'sign-in' } } : {} }
    )
    const tools = renderHook(() => useBotTools({ hostId: 'local', id: 'bot-2' }))
    await vi.waitFor(() =>
      expect(tools.result.current.view).toMatchObject({ status: 'ready', problems: {} })
    )

    mocks.bots = [{ id: 'bot-2', hostId: 'local', agent: 'codex' }]
    tools.rerender()
    await vi.waitFor(() =>
      expect(tools.result.current.view).toMatchObject({
        status: 'ready',
        problems: { vercel: { kind: 'sign-in' } }
      })
    )
  })
})

describe('who starts a check of a bot’s servers, and who stops it', () => {
  const own: Record<string, { name: string; detail: string; remote: boolean }[]> = {
    'bot-a': [{ name: 'vercel', detail: 'https://mcp.vercel.com', remote: true }],
    'bot-b': [{ name: 'linear', detail: 'https://mcp.linear.app/mcp', remote: true }],
    'bot-cmd': [{ name: 'metrics', detail: 'node metrics.js', remote: false }]
  }
  const calls = (method: string) =>
    mocks.rpc.mock.calls.filter(([, name]) => name === method).map(([, , params]) => params)
  beforeEach(() => {
    mocks.bots = Object.keys(own).map((id) => ({ id, hostId: 'local', agent: 'claude' }))
    mocks.rpc
      .mockReset()
      .mockImplementation(async (_target: unknown, method: string, params: { botId: string }) =>
        method === 'bots.tools.list'
          ? { agent: 'claude', own: own[params.botId], inherited: [] }
          : method === 'bots.tools.problems'
            ? new Promise(() => {})
            : { cancelled: true }
      )
  })
  afterEach(cleanup)

  it('stops a check under way when the shown bot changes or its list goes away, sharing it meanwhile', async () => {
    const list = renderHook(({ botId }) => useBotTools({ hostId: 'local', id: botId }, 'apps'), {
      initialProps: { botId: 'bot-a' }
    })
    renderHook(() => useBotTools({ hostId: 'local', id: 'bot-a' }, 'apps')).unmount()
    await vi.waitFor(() => expect(calls('bots.tools.problems')).toHaveLength(1))
    expect(calls('bots.tools.problems')[0]).toEqual({ botId: 'bot-a', scope: 'remote' })
    expect(calls('bots.tools.cancelProblems')).toEqual([])

    list.rerender({ botId: 'bot-b' })
    await vi.waitFor(() => expect(calls('bots.tools.problems')).toHaveLength(2))
    expect(calls('bots.tools.cancelProblems')).toEqual([{ botId: 'bot-a' }])

    list.unmount()
    expect(calls('bots.tools.cancelProblems')).toEqual([{ botId: 'bot-a' }, { botId: 'bot-b' }])
  })

  it('starts nothing for a bot with only command tools, or for readers that need no check', async () => {
    const apps = renderHook(() => useBotTools({ hostId: 'local', id: 'bot-cmd' }, 'apps'))
    const names = renderHook(() => useBotTools({ hostId: 'local', id: 'bot-a' }, 'none'))
    const badge = renderHook(() => useBotTools({ hostId: 'local', id: 'bot-a' }, 'finished'))
    await vi.waitFor(() => {
      expect(apps.result.current.view.status).toBe('ready')
      expect(names.result.current.view.status).toBe('ready')
      expect(badge.result.current.view.status).toBe('ready')
    })
    expect(calls('bots.tools.problems')).toEqual([])
  })
})
