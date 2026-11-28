import { expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalResolution
} from '../journal/agent-session-journal-types'
import { structuredAgentSessionAgentStatus } from './structured-agent-session-agent-status'
import { projectStructuredAgentSessionStatusSummary } from './structured-agent-session-projection'

const resolution: AgentJournalResolution = {
  state: 'pending',
  selectedOptionId: null,
  resolvedBy: null,
  resolvedAt: null
}
const request: AgentJournalRenderItem = {
  itemId: 'u1',
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'Pick one' }] }
}
const question: AgentJournalRenderItem = {
  itemId: 'q1',
  revision: 1,
  sequence: 2,
  observedAt: 2,
  body: { kind: 'question', question: 'Which one?', options: [], resolution }
}
const approval: AgentJournalRenderItem = {
  itemId: 'a1',
  revision: 1,
  sequence: 3,
  observedAt: 3,
  body: { kind: 'approval', title: 'Run command', detail: null, options: [], resolution }
}

function leadState(items: AgentJournalRenderItem[]): string {
  const summary = projectStructuredAgentSessionStatusSummary(items)
  expect(summary.status).toBe('attention')
  return structuredAgentSessionAgentStatus({ ...summary, status: 'attention' }).mainAgent.state
}

it('waits on an open question like a terminal question, and blocks on any open approval', () => {
  expect(leadState([request, question])).toBe('waiting')
  expect(leadState([request, approval])).toBe('blocked')
  expect(leadState([request, question, approval])).toBe('blocked')
})
