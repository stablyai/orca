// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, screen } from '@testing-library/react'
import { render } from './native-chat-app-root-test-render'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalTurnScope
} from '../../../../shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'

let restoreViewport = (): void => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())
afterEach(cleanup)

const text = (
  id: string,
  role: NativeChatMessage['role'],
  body: string,
  timestamp: number
): NativeChatMessage => ({
  id,
  role,
  blocks: [{ type: 'text', text: body }],
  timestamp,
  source: 'transcript'
})
const toolRun = (id: string, timestamp: number): NativeChatMessage => ({
  id,
  role: 'assistant',
  blocks: [{ type: 'tool-call', name: 'Bash', input: { command: 'sleep 5' }, state: 'completed' }],
  timestamp,
  source: 'transcript'
})

// Claude runs A; B is sent mid-turn and Claude answers it after A. The journal writes B when it is
// sent, so A's remaining tool run and its answer follow B there, and B's turn opens after them.
const messages = [
  text('user-a', 'user', 'Run the first job', 1),
  toolRun('a-tool-1', 2),
  text('user-b', 'user', 'Then run the second job', 3),
  toolRun('a-tool-2', 4),
  text('a-answer', 'assistant', 'FIRST DONE', 5),
  text('b-answer', 'assistant', 'SECOND DONE', 6)
]

/** With `statesScope` false the rows carry no turn scope, as a host older than turn scopes writes. */
function journal(bState: 'running' | 'completed', statesScope: boolean): AgentJournalRenderItem[] {
  const thread: AgentJournalTurnScope = { kind: 'thread' }
  const inTurn = (turnItemId: string): AgentJournalTurnScope => ({ kind: 'turn', turnItemId })
  const row = (
    itemId: string,
    body: AgentJournalItemBody,
    turnScope: AgentJournalTurnScope,
    sequence: number
  ): AgentJournalRenderItem => ({
    itemId,
    revision: 0,
    sequence,
    observedAt: sequence,
    body,
    ...(statesScope ? { turnScope } : {})
  })
  const said = (role: 'user' | 'assistant'): AgentJournalItemBody => ({
    kind: 'message',
    role,
    blocks: []
  })
  return [
    row('user-a', said('user'), thread, 1),
    row(
      'turn-a',
      { kind: 'turn', turnId: 'turn-a', state: 'completed', userItemId: 'user-a' },
      thread,
      2
    ),
    row('a-tool-1', said('assistant'), inTurn('turn-a'), 3),
    // Handed over while A runs, so the host scopes it to A's turn until its own opens.
    row('user-b', said('user'), inTurn('turn-a'), 4),
    row('a-tool-2', said('assistant'), inTurn('turn-a'), 5),
    row('a-answer', said('assistant'), inTurn('turn-a'), 6),
    row(
      'turn-b',
      { kind: 'turn', turnId: 'turn-b', state: bState, userItemId: 'user-b' },
      thread,
      7
    ),
    row('b-answer', said('assistant'), inTurn('turn-b'), 8)
  ]
}

const session = (status: NativeChatLiveSession['status']): NativeChatLiveSession => ({
  messages,
  status,
  sessionId: 'session-1',
  agent: 'claude',
  hasMore: false,
  loadingEarlier: false,
  olderHistoryGeneration: 0,
  loadEarlier: vi.fn(),
  readPhase: 'ready'
})

function expectInOrder(...nodes: Element[]): void {
  for (const [index, node] of nodes.slice(1).entries()) {
    expect(nodes[index]!.compareDocumentPosition(node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  }
}

const bar = (label: string | RegExp): Element =>
  screen.getByText(label).closest('[data-native-chat-turn-status]')!

describe.each([['states each row’s turn', true]])(
  'a message the provider answered after the running turn, on a host that %s',
  (_host, statesScope) => {
    it("draws A's remaining rows and answer under A's bar, then B's bubble and turn", () => {
      render(
        <NativeChatMessageList
          session={session('working')}
          journalItems={journal('running', statesScope)}
          journalSubmissions={[]}
          isWorking
          workingStartedAt={Date.now() - 1000}
          settledTurns={new Map([['user-a', { startedAt: 1, workedSeconds: 17 }]])}
          expandSignal={false}
        />
      )

      expectInOrder(
        screen.getByText('Run the first job'),
        bar('Worked for 17s'),
        screen.getByText('FIRST DONE'),
        screen.getByText('Then run the second job'),
        bar(/Working for/),
        screen.getByText('SECOND DONE')
      )
    })

    it('keeps that order once both turns settle', () => {
      render(
        <NativeChatMessageList
          session={session('ready')}
          journalItems={journal('completed', statesScope)}
          journalSubmissions={[]}
          isWorking={false}
          workingStartedAt={null}
          settledTurns={
            new Map([
              ['user-a', { startedAt: 1, workedSeconds: 17 }],
              ['user-b', { startedAt: 2, workedSeconds: 51 }]
            ])
          }
          expandSignal={false}
        />
      )

      expectInOrder(
        screen.getByText('Run the first job'),
        bar('Worked for 17s'),
        screen.getByText('FIRST DONE'),
        screen.getByText('Then run the second job'),
        bar('Worked for 51s'),
        screen.getByText('SECOND DONE')
      )
    })
  }
)
