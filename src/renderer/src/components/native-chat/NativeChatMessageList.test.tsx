// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { subagentGroupFallbackText } from '../../../../shared/native-chat-subagent-summary'
import type {
  NativeChatMessage,
  NativeChatSubagentEntry
} from '../../../../shared/native-chat-types'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'

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
  loadEarlier: vi.fn(),
  readPhase: 'ready'
}

describe('NativeChatMessageList assistant messages', () => {
  it('keeps prose selectable and places non-selectable controls after it', () => {
    render(
      <NativeChatMessageList
        session={session}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
      />
    )

    const prose = screen.getByText('Selectable agent response.')
    const row = prose.closest('.group')
    const copyButton = screen.getByRole('button', { name: 'Copy message' })
    const controls = copyButton.parentElement

    expect(row).toHaveClass('select-text')
    expect(controls).toHaveClass('select-none', 'can-hover:pointer-events-none', 'mt-1')
    expect(controls).not.toHaveClass('absolute')
    expect(prose.compareDocumentPosition(controls!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })

  it('keeps a running tool live when transcript lifecycle metadata is absent', () => {
    render(
      <NativeChatMessageList
        session={{
          ...session,
          status: 'working',
          messages: [
            {
              id: 'assistant-tool-1',
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
      />
    )

    expect(screen.getByText('Running sleep 5')).toBeInTheDocument()
    expect(screen.queryByText('1×')).toBeNull()
    expect(document.querySelector('.text-destructive')).toBeNull()
  })

  it('keeps a reduced-motion-safe spinner activity line at the tail of a no-tool Codex turn', () => {
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

  it('keeps the broad fallback distinct from the running tool row', () => {
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

    const toolLabel = screen.getByText('Running pnpm test')
    expect(toolLabel).toHaveClass('animate-pulse')
    expect(screen.getAllByText('Running pnpm test')).toHaveLength(1)
    const activity = screen.getByText('Working…')
    expect(activity.textContent).not.toBe(toolLabel.textContent)
    expect(activity).not.toHaveTextContent('shell')
    expect(activity).not.toHaveTextContent('pnpm test')
    const spinner = activity.closest('[data-native-chat-turn-activity]')?.querySelector('svg')
    expect(activity).not.toHaveClass('animate-pulse', 'animate-spin')
    expect(spinner).toHaveClass('animate-spin', 'motion-reduce:animate-none')
  })

  it('uses the broad fallback after a tool settles', () => {
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

    const settledTool = screen.getByText('shell')
    const activity = screen.getByText('Working…')
    expect(activity.textContent).not.toBe(settledTool.textContent)
    expect(activity).not.toHaveTextContent('shell')
    expect(activity).not.toHaveTextContent('pnpm test')
    expect(activity).not.toHaveClass('animate-pulse', 'animate-spin')
    expect(activity.closest('[data-native-chat-turn-activity]')?.querySelector('svg')).toHaveClass(
      'animate-spin'
    )
  })

  it('keeps a completed tool row static while the turn tail spins, then removes the tail', () => {
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

    const settledTool = screen.getByText('shell')
    expect(settledTool).toHaveTextContent('shell pnpm test')
    expect(settledTool.closest('button')?.querySelector('.animate-pulse')).toBeNull()
    expect(settledTool.closest('button')?.querySelector('.lucide-check')).toBeInTheDocument()
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

  it('keeps the current tool live when a stale completed lifecycle meets active hook state', () => {
    render(
      <NativeChatMessageList
        session={{
          ...session,
          status: 'working',
          transcriptLifecycle: { state: 'completed', turnId: 'old-turn', timestamp: 1 },
          messages: [
            {
              id: 'current-tool',
              role: 'assistant',
              blocks: [
                {
                  type: 'tool-call',
                  name: 'shell',
                  input: { command: 'sleep 5' },
                  state: 'running'
                }
              ],
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

    expect(screen.getByText('Running sleep 5')).toBeInTheDocument()
  })

  it('shows a stable thinking status directly below the user message', () => {
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
        isWorking
        expandSignal={false}
        fontScale={1}
      />
    )

    const user = screen.getByText('Start the task')
    const thinking = screen.getByText('Thinking')
    expect(user.compareDocumentPosition(thinking)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(thinking.parentElement).not.toHaveClass('border-b')
    expect(thinking.parentElement).toHaveClass('text-sm')
    expect(container.querySelector('.animate-bounce')).toBeNull()
    expect(thinking).toHaveClass('animate-pulse')
    expect(container.querySelectorAll('.size-1.5.animate-pulse')).toHaveLength(0)
  })

  it('places the thinking status directly after the latest user message', () => {
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
    const status = screen.getByText('Working for 0s')
    const assistant = screen.getByText('I am checking now.')
    expect(user.compareDocumentPosition(status)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(status.compareDocumentPosition(assistant)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    expect(status.parentElement).toHaveClass('border-b')
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
    expect(screen.getByText('Thinking')).toBeInTheDocument()
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
    expect(screen.queryByRole('button', { name: /1× shell/ })).toBeNull()
    fireEvent.click(status)
    expect(status).toHaveAttribute('aria-expanded', 'true')
    const tool = screen.getByRole('button', { name: /1× shell/ })
    expect(tool).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getAllByRole('button', { name: /shell pwd/ })[1]).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  })
})

// List-level, because every defect this feature has shipped so far lived in the
// assembly between rows — the roster is its own `role: 'system'` journal row, and
// what reaches the DOM depends on `foldToolMessages`, the turn-key mapping and the
// disclosure state the list owns. Rendering `NativeChatToolRun` in isolation
// supplies those by hand and agrees with whatever the caller was asked to assume.
describe('NativeChatMessageList spawn-group roster', () => {
  const ROSTER: NativeChatSubagentEntry[] = [
    { id: 'a', label: 'read', state: 'completed' },
    { id: 'b', label: 'search', state: 'failed' }
  ]

  /** The exact two-block row `codexSubagentGroupBody` writes: the structured
   *  block plus the plain-text twin a client without the block type reads. */
  function rosterMessage(agents: NativeChatSubagentEntry[], at: number): NativeChatMessage {
    return {
      id: 'roster-1',
      role: 'system',
      blocks: [
        { type: 'text', text: subagentGroupFallbackText(agents) },
        { type: 'subagent-group', groupId: 'thread-1:turn-1', agents }
      ],
      timestamp: at,
      source: 'transcript'
    }
  }

  // Explicit ascending timestamps: the list re-sorts by (timestamp, id), so rows
  // sharing a millisecond tie-break alphabetically and the user turn can land
  // last — which would strand the roster outside its own turn.
  function rosterSession(
    agents: NativeChatSubagentEntry[],
    startedAt: number
  ): NativeChatLiveSession {
    return {
      ...session,
      status: 'ready',
      messages: [
        {
          id: 'user-fanout',
          role: 'user',
          blocks: [{ type: 'text', text: 'Fan this out' }],
          timestamp: startedAt,
          source: 'transcript'
        },
        {
          id: 'assistant-fanout',
          role: 'assistant',
          blocks: [
            { type: 'tool-call', name: 'shell', input: { command: 'pwd' }, state: 'completed' },
            { type: 'tool-result', output: '/repo' }
          ],
          timestamp: startedAt + 1,
          source: 'transcript'
        },
        rosterMessage(agents, startedAt + 2)
      ]
    }
  }

  // A settled turn with its activity collapsed is the resting state of the whole
  // transcript, so this is the roster's normal appearance, not an edge case. The
  // completed-turn disclosure guard used to swallow it here — the compact row the
  // feature exists to leave behind vanished the moment its turn ended.
  it('leaves the roster row behind on a settled turn whose activity is collapsed', () => {
    const startedAt = Date.now() - 3000
    render(
      <NativeChatMessageList
        session={rosterSession(ROSTER, startedAt)}
        isWorking={false}
        workingStartedAt={startedAt}
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(screen.getByRole('button', { name: 'Toggle turn details' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.getByRole('button', { name: /Ran 2 subagents/ })).toHaveTextContent('1 failed')
    // The twin is the roster written out for clients that cannot draw the block.
    // This one draws it, so printing the sentence too would say it all twice.
    expect(screen.queryByText('Ran 2 subagents (1 failed)')).toBeNull()
  })

  // The block is provider-agnostic — the Claude lane feeds it too — so a lane
  // that folds a roster into a message carrying real prose is a live shape. The
  // filter used to drop EVERY text block once a roster was present, so that
  // prose vanished on desktop while mobile, which reads the raw blocks, kept it.
  it('keeps prose beside a roster block and drops only the twin', () => {
    const startedAt = Date.now() - 3000
    const twin = subagentGroupFallbackText(ROSTER)
    render(
      <NativeChatMessageList
        session={{
          ...rosterSession(ROSTER, startedAt),
          messages: [
            {
              id: 'roster-with-prose',
              role: 'assistant',
              blocks: [
                { type: 'text', text: 'Handing the audit to two children.' },
                { type: 'text', text: twin },
                { type: 'subagent-group', groupId: 'thread-1:turn-1', agents: ROSTER }
              ],
              timestamp: startedAt + 3,
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

    expect(screen.getByText('Handing the audit to two children.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Ran 2 subagents/ })).toBeInTheDocument()
    expect(screen.queryByText(twin)).toBeNull()
  })

  // The reordering that kept the roster visible must not have let TOOL activity
  // out from behind the same disclosure: a failed child command reading as live
  // on a finished turn is what put that guard there.
  it('keeps tool activity behind the disclosure the roster now bypasses', () => {
    const startedAt = Date.now() - 3000
    render(
      <NativeChatMessageList
        session={rosterSession(ROSTER, startedAt)}
        isWorking={false}
        workingStartedAt={startedAt}
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(screen.queryByRole('button', { name: /1× shell/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Toggle turn details' }))
    expect(screen.getByRole('button', { name: /1× shell/ })).toBeInTheDocument()
    // Expanding must reveal the tools beside the roster, never a second copy of it.
    expect(screen.getAllByRole('button', { name: /Ran 2 subagents/ })).toHaveLength(1)
  })

  it('reads as a live spawn while the turn is still working', () => {
    render(
      <NativeChatMessageList
        session={{
          ...rosterSession(
            [
              { id: 'a', label: 'read', state: 'working' },
              { id: 'b', label: 'search', state: 'working' }
            ],
            Date.now() - 3000
          ),
          status: 'working'
        }}
        isWorking
        workingStartedAt={Date.now()}
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(screen.getByRole('button', { name: /Kicked off 2 subagents/ })).toHaveTextContent(
      '2 working'
    )
  })

  // The QA defect, at the seam that produced it. A mid-turn correction opens a
  // NEW turn, so `isCurrentTurn` goes false for the fan-out's row and the list
  // passes `activeTurnIsWorking={false}` down to the roster. The row used to
  // relabel every live child `unverifiable` and flip its headline to "Ran" —
  // claiming both that contact was lost and that the fan-out had finished, while
  // the three real children were still running and completed 57-87s later.
  it('keeps live children working after a newer turn supersedes their own', () => {
    const startedAt = Date.now() - 3000
    const live = rosterSession(
      [
        { id: 'a', label: 'read_readme', state: 'working', startedAt },
        { id: 'b', label: 'read_package', state: 'working', startedAt }
      ],
      startedAt
    )
    render(
      <NativeChatMessageList
        session={{
          ...live,
          status: 'working',
          messages: [
            ...live.messages,
            {
              id: 'user-correction',
              role: 'user',
              blocks: [{ type: 'text', text: 'Actually, read the styleguide too' }],
              timestamp: startedAt + 3,
              source: 'transcript'
            }
          ]
        }}
        isWorking
        workingStartedAt={startedAt + 3}
        expandSignal={false}
        fontScale={1}
      />
    )

    const roster = screen.getByRole('button', { name: /Kicked off 2 subagents/ })
    expect(roster).toHaveTextContent('2 working')
    expect(roster).not.toHaveTextContent('unverifiable')
    expect(screen.queryByRole('button', { name: /Ran 2 subagents/ })).toBeNull()
  })
})

// The block schema admits `agents: []`, so a childless spawn group is a shape the
// wire allows even though no producer writes one. It draws nothing, so the row
// must not be mounted on its account: "counts as renderable" and "actually draws"
// have to answer the same. A row that passes the first and fails the second is an
// invisible div that still consumes one `gap-5` slot of the transcript.
describe('NativeChatMessageList childless spawn group', () => {
  const NO_AGENTS: NativeChatSubagentEntry[] = []

  function rosterSession(blocks: NativeChatMessage['blocks'], at: number): NativeChatLiveSession {
    return {
      ...session,
      status: 'ready',
      messages: [
        {
          id: 'user-fanout',
          role: 'user',
          blocks: [{ type: 'text', text: 'Fan this out' }],
          timestamp: at,
          source: 'transcript'
        },
        { id: 'roster-1', role: 'system', blocks, timestamp: at + 1, source: 'transcript' }
      ]
    }
  }

  /** Every slot the transcript column lays out — one per row that mounted. */
  function emptySlots(container: HTMLElement): Element[] {
    const column = container.querySelector('.max-w-4xl')
    expect(column).not.toBeNull()
    return Array.from(column!.children).filter((slot) => slot.textContent === '')
  }

  it('mounts no row for a bare spawn group with no children', () => {
    const startedAt = Date.now() - 3000
    const { container } = render(
      <NativeChatMessageList
        session={rosterSession(
          [{ type: 'subagent-group', groupId: 'thread-1:turn-1', agents: NO_AGENTS }],
          startedAt
        )}
        isWorking={false}
        workingStartedAt={startedAt}
        expandSignal={false}
        fontScale={1}
      />
    )

    expect(screen.getByText('Fan this out')).toBeInTheDocument()
    expect(emptySlots(container)).toEqual([])
  })

  it('falls back to the plain-text twin when the block it stands in for cannot draw', () => {
    const startedAt = Date.now() - 3000
    const { container } = render(
      <NativeChatMessageList
        session={rosterSession(
          [
            { type: 'text', text: subagentGroupFallbackText(NO_AGENTS) },
            { type: 'subagent-group', groupId: 'thread-1:turn-1', agents: NO_AGENTS }
          ],
          startedAt
        )}
        isWorking={false}
        workingStartedAt={startedAt}
        expandSignal={false}
        fontScale={1}
      />
    )

    // The twin is dropped only because the block draws the roster instead. This
    // one cannot, so suppressing it too would leave the row with nothing at all.
    expect(screen.getByText(subagentGroupFallbackText(NO_AGENTS))).toBeInTheDocument()
    expect(emptySlots(container)).toEqual([])
  })
})
