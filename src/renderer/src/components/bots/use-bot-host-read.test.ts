// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emitBotsChangedWindowEvent } from '@/lib/bots-changed-window-event'
import { botRefKey } from '@/lib/bot-hosts'
import type * as BotHosts from '@/lib/bot-hosts'
import { BOT_WORK_KINDS } from '../../../../shared/bots/bot-change-scope'
import { createBotHostRead } from './use-bot-host-read'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'

const mocks = vi.hoisted(() => ({
  answers: new Map<string, unknown>(),
  calls: new Array<string>()
}))
vi.mock('@/lib/bot-hosts', async (importOriginal) => ({
  ...(await importOriginal<typeof BotHosts>()),
  callBotRpc: async (_bot: unknown, _method: string, params: { botId: string }) => {
    mocks.calls.push(params.botId)
    const answer = mocks.answers.get(params.botId)
    if (answer instanceof Error) {
      throw answer
    }
    return answer
  }
}))

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

afterEach(() => {
  mocks.calls.length = 0
  mocks.answers.clear()
})

describe('createBotHostRead', () => {
  it('reports initial read errors and preserves the last good value through a failed refresh', async () => {
    const read = createBotHostRead<{ items: string[] }>(
      'bots.items.owner.list',
      (result: never) => result,
      'failed',
      BOT_WORK_KINDS
    )
    const bot = { hostId: 'local' as const, id: 'bot-r' }
    const key = botRefKey(bot)
    const stop = read.subscribe(bot, vi.fn())
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    expect(read.state(key)).toBe('loading')
    mocks.answers.set('bot-r', new Error('connection reset'))
    read.request(bot)
    await flush()
    expect(read.state(key)).toBe('failed')
    mocks.answers.set('bot-r', { items: ['a'] })
    read.request(bot)
    await flush()
    expect(read.state(key)).toBe('ready')
    expect(read.refreshFailed(key)).toBe(false)
    mocks.answers.set('bot-r', new Error('connection reset'))
    read.request(bot)
    await flush()
    expect(read.snapshot(key)).toEqual({ items: ['a'] })
    expect(read.refreshFailed(key)).toBe(true)
    mocks.answers.set('bot-r', { items: ['a', 'b'] })
    read.request(bot)
    await flush()
    expect(read.snapshot(key)).toEqual({ items: ['a', 'b'] })
    expect(read.refreshFailed(key)).toBe(false)
    stop()
    vi.restoreAllMocks()
  })

  it('keeps an unchanged answer, and its unchanged parts, as they were', async () => {
    const read = createBotHostRead<{ chats: { id: string; title: string }[] }>(
      'bots.chatTree',
      (result: never) => result,
      'failed',
      BOT_WORK_KINDS
    )
    const bot = { hostId: 'local' as const, id: 'bot-a' }
    const heard = vi.fn()
    const stop = read.subscribe(bot, heard)
    mocks.answers.set('bot-a', {
      chats: [
        { id: 'c1', title: 'One' },
        { id: 'c2', title: 'Two' }
      ]
    })
    read.request(bot)
    await flush()
    const first = read.snapshot(botRefKey(bot))
    mocks.answers.set('bot-a', {
      chats: [
        { id: 'c1', title: 'One' },
        { id: 'c2', title: 'Two' }
      ]
    })
    read.request(bot)
    await flush()
    expect(read.snapshot(botRefKey(bot))).toBe(first)
    expect(heard).toHaveBeenCalledTimes(1)
    mocks.answers.set('bot-a', {
      chats: [
        { id: 'c1', title: 'One' },
        { id: 'c2', title: 'Renamed' }
      ]
    })
    read.request(bot)
    await flush()
    const next = read.snapshot(botRefKey(bot))
    expect(next).not.toBe(first)
    expect(next?.chats[0]).toBe(first?.chats[0])
    stop()
  })
})

describe('a botsChanged notice and a bot view', () => {
  it("re-reads only the views of the bots it names, or every view when it names none (an older host's)", async () => {
    const { useBotHostRead } = await import('./use-bot-host-read')
    const { renderHook } = await import('@testing-library/react')
    const read = createBotHostRead<{ n: number }>(
      'bots.chatTree',
      (result: never) => result,
      'failed',
      BOT_WORK_KINDS
    )
    const bots = ['bot-a', 'bot-b'].map((id) => ({
      id,
      hostId: 'local' as const,
      folderWorkspaceId: `fw-${id}`,
      chatSessionId: null
    }))
    for (const bot of bots) {
      mocks.answers.set(bot.id, { n: 1 })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only these fields.
      renderHook(() => useBotHostRead(read, bot as never))
    }
    await flush()
    mocks.calls.length = 0
    emitBotsChangedWindowEvent('local', { botIds: ['bot-a'], kinds: ['chats'] })
    await flush()
    expect(mocks.calls).toEqual(['bot-a'])
    mocks.calls.length = 0
    // A change of a kind no chats view shows reads nothing.
    emitBotsChangedWindowEvent('local', { kinds: ['access'] })
    await flush()
    expect(mocks.calls).toEqual([])
    emitBotsChangedWindowEvent('local')
    await flush()
    expect(mocks.calls.toSorted()).toEqual(['bot-a', 'bot-b'])
  })

  it("re-reads a chats view as its Home chat's phase changes, and an items view only on its notices", async () => {
    const { useBotHostRead } = await import('./use-bot-host-read')
    const { act, renderHook } = await import('@testing-library/react')
    const { useAppStore } = await import('@/store')
    const { acceptedAgentStatuses } =
      await import('@/store/slices/agent-status/status-ownership/accepted-agent-statuses')
    const { structuredAgentSessionStatusPaneKey } =
      await import('../../../../shared/agent-session/view/structured-agent-session-tab')
    const views = [
      { id: 'bot-chats', kinds: BOT_WORK_KINDS },
      { id: 'bot-items', kinds: ['items', 'workers'] as const }
    ]
    for (const { id, kinds } of views) {
      const read = createBotHostRead<{ n: number }>('bots.read', (r: never) => r, 'failed', kinds)
      const bot = {
        id,
        hostId: 'local' as const,
        folderWorkspaceId: `fw-${id}`,
        chatSessionId: `s-${id}`
      }
      mocks.answers.set(id, { n: 1 })
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook reads only these fields.
      renderHook(() => useBotHostRead(read, bot as never))
    }
    await flush()
    mocks.calls.length = 0
    const states: AgentStatusEntry['state'][] = ['working', 'done', 'working']
    for (const state of states) {
      act(() =>
        useAppStore.setState({
          agentStatusByPaneKey: acceptedAgentStatuses(
            views.map(({ id }) => {
              const paneKey = structuredAgentSessionStatusPaneKey(`s-${id}`)
              const entry: AgentStatusEntry = {
                paneKey,
                state,
                agentType: 'claude',
                prompt: '',
                updatedAt: 1,
                stateStartedAt: 1,
                stateHistory: []
              }
              return [paneKey, entry] as const
            })
          )
        })
      )
      await flush()
    }
    expect(mocks.calls).toEqual(['bot-chats', 'bot-chats', 'bot-chats'])
  })
})
