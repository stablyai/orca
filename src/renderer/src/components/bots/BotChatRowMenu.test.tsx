// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import type { BotChatTreeChat } from '../../../../shared/bots/bot-chat-tree'

const calls = vi.hoisted(() => ({ deleteChat: vi.fn(async () => true) }))
vi.mock('@/lib/agent-session/chat-deletion/orca-chat-delete', () => ({
  useDeleteOrcaChat: () => calls.deleteChat,
  useOrcaChatDeleteHostReason: () => null
}))

import { BotChatMoreButton } from './BotChatRowMenu'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the menu reads only the bot's host id.
const bot = { id: 'bot-1', hostId: 'local' } as Bot
const chat: BotChatTreeChat = {
  chatId: 'chat-1',
  title: 'Side chat',
  origin: 'side',
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

it('deleting from the row menu never also opens the chat the row stands for', () => {
  const openRow = vi.fn()
  render(
    <div role="button" onClick={openRow} onKeyDown={openRow}>
      <BotChatMoreButton bot={bot} chat={chat} onOpen={vi.fn()} />
    </div>
  )
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Chat actions' }), {
    button: 0,
    ctrlKey: false
  })

  fireEvent.click(screen.getByRole('menuitem', { name: 'Delete chat' }))

  expect(calls.deleteChat).toHaveBeenCalledWith({ hostId: 'local', sessionId: 'chat-1' })
  expect(openRow).not.toHaveBeenCalled()
})
