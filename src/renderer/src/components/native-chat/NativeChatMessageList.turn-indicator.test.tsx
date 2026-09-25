// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'
import type {
  AgentJournalItemBody,
  AgentJournalRenderItem
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

// The live turn renders exactly one indicator row; a settled turn keeps its own.
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

    const activity = screen.getByText('Working for 0s')
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
    const activity = screen.getByText('Working for 0s')
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
        showLiveTurnActivity={false}
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(container.querySelector('[data-native-chat-turn-activity]')).toBeNull()
    expect(screen.queryByText(/Working for/)).toBeNull()
    expect(screen.queryByText('Thinking')).toBeNull()
    expect(screen.getByText('Running 1 command')).toHaveClass('animate-pulse')
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
    const activity = screen.getByText('Working for 0s')
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

  it('keeps bridge chats on the legacy activity chrome', () => {
    render(
      <NativeChatMessageList
        session={{
          ...session,
          status: 'working',
          messages: [
            {
              id: 'bridge-tool',
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
        expandSignal={false}
        fontScale={1}
        showTurnStatus={false}
      />
    )

    expect(screen.queryByText('Thinking')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Toggle turn details' })).toBeNull()
    expect(screen.queryByText('Running sleep 5')).toBeNull()
    expect(document.querySelectorAll('.animate-bounce')).toHaveLength(3)
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
        showTurnStatus={false}
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
        showTurnStatus={false}
      />
    )

    expect(screen.queryByText('Awaiting user input:')).toBeNull()
    expect(screen.getByText('Asked:')).toBeInTheDocument()
    expect(screen.queryByText(/AskUserQuestion/)).toBeNull()
  })

  it('reads "Thinking" on the one live row while the turn is reasoning', () => {
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
    const thinking = screen.getByText('Thinking')
    expect(user.compareDocumentPosition(thinking)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    // One indicator, not a "Thinking" row stacked above a spinning "Working…" row.
    expect(container.querySelectorAll('[data-native-chat-turn-status]')).toHaveLength(1)
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
    expect(screen.getByText('Working for 0s')).toBeInTheDocument()
  })

  it('lets provider activity text beat the reasoning label on the same single row', () => {
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
    expect(container.querySelectorAll('[data-native-chat-turn-status]')).toHaveLength(1)
  })

  it('places the one live row after the newest content in the turn', () => {
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

    const status = screen.getByText('Working for 0s')
    const assistant = screen.getByText('I am checking now.')
    // The live row trails the newest content instead of sitting under the prompt.
    expect(assistant.compareDocumentPosition(status)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(document.querySelectorAll('[data-native-chat-turn-status]')).toHaveLength(1)
  })

  it('shows elapsed working time once tool activity starts', () => {
    render(
      <NativeChatMessageList
        session={{
          ...session,
          status: 'working',
          messages: [
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
