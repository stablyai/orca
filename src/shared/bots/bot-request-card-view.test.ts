import { describe, expect, it } from 'vitest'
import type { BotRequestCard, BotRequestCardOutcome } from './bot-request-card'
import { BOT_REQUEST_CARD_COPY, botRequestCardView } from './bot-request-card-view'

const say = (id: keyof typeof BOT_REQUEST_CARD_COPY) => BOT_REQUEST_CARD_COPY[id]

function badge(
  card: Partial<BotRequestCard>,
  outcome: BotRequestCardOutcome,
  activity = ''
): string | null {
  const full: BotRequestCard = {
    toBotId: 'b1',
    toBotName: 'Design',
    purpose: 'question',
    subject: 'Tone',
    messageId: 'm1',
    ...card
  }
  return botRequestCardView(full, { outcome, answer: null }, activity, say).badge
}

describe('botRequestCardView badge', () => {
  it('marks a request Orca did not send as failed, whatever the reading says', () => {
    expect(badge({ messageId: undefined, refusal: 'bot_paused' }, null)).toBe('failed')
    expect(badge({ messageId: undefined }, 'answered', 'working')).toBe('failed')
  })

  it('spins only while the asked chat is working on a sent request', () => {
    expect(badge({}, null, 'working')).toBe('running')
    expect(badge({ purpose: 'handoff' }, null, '')).toBe('running')
    expect(badge({}, null, 'permission')).toBeNull()
    expect(badge({}, 'answered', 'working')).toBeNull()
    expect(badge({}, 'posted')).toBeNull()
    expect(badge({}, 'unanswered')).toBeNull()
    expect(badge({}, 'dropped')).toBeNull()
    expect(badge({ purpose: 'handoff' }, 'unanswered', 'working')).toBeNull()
  })
})
