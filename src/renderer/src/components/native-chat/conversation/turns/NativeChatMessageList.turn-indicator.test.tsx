// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, screen } from '@testing-library/react'
import { render } from '../../messages/actions/native-chat-tooltip-test-harness'
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
vi.mock('../../media/visuals/NativeChatInlineVisual', () => ({
  NativeChatInlineVisual: unusedChatLeaves.inlineVisual
}))
vi.mock('@/lib/open-agent-message-sender', () => ({
  openAgentMessageSender: unusedChatLeaves.openSender
}))
afterEach(() => {
  expect(unusedChatLeaves.inlineVisual).not.toHaveBeenCalled()
  expect(unusedChatLeaves.openSender).not.toHaveBeenCalled()
})
import type { NativeChatLiveSession } from '../../session/terminal/read/native-chat-live-session-contract'
import { NativeChatMessageList } from '../../NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from '../../viewport/virtualization/native-chat-message-list-test-viewport'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../../../../shared/agent-session/journal/agent-session-journal-turn-scope'

const reasoningRow: AgentJournalItemBody = {
  kind: 'message',
  role: 'reasoning',
  blocks: [{ type: 'text', text: '' }]
}

function journalItem(sequence: number, body: AgentJournalItemBody): AgentJournalRenderItem {
  return { itemId: `item-${sequence}`, revision: 1, sequence, observedAt: sequence, body }
}

let restoreViewport = (): void => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())
afterEach(cleanup)

const session: NativeChatLiveSession = {
  messages: [
    {
      id: 'assistant-1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Selectable agent response.' }],
      timestamp: 1,
      source: 'transcript'
    }
  ],
  status: 'ready',
  sessionId: 'session-1',
  agent: 'codex',
  hasMore: false,
  loadingEarlier: false,
  olderHistoryGeneration: 0,
  loadEarlier: vi.fn(),
  readPhase: 'ready'
}

// Live turns show a prompt clock and tail activity; settled turns retain the clock bar.
describe('NativeChatMessageList turn indicator', () => {
  // The trailing run stays live between calls until the turn ends; its motion stays separate from the tail spinner.
  it('keeps the trailing run live while the turn tail spins, then settles both', () => {
    const workingSession: NativeChatLiveSession = {
      ...session,
      status: 'working',
      messages: [
        {
          id: 'assistant-settled-tool',
          role: 'assistant',
          blocks: [
            {
              type: 'tool-call',
              name: 'shell',
              input: { command: 'pnpm test' },
              state: 'completed'
            },
            { type: 'tool-result', output: 'passed' }
          ],
          timestamp: 1,
          source: 'transcript'
        }
      ]
    }
    const { container, rerender } = render(
      <NativeChatMessageList
        session={workingSession}
        isWorking
        turnActivity={{ kind: 'description', text: 'Preparing the answer' }}
        expandSignal={false}
      />
    )

    const liveRun = screen.getByText('Running 1 command').closest('button')
    expect(liveRun).toHaveTextContent('pnpm test')
    expect(liveRun?.querySelector('.animate-pulse')).toBeInTheDocument()
    expect(liveRun?.querySelector('.animate-spin')).toBeNull()
    expect(liveRun?.querySelector('.lucide-check')).toBeNull()
    const activity = screen.getByText('Preparing the answer')
    expect(activity).not.toHaveClass('animate-pulse', 'animate-spin')
    expect(activity.closest('[data-native-chat-turn-activity]')?.querySelector('svg')).toHaveClass(
      'animate-spin'
    )

    rerender(
      <NativeChatMessageList
        session={{ ...workingSession, status: 'ready' }}
        isWorking={false}
        turnActivity={{ kind: 'description', text: 'Preparing the answer' }}
        expandSignal={false}
      />
    )

    expect(container.querySelector('[data-native-chat-turn-activity]')).toBeNull()
    expect(container.querySelector('.animate-pulse')).toBeNull()
    expect(container.querySelector('.animate-spin')).toBeNull()
    expect(liveRun).toBeInTheDocument()
    expect(liveRun).toHaveTextContent('pnpm test')
    expect(liveRun).not.toHaveTextContent('Running')
    expect(liveRun?.querySelector('.lucide-check')).toBeInTheDocument()
  })

  it('replaces a bridge ask row and settles it from the FIFO tool result', () => {
    const user = {
      id: 'bridge-user',
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'Help me choose' }],
      timestamp: 1,
      source: 'transcript' as const
    }
    const call = {
      id: 'bridge-ask',
      role: 'assistant' as const,
      blocks: [
        {
          type: 'tool-call' as const,
          name: 'AskUserQuestion',
          input: { questions: [{ question: 'Which branch?' }] }
        }
      ],
      timestamp: 2,
      source: 'transcript' as const
    }
    const bridgeSession: NativeChatLiveSession = {
      ...session,
      agent: 'claude',
      messages: [user, call],
      transcriptLifecycle: { state: 'working', turnId: user.id, timestamp: 1 }
    }
    const rendered = render(
      <NativeChatMessageList session={bridgeSession} isWorking={false} expandSignal={false} />
    )

    expect(screen.getByText('Awaiting user input:')).toBeInTheDocument()
    expect(screen.getByText('Which branch?')).toBeInTheDocument()
    expect(screen.queryByText(/AskUserQuestion/)).toBeNull()

    rendered.rerender(
      <NativeChatMessageList
        session={{
          ...bridgeSession,
          messages: [
            user,
            call,
            {
              id: 'bridge-answer',
              role: 'tool',
              blocks: [{ type: 'tool-result', output: 'main' }],
              timestamp: 3,
              source: 'transcript'
            }
          ]
        }}
        isWorking={false}
        expandSignal={false}
      />
    )

    expect(screen.queryByText('Awaiting user input:')).toBeNull()
    expect(screen.getByText('Asked:')).toBeInTheDocument()
    expect(screen.queryByText(/AskUserQuestion/)).toBeNull()
  })

  it('does not reuse completed-turn reasoning while the next dispatch is pending', () => {
    render(
      <NativeChatMessageList
        session={{
          ...session,
          status: 'working',
          messages: [
            {
              id: 'user-next',
              role: 'user',
              blocks: [{ type: 'text', text: 'Start the next task' }],
              timestamp: Date.now(),
              source: 'transcript'
            }
          ]
        }}
        journalItems={[
          journalItem(1, { kind: 'turn', turnId: 'turn-1', state: 'completed' }),
          journalItem(2, reasoningRow)
        ]}
        isWorking
        expandSignal={false}
      />
    )

    expect(screen.queryByText('Thinking')).toBeNull()
    expect(screen.getByText('Working…')).toBeInTheDocument()
  })

  it.each([
    ["a host that states each row's turn", true],
    ['a host that states none', false]
  ])(
    'keeps the live bar under the prompt that opened the running turn, not a message sent mid-turn, on %s',
    (_, scoped) => {
      const prompt = (id: string, text: string): NativeChatLiveSession['messages'][number] => ({
        id,
        role: 'user',
        blocks: [{ type: 'text', text }],
        timestamp: 1,
        source: 'transcript'
      })
      const messages = [
        prompt('user-a', 'Run four sleeps'),
        {
          id: 'tool-a',
          role: 'assistant' as const,
          blocks: [
            {
              type: 'tool-call' as const,
              name: 'Bash',
              input: { command: 'sleep 15' },
              state: 'running' as const
            }
          ],
          timestamp: 2,
          source: 'transcript' as const
        },
        prompt('user-b', 'Also say banana')
      ]
      // B was handed over while A's turn runs, so a host that states scopes puts it in that turn.
      const t1: AgentJournalTurnScope = { kind: 'turn', turnItemId: 't1' }
      const thread: AgentJournalTurnScope = { kind: 'thread' }
      const row = (
        itemId: string,
        sequence: number,
        body: AgentJournalItemBody,
        turnScope: AgentJournalTurnScope
      ): AgentJournalRenderItem => ({
        itemId,
        revision: 1,
        sequence,
        observedAt: sequence,
        body,
        ...(scoped ? { turnScope } : {})
      })
      const journal = (t1State: 'running' | 'completed', t2State?: 'running' | 'completed') => [
        row('user-a', 1, { kind: 'message', role: 'user', blocks: [] }, thread),
        row('t1', 2, { kind: 'turn', turnId: 't1', state: t1State, userItemId: 'user-a' }, thread),
        row('tool-a', 3, { kind: 'message', role: 'assistant', blocks: [] }, t1),
        row('user-b', 4, { kind: 'message', role: 'user', blocks: [] }, t1),
        ...(t2State
          ? [
              row(
                't2',
                5,
                { kind: 'turn', turnId: 't2', state: t2State, userItemId: 'user-b' },
                thread
              )
            ]
          : [])
      ]
      const list = (props: Partial<React.ComponentProps<typeof NativeChatMessageList>>) => (
        <NativeChatMessageList
          session={{ ...session, status: 'working', messages }}
          isWorking
          expandSignal={false}
          {...props}
        />
      )
      // B was sent while A's turn runs: the host's record still names A as the running turn's opener.
      const { rerender } = render(
        list({
          workingStartedAt: Date.now() - 5000,
          settledTurns: new Map(),
          journalItems: journal('running')
        })
      )
      const barA = screen.getByText('Working for 5s').closest('[data-native-chat-turn-status]')
      expect(screen.getAllByText(/Working for/)).toHaveLength(1)
      expect(screen.getByText('Run four sleeps').compareDocumentPosition(barA!)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      )
      expect(barA!.compareDocumentPosition(screen.getByText('Also say banana'))).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      )

      // A’s bar settles under A; tool scope or journal order keeps A’s work inside its fold.
      const expectSettledUnderA = () => {
        const settledA = screen
          .getByText('Worked for 17s')
          .closest('[data-native-chat-turn-status]')
        expect(screen.getByText('Run four sleeps').compareDocumentPosition(settledA!)).toBe(
          Node.DOCUMENT_POSITION_FOLLOWING
        )
        expect(settledA!.compareDocumentPosition(screen.getByText('Also say banana'))).toBe(
          Node.DOCUMENT_POSITION_FOLLOWING
        )
      }

      // B's own turn opens: A settles in place and B counts from A's end.
      rerender(
        list({
          workingStartedAt: Date.now() - 1000,
          settledTurns: new Map([['user-a', { startedAt: 1, workedSeconds: 17 }]]),
          journalItems: journal('completed', 'running')
        })
      )
      expectSettledUnderA()
      const barB = screen.getByText('Working for 1s').closest('[data-native-chat-turn-status]')
      expect(screen.getByText('Also say banana').compareDocumentPosition(barB!)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      )

      rerender(
        list({
          isWorking: false,
          session: { ...session, status: 'ready', messages },
          workingStartedAt: null,
          settledTurns: new Map([
            ['user-a', { startedAt: 1, workedSeconds: 17 }],
            ['user-b', { startedAt: 2, workedSeconds: 51 }]
          ]),
          journalItems: journal('completed', 'completed')
        })
      )
      expectSettledUnderA()
      expect(
        screen
          .getByText('Also say banana')
          .compareDocumentPosition(screen.getByText('Worked for 51s'))
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
      expect(screen.queryByText(/Working for/)).toBeNull()
    }
  )
})
