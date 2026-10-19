// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
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
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalTurnItem
} from '../../../../shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { selectStructuredAgentSettledTurns } from '../../../../shared/structured-agent-session-turn-timing'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'

let restoreViewport = (): void => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())
afterEach(cleanup)

{
  const TURN_MS = 12_000

  // Each turn ends differently. The journal is where each end is recorded, and the lifecycle is
  // seeded rather than produced, since a crash settles as `interrupted` only once the host proves it.
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
    // A crash-cut turn reads like a finished one; the chat's notice row is what says it stopped.
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
      // The turn's detail stays inside the fold.
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

  // The turn still runs while a Stop ends it, so its bar keeps the running clock; only the tail line
  // says the turn is stopping, and the bar settles to "Interrupted after" once the turn ends.
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

  // Where the host does not queue sends, one made while Stopping is held until the turn ends: it is
  // drawn after the Stopping line, not inside the turn being stopped.
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

    // Sent just before the Stop, the host steers it into the turn: it stays there, never jumping.
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
