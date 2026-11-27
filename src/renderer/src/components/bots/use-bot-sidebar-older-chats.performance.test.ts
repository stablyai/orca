// @vitest-environment happy-dom
// Guards STA-18288 (follow-up to #48722): a bot list waits on the older-chat clock only while some fold
// time is still ahead, so a Home-only list, or one whose fold times have all passed, holds no timer.
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BotChatTreeChat } from '../../../../shared/bots/bot-chat-tree'
import type { BotSidebarChatView } from '../../../../shared/bots/bot-sidebar-tree'
import type { Worktree } from '../../../../shared/worktree/types'
import { useBotSidebarOlderChats } from './use-bot-sidebar-older-chats'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

function chat(chatId: string, extra: Partial<BotChatTreeChat>): BotChatTreeChat {
  return {
    chatId,
    title: chatId,
    origin: 'side',
    live: 'idle',
    lastActiveAt: NOW - HOUR,
    unread: false,
    closed: false,
    tab: true,
    running: [],
    runningTotal: 0,
    finished: [],
    finishedTotal: 0,
    failedTotal: 0,
    ...extra
  }
}

const BOT = { hostId: 'local', folderWorkspaceId: 'bot-home' } as const
const NO_WORKSPACES: Worktree[] = []
const NO_CHILDREN = new Map<string, Worktree[]>()
const NO_LINES = new Set<string>()
const NO_CHATS = {}

/** Timers the list holds once mounted with these chats. */
function timersFor(chats: BotChatTreeChat[]): number {
  const views = chats.map((read): BotSidebarChatView<Worktree> => ({
    chat: read,
    foldable: false,
    open: false,
    trailing: null,
    lines: [],
    paging: null,
    steps: 0
  }))
  const { unmount } = renderHook(() =>
    useBotSidebarOlderChats({
      bot: BOT,
      entryKey: 'bot',
      views,
      readChats: chats,
      workspaces: NO_WORKSPACES,
      workspaceChats: NO_CHATS,
      lineageChildrenByParentIdentity: NO_CHILDREN,
      liveLineIds: NO_LINES,
      activeLineId: null,
      reveal: null,
      front: null,
      fresh: true,
      held: false
    })
  )
  const count = vi.getTimerCount()
  unmount()
  return count
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('holds no clock without a fold time ahead, and one while a fold time is ahead', () => {
  expect(timersFor([chat('home', { origin: 'home' })])).toBe(0)
  expect(timersFor([chat('old', { lastActiveAt: NOW - 48 * HOUR })])).toBe(0)
  expect(timersFor([chat('recent', {})])).toBe(1)
})
