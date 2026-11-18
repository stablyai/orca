import { describe, expect, it } from 'vitest'
import type { BotGroupMessage } from './bot-group-schema'
import { botGroupPeerLine } from './bot-group-peer-line'

const LEGACY = 'Continued on an explicit peer request'

function mail(
  sequence: number,
  author: { id: string; name: string },
  over: Partial<BotGroupMessage> = {}
): BotGroupMessage {
  return {
    id: `mail-${sequence}`,
    groupId: 'group-1',
    sequence,
    author: { kind: 'bot', ...author },
    text: '',
    createdAt: sequence,
    rootRequestId: 'human-1',
    rootSequence: 1,
    turns: [
      {
        operationId: `op-${sequence}`,
        botId: author.id,
        botName: author.name,
        avatar: null,
        agent: 'claude',
        sessionId: `bot-group-member-${author.id}`,
        mailbox: true
      }
    ],
    ...over
  }
}

const triage = { id: 'bot-1', name: 'Triage bot' }
describe('botGroupPeerLine', () => {
  it('says a plain follow-up for a legacy row with no stored peer', () => {
    // An older row, or a worker report: earlier asks in the room never name its peer.
    expect(botGroupPeerLine(mail(3, triage, { text: LEGACY }))).toEqual({
      kind: 'followed',
      bot: 'Triage bot'
    })
  })
})
