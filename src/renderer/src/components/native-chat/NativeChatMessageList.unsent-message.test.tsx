import { EMPTY_AGENT_SESSION_CONTEXT } from '../../../../shared/agent-session-context'
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
import {
  createStructuredAgentSessionOutboxEntry,
  type StructuredAgentSessionOutboxEntry
} from '../../../../shared/structured-agent-session-outbox'
import { NativeChatMessageList } from './NativeChatMessageList'
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

function unsentEntry(kind: 'held' | 'rejected'): StructuredAgentSessionOutboxEntry {
  const entry = createStructuredAgentSessionOutboxEntry({
    clientMessageId: 'held',
    sessionId: 'session-1',
    text: 'HELD PROMPT',
    attachments: [],
    queuedAt: 500
  })
  return kind === 'held'
    ? {
        ...entry,
        lastAttemptAt: 500,
        lastFailure: { kind: 'refused', code: 'agent_session_journal_unreadable' }
      }
    : { ...entry, state: 'rejected', lastFailure: { kind: 'rejected', reason: null } }
}

function list(phase: Phase, scoped: boolean, outbox: StructuredAgentSessionOutboxEntry[]) {
  const items = journal(phase, scoped)
  const submissions = [
    submission('seed', 'accepted'),
    submission('new', phase === 'done' ? 'accepted' : 'pending')
  ]
  const settledTurns: NativeChatSettledTurns = new Map([
    [SEED, { startedAt: 1, workedSeconds: 3 }],
    ...(phase === 'done' ? [[NEW, { startedAt: 2, workedSeconds: 5 }] as const] : [])
  ])
  return (
    <NativeChatMessageList
      session={{
        messages: projectStructuredAgentSessionMessages(items, outbox, submissions),
        status: phase === 'done' ? 'ready' : 'working',
        sessionId: 'session-1',
        agent: 'claude',
        hasMore: false,
        loadingEarlier: false,
        olderHistoryGeneration: 0,
        loadEarlier: vi.fn(),
        context: EMPTY_AGENT_SESSION_CONTEXT,
        markCompactionRequested: () => undefined,
        readPhase: 'ready'
      }}
      journalItems={items}
      journalSubmissions={submissions}
      isWorking={phase !== 'done'}
      workingStartedAt={phase === 'done' ? null : Date.now() - 1500}
      settledTurns={settledTurns}
      expandSignal={false}
      fontScale={1}
    />
  )
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

describe.each([
  ['held for its Retry', 'held'],
  ['rejected', 'rejected']
] as const)('a message %s, below a newer turn', (_label, kind) => {
  it.each([
    ['states each row turn', true],
    ['states no turn scope', false]
  ])(
    'keeps the newer turn bar with that turn while it runs and once done (host %s)',
    (_host, scoped) => {
      const outbox = [unsentEntry(kind)]
      const { container, rerender } = render(list('in flight', scoped, outbox))
      expect(drawn(container)).toEqual([
        'SEED PROMPT',
        'WORKED',
        'NEW PROMPT',
        'WORKING',
        'ACTIVITY',
        'HELD PROMPT'
      ])
      rerender(list('running', scoped, outbox))
      expect(drawn(container)).toEqual([
        'SEED PROMPT',
        'WORKED',
        'NEW PROMPT',
        'WORKING',
        'ACTIVITY',
        'HELD PROMPT'
      ])
      rerender(list('done', scoped, outbox))
      expect(drawn(container)).toEqual([
        'SEED PROMPT',
        'WORKED',
        'NEW PROMPT',
        'WORKED',
        'HELD PROMPT'
      ])
      expect(container.textContent).toContain('Worked for 5s')
    }
  )
})
