// @vitest-environment happy-dom
// A chat row's second line is never empty, so every row is the same height, and it names a teammate's chat.
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Bot } from '../../../../shared/bot-types'
import type { BotChatTreeChat } from '../../../../shared/bots/bot-chat-tree'
import { BotChatLine } from './BotChatTreeGroup'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the line reads only the name.
const BOT = { id: 'bot-1', name: 'Builder' } as unknown as Bot
const chat = (extra: Partial<BotChatTreeChat>): BotChatTreeChat => ({
  chatId: 'c1',
  title: 'Claude Chat',
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
  ...extra
})
const line = (entry: BotChatTreeChat, hidePerson = false) =>
  render(<BotChatLine bot={BOT} chat={entry} folded={false} liveAtEnd hidePerson={hidePerson} />)
    .container.textContent

afterEach(cleanup)

describe('a chat row’s second line', () => {
  it('says a chat with nothing said has no messages yet', () => {
    expect(line(chat({}))).toBe('No messages yet')
  })

  it('names a teammate after the place, unless a person is picked', () => {
    const alice = chat({
      origin: 'slack',
      originLabel: '#releases',
      preview: 'Three new crashes',
      person: { accountId: 'acc-alice', name: 'Alice Park' }
    })
    expect(line(alice)).toBe('#releases · Alice Park · Three new crashes')
    cleanup()
    expect(line(alice, true)).toBe('#releases · Three new crashes')
  })

  it('puts separators only between parts, for a replying chat with nothing said', () => {
    const replying = chat({
      live: 'replying',
      origin: 'slack',
      originLabel: '#orca',
      person: { accountId: 'acc-alice', name: 'Alice Park' }
    })
    expect(line(replying)).toBe('#orca · Alice Park')
    cleanup()
    expect(line(chat({ live: 'replying' }))).toBe('')
  })
})
