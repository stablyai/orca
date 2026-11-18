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
const worker = { id: 'bot-2', name: 'Triaged issues worker' }

describe('botGroupPeerLine', () => {
  it('names who asked whom', () => {
    expect(botGroupPeerLine(mail(2, worker, { requester: triage }))).toEqual({
      kind: 'asked',
      from: 'Triage bot',
      to: 'Triaged issues worker'
    })
  })

  it('says told, not asked, when the peer only sent status', () => {
    expect(botGroupPeerLine(mail(2, worker, { requester: { ...triage, told: true } }))).toEqual({
      kind: 'told',
      from: 'Triage bot',
      to: 'Triaged issues worker'
    })
  })

  it('names whose reply the asker read, from the stored peer', () => {
    expect(botGroupPeerLine(mail(3, triage, { answeredBy: worker }))).toEqual({
      kind: 'read',
      reader: 'Triage bot',
      peer: 'Triaged issues worker'
    })
  })

  it('says a plain follow-up for a row with no stored peer, whatever the loaded room shows', () => {
    // An older row, or a worker report: earlier asks in the room never name its peer.
    expect(botGroupPeerLine(mail(3, triage, { text: LEGACY }))).toEqual({
      kind: 'followed',
      bot: 'Triage bot'
    })
    expect(botGroupPeerLine(mail(4, triage, { text: 'Triage bot followed up' }))).toEqual({
      kind: 'followed',
      bot: 'Triage bot'
    })
  })
})
