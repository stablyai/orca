// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalRenderItem,
  AgentJournalTurnItem
} from '../../../../shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { selectStructuredAgentSettledTurns } from '../../../../shared/structured-agent-session-turn-timing'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'

let restoreViewport = (): void => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())
afterEach(cleanup)

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
  it('says a turn a crash cut off failed and a stopped turn was interrupted, where a finished one worked', () => {
    render(
      <NativeChatMessageList
        session={session()}
        isWorking={false}
        workingStartedAt={null}
        settledTurns={selectStructuredAgentSettledTurns(journal())}
        expandSignal={false}
        fontScale={1}
      />
    )

    const headers = screen
      .getAllByRole('button', { name: 'Toggle turn details' })
      .map((button) => [button.textContent, button.getAttribute('aria-expanded')])
    expect(headers).toEqual([
      ['Worked for 12s', 'false'],
      ['Failed after 12s', 'false'],
      ['Interrupted after 12s', 'false']
    ])
    // The turn's detail stays inside the fold.
    expect(screen.queryByText('narration user-crashed')).toBeNull()
    expect(screen.getByText('answer user-crashed')).toBeInTheDocument()
  })
})
