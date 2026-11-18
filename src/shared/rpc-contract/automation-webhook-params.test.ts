import { describe, expect, it } from 'vitest'
import { EVENT_ONLY_SCHEDULE } from '../automation-event-triggers'
import { AutomationCreate, AutomationUpdate } from './automations/automation-params'

const CREATE = {
  name: 'Webhook',
  prompt: 'Read the call',
  agentId: 'claude',
  ...EVENT_ONLY_SCHEDULE
}
const RULE = {
  id: '',
  source: 'webhook',
  event: 'call',
  rev: 0,
  where: [{ path: 'body.kind', op: 'in', values: ['opened', 'closed'] }],
  pick: ['body.title'],
  subjectFrom: 'body.id',
  subject: '42'
}

describe('automation webhook RPC params', () => {
  it('preserves a new hook and its filters on create and update', () => {
    expect(AutomationCreate.parse({ ...CREATE, on: [RULE] }).on).toEqual([RULE])
    expect(AutomationUpdate.parse({ id: 'a', updates: { on: [RULE] } }).updates.on).toEqual([RULE])
  })

  it.each([
    { ...RULE, rev: -1 },
    { ...RULE, rev: undefined },
    { ...RULE, in: ['somewhere'] },
    { ...RULE, where: [{ path: 'body.kind', op: 'exists', unknownFilter: true }] },
    { ...RULE, unknownFilter: true }
  ])('rejects an unreadable rule rather than dropping a filter', (rule) => {
    expect(AutomationCreate.safeParse({ ...CREATE, on: [rule] }).success).toBe(false)
    expect(AutomationUpdate.safeParse({ id: 'a', updates: { on: [rule] } }).success).toBe(false)
  })
})
