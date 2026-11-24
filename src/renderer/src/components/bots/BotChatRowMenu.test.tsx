// @vitest-environment happy-dom
// A bot chat row's one menu: Open, End chat for a side chat whose host can end it, then Delete chat,
// the same from a right-click, the keyboard and the row's ⋯; ending a chat moves focus to the next row.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import type { BotChatTreeChat } from '../../../../shared/bots/bot-chat-tree'

const host = vi.hoisted(() => ({ endsChats: true }))
const ended = vi.hoisted(() => vi.fn(async (_bot: unknown, _chatId: string) => true))

vi.mock('@/lib/bot-host-status', () => ({ useBotHostHas: () => host.endsChats }))
vi.mock('@/lib/agent-session/chat-deletion/orca-chat-delete', () => ({
  useDeleteOrcaChat: () => vi.fn(),
  useOrcaChatDeleteHostReason: () => null
}))
vi.mock('./bot-chat-end', () => ({ endBotChatFromRow: ended }))

const { BotChatContextMenu, BotChatMoreButton } = await import('./BotChatRowMenu')
const { BOT_CHAT_ROW_ATTRIBUTE, openRowMenuFromKeyboard } = await import('./BotChatEndMenu')

const BOT: Bot = {
  id: 'bot-1',
  name: 'Gardener',
  hostId: 'local',
  folder: 'gardener',
  folderWorkspaceId: 'w1',
  agent: 'codex',
  avatar: null,
  paused: false,
  permissionMode: 'ask',
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: 'home',
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}

function chat(chatId: string, origin: BotChatTreeChat['origin'] = 'side'): BotChatTreeChat {
  return {
    chatId,
    title: chatId,
    origin,
    live: 'idle',
    lastActiveAt: 1,
    unread: false,
    closed: false,
    running: [],
    runningTotal: 0,
    finished: [],
    finishedTotal: 0,
    failedTotal: 0
  }
}

/** Two rows, as the sidebar lists them: each a focus stop that opens the menu from the keyboard. */
function rows(first: BotChatTreeChat, second = chat('Compost notes')): void {
  render(
    <>
      {[first, second].map((row) => (
        <BotChatContextMenu key={row.chatId} bot={BOT} chat={row} onOpen={vi.fn()}>
          <div
            role="button"
            tabIndex={0}
            aria-label={row.title}
            {...{ [BOT_CHAT_ROW_ATTRIBUTE]: '' }}
            onKeyDown={(event) => openRowMenuFromKeyboard(event)}
          >
            {row.title}
            <BotChatMoreButton bot={BOT} chat={row} onOpen={vi.fn()} />
          </div>
        </BotChatContextMenu>
      ))}
    </>
  )
}

function items(): string[] {
  return screen.getAllByRole('menuitem').map((item) => item.textContent ?? '')
}

beforeEach(() => {
  host.endsChats = true
  ended.mockClear()
})
afterEach(cleanup)

describe('a bot chat row menu', () => {
  it('offers Open, End chat, then Delete chat on a right-click', () => {
    rows(chat('Water the lawn'))
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Water the lawn' }))

    expect(items()).toEqual(['Open', 'End chat', 'Delete chat'])
  })

  it('offers no End chat on a host that cannot end chats, or on the Home Chat', () => {
    host.endsChats = false
    rows(chat('Water the lawn'))
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Water the lawn' }))
    expect(items()).toEqual(['Open', 'Delete chat'])
    cleanup()

    host.endsChats = true
    rows(chat('Home', 'home'))
    fireEvent.contextMenu(screen.getByRole('button', { name: 'Home' }))
    expect(items()).toEqual(['Open'])
  })

  it('opens the same menu from Shift+F10, and ending the chat moves focus to the next row', async () => {
    rows(chat('Water the lawn'))
    const row = screen.getByRole('button', { name: 'Water the lawn' })
    row.focus()
    fireEvent.keyDown(row, { key: 'F10', shiftKey: true })
    fireEvent.click(screen.getByRole('menuitem', { name: 'End chat' }))

    expect(ended).toHaveBeenCalledWith(BOT, 'Water the lawn')
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Compost notes' }))
    )
  })

  it('offers End chat from the row ⋯ too, and moves focus on from there', async () => {
    rows(chat('Water the lawn'))
    const more = screen.getAllByRole('button', { name: 'Chat actions' })[0]!
    fireEvent.pointerDown(more, { button: 0, pointerType: 'mouse' })

    expect(items()).toEqual(['Open', 'End chat', 'Delete chat'])
    fireEvent.click(screen.getByRole('menuitem', { name: 'End chat' }))
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Compost notes' }))
    )
  })
})
