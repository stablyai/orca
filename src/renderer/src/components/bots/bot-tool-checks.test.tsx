// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BotTools } from '../../../../shared/bot-tools'

type Ref = { hostId: string; id: string }
type Call = {
  bot: Ref
  method: string
  params: Record<string, unknown>
  resolve: (value: unknown) => void
}

const host = vi.hoisted(() => {
  const state: {
    calls: Call[]
    changed: ((hostId: string, scope: unknown) => void) | null
  } = { calls: [], changed: null }
  return state
})

vi.mock('@/lib/bot-hosts', () => ({
  botRefKey: (bot: Ref) => `${bot.hostId}\0${bot.id}`,
  isSameBot: (a: Ref, b: Ref) => a.hostId === b.hostId && a.id === b.id,
  callBotRpc: (bot: Ref, method: string, params: Record<string, unknown>) =>
    new Promise((resolve) => host.calls.push({ bot, method, params, resolve }))
}))
vi.mock('@/lib/bot-catalog', () => ({
  useBots: () => [
    { hostId: 'local', id: 'bot-1', agent: 'codex' },
    { hostId: 'runtime:other', id: 'bot-2', agent: 'codex' }
  ]
}))
vi.mock('@/lib/bots-changed-window-event', () => ({
  onBotsChanged: (listener: (hostId: string, scope: unknown) => void) => {
    host.changed = listener
    return () => {}
  }
}))

const BOT = { hostId: 'local' as const, id: 'bot-1' }
const OTHER = { hostId: 'runtime:other' as const, id: 'bot-2' }
const pending = (method: string, bot: Ref = BOT) =>
  host.calls.filter((call) => call.method === method && call.bot.id === bot.id)
const tools = (own: BotTools['own'], checkBasis?: string): BotTools => ({
  agent: 'codex',
  own,
  inherited: [],
  ...(checkBasis === undefined ? {} : { checkBasis })
})
const linear = { name: 'linear', detail: 'https://mcp.linear.app/mcp', remote: true }
const failed = { linear: { kind: 'failed' as const } }

async function answer(call: Call | undefined, value: unknown): Promise<void> {
  await act(async () => {
    call?.resolve(value)
  })
}

beforeEach(() => {
  host.calls.length = 0
})
afterEach(() => {
  cleanup()
  vi.resetModules()
})

describe('useBotTools', () => {
  it('checks Connectors whose only apps Orca signed in to', async () => {
    const { useBotTools } = await import('./bot-tool-checks')
    renderHook(() => useBotTools(BOT, 'apps'))
    const signedIn = {
      name: 'notion',
      detail: 'https://mcp.notion.com/mcp',
      remote: false,
      signIn: { state: 'signed-in' as const, limited: false }
    }
    await answer(pending('bots.tools.list')[0], tools([signedIn]))
    expect(pending('bots.tools.problems').map((call) => call.params)).toEqual([
      { botId: 'bot-1', scope: 'remote' }
    ])
  })

  it('checks again after the Codex Arguments change, and again when they change back', async () => {
    const { useBotTools } = await import('./bot-tool-checks')
    const { result } = renderHook(() => useBotTools(BOT, 'check'))
    await answer(pending('bots.tools.list')[0], tools([linear], 'a'))
    await answer(pending('bots.tools.problems')[0], { problems: {}, checkBasis: 'a' })
    expect(result.current.view).toMatchObject({ status: 'ready', problems: {} })

    // Another bot setting changed: the same basis keeps the settled check.
    act(() => host.changed?.('local', undefined))
    await answer(pending('bots.tools.list')[1], tools([linear], 'a'))
    expect(pending('bots.tools.problems')).toHaveLength(1)

    act(() => host.changed?.('local', undefined))
    await answer(pending('bots.tools.list')[2], tools([linear], 'b'))
    await answer(pending('bots.tools.list').at(-1), tools([linear], 'b'))
    expect(pending('bots.tools.problems')).toHaveLength(2)

    act(() => host.changed?.('local', undefined))
    await answer(pending('bots.tools.list').at(-1), tools([linear], 'a'))
    await answer(pending('bots.tools.list').at(-1), tools([linear], 'a'))
    expect(pending('bots.tools.problems')).toHaveLength(3)
  })

  it('never shows an answer run under other settings, and checks again in its place', async () => {
    const { useBotTools } = await import('./bot-tool-checks')
    const { result } = renderHook(() => useBotTools(BOT, 'check'))
    await answer(pending('bots.tools.list')[0], tools([linear], 'b'))
    // The host ran this check under the old Arguments.
    await answer(pending('bots.tools.problems')[0], { problems: failed, checkBasis: 'a' })
    expect(result.current.view).not.toMatchObject({ problems: failed })
    expect(pending('bots.tools.list')).toHaveLength(2)
    await answer(pending('bots.tools.list')[1], tools([linear], 'b'))
    await answer(pending('bots.tools.problems')[1], { problems: {}, checkBasis: 'b' })
    expect(result.current.view).toMatchObject({ status: 'ready', problems: {} })
  })

  it('drops an old check that answers after the change, once the new one has', async () => {
    const { useBotTools } = await import('./bot-tool-checks')
    const { result } = renderHook(() => useBotTools(BOT, 'check'))
    await answer(pending('bots.tools.list')[0], tools([linear], 'a'))
    const old = pending('bots.tools.problems')[0]
    act(() => host.changed?.('local', undefined))
    await answer(pending('bots.tools.list')[1], tools([linear], 'b'))
    await answer(pending('bots.tools.list').at(-1), tools([linear], 'b'))
    await answer(pending('bots.tools.problems')[1], { problems: {}, checkBasis: 'b' })
    // The answers arrive in reverse: the old check last.
    await answer(old, { problems: failed, checkBasis: 'a' })
    expect(result.current.view).toMatchObject({ status: 'ready', problems: {} })
  })

  it('leaves another host’s check under way alone', async () => {
    const { useBotTools } = await import('./bot-tool-checks')
    renderHook(() => useBotTools(BOT, 'check'))
    renderHook(() => useBotTools(OTHER, 'check'))
    await answer(pending('bots.tools.list', BOT)[0], tools([linear], 'a'))
    await answer(pending('bots.tools.list', OTHER)[0], tools([linear], 'z'))
    expect(pending('bots.tools.problems', OTHER)).toHaveLength(1)

    act(() => host.changed?.('local', undefined))
    await answer(pending('bots.tools.list', BOT)[1], tools([linear], 'b'))
    await answer(pending('bots.tools.list', BOT).at(-1), tools([linear], 'b'))
    expect(pending('bots.tools.problems', BOT)).toHaveLength(2)
    expect(pending('bots.tools.list', OTHER)).toHaveLength(1)
    expect(pending('bots.tools.problems', OTHER)).toHaveLength(1)
    expect(pending('bots.tools.cancelProblems', OTHER)).toEqual([])
  })
})
