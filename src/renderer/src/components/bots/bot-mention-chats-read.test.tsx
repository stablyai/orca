// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as BotHosts from '@/lib/bot-hosts'

vi.mock('@/lib/bot-hosts', async (importOriginal) => ({
  ...(await importOriginal<typeof BotHosts>()),
  callBotRpc: async () => ({ chats: [{ chatId: 'c1' }] })
}))

import { useBotMentionChatsReads, useBotMentionChatsWatch } from './bot-mention-chats-read'

const BOTS = [{ hostId: 'local' as const, id: 'bot-a' }]
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)))

function useComposer(caller: string, watched: typeof BOTS) {
  const reads = useBotMentionChatsReads(caller)
  useBotMentionChatsWatch(watched, caller)
  return reads(BOTS[0])
}

afterEach(cleanup)

describe('@-mention chat reads', () => {
  it("drops a chat's reads once its last composer closes", async () => {
    const open = renderHook(() => useComposer('chat-1', BOTS))
    await flush()
    expect(open.result.current?.status).toBe('ready')
    open.unmount()
    const reopened = renderHook(() => useComposer('chat-1', []))
    expect(reopened.result.current).toBeNull()
  })
})
