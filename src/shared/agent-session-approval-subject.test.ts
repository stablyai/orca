import { expect, it } from 'vitest'
import {
  DRAWN_APPROVAL_SUBJECT_KINDS,
  isNewerApprovalSubject,
  pendingPromptsAllUnanswerableHere
} from './agent-session-approval-subject'
import type { AgentJournalItemBody } from './agent-session-journal-types'
import {
  AGENT_JOURNAL_APPROVAL_SUBJECT_KINDS,
  isAdmissibleAgentJournalItemBody
} from './agent-session-journal-schemas'

it('draws exactly the subject kinds the journal schema knows', () => {
  expect([...DRAWN_APPROVAL_SUBJECT_KINDS].sort()).toEqual(
    [...AGENT_JOURNAL_APPROVAL_SUBJECT_KINDS].sort()
  )
})

it("reads only a subject of a kind it does not draw as a newer build's", () => {
  expect(isNewerApprovalSubject(undefined)).toBe(false)
  expect(isNewerApprovalSubject({ kind: 'plan' })).toBe(false)
  expect(isNewerApprovalSubject({ kind: 'diff' })).toBe(true)
})

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
