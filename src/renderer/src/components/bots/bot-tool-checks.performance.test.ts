// @vitest-environment happy-dom
// Guards the bot tools reads fix: a host's bots change rereads only the bots a view still shows, so
// tools views opened and closed earlier cost the host no reads.
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { emitBotsChangedWindowEvent } from '@/lib/bots-changed-window-event'
import { useBotTools } from './bot-tool-checks'

let lists = 0
vi.mock('@/lib/bot-hosts', () => ({
  botRefKey: (bot: { hostId: string; id: string }) => `${bot.hostId}:${bot.id}`,
  isSameBot: (a: { hostId: string; id: string }, b: { hostId: string; id: string }) =>
    a.hostId === b.hostId && a.id === b.id,
  callBotRpc: async (_bot: unknown, method: string) => {
    if (method === 'bots.tools.list') {
      lists += 1
    }
    return { own: [] }
  }
}))
vi.mock('@/lib/bot-catalog', () => ({ useBots: () => [] }))

afterEach(cleanup)

let opened = 0
const viewOf = () => {
  const id = `bot-${opened++}`
  return renderHook(() => useBotTools({ hostId: 'local', id }, 'none'))
}

async function readsOnChange(closed: number, shown: number): Promise<number> {
  const views = Array.from({ length: closed + shown }, viewOf)
  await act(async () => {})
  for (const view of views.slice(0, closed)) {
    view.unmount()
  }
  lists = 0
  await act(async () => emitBotsChangedWindowEvent('local'))
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
