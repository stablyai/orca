import { expect, it } from 'vitest'
import { matchBotChats } from './bot-chat-search'

it('matches a group room session only by its workers, never its own title or text', () => {
  const room = 'bot-group-member-1'
  const chats = [
    { chatId: room, title: 'Release room', preview: 'release plan' },
    { chatId: 'side', title: 'Release notes draft' }
  ]
  const workers = [{ key: 'w1', chatId: room, title: 'Release notes' }]

  expect(matchBotChats(chats, workers, 'release', { contentChatIds: new Set([room]) })).toEqual({
    matches: [
      { chatId: room, workerKeys: ['w1'] },
      { chatId: 'side', workerKeys: null }
    ],
    more: 0
  })
  // A room whose only hit is its own title takes no place under the limit.
  expect(matchBotChats(chats, [], 'release', { limit: 1 })).toEqual({
    matches: [{ chatId: 'side', workerKeys: null }],
    more: 0
  })
})
