import { describe, expect, it } from 'vitest'
import {
  nativeChatBotCardOf,
  nativeChatBotCardsOf,
  nativeChatBotDirectiveCardOf,
  nativeChatBotMessageCardOf
} from './native-chat-bot-card-kind'
import { structuredAgentSessionStatusBlock } from '../../agent-session/view/structured-agent-session-status-block'

const request = { toBotId: 'd', toBotName: 'D', purpose: 'question' as const, subject: 's' }
const note = { botId: 'b', added: ['x'], removed: [], topics: [], otherChanges: 0 }

describe('bot card readers', () => {
  it('names the card a status line carries, the first in reading order', () => {
    expect(nativeChatBotCardOf({ botRequest: request })).toEqual({
      kind: 'botRequest',
      value: request
    })
    expect(nativeChatBotCardOf({ botMemoryUpdated: note, botRequest: request })).toEqual({
      kind: 'memoryUpdated',
      value: note
    })
    expect(nativeChatBotCardOf({})).toBeNull()
  })

  it('keeps every card of a mixed status line, for each client to pick its own kinds', () => {
    const offer = { botId: 'b', source: 'github' as const }
    const plan = {
      botId: 'b',
      app: 'Other',
      name: 'Molty',
      items: [{ group: 'comes' as const, what: 'Who Molty is', to: 'Soul', why: 'Its persona.' }]
    }
    // A newer host can send a bot request purpose this client cannot read.
    const status = {
      kind: 'status' as const,
      text: 'Memory updated',
      botMemoryUpdated: note,
      connectorOffer: offer,
      botImportPlan: plan,
      botRequest: { ...request, purpose: 'delegate' }
    }
    const block = structuredAgentSessionStatusBlock(status)
    expect(block).toMatchObject({
      botMemoryUpdated: note,
      connectorOffer: offer,
      botImportPlan: plan
    })
    expect(block).not.toHaveProperty('botRequest')
    expect(nativeChatBotCardsOf(block).map((card) => card.kind)).toEqual([
      'memoryUpdated',
      'connectorOffer',
      'importPlan'
    ])
    // The desktop draws the first; the phone's notice row still finds the offer.
    expect(nativeChatBotCardOf(block)?.kind).toBe('memoryUpdated')
  })

  it('reads message and directive cards through their own tables', () => {
    const toolAdded = {
      botId: 'b',
      tool: { name: 'gh', detail: 'gh mcp', remote: false },
      addedAt: 1
    }
    expect(nativeChatBotMessageCardOf({ toolAdded })).toEqual({
      kind: 'toolAdded',
      value: toolAdded
    })
    expect(nativeChatBotMessageCardOf({})).toBeNull()
    expect(nativeChatBotDirectiveCardOf('::orca-webhook{hook="wh_7Kx2pQ9mT4vB8nLc"}')).toEqual({
      kind: 'webhook',
      value: { hookId: 'wh_7Kx2pQ9mT4vB8nLc' }
    })
    expect(nativeChatBotDirectiveCardOf('::orca-visual{file="a.svg"}')).toBeNull()
  })
})
