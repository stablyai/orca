import { describe, expect, it } from 'vitest'
import {
  botChatArchiveOrEmpty,
  canArchiveBotChat,
  isBotChatArchived,
  parseBotChatArchive,
  withBotChatArchive,
  type BotChatArchive
} from './bot-chat-archive'
import { botChatFoldKey, type BotChatTreeChat } from './bot-chat-tree'

function chat(chatId: string, extra: Partial<BotChatTreeChat> = {}): BotChatTreeChat {
  const running = extra.running ?? []
  const finished = extra.finished ?? []
  return {
    chatId,
    title: chatId,
    origin: 'side',
    live: 'idle',
    lastActiveAt: 100,
    unread: false,
    closed: false,
    running,
    runningTotal: running.length,
    finished,
    finishedTotal: finished.length,
    failedTotal: 0,
    ...extra
  }
}

function archivedAt(target: BotChatTreeChat, hostId = 'host-a', botId = 'bot-a'): BotChatArchive {
  return { [botChatFoldKey(hostId, botId, target.chatId)]: target.lastActiveAt }
}

describe('bot chat archive', () => {
  it('scopes one chat id by host and bot', () => {
    const target = chat('same')
    const entries = withBotChatArchive({}, 'host-a', 'bot-a', target, true)

    expect(isBotChatArchived(entries, 'host-a', 'bot-a', target)).toBe(true)
    expect(isBotChatArchived(entries, 'host-b', 'bot-a', target)).toBe(false)
    expect(isBotChatArchived(entries, 'host-a', 'bot-b', target)).toBe(false)
  })

  it('hides at the stored watermark and returns on newer settled activity', () => {
    const target = chat('settled')
    const entries = archivedAt(target)

    expect(isBotChatArchived(entries, 'host-a', 'bot-a', target)).toBe(true)
    expect(isBotChatArchived(entries, 'host-a', 'bot-a', { ...target, lastActiveAt: 99 })).toBe(
      true
    )
    expect(isBotChatArchived(entries, 'host-a', 'bot-a', { ...target, lastActiveAt: 101 })).toBe(
      false
    )
  })

  it.each([
    ['home', chat('home', { origin: 'home' })],
    ['replying', chat('replying', { live: 'replying' })],
    ['needs you', chat('needs-you', { live: 'needs-you' })],
    ['unread', chat('unread', { unread: true })],
    ['unseen', chat('unseen', { unseen: true })],
    [
      'running',
      chat('running', {
        running: [
          { key: 'w', title: 'worker', state: 'running', startedAt: 1 },
          { key: 'waiting', title: 'waiting', state: 'needs-you', startedAt: 1 }
        ],
        runningTotal: 2
      })
    ],
    ['terminal run', chat('run', { run: { automationId: 'automation', runId: 'run' } })]
  ])('never hides a %s row', (_name, target) => {
    const entries = archivedAt(target)

    expect(canArchiveBotChat(target)).toBe(false)
    expect(isBotChatArchived(entries, 'host-a', 'bot-a', target)).toBe(false)
    const empty: BotChatArchive = {}
    expect(withBotChatArchive(empty, 'host-a', 'bot-a', target, true)).toBe(empty)
  })

  it('restores only the exact key and leaves redundant writes unchanged', () => {
    const target = chat('target')
    const other = chat('other')
    const entries = {
      ...archivedAt(target),
      ...archivedAt(other, 'host-a', 'bot-a'),
      ...archivedAt(target, 'host-b', 'bot-a'),
      ...archivedAt(target, 'host-a', 'bot-b')
    }
    const restored = withBotChatArchive(entries, 'host-a', 'bot-a', target, false)

    expect(restored).toEqual({
      [botChatFoldKey('host-a', 'bot-a', 'other')]: other.lastActiveAt,
      [botChatFoldKey('host-b', 'bot-a', 'target')]: target.lastActiveAt,
      [botChatFoldKey('host-a', 'bot-b', 'target')]: target.lastActiveAt
    })
    expect(entries[botChatFoldKey('host-a', 'bot-a', 'target')]).toBe(target.lastActiveAt)

    const archived = withBotChatArchive({}, 'host-a', 'bot-a', target, true)
    expect(withBotChatArchive(archived, 'host-a', 'bot-a', target, true)).toBe(archived)
    expect(withBotChatArchive(archived, 'host-a', 'bot-a', other, false)).toBe(archived)
  })

  it('rejects malformed persisted input so callers fail open', () => {
    expect(parseBotChatArchive({ 'host\u0000bot\u0000chat': 100 })).toEqual({
      'host\u0000bot\u0000chat': 100
    })
    expect(parseBotChatArchive(null)).toBeNull()
    expect(parseBotChatArchive([])).toBeNull()
    expect(parseBotChatArchive({ chat: Number.NaN })).toBeNull()
    expect(parseBotChatArchive({ chat: Number.POSITIVE_INFINITY })).toBeNull()
    expect(parseBotChatArchive({ chat: '100' })).toBeNull()
    expect(parseBotChatArchive({ chat: { at: 100 } })).toBeNull()
    expect(botChatArchiveOrEmpty({ chat: Number.NaN })).toEqual({})
    expect(botChatArchiveOrEmpty({ chat: 100 })).toEqual({ chat: 100 })
  })
})
