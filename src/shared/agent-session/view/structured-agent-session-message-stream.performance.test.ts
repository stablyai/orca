import { expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../journal/agent-session-journal-item-key'
import { DISPATCH_REJECTED_CANCELLED } from '../requests/structured-agent-session-dispatch-rejection'
import { projectStructuredItemsToNativeChat } from './structured-agent-session-projection'
import { createStructuredAgentSessionMessageProjection } from './structured-agent-session-message-stream'

const row = (
  itemId: string,
  sequence: number,
  role: 'user' | 'assistant',
  text: string
): AgentJournalRenderItem => ({
  itemId,
  revision: 1,
  sequence,
  observedAt: sequence,
  body: { kind: 'message', role, blocks: [{ type: 'text', text }] }
})

// Perf contract: in a chat holding a send stopped before it started, a reply that only grows its
// text projects only its own row each window, not the whole history.
it('projects only the streaming row while a stopped send is held, not the history', () => {
  const stopped: AgentJournalSubmission = {
    clientMessageId: 'stopped-send',
    fence: 1,
    payloadFingerprint: 'stopped',
    dispatchState: 'rejected',
    providerItemId: null,
    reason: DISPATCH_REJECTED_CANCELLED,
    submittedAt: 1,
    resolvedAt: 2
  }
  const history: AgentJournalRenderItem[] = []
  for (let turn = 0; turn < 200; turn++) {
    history.push(row(`ask-${turn}`, turn * 2 + 1, 'user', `Question ${turn}`))
    history.push(row(`answer-${turn}`, turn * 2 + 2, 'assistant', `Answer ${turn}`))
  }
  history.push(row(agentJournalSubmissionKey('stopped-send'), 401, 'user', 'Never mind'))
  const reply = (text: string) => row('reply', 402, 'assistant', text)
  let visited = 0
  const project = createStructuredAgentSessionMessageProjection((items) => {
    visited += items.length
    return projectStructuredItemsToNativeChat(items)
  })
  const submissions = [stopped]
  const optimistic: never[] = []
  const first = project([...history, reply('The reply')], optimistic, submissions)
  expect(first.some((message) => message.stoppedBeforeStart)).toBe(true)
  visited = 0
  let latest = first
  for (let window = 1; window <= 20; window++) {
    const text = `The reply${' and more'.repeat(window)}`
    latest = project([...history, reply(text)], optimistic, submissions)
  }
  // Each window projects the revised row's before and after: 2 visits, not the 402-row history.
  expect(visited).toBe(40)
  // A revision beside streamed text (here the stopped send's own row) places stopped sends again.
  visited = 0
  const reworded = row(agentJournalSubmissionKey('stopped-send'), 401, 'user', 'Never mind, really')
  project([...history.slice(0, -1), reworded, reply('The reply')], optimistic, submissions)
  expect(visited).toBeGreaterThan(400)
  expect(latest.at(-1)?.blocks).toEqual([
    { type: 'text', text: `The reply${' and more'.repeat(20)}` }
  ])
})
