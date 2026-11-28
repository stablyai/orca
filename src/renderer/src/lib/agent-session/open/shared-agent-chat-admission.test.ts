// @vitest-environment happy-dom
// For a shared agent, unknown never means mine: the open path places only this viewer's own chats in
// its tabs (and marks only those seen), whatever entry asked. An agent shared with no one is unchanged.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotChatTreeChat } from '../../../../../shared/bots/bot-chat-tree'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { openBotSession } from '@/components/bots/bot-session-open'
import {
  useViewedTabList,
  viewTabList,
  type ViewedTabList
} from '@/components/bots/teammate-tabs/viewed-tab-list'
import { renderHook } from '@testing-library/react'
import type * as BotHosts from '@/lib/bot-hosts'
import type * as BotCatalog from '@/lib/bot-catalog'
import { openBotHomeTab } from '@/lib/bot-catalog'
import { claimChatMadeHere } from './shared-agent-chat-admission'
import { makeTestBot } from '../../../../../main/bots/bot.test-fixture'

// The agent's host: its chat list (whose each chat is), and every call that would place a chat in
// this window's tabs (`agentSession.reveal`) or mark one seen (`bots.chats.seen`).
const host = vi.hoisted(() => {
  const bots: Bot[] = []
  const rows: Record<string, unknown> = {}
  return { bots, rows, down: false, reveal: vi.fn(), seen: vi.fn() }
})
vi.mock('@/lib/bot-hosts', async (importOriginal) => ({
  ...(await importOriginal<typeof BotHosts>()),
  callBotRpc: async (
    _bot: unknown,
    method: string,
    params: { chatId?: string; sessionIds?: string[] }
  ) => {
    if (method === 'bots.chats.seen') {
      host.seen(params.sessionIds)
      return null
    }
    if (host.down) {
      throw new Error('unreachable')
    }
    const row = params.chatId ? host.rows[params.chatId] : undefined
    return { chats: row ? [row] : [], workspaceChats: {} }
  }
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  callRuntimeRpc: async (
    _target: unknown,
    method: string,
    params: { sessionId?: string; address?: string }
  ) => {
    if (method === 'agentSession.reveal') {
      host.reveal(params.sessionId)
      return { ok: false, refusal: { code: 'agent_session_identity_required' } }
    }
    if (method === 'orchestration.partyLocation' || method === 'orchestration.partyOpen') {
      // The host finds the chat in the agent's Home.
      const sessionId = params.address?.replace('orca_session_id:', '') ?? ''
      return { location: { kind: 'chat', sessionId, worktreeId: 'folder:home-1' } }
    }
    return null
  }
}))
vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
  refreshLocalStructuredSessionWorktreeTabs: async () => {}
}))
vi.mock('@/lib/bot-catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof BotCatalog>()),
  readBots: () => host.bots,
  readBotsEnabled: () => true,
  openBotHome: () => true
}))

const MATE = { accountId: 'acc-mate', name: 'Mate Park' }
const HOME = folderWorkspaceKey('home-1')
const unshared = makeTestBot({
  id: 'bot-1',
  name: 'Helper',
  folderWorkspaceId: 'home-1',
  chatSessionId: 'owner-home'
})
const shared = makeTestBot({
  ...unshared,
  shares: [
    {
      kind: 'account',
      shareId: 's1',
      accountId: MATE.accountId,
      name: MATE.name,
      email: 'mate@example.com',
      addedAt: 1,
      acceptedAt: 2
    }
  ]
})

function row(chatId: string, person?: typeof MATE): BotChatTreeChat {
  return {
    chatId,
    title: 'Chat',
    origin: 'side',
    live: 'idle',
    lastActiveAt: 1,
    unread: false,
    closed: false,
    running: [],
    runningTotal: 0,
    finished: [],
    finishedTotal: 0,
    failedTotal: 0,
    ...(person ? { person } : {})
  }
}

function viewed(): ViewedTabList | null {
  return renderHook(() => useViewedTabList(HOME)).result.current
}

/** Opens a chat the way an item link, Needs you row, Session History or a sender chip ends up doing. */
async function open(bot: Bot, sessionId: string): Promise<void> {
  host.bots = [bot]
  openBotSession(bot, sessionId)
  await vi.waitFor(() =>
    expect(host.reveal.mock.calls.length + (viewed() ? 1 : 0)).toBeGreaterThan(0)
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  host.down = false
  for (const key of Object.keys(host.rows)) {
    delete host.rows[key]
  }
})
afterEach(() => {
  viewTabList(HOME, null)
  vi.clearAllMocks()
})

it('shows a teammate’s chat in the view of their tabs, never placing it here or marking it seen', async () => {
  host.rows['mate-side'] = row('mate-side', MATE)
  await open(shared, 'mate-side')
  expect(viewed()).toEqual({
    person: { accountId: MATE.accountId },
    picked: { sessionId: 'mate-side' }
  })
  expect(host.reveal).not.toHaveBeenCalled()
  expect(host.seen).not.toHaveBeenCalled()
})

it.each([
  ['the host lists no such chat yet', false],
  ['the host can’t be read', true]
])('shows a chat to read alone when %s', async (_label, down) => {
  host.down = down
  await open(shared, 'someone-side')
  expect(viewed()).toEqual({ person: null, picked: { sessionId: 'someone-side' } })
  expect(host.reveal).not.toHaveBeenCalled()
  expect(host.seen).not.toHaveBeenCalled()
})

it('places this viewer’s own chats: one the host says is theirs, their Home, one made here', async () => {
  host.rows['own-side'] = row('own-side')
  // Opened while this window shows Mate's tabs: its own tabs show again.
  viewTabList(HOME, { accountId: MATE.accountId })
  await open(shared, 'own-side')
  expect(viewed()).toBeNull()
  await open(shared, 'owner-home')
  await open(shared, claimChatMadeHere('just-made'))
  expect(host.reveal.mock.calls).toEqual([['own-side'], ['owner-home'], ['just-made']])
  expect(viewed()).toBeNull()
})

it('places any chat of an agent shared with no one, as before', async () => {
  await open(unshared, 'any-side')
  expect(host.reveal).toHaveBeenCalledWith('any-side')
  expect(viewed()).toBeNull()
})

it('shows this window’s own tabs again when it opens its own Home', async () => {
  host.bots = [shared]
  viewTabList(HOME, { accountId: MATE.accountId })
  void openBotHomeTab(shared).catch(() => false)
  expect(viewed()).toBeNull()
})
