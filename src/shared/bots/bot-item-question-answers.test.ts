import { describe, expect, it } from 'vitest'
import type { BotItem, BotItemEvent } from './bot-items'
import { botItemWaitingLine } from './bot-item-question-answers'

const BOT = { kind: 'bot', botId: 'bot', chatId: 'chat' } as const
const OWNER = { kind: 'owner' } as const
const HOSTS = 'Use these hostnames?'
const GO = 'Go ahead without a separate OK?'
const options = [{ label: 'Yes' }, { label: 'No' }]

function comment(id: string, actor: BotItemEvent['actor'], data: Record<string, unknown>, at = 1) {
  return { id, kind: 'commented', actor, data, at } as const satisfies BotItemEvent
}

function needsYou(id: string, at: number): BotItemEvent {
  return { id, kind: 'status', actor: BOT, data: { from: 'working', to: 'needs_you' }, at }
}

function item(
  status: BotItem['status'],
  questionId: string | null
): Pick<BotItem, 'question' | 'status'> {
  return { status, question: questionId ? { eventId: questionId, text: '' } : null }
}

const ask = comment('e1', BOT, {
  text: `${HOSTS}\n${GO}`,
  ask: { questions: [HOSTS, GO].map((prompt) => ({ prompt, options })) }
})
const firstAnswered = [ask, needsYou('e2', 1), comment('e3', OWNER, { text: `${HOSTS} → Yes` }, 2)]

describe('the line the comment box replies to', () => {
  it('is the next open line while the item still asks', () => {
    expect(botItemWaitingLine(item('needs_you', 'e1'), firstAnswered)?.line).toBe(GO)
  })

  it('is none once the item left Needs you with a line still open', () => {
    expect(botItemWaitingLine(item('working', null), firstAnswered)).toBeNull()
  })

  it('is none for a Needs you comment that asks nothing', () => {
    const events = [
      ...firstAnswered,
      comment('e4', OWNER, { text: `${GO} → Yes` }, 3),
      comment('e5', BOT, { text: 'Got it. Only the hostname question is left.' }, 4),
      needsYou('e6', 4)
    ]
    expect(botItemWaitingLine(item('needs_you', 'e5'), events)).toBeNull()
  })

  it('stays on an earlier ask left open after a later question and a Needs you with no ask', () => {
    const merge = 'Merge it?'
    const moved = (id: string, at: number, actor: BotItemEvent['actor'], cause?: string) =>
      ({
        id,
        kind: 'status',
        actor,
        data: { from: 'needs_you', to: 'working', ...(cause ? { cause } : {}) },
        at
      }) as const satisfies BotItemEvent
    const events = [
      ...firstAnswered,
      // An older host moved the item on with the first answer.
      moved('e4', 2, OWNER, 'answer'),
      comment('e5', BOT, { text: merge, ask: { questions: [{ prompt: merge, options }] } }, 3),
      needsYou('e6', 3),
      comment('e7', OWNER, { text: 'Yes', answers: 'e5' }, 4),
      moved('e8', 4, OWNER, 'answer'),
      comment('e9', BOT, { text: 'Only one question is left.' }, 5),
      needsYou('e10', 5)
    ]
    expect(botItemWaitingLine(item('needs_you', 'e9'), events)).toMatchObject({
      eventId: 'e1',
      line: GO
    })
    // The agent moving the item on itself ends the wait.
    expect(botItemWaitingLine(item('working', null), [...events, moved('e11', 6, BOT)])).toBeNull()
  })
})
