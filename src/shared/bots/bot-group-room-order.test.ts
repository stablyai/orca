import { expect, it } from 'vitest'
import { botGroupRoomOrder } from './bot-group-room-order'
import type { BotGroupTurn } from './bot-group-schema'

const mailboxTurn: BotGroupTurn = {
  operationId: 'mail-turn',
  botId: 'bot',
  botName: 'Scout',
  avatar: null,
  agent: 'claude',
  sessionId: 'scout',
  mailbox: true
}

it('places completed worker and item mail after posts made while those turns were running', () => {
  const messages = [
    { id: 'first-post', sequence: 1, turns: [] },
    { id: 'second-post', sequence: 2, turns: [] },
    {
      id: 'worker-mail',
      sequence: 3,
      rootRequestId: 'first-post',
      rootSequence: 1,
      mailReplyOrder: { after: 6, reply: 20 },
      turns: [mailboxTurn]
    },
    {
      id: 'item-mail',
      sequence: 4,
      mailReplyOrder: { after: 6, reply: 19 },
      turns: [mailboxTurn]
    },
    {
      id: 'peer-mail',
      sequence: 5,
      rootRequestId: 'first-post',
      rootSequence: 1,
      requester: { id: 'peer', name: 'Peer' },
      turns: [mailboxTurn]
    },
    { id: 'third-post', sequence: 6, turns: [] }
  ]

  expect(botGroupRoomOrder(messages).map(({ id }) => id)).toEqual([
    'first-post',
    'peer-mail',
    'second-post',
    'third-post',
    'item-mail',
    'worker-mail'
  ])
})
