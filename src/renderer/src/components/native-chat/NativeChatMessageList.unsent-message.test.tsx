// @vitest-environment happy-dom

// A message shown as not sent stays in the outbox and draws below newer turns, after their live
// activity. It is in no turn: the newer turn's "Working for" clock and "Worked for" bar stay with
// that turn, never under it.

import '@testing-library/jest-dom/vitest'

import { cleanup, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnScope
} from '../../../../shared/agent-session-journal-types'
import { agentJournalSubmissionKey } from '../../../../shared/agent-session-journal-item-key'
import type { NativeChatSettledTurns } from '../../../../shared/native-chat-turn-status'
import { DISPATCH_REJECTED_HOST_RESTARTED } from '../../../../shared/structured-agent-session-dispatch-rejection'
import { NativeChatMessageList } from './NativeChatMessageList'
import { structuredAgentSessionDeliveryNotices } from './structured-agent-session-delivery-notices'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

let restoreViewport = (): void => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())
afterEach(cleanup)

type Phase = 'in flight' | 'running' | 'done'

const SEED = agentJournalSubmissionKey('seed')
const NEW = agentJournalSubmissionKey('new')

function said(role: 'user' | 'assistant', text: string): AgentJournalItemBody {
  return { kind: 'message', role, blocks: [{ type: 'text', text }] }
}

function journal(phase: Phase, scoped: boolean): AgentJournalRenderItem[] {
  const thread: AgentJournalTurnScope = { kind: 'thread' }
  const row = (
    itemId: string,
    body: AgentJournalItemBody,
    turnScope: AgentJournalTurnScope
  ): AgentJournalRenderItem => ({
    itemId,
    revision: 0,
    sequence: rows.length + 1,
    observedAt: 1000 + rows.length,
    body,
    ...(scoped ? { turnScope } : {})
  })
  const rows: AgentJournalRenderItem[] = []
  rows.push(row(SEED, said('user', 'SEED PROMPT'), thread))
  rows.push(
    row(
      'turn-seed',
      { kind: 'turn', turnId: 'turn-seed', state: 'completed', userItemId: SEED },
      thread
    )
  )
  rows.push(
    row('seed-answer', said('assistant', 'SEED OK'), { kind: 'turn', turnItemId: 'turn-seed' })
  )
  rows.push(row(NEW, said('user', 'NEW PROMPT'), thread))
  if (phase !== 'in flight') {
    rows.push(
      row(
        'turn-new',
        {
          kind: 'turn',
          turnId: 'turn-new',
          state: phase === 'done' ? 'completed' : 'running',
          userItemId: NEW
        },
        thread
      )
    )
  }
  if (phase === 'done') {
    rows.push(
      row('new-answer', said('assistant', 'NEW OK'), { kind: 'turn', turnItemId: 'turn-new' })
    )
  }
  return rows
}

function submission(
  id: string,
  dispatchState: AgentJournalSubmission['dispatchState']
): AgentJournalSubmission {
  return {
    clientMessageId: id,
    fence: 1,
    payloadFingerprint: id,
    dispatchState,
    providerItemId: null,
    reason: null,
    submittedAt: 1,
    resolvedAt: null
  }
}

/** The drawn sequence of the prompts, bars and live activity line, top to bottom. */
function drawn(container: HTMLElement): string[] {
  const out: string[] = []
  for (const element of container.querySelectorAll('*')) {
    if (element.hasAttribute('data-native-chat-turn-activity')) {
      out.push('ACTIVITY')
    } else if (element.hasAttribute('data-native-chat-turn-status')) {
      out.push(
        element.getAttribute('data-native-chat-turn-status') === 'active' ? 'WORKING' : 'WORKED'
      )
    } else if (element.childElementCount === 0 && (element.textContent ?? '').endsWith('PROMPT')) {
      out.push(element.textContent ?? '')
    }
  }
  return out
}

describe('a message the host rejected after a crash, with no outbox entry left', () => {
  const LOST = agentJournalSubmissionKey('lost')

  function hostList(phase: Phase) {
    const items = journal(phase, true)
    const newIndex = items.findIndex((item) => item.itemId === NEW)
    // Recorded between the seed's answer and the newer prompt; the next open rejected it.
    items.splice(newIndex, 0, {
      itemId: LOST,
      revision: 0,
      sequence: items[newIndex - 1]!.sequence,
      sequenceIndex: 1,
      observedAt: 1002.5,
      body: said('user', 'LOST PROMPT'),
      turnScope: { kind: 'thread' }
    })
    const submissions: AgentJournalSubmission[] = [
      submission('seed', 'accepted'),
      {
        ...submission('lost', 'rejected'),
        reason: DISPATCH_REJECTED_HOST_RESTARTED,
        rejection: { kind: 'hostRestarted' }
      },
      submission('new', phase === 'done' ? 'accepted' : 'pending')
    ]
    const settledTurns: NativeChatSettledTurns = new Map([
      [SEED, { startedAt: 1, workedSeconds: 3 }],
      ...(phase === 'done' ? [[NEW, { startedAt: 2, workedSeconds: 5 }] as const] : [])
    ])
    return (
      <NativeChatMessageList
        session={{
          messages: projectStructuredAgentSessionMessages(items, [], submissions),
          status: phase === 'done' ? 'ready' : 'working',
          sessionId: 'session-1',
          agent: 'claude',
          hasMore: false,
          loadingEarlier: false,
          olderHistoryGeneration: 0,
          loadEarlier: vi.fn(),
          readPhase: 'ready'
        }}
        journalItems={items}
        journalSubmissions={submissions}
        deliveryNotices={structuredAgentSessionDeliveryNotices({
          pending: [],
          submissions,
          agentName: 'Claude',
          startFailures: []
        })}
        isWorking={phase !== 'done'}
        workingStartedAt={phase === 'done' ? null : Date.now() - 1500}
        settledTurns={settledTurns}
        expandSignal={false}
      />
    )
  }

  it('draws it where it was sent, with its reason and no Retry, outside the newer turn', () => {
    const { container, rerender } = render(hostList('running'))
    expect(drawn(container)).toEqual([
      'SEED PROMPT',
      'WORKED',
      'LOST PROMPT',
      'NEW PROMPT',
      'WORKING',
      'ACTIVITY'
    ])
    expect(container.textContent).toContain('Orca restarted before this message was sent.')
    expect(container.querySelector('button[aria-label="Retry"]')).toBeNull()
    expect(
      [...container.querySelectorAll('button')].map((button) => button.textContent)
    ).not.toContain('Retry')
    rerender(hostList('done'))
    expect(drawn(container)).toEqual([
      'SEED PROMPT',
      'WORKED',
      'LOST PROMPT',
      'NEW PROMPT',
      'WORKED'
    ])
    expect(container.textContent).toContain('Worked for 5s')
  })
})
