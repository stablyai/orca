import { describe, expect, it } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../journal/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../journal/agent-session-journal-item-key'
import { agentSessionFailureWords } from '../failures/agent-session-failure-words'
import { latestStructuredAgentSessionFailure } from './structured-agent-session-latest-request'
import {
  projectStructuredAgentSessionStatusState,
  projectStructuredAgentSessionStatusSummary
} from '../view/structured-agent-session-projection'
import type { StructuredAgentSessionWorkScope } from '../view/structured-agent-session-main-agent-working'

describe('the assistant line plain-text surfaces show', () => {
  function message(
    itemId: string,
    sequence: number,
    role: 'user' | 'assistant',
    text: string
  ): AgentJournalRenderItem {
    return {
      itemId,
      revision: 0,
      sequence,
      observedAt: sequence,
      body: { kind: 'message', role, blocks: [{ type: 'text', text }] }
    }
  }

  const botPreview = (items: AgentJournalRenderItem[]): string | undefined =>
    projectStructuredAgentSessionStatusState(items, [], undefined, undefined, undefined, true)
      .summary.lastAssistantMessage

  it("shows a bot's last real answer, never the quiet marker, after quiet turns", () => {
    const items = [
      message('ask', 1, 'user', 'triage today'),
      message('said', 2, 'assistant', 'Started 11 triage agents.'),
      message('wake-1', 3, 'user', 'agent 1 finished'),
      message('quiet-1', 4, 'assistant', 'NO_REPLY'),
      message('wake-2', 5, 'user', 'agent 2 finished'),
      message('quiet-2', 6, 'assistant', '2 of 11 done.\n\n**NO_REPLY**')
    ]
    expect(botPreview(items)).toBe('Started 11 triage agents.')
  })

  const send = (
    clientMessageId: string,
    dispatchState: AgentJournalSubmission['dispatchState'],
    reason: string | null = null
  ): AgentJournalSubmission => ({
    clientMessageId,
    fence: 1,
    payloadFingerprint: 'f',
    dispatchState,
    providerItemId: null,
    reason,
    submittedAt: 1,
    resolvedAt: dispatchState === 'pending' ? null : 2
  })
  const answered = [
    message(agentJournalSubmissionKey('first'), 1, 'user', 'check the nightly'),
    message('said', 2, 'assistant', 'Nightly is green.')
  ]
  const summary = (
    submissions: AgentJournalSubmission[],
    scope?: StructuredAgentSessionWorkScope
  ) =>
    projectStructuredAgentSessionStatusState(answered, submissions, 1, scope, undefined, true)
      .summary

  it('drops the previous answer as soon as a new message is sent, before the agent echoes it', () => {
    expect(summary([send('first', 'accepted')]).lastAssistantMessage).toBe('Nightly is green.')
    // The second message is out but not yet journaled: working, with no answer of its own yet.
    expect(summary([send('first', 'accepted'), send('second', 'pending')])).toMatchObject({
      status: 'working'
    })
    expect(
      summary([send('first', 'accepted'), send('second', 'pending')]).lastAssistantMessage
    ).toBeUndefined()
  })

  it('keeps the answer when the host owes no send: one released in doubt or no longer held', () => {
    const notHeld: StructuredAgentSessionWorkScope = {
      isCurrentItem: () => false,
      owesSend: () => false
    }
    for (const second of [
      send('second', 'unknown', 'provider_ended_before_acknowledgement'),
      send('second', 'pending')
    ]) {
      expect(summary([send('first', 'accepted'), second], notHeld)).toMatchObject({
        status: 'idle',
        lastAssistantMessage: 'Nightly is green.'
      })
    }
  })

  it('keeps a non-bot answer that ends with the quiet marker as its preview', () => {
    const items = [
      message('ask', 1, 'user', 'What is next?'),
      message('said', 2, 'assistant', 'Ready for the next task.'),
      message('ask-2', 3, 'user', 'What token means no response?'),
      message('answer', 4, 'assistant', 'The token is `NO_REPLY`')
    ]
    expect(projectStructuredAgentSessionStatusSummary(items).lastAssistantMessage).toBe(
      'The token is `NO_REPLY`'
    )
  })
})

const failureTestUserMessage = (itemId: string, sequence: number): AgentJournalRenderItem => ({
  itemId,
  revision: 0,
  sequence,
  observedAt: sequence,
  body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'look into this' }] }
})
const failureTestStatusRow = (
  itemId: string,
  sequence: number,
  kind: 'usageLimitReached' | 'providerRetrying' | 'notSignedIn'
): AgentJournalRenderItem => ({
  itemId,
  revision: 0,
  sequence,
  observedAt: sequence,
  body: { kind: 'status', ...agentSessionFailureWords({ kind }, { surface: 'row' }) }
})

describe('why the latest request failed', () => {
  it('reads the latest turn’s failure row, past a retry, and nothing from an earlier turn', () => {
    const asked = failureTestUserMessage('ask', 1)
    const limit = failureTestStatusRow('limit', 2, 'usageLimitReached')
    const retrying = failureTestStatusRow('retry', 3, 'providerRetrying')
    expect(latestStructuredAgentSessionFailure([asked, limit, retrying], [])?.kind).toBe(
      'usageLimitReached'
    )
    expect(latestStructuredAgentSessionFailure([asked, retrying], [])).toBeUndefined()
    expect(
      latestStructuredAgentSessionFailure([asked, limit, failureTestUserMessage('again', 4)], [])
    ).toBeUndefined()
  })

  it('reads a refused send’s rejection', () => {
    const submission: AgentJournalSubmission = {
      clientMessageId: 'm1',
      fence: 1,
      payloadFingerprint: 'f',
      dispatchState: 'rejected',
      providerItemId: null,
      reason: 'Codex is not signed in.',
      rejection: { kind: 'notSignedIn' },
      submittedAt: 1,
      resolvedAt: 2
    }
    const sent = failureTestUserMessage(agentJournalSubmissionKey('m1'), 1)
    expect(latestStructuredAgentSessionFailure([sent], [submission])?.kind).toBe('notSignedIn')
  })
})
