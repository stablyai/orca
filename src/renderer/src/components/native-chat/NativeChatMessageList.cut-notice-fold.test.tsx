// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { agentSessionResponseInterruptedStoredBody } from '../../../../shared/agent-session-host-status-rows'
import { agentJournalItemKey } from '../../../../shared/agent-session-journal-item-key'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalTurnScope
} from '../../../../shared/agent-session-journal-types'
import { withNativeChatCutTurnNotices } from '../../../../shared/native-chat-cut-turn-notice'
import { projectStructuredAgentSessionMessages } from '../../../../shared/structured-agent-session-message-projection'
import { selectStructuredAgentSettledTurns } from '../../../../shared/structured-agent-session-turn-timing'
import { NativeChatMessageList } from './NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'

let restoreViewport = (): void => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())
afterEach(cleanup)

const NOTICE = 'This response was interrupted. You can continue in this conversation.'
const THREAD: AgentJournalTurnScope = { kind: 'thread' }
const IN_CUT: AgentJournalTurnScope = { kind: 'turn', turnItemId: 't1' }
let sequence = 0

function item(
  itemId: string,
  body: AgentJournalItemBody,
  turnScope: AgentJournalTurnScope | null
): AgentJournalRenderItem {
  sequence += 1
  return {
    itemId,
    revision: 0,
    sequence,
    observedAt: 1_000_000 + sequence,
    body,
    ...(turnScope ? { turnScope } : {})
  }
}

const say = (itemId: string, text: string, scope: AgentJournalTurnScope | null) =>
  item(itemId, { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] }, scope)

/** A turn cut 12 s in, after it had narrated and started an answer; null scopes for an older host. */
function cutTurn(scoped: boolean, replies = true): AgentJournalRenderItem[] {
  const scope = (value: AgentJournalTurnScope) => (scoped ? value : null)
  return [
    item(
      'u1',
      { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'please do it' }] },
      scope(THREAD)
    ),
    item(
      't1',
      {
        kind: 'turn',
        turnId: 't1',
        userItemId: 'u1',
        startedAt: 1_000_000,
        requestedAt: 1_000_000,
        completedAt: 1_012_000,
        state: 'interrupted'
      },
      scope(THREAD)
    ),
    ...(replies
      ? [say('a1', 'narration a1', scope(IN_CUT)), say('a2', 'partial answer a2', scope(IN_CUT))]
      : [])
  ]
}

const reopenRow = (body: AgentJournalItemBody) =>
  item(
    agentJournalItemKey({ provider: 'orca', clientMessageId: 'stale-session:s:death-3-2000' }),
    body,
    IN_CUT
  )

function renderCollapsed(journal: readonly AgentJournalRenderItem[], represent = true) {
  const items = represent ? withNativeChatCutTurnNotices(journal) : journal
  render(
    <NativeChatMessageList
      session={{
        messages: projectStructuredAgentSessionMessages(items, [], [], { rejectedInPlace: true }),
        status: 'ready',
        sessionId: 'session-1',
        agent: 'codex',
        hasMore: false,
        loadingEarlier: false,
        olderHistoryGeneration: 0,
        loadEarlier: vi.fn(),
        readPhase: 'ready'
      }}
      journalItems={items}
      journalSubmissions={[]}
      isWorking={false}
      workingStartedAt={null}
      settledTurns={selectStructuredAgentSettledTurns(items)}
      expandSignal={false}
    />
  )
  expect(screen.getByRole('button', { name: 'Toggle turn details' })).toHaveAttribute(
    'aria-expanded',
    'false'
  )
}

// The notice is the one row that says why the turn stopped, so the collapsed turn never hides it:
// the partial answer stays the answer and the muted line sits under it.
describe('a collapsed turn that was cut short', () => {
  it.each([
    ['derived for a quit, on a host that states scopes', () => cutTurn(true)],
    ['derived for a quit, on a host that states none', () => cutTurn(false)],
    [
      "the host's reopen row, stored red for older clients",
      () => [...cutTurn(true), reopenRow(agentSessionResponseInterruptedStoredBody())]
    ],
    [
      "an older host's red reopen row, re-presented",
      () => [
        ...cutTurn(true),
        reopenRow({
          kind: 'status',
          text: 'Codex stopped while this response was in progress. You can continue in this conversation.',
          tone: 'error'
        })
      ]
    ],
    [
      'a row naming why Orca stopped, red for older clients',
      () => [
        ...cutTurn(true),
        reopenRow({
          kind: 'status',
          text: 'Codex stopped while this response was in progress. You can continue in this conversation.',
          presentation: 'orca-stop',
          tone: 'error'
        })
      ]
    ]
  ])('shows its answer and the notice: %s', (_label, journal) => {
    renderCollapsed(journal())

    expect(screen.getByText('partial answer a2')).toBeInTheDocument()
    expect(screen.queryByText('narration a1')).toBeNull()
    expect(screen.getAllByText(NOTICE)).toHaveLength(1)
  })

  // Its red tone is for older clients: it is never the turn's failure report, so the partial answer
  // stays the answer, even read before the re-wording.
  it('never takes an orca-stop row as the failure the turn ended on', () => {
    renderCollapsed(
      [
        ...cutTurn(true),
        reopenRow({
          kind: 'status',
          text: 'Codex stopped while this response was in progress.',
          presentation: 'orca-stop',
          tone: 'error'
        })
      ],
      false
    )

    expect(screen.getByText('partial answer a2')).toBeInTheDocument()
    expect(screen.getAllByText(NOTICE)).toHaveLength(1)
  })

  it('shows the notice when the turn wrote no answer', () => {
    renderCollapsed([
      ...cutTurn(true, false),
      item(
        'tool-1',
        { kind: 'tool-call', name: 'shell', input: { command: 'pnpm test' }, state: 'failed' },
        IN_CUT
      )
    ])

    expect(screen.getAllByText(NOTICE)).toHaveLength(1)
  })
})
