// @vitest-environment happy-dom
// Guards PR #49171: a host's bots change rereads only the bots a view still shows, so
// tools views opened and closed earlier cost the host no reads, and a finished check outlives them.
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { emitBotsChangedWindowEvent } from '@/lib/bots-changed-window-event'
import type { BotChangeScope } from '../../../../shared/bots/bot-change-scope'
import { useBotTools } from './bot-tool-checks'

let lists = 0
vi.mock('@/lib/bot-hosts', () => ({
  botRefKey: (bot: { hostId: string; id: string }) => `${bot.hostId}:${bot.id}`,
  isSameBot: (a: { hostId: string; id: string }, b: { hostId: string; id: string }) =>
    a.hostId === b.hostId && a.id === b.id,
  callBotRpc: async (bot: { id: string }, method: string) => {
    if (method === 'bots.tools.problems') {
      return { problems: { app: { kind: 'sign-in' } } }
    }
    if (method === 'bots.tools.list') {
      lists += 1
    }
    return {
      own: bot.id.startsWith('checked')
        ? [{ name: 'app', detail: 'https://app', remote: true }]
        : []
    }
  }
}))
let listed: { id: string }[] = []
vi.mock('@/lib/bot-catalog', () => ({ useBots: () => [], readHostBots: () => listed }))

afterEach(cleanup)

let opened = 0
const viewOf = () => {
  const id = `bot-${opened++}`
  return renderHook(() => useBotTools({ hostId: 'local', id }, 'none'))
}

async function readsOnChange(
  closed: number,
  shown: number,
  scope?: BotChangeScope
): Promise<number> {
  const views = Array.from({ length: closed + shown }, viewOf)
  await act(async () => {})
  for (const view of views.slice(0, closed)) {
    view.unmount()
  }
  lists = 0
  await act(async () => emitBotsChangedWindowEvent('local', scope))
  for (const view of views.slice(closed)) {
    view.unmount()
  }
  return lists
}

it('rereads only the shown bots on a change, however many views closed before it', async () => {
  expect(await readsOnChange(10, 1)).toBe(1)
  expect(await readsOnChange(100, 1)).toBe(1)
  // The closed views from the rounds above were forgotten, not kept to read again.
  expect(await readsOnChange(0, 0)).toBe(0)
})

it('rereads no shown bot on a change the host scoped to another bot', async () => {
  const elsewhere: BotChangeScope = { botIds: ['another-bot'], kinds: ['settings'] }
  expect(await readsOnChange(0, 10, elsewhere)).toBe(0)
  expect(await readsOnChange(0, 100, elsewhere)).toBe(0)
})

/** Checks a bot, closes its view, then sends a host change while the host does or doesn't list it. */
async function closeCheckedBot(id: string, stillListed: boolean) {
  const bot = { hostId: 'local' as const, id }
  const tools = renderHook(() => useBotTools(bot, 'check'))
  await waitFor(() => expect(tools.result.current.view).toMatchObject({ problems: { app: {} } }))
  tools.unmount()
  listed = stillListed ? [{ id }] : []
  lists = 0
  await act(async () => emitBotsChangedWindowEvent('local'))
  expect(lists).toBe(0)
  return renderHook(() => useBotTools(bot, 'finished'))
}

it("keeps a closed bot's finished check for the next badge, and rereads only its tools", async () => {
  const badge = await closeCheckedBot('checked', true)
  await waitFor(() =>
    expect(badge.result.current.view).toMatchObject({ problems: { app: { kind: 'sign-in' } } })
  )
  expect(lists).toBe(1)
})

it('forgets a closed bot the host no longer lists, finished check and all', async () => {
  const badge = await closeCheckedBot('checked-then-deleted', false)
  await waitFor(() => expect(badge.result.current.view).toMatchObject({ problems: {} }))
  expect(badge.result.current.view).not.toMatchObject({ problems: { app: {} } })
})
