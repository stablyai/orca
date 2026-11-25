// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { BotChatTreeChat } from '../../../../shared/bots/bot-chat-tree'
import { BOT_SIDEBAR_OLDER_AFTER_MS } from '../../../../shared/bots/bot-sidebar-older-chats'
import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { useBotSidebarOlder } from './use-bot-sidebar-older'

const BOT = { hostId: 'local', id: 'reviewer', folderWorkspaceId: 'reviewer-home' }
const HOME = folderWorkspaceKey(BOT.folderWorkspaceId)
const DAY_AGO = Date.now() - BOT_SIDEBAR_OLDER_AFTER_MS - 60_000

function chat(chatId: string, overrides: Partial<BotChatTreeChat> = {}): BotChatTreeChat {
  return {
    chatId,
    title: chatId,
    origin: 'side',
    live: 'idle',
    lastActiveAt: DAY_AGO,
    unread: false,
    closed: false,
    tab: true,
    running: [],
    runningTotal: 0,
    finished: [],
    finishedTotal: 0,
    failedTotal: 0,
    ...overrides
  }
}

const views = (chats: BotChatTreeChat[]) =>
  chats.map((entry) => ({ chat: entry, open: false, lines: [] }))
const ids = (list: { chat: BotChatTreeChat }[]) => list.map((view) => view.chat.chatId)

let initial: ReturnType<typeof useAppStore.getState>
beforeEach(() => {
  initial = useAppStore.getState()
  // The fold choice is saved through the preload bridge.
  vi.stubGlobal('api', { ...window.api, ui: { ...window.api?.ui, set: vi.fn(async () => {}) } })
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
  vi.unstubAllGlobals()
})

describe('useBotSidebarOlder', () => {
  it('folds settled day-old chats, folded by default, and opens and folds again', () => {
    const { result } = renderHook(() =>
      useBotSidebarOlder(BOT, views([chat('home', { origin: 'home' }), chat('a'), chat('b')]), null)
    )
    expect(ids(result.current.recent)).toEqual(['home'])
    expect(ids(result.current.older)).toEqual(['a', 'b'])
    expect(result.current.showOlder).toBe(false)
    act(() => result.current.toggleOlder())
    expect(result.current.showOlder).toBe(true)
    act(() => result.current.toggleOlder())
    expect(result.current.showOlder).toBe(false)
  })

  it('brings a chat back up the moment it replies, while the rest stay folded', () => {
    let chats = [chat('a'), chat('b'), chat('c')]
    const { result, rerender } = renderHook(() => useBotSidebarOlder(BOT, views(chats), null))
    expect(ids(result.current.older)).toEqual(['a', 'b', 'c'])
    chats = [chat('a', { live: 'replying' }), chat('b'), chat('c')]
    rerender()
    expect(ids(result.current.recent)).toEqual(['a'])
    expect(ids(result.current.older)).toEqual(['b', 'c'])
  })

  it('keeps the chat whose tab is in front, and one focused within the day', () => {
    useAppStore.setState({
      activeWorktreeId: HOME,
      activeWorkspaceKey: HOME,
      unifiedTabsByWorktree: {
        [HOME]: [
          {
            id: 'tab-b',
            entityId: 'b',
            groupId: 'g',
            worktreeId: HOME,
            contentType: 'agent-session',
            label: 'b',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: DAY_AGO,
            lastFocusedAt: Date.now() - 1000
          }
        ]
      }
    })
    const { result } = renderHook(() =>
      useBotSidebarOlder(BOT, views([chat('a'), chat('b'), chat('c')]), null)
    )
    expect(ids(result.current.recent)).toEqual(['b'])
    expect(ids(result.current.older)).toEqual(['a', 'c'])
  })

  it('folds nothing away under the pointer: rows shown stay until it leaves', () => {
    let chats = [chat('a', { live: 'replying' }), chat('b', { live: 'replying' }), chat('c')]
    const { result, rerender } = renderHook(() => useBotSidebarOlder(BOT, views(chats), null))
    expect(ids(result.current.recent)).toEqual(['a', 'b', 'c'])
    act(() => result.current.hold.onPointerEnter())
    chats = [chat('a'), chat('b'), chat('c')]
    rerender()
    expect(ids(result.current.recent)).toEqual(['a', 'b', 'c'])
    act(() => result.current.hold.onPointerLeave())
    expect(ids(result.current.older)).toEqual(['a', 'b', 'c'])
  })
})
