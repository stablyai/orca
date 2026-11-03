// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, screen } from '@testing-library/react'
import { render } from './native-chat-tooltip-test-harness'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// Why: these fixtures have neither inline visual owners nor sender navigation.
const unusedChatLeaves = vi.hoisted(() => ({
  inlineVisual: vi.fn(() => {
    throw new Error('Unexpected inline visual in transcript fixture')
  }),
  openSender: vi.fn(() => {
    throw new Error('Unexpected sender navigation in transcript fixture')
  })
}))
vi.mock('./NativeChatInlineVisual', () => ({
  NativeChatInlineVisual: unusedChatLeaves.inlineVisual
}))
vi.mock('@/lib/open-agent-message-sender', () => ({
  openAgentMessageSender: unusedChatLeaves.openSender
}))
afterEach(() => {
  expect(unusedChatLeaves.inlineVisual).not.toHaveBeenCalled()
  expect(unusedChatLeaves.openSender).not.toHaveBeenCalled()
})
import { NativeChatOrcaStopContext } from './native-chat-orca-stop-context'
import { agentSessionFailureWords } from '../../../../shared/agent-session/failures/agent-session-failure-words'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalTurnItem
} from '../../../../shared/agent-session/journal/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { selectStructuredAgentSettledTurns } from '../../../../shared/agent-session/view/structured-agent-session-turn-timing'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../shared/agent-session/journal/agent-session-journal-item-key'
import { latestNativeChatOrcaStopCut } from '../../../../shared/native-chat/native-chat-orca-stop-cut'
import { latestNativeChatUsageLimitCut } from '../../../../shared/native-chat/native-chat-usage-limit-cut'
import { latestStructuredAgentSessionRequest } from '../../../../shared/agent-session/requests/structured-agent-session-latest-request'

let restoreViewport = (): void => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())
afterEach(cleanup)

const continueUsageLimit = vi.fn()
const usageLimitView = {
  hostLabel: null,
  remoteHost: false,
  continueAvailable: false,
  offeredTurnItemId: null,
  continueNow: vi.fn(),
  usageLimitTurnItemId: 'item-2',
  continueUsageLimit
}
// A host that could continue, with no turn the selectors offered.
const commandView = {
  ...usageLimitView,
  continueAvailable: true,
  offeredTurnItemId: null,
  usageLimitTurnItemId: null
}

{
  const TURN_MS = 12_000

  // Seed lifecycle separately: the host must confirm a crash before it settles as interrupted.
  const TURNS: { id: string; end: Pick<AgentJournalTurnItem, 'state' | 'outcome'> }[] = [
    { id: 'user-finished', end: { state: 'completed', outcome: 'success' } },
    { id: 'user-crashed', end: { state: 'interrupted' } },
    { id: 'user-stopped', end: { state: 'interrupted', outcome: 'cancellation' } }
  ]

  function turnMessages(userId: string, at: number): NativeChatMessage[] {
    return [
      {
        id: userId,
        role: 'user',
        blocks: [{ type: 'text', text: `prompt ${userId}` }],
        timestamp: at,
        source: 'transcript'
      },
      {
        id: `${userId}-narration`,
        role: 'assistant',
        blocks: [{ type: 'text', text: `narration ${userId}` }],
        timestamp: at + 1,
        source: 'transcript'
      },
      {
        id: `${userId}-work`,
        role: 'assistant',
        blocks: [
          { type: 'tool-call', name: 'shell', input: { command: 'pnpm test' }, state: 'completed' },
          { type: 'tool-result', output: 'ok' }
        ],
        timestamp: at + 2,
        source: 'transcript'
      },
      {
        id: `${userId}-answer`,
        role: 'assistant',
        blocks: [{ type: 'text', text: `answer ${userId}` }],
        timestamp: at + 3,
        source: 'transcript'
      }
    ]
  }

  function journal(): AgentJournalRenderItem[] {
    return TURNS.flatMap(({ id, end }, index) => {
      const at = 1_000_000 + index * 100_000
      return [
        {
          itemId: id,
          sequence: index * 2 + 1,
          revision: 1,
          observedAt: at,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: id }] }
        },
        {
          itemId: `${id}-turn`,
          sequence: index * 2 + 2,
          revision: 1,
          observedAt: at + TURN_MS,
          body: {
            kind: 'turn',
            turnId: `${id}-turn`,
            userItemId: id,
            startedAt: at,
            requestedAt: at,
            completedAt: at + TURN_MS,
            ...end
          }
        }
      ]
    })
  }

  function session(): NativeChatLiveSession {
    return {
      messages: TURNS.flatMap(({ id }, index) => turnMessages(id, index * 10)),
      status: 'ready',
      sessionId: 'session-1',
      agent: 'codex',
      hasMore: false,
      loadingEarlier: false,
      olderHistoryGeneration: 0,
      loadEarlier: vi.fn(),
      readPhase: 'ready'
    }
  }

  describe('NativeChatMessageList folded turn headers', () => {
    it('says a crash-cut turn worked like a finished one and a stopped turn was interrupted', () => {
      render(
        <NativeChatMessageList
          session={session()}
          isWorking={false}
          workingStartedAt={null}
          settledTurns={selectStructuredAgentSettledTurns(journal())}
          expandSignal={false}
        />
      )

      const headers = screen
        .getAllByRole('button', { name: 'Toggle turn details' })
        .map((button) => [button.textContent, button.getAttribute('aria-expanded')])
      expect(headers).toEqual([
        ['Worked for 12s', 'false'],
        ['Worked for 12s', 'false'],
        ['Interrupted after 12s', 'false']
      ])
      expect(screen.queryByText('narration user-crashed')).toBeNull()
      expect(screen.getByText('answer user-crashed')).toBeInTheDocument()
    })
  })
}

{
  function retry(sequence: number, attempt: number): AgentJournalRenderItem {
    return {
      itemId: `retry-${sequence}`,
      revision: 1,
      sequence,
      observedAt: sequence,
      body: {
        kind: 'status',
        tone: 'warning',
        ...agentSessionFailureWords(
          {
            kind: 'providerRetrying',
            detail: { text: `Reconnecting... ${attempt}/5`, audience: 'person' },
            retry: { cause: 'stream disconnected before completion' }
          },
          { surface: 'row', agentName: 'Codex' }
        )
      }
    }
  }

  function transcript(items: AgentJournalRenderItem[]) {
    return (
      <NativeChatMessageList
        session={{
          messages: projectStructuredAgentSessionMessages(items, [], []),
          status: 'ready',
          sessionId: 'live-codex',
          agent: 'codex',
          hasMore: false,
          loadingEarlier: false,
          olderHistoryGeneration: 0,
          loadEarlier: vi.fn(),
          readPhase: 'ready'
        }}
        isWorking={false}
        expandSignal
      />
    )
  }

  describe('a Codex retrying a dropped stream', () => {
    it('draws one warning for the run, with what failed on its second line', () => {
      render(transcript([retry(1, 1), retry(2, 2), retry(3, 3)]))

      const rows = screen.getAllByText(/Codex is retrying/)
      expect(rows).toHaveLength(1)
      expect(rows[0]?.textContent).toBe(
        'Codex is retrying: Reconnecting... 3/5.\nstream disconnected before completion'
      )
    })
  })
}

{
  const turnItem: AgentJournalItemBody = { kind: 'turn', turnId: 'turn-1', state: 'running' }

  function journalItem(sequence: number, body: AgentJournalItemBody): AgentJournalRenderItem {
    return { itemId: `item-${sequence}`, revision: 1, sequence, observedAt: sequence, body }
  }

  const session: NativeChatLiveSession = {
    messages: [
      {
        id: 'user-stop',
        role: 'user',
        blocks: [{ type: 'text', text: 'Start the task' }],
        timestamp: Date.now(),
        source: 'transcript'
      }
    ],
    status: 'working',
    sessionId: 'session-1',
    agent: 'codex',
    hasMore: false,
    loadingEarlier: false,
    olderHistoryGeneration: 0,
    loadEarlier: vi.fn(),
    readPhase: 'ready'
  }

  it.each(['claude', 'codex', 'grok'] as const)(
    'keeps a collapsed %s quota warning visible and continues once the limit resets',
    (agent) => {
      continueUsageLimit.mockClear()
      const items: AgentJournalRenderItem[] = [
        journalItem(1, {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: 'Start' }]
        }),
        journalItem(2, {
          kind: 'turn',
          turnId: 'turn-1',
          userItemId: 'item-1',
          state: 'completed',
          outcome: 'failure',
          startedAt: 1000,
          completedAt: 2000
        }),
        {
          ...journalItem(3, {
            kind: 'message',
            role: 'assistant',
            blocks: [{ type: 'text', text: 'Earlier work' }]
          }),
          turnScope: { kind: 'turn', turnItemId: 'item-2' }
        },
        {
          ...journalItem(4, {
            kind: 'status',
            tone: 'warning',
            ...agentSessionFailureWords(
              {
                kind: 'usageLimitReached',
                usageLimit: { window: 'session', resetsAt: Date.now() - 60_000 },
                detail: { text: 'The provider refused this request.', audience: 'person' }
              },
              { surface: 'row' }
            )
          }),
          turnScope: { kind: 'turn', turnItemId: 'item-2' }
        }
      ]
      render(
        <NativeChatOrcaStopContext.Provider value={usageLimitView}>
          <NativeChatMessageList
            session={{
              ...session,
              agent,
              status: 'ready',
              messages: projectStructuredAgentSessionMessages(items, [], [])
            }}
            journalItems={items}
            settledTurns={selectStructuredAgentSettledTurns(items)}
            isWorking={false}
            expandSignal={false}
          />
        </NativeChatOrcaStopContext.Provider>
      )
      expect(screen.getByRole('button', { name: 'Toggle turn details' })).toHaveAttribute(
        'aria-expanded',
        'false'
      )
      expect(screen.queryByText('Earlier work')).toBeNull()
      expect(screen.getByText(/hit its session limit/)).toBeVisible()
      expect(screen.getByText('Details')).toBeVisible()
      const button = screen.getByRole('button', { name: 'Continue Now' })
      expect(button).toBeVisible()
      fireEvent.click(button)
      expect(continueUsageLimit).toHaveBeenCalledOnce()
    }
  )

  // Stop leaves the bar’s clock running until settlement; only the tail says Stopping.
  describe("the turn bar while a person's Stop ends the turn", () => {
    it('keeps the running clock above the Stopping tail line', () => {
      const transcript = (stopping: boolean) => (
        <NativeChatMessageList
          session={session}
          journalItems={[journalItem(1, turnItem)]}
          turnActivity={{ kind: 'description', text: 'Running pnpm test' }}
          isWorking
          stopping={stopping}
          expandSignal={false}
        />
      )
      const { rerender } = render(transcript(false))
      expect(screen.getByText('Running pnpm test')).toBeInTheDocument()
      expect(screen.queryByText('Stopping…')).toBeNull()

      rerender(transcript(true))

      const bar = screen.getByText('Working for 0s')
      const stopping = screen.getByText('Stopping…')
      expect(bar.compareDocumentPosition(stopping)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
      expect(screen.getAllByText(/Stopping/)).toHaveLength(1)
      expect(screen.queryByText('Running pnpm test')).toBeNull()
    })
  })

  // Hosts without queueing hold sends after the Stopping line until the turn ends.
  describe('a message sent while Stopping, before the host has handed it over', () => {
    const pending = {
      id: 'pending-send',
      role: 'user' as const,
      sentWhileStopping: true as const,
      blocks: [{ type: 'text' as const, text: 'Run this after the stop' }],
      timestamp: Date.now(),
      source: 'transcript' as const
    }

    function renderList(stopping: boolean): void {
      render(
        <NativeChatMessageList
          session={{ ...session, messages: [...session.messages, pending] }}
          journalItems={[journalItem(1, turnItem)]}
          isWorking
          stopping={stopping}
          expandSignal={false}
        />
      )
    }

    it('draws after the Stopping line', () => {
      renderList(true)

      const stopping = screen.getByText('Stopping…')
      const sent = screen.getByText('Run this after the stop')
      expect(stopping.compareDocumentPosition(sent)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    })

    it('stays in the turn while nothing is stopping', () => {
      renderList(false)

      const sent = screen.getByText('Run this after the stop')
      const working = screen.getByText('Working…')
      expect(sent.compareDocumentPosition(working)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    })

    it('keeps a send made before the Stop in the turn', () => {
      const { sentWhileStopping: _made, ...beforeStop } = pending
      render(
        <NativeChatMessageList
          session={{ ...session, messages: [...session.messages, beforeStop] }}
          journalItems={[journalItem(1, turnItem)]}
          isWorking
          stopping
          expandSignal={false}
        />
      )

      const sent = screen.getByText('Run this after the stop')
      const stopping = screen.getByText('Stopping…')
      expect(sent.compareDocumentPosition(stopping)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    })
  })
}

{
  const compactEntry = agentJournalSubmissionKey('cmd-1')
  const commandTurn = agentJournalItemKey({
    provider: 'orca',
    clientMessageId: 'command-turn:cmd-1'
  })
  const row = (
    itemId: string,
    sequence: number,
    body: AgentJournalItemBody,
    turnItemId?: string
  ): AgentJournalRenderItem => ({
    itemId,
    revision: 1,
    sequence,
    observedAt: sequence,
    body,
    turnScope: turnItemId ? { kind: 'turn', turnItemId } : { kind: 'thread' }
  })
  const settled = (
    itemId: string,
    userItemId: string,
    outcome: 'success' | 'failure',
    at: number
  ) =>
    row(itemId, at, {
      kind: 'turn',
      turnId: itemId,
      userItemId,
      state: 'completed',
      outcome,
      startedAt: at * 1000,
      completedAt: at * 1000 + 4000
    })
  const failures: [string, AgentJournalItemBody, RegExp][] = [
    [
      'usage-limit warning',
      {
        kind: 'status',
        tone: 'warning',
        ...agentSessionFailureWords(
          {
            kind: 'usageLimitReached',
            usageLimit: { window: 'session', resetsAt: 1_700_000_000_000 },
            detail: { text: "You've hit your limit", audience: 'person' }
          },
          { surface: 'row', agentName: 'Claude' }
        )
      },
      /hit its session limit/
    ],
    [
      'compaction failure',
      {
        kind: 'status',
        tone: 'error',
        ...agentSessionFailureWords(
          { kind: 'compactionFailed', detail: { text: 'nothing to compact', audience: 'person' } },
          { surface: 'row', agentName: 'Grok' }
        )
      },
      /Compaction failed: nothing to compact/
    ],
    [
      'fact-less provider error',
      { kind: 'status', tone: 'error', text: 'API Error: 529 upstream overloaded' },
      /API Error: 529 upstream overloaded/
    ]
  ]

  describe('a failed /compact command turn', () => {
    it.each(failures)(
      'shows its %s with no recovery controls, leaving the request before it as it was',
      (_name, failure, words) => {
        const items = [
          row('u1', 1, {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: 'Fix it' }]
          }),
          settled('t1', 'u1', 'success', 2),
          row(
            't1-answer',
            3,
            { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'Fixed.' }] },
            't1'
          ),
          row(compactEntry, 10, {
            kind: 'message',
            role: 'user',
            blocks: [{ type: 'text', text: '/compact' }],
            command: { name: 'compact' }
          }),
          settled(commandTurn, compactEntry, 'failure', 11),
          row('command-failure', 12, failure, commandTurn)
        ]
        // The live list's Continue targets come from these selectors; neither offers the command.
        expect(latestNativeChatOrcaStopCut(items, [])).toBeNull()
        expect(latestNativeChatUsageLimitCut(items, [])).toBeNull()
        render(
          <NativeChatOrcaStopContext.Provider value={commandView}>
            <NativeChatMessageList
              session={{
                messages: projectStructuredAgentSessionMessages(items, [], []),
                status: 'ready',
                sessionId: 'session-1',
                agent: 'claude',
                hasMore: false,
                loadingEarlier: false,
                olderHistoryGeneration: 0,
                loadEarlier: vi.fn(),
                readPhase: 'ready'
              }}
              journalItems={items}
              settledTurns={selectStructuredAgentSettledTurns(items)}
              isWorking={false}
              expandSignal={false}
            />
          </NativeChatOrcaStopContext.Provider>
        )
        expect(screen.getByText('/compact')).toBeVisible()
        expect(screen.getAllByText(words)).toHaveLength(1)
        expect(screen.getByText(words)).toBeVisible()
        expect(screen.queryByRole('button', { name: /Continue/ })).toBeNull()
        expect(screen.queryByRole('separator', { name: 'Context compacted' })).toBeNull()
        expect(screen.getByText('Fixed.')).toBeVisible()
        // Status readers keep the last real request's verdict through the failed command.
        expect(latestStructuredAgentSessionRequest(items, [])).toMatchObject({
          id: 't1',
          outcome: 'success'
        })
      }
    )
  })
}
