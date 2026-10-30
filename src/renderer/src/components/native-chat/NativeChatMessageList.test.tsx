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

import { subagentGroupFallbackText } from '../../../../shared/native-chat/transcript/native-chat-subagent-summary'

import type {
  NativeChatMessage,
  NativeChatSubagentEntry
} from '../../../../shared/native-chat-types'

import type { NativeChatLiveSession } from './use-native-chat-live-session'

import { NativeChatMessageList } from './NativeChatMessageList'

import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'

import type {
  AgentJournalRenderItem,
  AgentJournalTurnScope
} from '../../../../shared/agent-session-journal-types'

{
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

  describe('NativeChatMessageList assistant messages', () => {
    let restoreViewport = (): void => {}
    beforeAll(() => {
      restoreViewport = installNativeChatMessageListTestViewport()
    })
    afterAll(() => restoreViewport())
    afterEach(cleanup)
    it.each([true, false])(
      'copies selections across message roots from the transcript (math=%s)',
      (math) => {
        const sources = math
          ? ['Before $x^2$ after.', 'Then \\(y_i\\).']
          : ['Before plain after.', 'Then plain.']
        const view = render(
          <NativeChatMessageList
            session={{
              ...session,
              messages: sources.map((text, index) => ({
                id: `selection-${index}`,
                role: 'assistant',
                blocks: [{ type: 'text', text }],
                timestamp: index + 1,
                source: 'transcript'
              }))
            }}
            isWorking={false}
            expandSignal={false}
          />
        )
        const transcript = view.container.querySelector('[data-native-chat-scroll]')
        const paragraphs = view.container.querySelectorAll('[data-native-chat-quote-source] p')
        if (!transcript || paragraphs.length !== 2) {
          throw new Error('Missing transcript paragraphs')
        }
        const range = document.createRange()
        range.setStart(paragraphs[0].firstChild ?? paragraphs[0], 0)
        range.setEnd(paragraphs[1], paragraphs[1].childNodes.length)
        const selection = document.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(range)
        for (const target of [paragraphs[0], transcript]) {
          const setData = vi.fn()
          const event = new Event('copy', { bubbles: true, cancelable: true })
          Object.defineProperty(event, 'clipboardData', { value: { setData } })
          fireEvent(target, event)
          if (math) {
            const copied = setData.mock.calls.find(([type]) => type === 'text/plain')?.[1]
            expect(copied).toBe(sources.join('\n\n'))
            expect(event.defaultPrevented).toBe(true)
          } else {
            expect(setData).not.toHaveBeenCalled()
            expect(event.defaultPrevented).toBe(false)
          }
        }
        const setData = vi.fn()
        const handled = new Event('copy', { bubbles: true, cancelable: true })
        handled.preventDefault()
        Object.defineProperty(handled, 'clipboardData', { value: { setData } })
        fireEvent(transcript, handled)
        expect(setData).not.toHaveBeenCalled()
        selection?.removeAllRanges()
      }
    )

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
        />
      )

      expect(screen.getByText('Running 1 command')).toBeInTheDocument()
      expect(screen.getByText('sleep 5')).toBeInTheDocument()
      expect(screen.queryByText('1×')).toBeNull()
      expect(document.querySelector('.text-destructive')).toBeNull()
    })

    it("holds back only the running turn's controls, and shows them once it ends", () => {
      const text = (
        id: string,
        role: 'user' | 'assistant',
        words: string,
        timestamp: number
      ): NativeChatMessage => ({
        id,
        role,
        blocks: [{ type: 'text', text: words }],
        timestamp,
        source: 'transcript'
      })
      const list = (isWorking: boolean) => (
        <NativeChatMessageList
          session={{
            ...session,
            status: isWorking ? 'working' : 'ready',
            messages: [
              text('user-1', 'user', 'First ask', 1),
              text('assistant-1', 'assistant', 'Finished reply.', 2),
              text('user-2', 'user', 'Second ask', 3),
              text('assistant-2', 'assistant', 'Reply still coming', 4)
            ]
          }}
          isWorking={isWorking}
          expandSignal={false}
        />
      )
      const copyButtons = () => screen.queryAllByRole('button', { name: 'Copy message' })

      const { rerender } = render(list(true))
      // The finished turn keeps its controls; user bubbles carry their own copy button.
      expect(copyButtons()).toHaveLength(3)
      expect(screen.getAllByRole('button', { name: 'Scroll this message to top' })).toHaveLength(1)

      rerender(list(false))
      expect(copyButtons()).toHaveLength(4)
      expect(screen.getAllByRole('button', { name: 'Scroll this message to top' })).toHaveLength(2)
    })

    // Prose settles the preceding run; reasoning asides remain inside it.
    it('settles a run once prose follows it, but not for a reasoning aside', () => {
      const run = {
        id: 'assistant-tool-1',
        role: 'assistant' as const,
        blocks: [
          {
            type: 'tool-call' as const,
            name: 'shell',
            input: { command: 'sleep 5' },
            state: 'running' as const
          }
        ],
        timestamp: 1,
        source: 'transcript' as const
      }
      const after = (role: 'assistant' | 'reasoning') => ({
        id: `after-${role}`,
        role,
        blocks: [{ type: 'text' as const, text: 'Looking at the output.' }],
        timestamp: 2,
        source: 'transcript' as const
      })
      const { rerender } = render(
        <NativeChatMessageList
          session={{ ...session, status: 'working', messages: [run, after('reasoning')] }}
          isWorking
          expandSignal={false}
        />
      )
      expect(screen.getByText('Running 1 command')).toBeInTheDocument()

      rerender(
        <NativeChatMessageList
          session={{ ...session, status: 'working', messages: [run, after('assistant')] }}
          isWorking
          expandSignal={false}
        />
      )
      expect(screen.queryByText('Running 1 command')).toBeNull()
      expect(screen.getByText('sleep 5')).toBeInTheDocument()
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
        />
      )

      expect(screen.getByText('Running 1 command')).toBeInTheDocument()
      expect(screen.getByText('sleep 5')).toBeInTheDocument()
    })
  })

  // Exercise list assembly: folding, turn mapping and disclosure decide whether roster rows reach the DOM.
  describe('NativeChatMessageList spawn-group roster', () => {
    let restoreViewport = (): void => {}
    beforeAll(() => {
      restoreViewport = installNativeChatMessageListTestViewport()
    })
    afterAll(() => restoreViewport())
    afterEach(cleanup)
    const ROSTER: NativeChatSubagentEntry[] = [
      { id: 'a', label: 'read', state: 'completed' },
      { id: 'b', label: 'search', state: 'failed' }
    ]

    /** Match the producer’s structured roster plus plain-text fallback for older clients. */
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

    // Use ascending timestamps; equal times sort by id and can move the opener after its roster.
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

    it('leaves the roster row behind on a settled turn whose activity is collapsed', () => {
      const startedAt = Date.now() - 3000
      render(
        <NativeChatMessageList
          session={rosterSession(ROSTER, startedAt)}
          isWorking={false}
          workingStartedAt={startedAt}
          expandSignal={false}
        />
      )

      expect(screen.getByRole('button', { name: 'Toggle turn details' })).toHaveAttribute(
        'aria-expanded',
        'false'
      )
      expect(screen.getByRole('button', { name: /Ran 2 subagents/ })).toHaveTextContent('1 failed')
      // Structured roster rendering replaces only its plain-text fallback.
      expect(screen.queryByText('Ran 2 subagents (1 failed)')).toBeNull()
    })

    // Providers may fold a roster beside real prose; remove only its fallback twin.
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
        />
      )

      expect(screen.getByText('Handing the audit to two children.')).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Ran 2 subagents/ })).toBeInTheDocument()
      expect(screen.queryByText(twin)).toBeNull()
    })

    // Roster visibility must not bypass the disclosure for settled tool activity.
    it('keeps tool activity behind the disclosure the roster now bypasses', () => {
      const startedAt = Date.now() - 3000
      render(
        <NativeChatMessageList
          session={rosterSession(ROSTER, startedAt)}
          isWorking={false}
          workingStartedAt={startedAt}
          expandSignal={false}
        />
      )

      expect(screen.queryByRole('button', { name: /pwd/ })).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: 'Toggle turn details' }))
      expect(screen.getAllByRole('button', { name: /pwd/ }).length).toBeGreaterThan(0)
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
        />
      )

      expect(screen.getByRole('button', { name: /Kicked off 2 subagents/ })).toHaveTextContent(
        '2 working'
      )
    })

    // A newer turn must not turn still-running children into completed or unverifiable agents.
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
        />
      )

      const roster = screen.getByRole('button', { name: /Kicked off 2 subagents/ })
      expect(roster).toHaveTextContent('2 working')
      expect(roster).not.toHaveTextContent('unverifiable')
      expect(screen.queryByRole('button', { name: /Ran 2 subagents/ })).toBeNull()
    })
  })

  // Empty rosters render nothing and must consume no transcript gap.
  describe('NativeChatMessageList childless spawn group', () => {
    let restoreViewport = (): void => {}
    beforeAll(() => {
      restoreViewport = installNativeChatMessageListTestViewport()
    })
    afterAll(() => restoreViewport())
    afterEach(cleanup)
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

    function emptySlots(container: HTMLElement): Element[] {
      const column = container.querySelector('[data-native-chat-transcript-column]')
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
        />
      )

      // An empty roster cannot replace its fallback text.
      expect(screen.getByText(subagentGroupFallbackText(NO_AGENTS))).toBeInTheDocument()
      expect(emptySlots(container)).toEqual([])
    })
  })
}

{
  const NARRATION = 'I am starting with the required readiness pass.'
  const MORE_NARRATION = 'The branch is current and the reference corpus is refreshed.'
  const ANSWER = 'Review complete: clean after fixes.'

  function session(startedAt: number): NativeChatLiveSession {
    return {
      messages: [
        {
          id: 'user-1',
          role: 'user',
          blocks: [{ type: 'text', text: 'Please review this PR.' }],
          timestamp: startedAt,
          source: 'transcript'
        },
        {
          id: 'narration-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: NARRATION }],
          timestamp: startedAt + 1,
          source: 'transcript'
        },
        {
          id: 'work-1',
          role: 'assistant',
          blocks: [
            {
              type: 'tool-call',
              name: 'shell',
              input: { command: 'pnpm test' },
              state: 'completed'
            },
            { type: 'tool-result', output: 'ok' }
          ],
          timestamp: startedAt + 2,
          source: 'transcript'
        },
        {
          id: 'narration-2',
          role: 'assistant',
          blocks: [{ type: 'text', text: MORE_NARRATION }],
          timestamp: startedAt + 3,
          source: 'transcript'
        },
        {
          id: 'answer-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: ANSWER }],
          timestamp: startedAt + 4,
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
  }

  /** One turn owns every later row; statesScope=false models older hosts without row scopes. */
  function journalOf(
    messages: readonly NativeChatMessage[],
    statesScope: boolean
  ): AgentJournalRenderItem[] {
    const scope = (turnScope: AgentJournalTurnScope) => (statesScope ? { turnScope } : {})
    const [opener, ...rest] = messages
    const entry = (message: NativeChatMessage, sequence: number): AgentJournalRenderItem => ({
      itemId: message.id,
      revision: 0,
      sequence,
      observedAt: sequence,
      body: {
        kind: 'message',
        role: message.role === 'user' ? 'user' : 'assistant',
        blocks: [{ type: 'text', text: message.id }]
      },
      ...scope({ kind: 'turn', turnItemId: 'turn-1' })
    })
    return [
      { ...entry(opener!, 1), ...scope({ kind: 'thread' }) },
      {
        itemId: 'turn-1',
        revision: 0,
        sequence: 2,
        observedAt: 2,
        body: { kind: 'turn', turnId: 'turn-1', state: 'completed', userItemId: opener!.id },
        ...scope({ kind: 'thread' })
      },
      ...rest.map((message, index) => entry(message, index + 3))
    ]
  }

  describe('NativeChatMessageList settled turn fold', () => {
    let restoreViewport = (): void => {}
    beforeAll(() => {
      restoreViewport = installNativeChatMessageListTestViewport()
    })
    afterAll(() => restoreViewport())
    afterEach(cleanup)
    it('shows a settled turn as its prompt, its duration and its answer', () => {
      const startedAt = Date.now() - 3000
      render(
        <NativeChatMessageList
          session={session(startedAt)}
          isWorking={false}
          workingStartedAt={startedAt}
          expandSignal={false}
        />
      )

      expect(screen.getByText('Please review this PR.')).toBeInTheDocument()
      expect(screen.getByText(ANSWER)).toBeInTheDocument()
      expect(screen.queryByText(NARRATION)).toBeNull()
      expect(screen.queryByText(MORE_NARRATION)).toBeNull()
      expect(screen.getByRole('button', { name: 'Toggle turn details' })).toHaveAttribute(
        'aria-expanded',
        'false'
      )
    })

    it('returns the whole turn when the reader opens it', () => {
      const startedAt = Date.now() - 3000
      render(
        <NativeChatMessageList
          session={session(startedAt)}
          isWorking={false}
          workingStartedAt={startedAt}
          expandSignal={false}
        />
      )

      fireEvent.click(screen.getByRole('button', { name: 'Toggle turn details' }))

      expect(screen.getByText(NARRATION)).toBeInTheDocument()
      expect(screen.getByText(MORE_NARRATION)).toBeInTheDocument()
      expect(screen.getByText(ANSWER)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Toggle turn details' })).toHaveAttribute(
        'aria-expanded',
        'true'
      )
    })

    // The fold starts closed only once settled; live work stays visible.
    it('folds nothing while the turn is still running', () => {
      const startedAt = Date.now() - 3000
      render(
        <NativeChatMessageList
          session={{ ...session(startedAt), status: 'working' }}
          isWorking
          workingStartedAt={startedAt}
          expandSignal={false}
        />
      )

      expect(screen.getByText(NARRATION)).toBeInTheDocument()
      expect(screen.getByText(MORE_NARRATION)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: 'Toggle turn details' })).toBeNull()
    })

    // A mid-turn steer remains in the opener’s fold without gaining its own turn bar.
    it.each([
      ['states each row’s turn', true],
      ['states no scope', false]
    ])(
      "folds the rows after a mid-turn send behind the opener's bar on a host that %s",
      (_host, statesScope) => {
        const startedAt = Date.now() - 3000
        const base = session(startedAt)
        const steer: (typeof base.messages)[number] = {
          id: 'mid-b',
          role: 'user',
          blocks: [{ type: 'text', text: 'Also check the tests.' }],
          timestamp: startedAt + 2,
          source: 'transcript'
        }
        const messages = [...base.messages.slice(0, 3), steer, ...base.messages.slice(3)]
        render(
          <NativeChatMessageList
            session={{ ...base, messages }}
            journalItems={journalOf(messages, statesScope)}
            journalSubmissions={[]}
            isWorking={false}
            workingStartedAt={null}
            settledTurns={new Map([['user-1', { startedAt, workedSeconds: 70 }]])}
            expandSignal={false}
          />
        )

        expect(screen.getByText('Also check the tests.')).toBeInTheDocument()
        expect(screen.queryByText(NARRATION)).toBeNull()
        expect(screen.queryByText(MORE_NARRATION)).toBeNull()
        const toggles = screen.getAllByRole('button', { name: 'Toggle turn details' })
        expect(toggles).toHaveLength(1)

        fireEvent.click(toggles[0]!)
        expect(screen.getByText(NARRATION)).toBeInTheDocument()
        expect(screen.getByText(MORE_NARRATION)).toBeInTheDocument()
      }
    )

    it('keeps the last prose row when the turn ends on tool activity', () => {
      const startedAt = Date.now() - 3000
      const base = session(startedAt)
      render(
        <NativeChatMessageList
          session={{
            ...base,
            messages: [
              ...base.messages,
              {
                id: 'work-2',
                role: 'assistant',
                blocks: [
                  {
                    type: 'tool-call',
                    name: 'shell',
                    input: { command: 'git push' },
                    state: 'completed'
                  },
                  { type: 'tool-result', output: 'done' }
                ],
                timestamp: startedAt + 5,
                source: 'transcript'
              }
            ]
          }}
          isWorking={false}
          workingStartedAt={startedAt}
          expandSignal={false}
        />
      )

      expect(screen.getByText(ANSWER)).toBeInTheDocument()
      expect(screen.queryByText(NARRATION)).toBeNull()
    })
  })
}
