// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, screen, fireEvent } from '@testing-library/react'
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

import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../../../shared/agent-session/journal/agent-session-journal-item-key'

import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentJournalTurnScope } from '../../../../../../shared/agent-session/journal/agent-session-journal-turn-scope'

import { projectStructuredAgentSessionMessages } from '../../../../../../shared/agent-session/view/structured-agent-session-message-projection'

import { selectStructuredAgentSettledTurns } from '../../../../../../shared/agent-session/view/structured-agent-session-turn-timing'

import { NativeChatMessageList } from '../../NativeChatMessageList'

import { installNativeChatMessageListTestViewport } from '../../viewport/virtualization/native-chat-message-list-test-viewport'

import type { NativeChatLiveSession } from '../../session/terminal/read/native-chat-live-session-contract'

import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'

{
  const THREAD: AgentJournalTurnScope = { kind: 'thread' }
  const inTurn = (turnItemId: string): AgentJournalTurnScope => ({ kind: 'turn', turnItemId })
  let sequence = 0

  function item(
    itemId: string,
    body: AgentJournalItemBody,
    turnScope: AgentJournalTurnScope = THREAD
  ): AgentJournalRenderItem {
    sequence += 1
    return { itemId, revision: 0, sequence, observedAt: sequence, body, turnScope }
  }
  const say = (
    itemId: string,
    role: 'user' | 'assistant',
    text: string,
    scope: AgentJournalTurnScope = THREAD
  ) => item(itemId, { kind: 'message', role, blocks: [{ type: 'text', text }] }, scope)
  const work = (itemId: string, scope: AgentJournalTurnScope) =>
    item(
      itemId,
      {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'tool-call', name: 'shell', input: { command: 'ls' }, state: 'completed' }]
      },
      scope
    )
  const settledTurn = (itemId: string, userItemId: string, seconds: number, start: number) =>
    item(itemId, {
      kind: 'turn',
      turnId: itemId,
      state: 'completed',
      outcome: 'success',
      userItemId,
      startedAt: start,
      completedAt: start + seconds * 1000
    })

  function fruitTurn(): AgentJournalRenderItem[] {
    return [
      say('u1', 'user', 'List three fruits'),
      settledTurn('t1', 'u1', 4, 1_000),
      say('t1-narration', 'assistant', 'Thinking about fruit.', inTurn('t1')),
      work('t1-work', inTurn('t1')),
      say('t1-answer', 'assistant', 'Apple, banana, cherry.', inTurn('t1'))
    ]
  }

  function journalList(
    items: AgentJournalRenderItem[],
    submissions: AgentJournalSubmission[] = [],
    {
      isWorking = false,
      workingStartedAt = null,
      hostTiming = true
    }: { isWorking?: boolean; workingStartedAt?: number | null; hostTiming?: boolean } = {}
  ): React.JSX.Element {
    return (
      <NativeChatMessageList
        session={{
          messages: projectStructuredAgentSessionMessages(items, [], submissions),
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
        journalSubmissions={submissions}
        settledTurns={
          hostTiming ? selectStructuredAgentSettledTurns(items, submissions) : undefined
        }
        isWorking={isWorking}
        workingStartedAt={workingStartedAt}
        expandSignal={false}
      />
    )
  }

  function renderJournal(
    items: AgentJournalRenderItem[],
    submissions: AgentJournalSubmission[] = [],
    isWorking = false
  ): void {
    render(journalList(items, submissions, { isWorking }))
  }

  function follows(later: HTMLElement, earlier: HTMLElement): boolean {
    return Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING)
  }

  describe('NativeChatMessageList turns from the turn record', () => {
    let restoreViewport = (): void => {}
    beforeAll(() => {
      restoreViewport = installNativeChatMessageListTestViewport()
    })
    afterAll(() => restoreViewport())
    afterEach(cleanup)

    it('draws a message waiting behind /compact after the compaction, never above it', () => {
      const compactEntry = agentJournalSubmissionKey('cmd-1')
      const commandTurn = agentJournalItemKey({
        provider: 'orca',
        clientMessageId: 'command-turn:cmd-1'
      })
      const held = agentJournalSubmissionKey('held')
      const items = [
        ...fruitTurn(),
        item(compactEntry, {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: '/compact' }],
          command: { name: 'compact' }
        }),
        settledTurn(commandTurn, compactEntry, 2, 10_000),
        // Accepted while the command ran, so written before the command's result.
        say(held, 'user', 'Say DONE'),
        item(
          'command-result',
          { kind: 'status', text: 'Conversation compacted.', presentation: 'compaction' },
          inTurn(commandTurn)
        )
      ]
      const submission = (
        clientMessageId: string,
        handedOverAt?: number
      ): AgentJournalSubmission => ({
        clientMessageId,
        fence: 1,
        payloadFingerprint: clientMessageId,
        dispatchState:
          handedOverAt === undefined && clientMessageId === 'held' ? 'pending' : 'accepted',
        providerItemId: null,
        reason: null,
        submittedAt: 9_000,
        resolvedAt: null,
        handoverRecorded: true,
        ...(handedOverAt !== undefined ? { handedOverAt } : {})
      })
      // The command settled; the loop has not yet handed the held message over.
      renderJournal(items, [submission('cmd-1', 9_500), submission('held')])

      expect(
        follows(
          screen.getByText('Say DONE'),
          screen.getByRole('separator', { name: 'Context compacted' })
        )
      ).toBe(true)
    })

    it('folds a turn the provider resumed on its own under its own status', () => {
      const wake = agentJournalItemKey({
        provider: 'legacy',
        agent: 'claude',
        sessionId: 'session-1',
        recordId: 'turn-lifecycle:wake'
      })
      const items = [
        ...fruitTurn(),
        // Claude keys a resumed turn's record on itself: no message opened it.
        settledTurn(wake, wake, 9, 20_000),
        say('wake-narration', 'assistant', 'The background build finished.', inTurn(wake)),
        work('wake-work', inTurn(wake)),
        say('wake-answer', 'assistant', 'All tests pass now.', inTurn(wake))
      ]
      renderJournal(items)

      const previousStatus = screen.getByText('Worked for 4s')
      const ownStatus = screen.getByText('Worked for 9s')
      expect(follows(ownStatus, screen.getByText('Apple, banana, cherry.'))).toBe(true)
      expect(follows(ownStatus, previousStatus)).toBe(true)
      expect(screen.queryByText('The background build finished.')).toBeNull()
      expect(screen.getByText('All tests pass now.')).toBeInTheDocument()
      expect(screen.getAllByRole('button', { name: 'Toggle turn details' })).toHaveLength(2)
    })

    it('clocks a turn the provider opened under its own key, not the user turn before it', () => {
      const wake = 'wake'
      const ask = say('u1', 'user', 'List three fruits')
      const answer = (state: 'running' | 'completed') => [
        ask,
        item('t1', { kind: 'turn', turnId: 't1', state, userItemId: 'u1' }),
        say('t1-answer', 'assistant', 'Apple, banana, cherry.', inTurn('t1'))
      ]
      const local = { hostTiming: false }
      const { rerender } = render(
        journalList(answer('running'), [], {
          ...local,
          isWorking: true,
          workingStartedAt: Date.now() - 7_000
        })
      )
      rerender(journalList(answer('completed'), [], local))
      expect(screen.getByText('Worked for 7s')).toBeInTheDocument()

      const woken = [
        ...answer('completed'),
        item(wake, { kind: 'turn', turnId: wake, state: 'running', userItemId: 'claude:wake' }),
        say('wake-answer', 'assistant', 'Checking the background build.', inTurn(wake))
      ]
      rerender(journalList(woken, [], { ...local, isWorking: true, workingStartedAt: Date.now() }))
      expect(screen.getByText('Worked for 7s')).toBeInTheDocument()
    })

    it('draws a message waiting behind a running /compact after its live activity', () => {
      const compactEntry = agentJournalSubmissionKey('cmd-1')
      const commandTurn = agentJournalItemKey({
        provider: 'orca',
        clientMessageId: 'command-turn:cmd-1'
      })
      const held = agentJournalSubmissionKey('held')
      const items = [
        ...fruitTurn(),
        item(compactEntry, {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: '/compact' }],
          command: { name: 'compact' }
        }),
        item(commandTurn, {
          kind: 'turn',
          turnId: 'compact:cmd-1',
          state: 'running',
          userItemId: compactEntry,
          startedAt: 10_000
        }),
        say(held, 'user', 'Say DONE')
      ]
      const submission = (
        clientMessageId: string,
        handedOverAt?: number
      ): AgentJournalSubmission => ({
        clientMessageId,
        fence: 1,
        payloadFingerprint: clientMessageId,
        dispatchState: handedOverAt === undefined ? 'pending' : 'accepted',
        providerItemId: null,
        reason: null,
        submittedAt: 9_000,
        resolvedAt: null,
        handoverRecorded: true,
        ...(handedOverAt !== undefined ? { handedOverAt } : {})
      })
      const { container } = render(
        journalList(items, [submission('cmd-1', 9_500), submission('held')], {
          isWorking: true,
          workingStartedAt: 10_000
        })
      )

      const activity = container.querySelector<HTMLElement>('[data-native-chat-turn-activity]')
      expect(activity).not.toBeNull()
      expect(follows(activity!, screen.getByText('/compact'))).toBe(true)
      expect(follows(screen.getByText('Say DONE'), activity!)).toBe(true)
    })

    it("keeps a steer on its way into an ordinary running turn above that turn's activity", () => {
      const steer = agentJournalSubmissionKey('steer')
      const items = [
        say('u1', 'user', 'List three fruits'),
        item('t1', {
          kind: 'turn',
          turnId: 't1',
          state: 'running',
          userItemId: 'u1',
          startedAt: 10_000
        }),
        say('t1-narration', 'assistant', 'Thinking about fruit.', inTurn('t1')),
        say(steer, 'user', 'Make it four')
      ]
      const { container } = render(
        journalList(
          items,
          [
            {
              clientMessageId: 'steer',
              fence: 1,
              payloadFingerprint: 'steer',
              dispatchState: 'pending',
              providerItemId: null,
              reason: null,
              submittedAt: 10_500,
              resolvedAt: null,
              handoverRecorded: true
            }
          ],
          { isWorking: true, workingStartedAt: 10_000 }
        )
      )

      const activity = container.querySelector<HTMLElement>('[data-native-chat-turn-activity]')
      expect(activity).not.toBeNull()
      expect(follows(activity!, screen.getByText('Make it four'))).toBe(true)
    })
  })
}

{
  describe('NativeChatMessageList host-settled turn timing', () => {
    afterEach(cleanup)

    let restoreViewport = (): void => {}

    beforeAll(() => {
      restoreViewport = installNativeChatMessageListTestViewport()
    })

    afterAll(() => restoreViewport())

    const session: NativeChatLiveSession = {
      messages: [
        {
          id: 'user-settled',
          role: 'user',
          blocks: [{ type: 'text', text: 'Settled on the host' }],
          timestamp: 1,
          source: 'transcript'
        },
        {
          id: 'assistant-settled',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Done.' }],
          timestamp: 2,
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

    it('does not render a local completed duration when the host cannot verify the end', () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
      const unknownTurns = new Map([['user-settled', null]])
      try {
        const { rerender } = render(
          <NativeChatMessageList
            session={session}
            isWorking
            workingStartedAt={1_000}
            settledTurns={unknownTurns}
            expandSignal={false}
          />
        )
        now.mockReturnValue(60_000)
        rerender(
          <NativeChatMessageList
            session={session}
            isWorking={false}
            workingStartedAt={null}
            settledTurns={unknownTurns}
            expandSignal={false}
          />
        )
        expect(screen.queryByText(/Worked for/)).not.toBeInTheDocument()
      } finally {
        now.mockRestore()
      }
    })
  })

  describe('a thought joining a work run', () => {
    let restoreViewport = (): void => {}
    beforeAll(() => {
      restoreViewport = installNativeChatMessageListTestViewport()
    })
    afterAll(() => restoreViewport())
    afterEach(cleanup)

    const STARTED = 1_000

    const prompt: NativeChatMessage = {
      id: 'user-1',
      role: 'user',
      blocks: [{ type: 'text', text: 'Start the task' }],
      timestamp: STARTED - 500,
      source: 'transcript'
    }

    const command: NativeChatMessage = {
      id: 'tool-1',
      role: 'assistant',
      blocks: [
        { type: 'tool-call', name: 'Bash', input: { command: 'ls logs' }, state: 'completed' }
      ],
      timestamp: STARTED,
      source: 'transcript'
    }

    function reasoning(state: 'running' | 'completed'): NativeChatMessage {
      return {
        id: 'r-1',
        role: 'reasoning',
        blocks: [{ type: 'text', text: 'Weighing two approaches' }],
        timestamp: STARTED + 50,
        source: 'transcript',
        state,
        ...(state === 'completed' ? { completedAt: STARTED + 12_000 } : {})
      }
    }

    function journal(rows: readonly NativeChatMessage[]): AgentJournalRenderItem[] {
      return [
        {
          itemId: prompt.id,
          revision: 1,
          sequence: 1,
          observedAt: 1,
          body: { kind: 'message', role: 'user', blocks: prompt.blocks }
        },
        {
          itemId: 'turn-1',
          revision: 1,
          sequence: 2,
          observedAt: 2,
          body: { kind: 'turn', turnId: 'turn-1', state: 'running', userItemId: prompt.id }
        },
        ...rows.map((row, index) => ({
          itemId: row.id,
          revision: 1,
          sequence: index + 3,
          observedAt: index + 3,
          body: {
            kind: 'message' as const,
            role: row.role,
            blocks: row.blocks,
            ...(row.state ? { state: row.state } : {})
          }
        }))
      ]
    }

    function list(
      rows: readonly NativeChatMessage[],
      props: Partial<React.ComponentProps<typeof NativeChatMessageList>> = {}
    ): React.JSX.Element {
      const session: NativeChatLiveSession = {
        messages: [prompt, ...rows],
        status: 'working',
        sessionId: 'session-1',
        agent: 'claude',
        hasMore: false,
        loadingEarlier: false,
        olderHistoryGeneration: 0,
        loadEarlier: vi.fn(),
        readPhase: 'ready'
      }
      return (
        <NativeChatMessageList
          session={session}
          journalItems={journal(rows)}
          isWorking
          expandSignal={false}
          {...props}
        />
      )
    }

    const runHeader = (): HTMLElement =>
      document.querySelector<HTMLElement>('[data-native-chat-tool-run-state]')!

    it('keeps a thought the reader opened live open inside its collapsed run', () => {
      const { rerender } = render(list([command, reasoning('running')]))
      fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
      expect(screen.getByText('Weighing two approaches')).toBeInTheDocument()

      rerender(list([command, reasoning('completed')]))
      expect(runHeader()).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByText('Weighing two approaches')).toBeNull()

      fireEvent.click(runHeader())
      expect(screen.getByRole('button', { name: /Thought for/ })).toHaveAttribute(
        'aria-expanded',
        'true'
      )
      expect(screen.getByText('Weighing two approaches')).toBeInTheDocument()
    })
  })
}
