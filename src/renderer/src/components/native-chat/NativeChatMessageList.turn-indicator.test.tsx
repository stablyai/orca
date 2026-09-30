// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalTurnScope
} from '../../../../shared/agent-session-journal-types'

// The turn record this host writes, and the legacy status row an older host sends.
const turnItem: AgentJournalItemBody = { kind: 'turn', turnId: 'turn-1', state: 'running' }
const legacyTurnRow: AgentJournalItemBody = {
  kind: 'status',
  text: 'Codex is working…',
  turnLifecycle: { turnId: 'turn-1', state: 'running' }
}
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

// The live turn has two rows: the clock bar under the prompt, and a tail line that
// says what the turn is doing. A settled turn keeps only the bar.
describe('NativeChatMessageList turn indicator', () => {
  it('keeps a reduced-motion-safe spinner on the live row of a no-tool Codex turn', () => {
    render(
      <NativeChatMessageList
        session={{
          ...session,
          status: 'working',
          messages: [
            {
              id: 'user-prose',
              role: 'user',
              blocks: [{ type: 'text', text: 'Write a long answer' }],
              timestamp: 1,
              source: 'transcript'
            },
            {
              id: 'assistant-prose',
              role: 'assistant',
              blocks: [{ type: 'text', text: 'The answer is still streaming.' }],
              timestamp: 2,
              source: 'transcript'
            }
          ]
        }}
        isWorking
        expandSignal={false}
        fontScale={1}
      />
    )

    const activity = screen.getByText('Working…')
    const row = activity.closest('[data-native-chat-turn-activity]')
    const spinner = row?.querySelector('svg')
    expect(activity).not.toHaveClass('animate-pulse', 'animate-spin')
    expect(spinner).toHaveClass('size-4', 'animate-spin', 'motion-reduce:animate-none')
    expect(row).toHaveAttribute('aria-live', 'polite')
    expect(screen.getByText('The answer is still streaming.').compareDocumentPosition(row!)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )
  })

  it('keeps the live row distinct from the running tool row', () => {
    render(
      <NativeChatMessageList
        session={{
          ...session,
          status: 'working',
          messages: [
            {
              id: 'assistant-running-tool',
              role: 'assistant',
              blocks: [
                {
                  type: 'tool-call',
                  name: 'shell',
                  input: { command: 'pnpm test' },
                  state: 'running'
                }
              ],
              timestamp: 1,
              source: 'transcript'
            }
          ]
        }}
        isWorking
        expandSignal={false}
        fontScale={1}
      />
    )

    const toolLabel = screen.getByText('Running 1 command')
    expect(toolLabel).toHaveClass('animate-pulse')
    expect(screen.getAllByText('Running 1 command')).toHaveLength(1)
    expect(screen.getByText('pnpm test')).toBeInTheDocument()
    const activity = screen.getByText('Working…')
    expect(activity.textContent).not.toBe(toolLabel.textContent)
    expect(activity).not.toHaveTextContent('shell')
    expect(activity).not.toHaveTextContent('pnpm test')
    const spinner = activity.closest('[data-native-chat-turn-activity]')?.querySelector('svg')
    expect(activity).not.toHaveClass('animate-pulse', 'animate-spin')
    expect(spinner).toHaveClass('animate-spin', 'motion-reduce:animate-none')
  })

  it('hides foreground turn activity without settling live tool state', () => {
    const { container } = render(
      <NativeChatMessageList
        session={{
          ...session,
          status: 'working',
          messages: [
            {
              id: 'assistant-running-tool',
              role: 'assistant',
              blocks: [
                {
                  type: 'tool-call',
                  name: 'shell',
                  input: { command: 'pnpm test' },
                  state: 'running'
                }
              ],
              timestamp: 1,
              source: 'transcript'
            }
          ]
        }}
        journalItems={[journalItem(1, turnItem), journalItem(2, reasoningRow)]}
        isWorking
        awaitingInput="shown"
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(container.querySelector('[data-native-chat-turn-activity]')).toBeNull()
    expect(screen.queryByText(/Working for/)).toBeNull()
    expect(screen.queryByText('Thinking')).toBeNull()
    expect(screen.getByText('Running 1 command')).toHaveClass('animate-pulse')
  })

  // A terminal-backed pane can learn its agent is waiting without being handed
  // the prompt; the tail then says so, in the row a question uses.
  it('says the turn waits on the reader when no card shows the prompt', () => {
    const { container } = render(
      <NativeChatMessageList
        session={{
          ...session,
          messages: [
            {
              id: 'user-wait',
              role: 'user',
              blocks: [{ type: 'text', text: 'Deploy it' }],
              timestamp: 1,
              source: 'transcript'
            }
          ]
        }}
        isWorking
        workingStartedAt={Date.now() - 5000}
        awaitingInput="unshown"
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(container.querySelector('[data-native-chat-ask-row="awaiting"]')).toHaveTextContent(
      /^Awaiting user input$/
    )
    expect(container.querySelector('[data-native-chat-turn-activity]')).toBeNull()
    expect(screen.getByText('Working for 5s')).toBeInTheDocument()
  })

  it('keeps the live row up after a tool settles', () => {
    render(
      <NativeChatMessageList
        session={{
          ...session,
          status: 'working',
          messages: [
            {
              id: 'assistant-completed-tool',
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
        }}
        isWorking
        expandSignal={false}
        fontScale={1}
      />
    )

    // The settled run heads with the command it ran; the live row is separate.
    const settledTool = screen.getByText('pnpm test')
    const activity = screen.getByText('Working…')
    expect(activity.textContent).not.toBe(settledTool.textContent)
    expect(activity).not.toHaveTextContent('shell')
    expect(activity).not.toHaveTextContent('pnpm test')
    expect(activity).not.toHaveClass('animate-pulse', 'animate-spin')
    expect(activity.closest('[data-native-chat-turn-activity]')?.querySelector('svg')).toHaveClass(
      'animate-spin'
    )
  })

  // The run is the turn's trailing one, so it stays live between calls and only
  // settles with the turn. Its motion is its own — the tail's spinner never
  // migrates onto it — and both are gone once the turn is.
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
        fontScale={1}
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
        fontScale={1}
      />
    )

    expect(container.querySelector('[data-native-chat-turn-activity]')).toBeNull()
    expect(container.querySelector('.animate-pulse')).toBeNull()
    expect(container.querySelector('.animate-spin')).toBeNull()
    // Same element, now settled: the lone command names it, marked done.
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
      <NativeChatMessageList
        session={bridgeSession}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
      />
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
        fontScale={1}
      />
    )

    expect(screen.queryByText('Awaiting user input:')).toBeNull()
    expect(screen.getByText('Asked:')).toBeInTheDocument()
    expect(screen.queryByText(/AskUserQuestion/)).toBeNull()
  })

  it('reads "Thinking" on the tail line while the bar keeps the clock', () => {
    const { container } = render(
      <NativeChatMessageList
        session={{
          ...session,
          status: 'working',
          messages: [
            {
              id: 'user-thinking',
              role: 'user',
              blocks: [{ type: 'text', text: 'Start the task' }],
              timestamp: Date.now(),
              source: 'transcript'
            }
          ]
        }}
        journalItems={[journalItem(1, turnItem), journalItem(2, reasoningRow)]}
        isWorking
        expandSignal={false}
        fontScale={1}
      />
    )

    const user = screen.getByText('Start the task')
    const bar = screen.getByText('Working for 0s')
    const thinking = screen.getByText('Thinking')
    expect(user.compareDocumentPosition(bar)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(bar.compareDocumentPosition(thinking)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(screen.getAllByText('Thinking')).toHaveLength(1)
    expect(screen.queryByText('Working…')).toBeNull()
    expect(thinking.closest('[data-native-chat-turn-activity]')?.querySelector('svg')).toHaveClass(
      'animate-spin'
    )
    expect(container.querySelector('.animate-bounce')).toBeNull()
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
        fontScale={1}
      />
    )

    expect(screen.queryByText('Thinking')).toBeNull()
    expect(screen.getByText('Working…')).toBeInTheDocument()
  })

  it('lets provider activity text beat the reasoning label on the tail line', () => {
    const { container } = render(
      <NativeChatMessageList
        session={{
          ...session,
          status: 'working',
          messages: [
            {
              id: 'user-activity',
              role: 'user',
              blocks: [{ type: 'text', text: 'Start the task' }],
              timestamp: Date.now(),
              source: 'transcript'
            }
          ]
        }}
        journalItems={[journalItem(1, legacyTurnRow), journalItem(2, reasoningRow)]}
        turnActivity={{ kind: 'description', text: 'Exploring the repo layout' }}
        isWorking
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(screen.getByText('Exploring the repo layout')).toBeInTheDocument()
    expect(screen.queryByText('Thinking')).toBeNull()
    expect(container.querySelectorAll('[data-native-chat-turn-activity]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-native-chat-turn-status]')).toHaveLength(1)
  })

  it('puts the clock bar under the prompt and the tail line after the newest content', () => {
    render(
      <NativeChatMessageList
        session={{
          ...session,
          status: 'working',
          messages: [
            {
              id: 'user-1',
              role: 'user',
              blocks: [{ type: 'text', text: 'Run the checks' }],
              timestamp: 1,
              source: 'transcript'
            },
            {
              id: 'assistant-1',
              role: 'assistant',
              blocks: [{ type: 'text', text: 'I am checking now.' }],
              timestamp: 2,
              source: 'transcript'
            }
          ]
        }}
        isWorking
        expandSignal={false}
        fontScale={1}
      />
    )

    const user = screen.getByText('Run the checks')
    const bar = screen.getByText('Working for 0s')
    const assistant = screen.getByText('I am checking now.')
    const tail = screen.getByText('Working…')
    expect(user.compareDocumentPosition(bar)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(bar.compareDocumentPosition(assistant)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(assistant.compareDocumentPosition(tail)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(bar.closest('[data-native-chat-turn-status]')).toHaveAttribute(
      'data-native-chat-turn-status',
      'active'
    )
    // The clock is said once, on the bar.
    expect(screen.getAllByText(/Working for/)).toHaveLength(1)
  })

  it('shows elapsed working time on the bar while a tool runs', () => {
    render(
      <NativeChatMessageList
        session={{
          ...session,
          status: 'working',
          messages: [
            {
              id: 'user-tool',
              role: 'user',
              blocks: [{ type: 'text', text: 'Wait a bit' }],
              timestamp: 1,
              source: 'transcript'
            },
            {
              id: 'tool-1',
              role: 'assistant',
              blocks: [
                {
                  type: 'tool-call',
                  name: 'shell',
                  input: { command: 'sleep 5' },
                  state: 'running'
                }
              ],
              timestamp: 1,
              source: 'transcript'
            }
          ]
        }}
        isWorking
        workingStartedAt={Date.now() - 3000}
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(screen.getByText('Working for 3s')).toBeInTheDocument()
  })

  it('keeps the completed duration below the user message', () => {
    const startedAt = Date.now() - 3000
    const turnSession: NativeChatLiveSession = {
      ...session,
      status: 'working',
      messages: [
        {
          id: 'user-complete',
          role: 'user',
          blocks: [{ type: 'text', text: 'Complete this task' }],
          timestamp: startedAt,
          source: 'transcript'
        },
        {
          id: 'assistant-complete',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Task complete.' }],
          timestamp: Date.now(),
          source: 'transcript'
        }
      ]
    }
    const { rerender } = render(
      <NativeChatMessageList
        session={turnSession}
        isWorking
        workingStartedAt={startedAt}
        expandSignal={false}
        fontScale={1}
      />
    )
    // The live bar sits where the settled one will, so settling never moves it.
    const liveBar = screen.getByText('Working for 3s')
    expect(screen.getByText('Complete this task').compareDocumentPosition(liveBar)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING
    )

    rerender(
      <NativeChatMessageList
        session={{ ...turnSession, status: 'ready' }}
        isWorking={false}
        workingStartedAt={null}
        expandSignal={false}
        fontScale={1}
      />
    )

    const user = screen.getByText('Complete this task')
    const status = screen.getByText('Worked for 3s')
    // Settled in place: the same bar, not a remount.
    expect(status.closest('[data-native-chat-turn-status]')).toBe(
      liveBar.closest('[data-native-chat-turn-status]')
    )
    const assistant = screen.getByText('Task complete.')
    expect(user.compareDocumentPosition(status)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(status.compareDocumentPosition(assistant)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)

    rerender(
      <NativeChatMessageList
        session={{
          ...turnSession,
          status: 'working',
          messages: [
            ...turnSession.messages,
            {
              id: 'user-next',
              role: 'user',
              blocks: [{ type: 'text', text: 'Start another task' }],
              timestamp: Date.now(),
              source: 'transcript'
            }
          ]
        }}
        isWorking
        workingStartedAt={Date.now()}
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(screen.getByText('Worked for 3s')).toBeInTheDocument()
    expect(screen.getByText('Working for 0s')).toBeInTheDocument()
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
          fontScale={1}
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

      // A settles in place: under its prompt, above B. A's tool work is A's on either host (read
      // from its scope, or from journal order), so the settled bar becomes that work's fold toggle.
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

  it("uses the completed caret to expand that turn's tool details", () => {
    const startedAt = Date.now() - 3000
    render(
      <NativeChatMessageList
        session={{
          ...session,
          status: 'ready',
          messages: [
            {
              id: 'user-details',
              role: 'user',
              blocks: [{ type: 'text', text: 'Inspect the repo' }],
              timestamp: startedAt,
              source: 'transcript'
            },
            {
              id: 'assistant-details',
              role: 'assistant',
              blocks: [
                {
                  type: 'tool-call',
                  name: 'shell',
                  input: { command: 'pwd' },
                  state: 'completed'
                },
                { type: 'tool-result', output: '/repo' }
              ],
              timestamp: Date.now(),
              source: 'transcript'
            }
          ]
        }}
        isWorking={false}
        workingStartedAt={startedAt}
        expandSignal={false}
        fontScale={1}
      />
    )

    const status = screen.getByRole('button', { name: 'Toggle turn details' })
    expect(status).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByRole('button', { name: /pwd/ })).toBeNull()
    fireEvent.click(status)
    expect(status).toHaveAttribute('aria-expanded', 'true')
    // Opening the turn status reveals the turn, but does not open its nested
    // tool-run disclosure. The command remains a separate reader action.
    const tools = screen.getAllByRole('button', { name: /pwd/ })
    expect(tools).toHaveLength(1)
    expect(tools[0]).toHaveAttribute('aria-expanded', 'false')
  })
})
