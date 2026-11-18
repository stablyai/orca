// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as BotHosts from '@/lib/bot-hosts'

const rpc = vi.hoisted(() => ({ calls: 0 }))
vi.mock('@/lib/bot-hosts', async (importOriginal) => ({
  ...(await importOriginal<typeof BotHosts>()),
  callBotRpc: async () => {
    rpc.calls += 1
    // A fresh answer each time, with the same rows.
    return { chats: [{ chatId: 'c1' }] }
  }
}))

import { emitBotsChangedWindowEvent } from '@/lib/bots-changed-window-event'
import { useBotMentionChatsReads, useBotMentionChatsWatch } from './bot-mention-chats-read'

const BOTS = [{ hostId: 'local' as const, id: 'bot-a' }]
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)))

function useComposer(caller: string, watched: typeof BOTS) {
  const reads = useBotMentionChatsReads(caller)
  useBotMentionChatsWatch(watched, caller)
  return reads(BOTS[0])
}

afterEach(() => {
  cleanup()
  rpc.calls = 0
})

describe('@-mention chat reads', () => {
  it("drops a chat's reads once its last composer closes", async () => {
    const open = renderHook(() => useComposer('chat-1', BOTS))
    await flush()
    expect(open.result.current?.status).toBe('ready')
    open.unmount()
    const reopened = renderHook(() => useComposer('chat-1', []))
    expect(reopened.result.current).toBeNull()
  })

  it("re-renders a composer for its own chat's reads only, and not for an answer that repeats", async () => {
    let renders = 0
    renderHook(() => {
      renders += 1
      return useComposer('chat-1', BOTS)
    })
    await flush()
    const settled = renders
    // Another chat's composer reads the same bot.
    renderHook(() => useComposer('chat-2', BOTS))
    await flush()
    expect(renders).toBe(settled)
    // The bot's chats change, but the answer is the same rows.
    const calls = rpc.calls
    act(() => emitBotsChangedWindowEvent('local', { botIds: ['bot-a'], kinds: ['chats'] }))
    await flush()
    expect(rpc.calls).toBe(calls + 2)
    expect(renders).toBe(settled)
  })
})
