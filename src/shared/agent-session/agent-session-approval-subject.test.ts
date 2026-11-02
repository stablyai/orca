import { expect, it } from 'vitest'
import { pendingPromptsAllUnanswerableHere } from './agent-session-approval-subject'
import type { AgentJournalItemBody } from './journal/agent-session-journal-types'
import { isAdmissibleAgentJournalItemBody } from './journal/agent-session-journal-schemas'

function pending(body: Record<string, unknown>): { body: AgentJournalItemBody } {
  const promptBody = {
    ...body,
    resolution: { state: 'pending', selectedOptionId: null, resolvedBy: null, resolvedAt: null }
  }
  if (!isAdmissibleAgentJournalItemBody(promptBody)) {
    throw new Error('Invalid pending prompt fixture')
  }
  return { body: promptBody }
}
const NEWER = pending({
  kind: 'approval',
  title: 'Review',
  detail: null,
  subject: { kind: 'diff' },
  options: [{ id: 'allow', label: 'Approve' }]
})
const PLAN = pending({
  kind: 'approval',
  title: 'Plan',
  detail: null,
  subject: { kind: 'plan', text: 'do it' },
  options: [{ id: 'allow', label: 'Approve' }]
})
const QUESTION = pending({ kind: 'question', question: 'Which?', options: [] })

it('holds only while every pending prompt is an approval this build cannot answer', () => {
  expect(pendingPromptsAllUnanswerableHere([])).toBe(false)
  expect(pendingPromptsAllUnanswerableHere([NEWER])).toBe(true)
  expect(pendingPromptsAllUnanswerableHere([NEWER, NEWER])).toBe(true)
  expect(pendingPromptsAllUnanswerableHere([NEWER, PLAN])).toBe(false)
  expect(pendingPromptsAllUnanswerableHere([QUESTION, NEWER])).toBe(false)
  const cancelled = JSON.parse(
    JSON.stringify(NEWER).replace('"state":"pending"', '"state":"cancelled"')
  )
  expect(pendingPromptsAllUnanswerableHere([cancelled, NEWER])).toBe(true)
  expect(pendingPromptsAllUnanswerableHere([NEWER, cancelled])).toBe(true)
  expect(pendingPromptsAllUnanswerableHere([cancelled, PLAN])).toBe(false)
  expect(pendingPromptsAllUnanswerableHere([cancelled])).toBe(false)
})
