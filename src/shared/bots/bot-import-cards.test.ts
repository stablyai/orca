import { describe, expect, it } from 'vitest'
import { structuredAgentSessionStatusBlock } from '../agent-session/view/structured-agent-session-status-block'
import {
  botImportAnswer,
  botImportDoneBody,
  botImportPlanBody,
  botImportPlanOf
} from './bot-import-cards'

const plan = {
  botId: 'b1',
  app: 'OpenClaw',
  name: 'Molty',
  items: [
    { group: 'comes' as const, what: 'Who Molty is', to: 'Soul', why: 'From its persona.' },
    { group: 'changed' as const, what: '41 daily notes', to: '6 topics', why: 'Condensed.' },
    { group: 'stays' as const, what: 'Telegram', why: 'Not available here yet.' }
  ]
}

describe('bot import plan', () => {
  it('answers with everything, or names what the owner left out', () => {
    expect(botImportAnswer(plan, new Set())).toBe('Import all of it.')
    expect(botImportAnswer(plan, new Set([1]))).toBe('Import it, but leave out: 41 daily notes.')
  })

  it('keeps readable plan text and card data after serialization', () => {
    const body = botImportPlanBody(plan)
    const parsed: typeof body = JSON.parse(JSON.stringify(body))
    expect(parsed.text.split('\n')).toEqual(
      expect.arrayContaining([
        '- Who Molty is → Soul: From its persona.',
        '- 41 daily notes → 6 topics: Condensed.',
        '- Telegram: Not available here yet.'
      ])
    )
    expect(structuredAgentSessionStatusBlock(parsed)).toMatchObject({ botImportPlan: plan })
    const done = {
      botId: 'b1',
      app: 'OpenClaw',
      name: 'Molty',
      created: [],
      stayed: [],
      paused: 0
    }
    expect(structuredAgentSessionStatusBlock(botImportDoneBody(done))).toMatchObject({
      botImportDone: done
    })
  })

  it('ignores a plan this build cannot read', () => {
    const broken = { ...botImportPlanBody(plan), botImportPlan: { botId: 'b1' } }
    expect(botImportPlanOf(broken)).toBeNull()
  })
})
