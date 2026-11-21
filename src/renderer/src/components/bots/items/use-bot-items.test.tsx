// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItemsRead } from './use-bot-items'
import type * as BotHosts from '@/lib/bot-hosts'

type Call = { method: string; params: unknown; resolve: (value: unknown) => void }
const rpc = vi.hoisted((): { calls: Call[] } => ({ calls: [] }))
vi.mock('@/lib/bot-hosts', async (importOriginal) => ({
  ...(await importOriginal<typeof BotHosts>()),
  callBotRpc: (_bot: unknown, method: string, params: unknown) =>
    new Promise((resolve) => rpc.calls.push({ method, params, resolve }))
}))

import { emitBotsChangedWindowEvent } from '@/lib/bots-changed-window-event'
import { useBotChatItems } from './use-bot-items'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the reads use only these fields.
const BOT = { id: 'bot-1', hostId: 'local', folderWorkspaceId: 'fw-1', chatSessionId: null } as Bot

const listReads = () => rpc.calls.filter((call) => call.method === 'bots.items.owner.list')
const flush = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)))
const notice = (kinds: ('items' | 'workers')[]) =>
  act(() => emitBotsChangedWindowEvent('local', { botIds: [BOT.id], kinds }))

function listOf(...uids: string[]): BotItemsRead {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the hook only hands the read on.
  return {
    items: uids.map((uid) => ({ uid })),
    counts: {},
    seenEventId: 'e0'
  } as unknown as BotItemsRead
}

afterEach(() => {
  cleanup()
  rpc.calls.length = 0
})

describe('useBotChatItems', () => {
  it('keeps one read out: notices during it share one more, and the newest list shows', async () => {
    const view = renderHook(() => useBotChatItems(BOT, ['chat-1']))
    expect(listReads()).toHaveLength(1)
    notice(['items'])
    notice(['items'])
    notice(['workers'])
    expect(listReads()).toHaveLength(1)
    await act(async () => listReads()[0].resolve(listOf('old')))
    await flush()
    expect(listReads()).toHaveLength(2)
    expect(view.result.current.read?.items.map((item) => item.uid)).toEqual(['old'])
    await act(async () => listReads()[1].resolve(listOf('new')))
    await flush()
    expect(listReads()).toHaveLength(2)
    expect(view.result.current.read?.items.map((item) => item.uid)).toEqual(['new'])
  })
})
