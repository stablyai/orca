// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, fireEvent } from '@testing-library/react'

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../../../shared/agent-session-journal-item-key'

import type {
  AgentJournalItemBody,
  AgentJournalRenderItem,
  AgentJournalSubmission,
  AgentJournalTurnScope
} from '../../../../shared/agent-session-journal-types'

import { projectStructuredAgentSessionMessages } from '../../../../shared/structured-agent-session-message-projection'

import { selectStructuredAgentSettledTurns } from '../../../../shared/structured-agent-session-turn-timing'

import { NativeChatMessageList } from './NativeChatMessageList'

import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'

import type { NativeChatLiveSession } from './use-native-chat-live-session'

import type { AgentSessionLatestTurn } from '../../../../shared/agent-session-wire'

import type { NativeChatMessage } from '../../../../shared/native-chat-types'

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

  /** "List three fruits", answered and settled in 4s. */
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
          messages: projectStructuredAgentSessionMessages(items, [], submissions, {
            rejectedInPlace: true
          }),
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
    it('gives /compact its own turn and result, and leaves the turn before it untouched', () => {
      const compactEntry = agentJournalSubmissionKey('cmd-1')
      const commandTurn = agentJournalItemKey({
        provider: 'orca',
        clientMessageId: 'command-turn:cmd-1'
      })
      const items = [
        ...fruitTurn(),
        item(compactEntry, {
          kind: 'message',
          role: 'user',
          blocks: [{ type: 'text', text: '/compact' }],
          command: { name: 'compact' }
        }),
        settledTurn(commandTurn, compactEntry, 2, 10_000),
        item(
          'command-result',
          { kind: 'status', text: 'Conversation compacted.', presentation: 'compaction' },
          inTurn(commandTurn)
        )
      ]
      renderJournal(items, [
        {
          clientMessageId: 'cmd-1',
          fence: 1,
          payloadFingerprint: 'f',
          dispatchState: 'accepted',
          providerItemId: null,
          reason: null,
          submittedAt: 9_000,
          resolvedAt: 12_000
        }
      ])

      expect(screen.getByText('Apple, banana, cherry.')).toBeInTheDocument()
      expect(screen.queryByText('Thinking about fruit.')).toBeNull()
      const compact = screen.getByText('/compact')
      const previousStatus = screen.getByText('Worked for 4s')
      const ownStatus = screen.getByText('Worked for 2s')
      expect(follows(compact, previousStatus)).toBe(true)
      expect(follows(ownStatus, compact)).toBe(true)
      expect(screen.getByRole('separator', { name: 'Context compacted' })).toBeInTheDocument()
    })

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

    it('keeps the row that says why a turn stopped visible in its folded turn', () => {
      const items = [
        ...fruitTurn(),
        item(
          'exit',
          { kind: 'status', text: 'The agent exited unexpectedly.', tone: 'error' },
          inTurn('t1')
        )
      ]
      renderJournal(items)

      expect(screen.queryByText('Thinking about fruit.')).toBeNull()
      expect(screen.getByText('The agent exited unexpectedly.')).toBeInTheDocument()
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

    it("keeps the settled turn's duration while a turn the provider opened runs after it", () => {
      const wake = agentJournalItemKey({
        provider: 'legacy',
        agent: 'claude',
        sessionId: 'session-1',
        recordId: 'turn-lifecycle:wake'
      })
      const items = [
        ...fruitTurn(),
        item(wake, {
          kind: 'turn',
          turnId: wake,
          state: 'running',
          userItemId: wake,
          startedAt: 20_000
        }),
        say('wake-answer', 'assistant', 'Checking the background build.', inTurn(wake))
      ]
      renderJournal(items, [], true)

      expect(screen.getByText('Worked for 4s')).toBeInTheDocument()
      expect(screen.getByText('Checking the background build.')).toBeInTheDocument()
    })

    it('clocks a turn the provider opened under its own key, not the user turn before it', () => {
      const wake = 'wake'
      const ask = say('u1', 'user', 'List three fruits')
      const answer = (state: 'running' | 'completed') => [
        ask,
        item('t1', { kind: 'turn', turnId: 't1', state, userItemId: 'u1' }),
        say('t1-answer', 'assistant', 'Apple, banana, cherry.', inTurn('t1'))
      ]
      // No host durations: this client's own clock is all the rows have.
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

    it.each(['settled', 'running'] as const)(
      "a queued card Steered into a %s turn joins it, under the opener's bar, with no bar of its own",
      (phase) => {
        // Steer hands the draft over under a fresh submission id, linked by `queuedMessageId`; the
        // host scopes its row to the turn it joined.
        const steer = agentJournalSubmissionKey('handed-off')
        const running = phase === 'running'
        const items = [
          say('u1', 'user', 'List three fruits'),
          running
            ? item('t1', {
                kind: 'turn',
                turnId: 't1',
                state: 'running',
                userItemId: 'u1',
                startedAt: 1_000
              })
            : settledTurn('t1', 'u1', 4, 1_000),
          say('t1-narration', 'assistant', 'Thinking about fruit.', inTurn('t1')),
          say(steer, 'user', 'Make it four', inTurn('t1')),
          say('t1-answer', 'assistant', 'Apple, banana, cherry, date.', inTurn('t1'))
        ]
        const { container } = render(
          journalList(
            items,
            [
              {
                clientMessageId: 'handed-off',
                fence: 1,
                payloadFingerprint: 'steer',
                dispatchState: 'accepted',
                providerItemId: null,
                reason: null,
                submittedAt: 2_000,
                resolvedAt: 2_100,
                queuedMessageId: 'draft-1'
              }
            ],
            running ? { isWorking: true, workingStartedAt: 1_000 } : {}
          )
        )

        const bars = container.querySelectorAll<HTMLElement>('[data-native-chat-turn-status]')
        expect(bars).toHaveLength(1)
        const opener = screen.getByText('List three fruits')
        const steered = screen.getByText('Make it four')
        expect(follows(bars[0]!, opener)).toBe(true)
        expect(follows(steered, bars[0]!)).toBe(true)
        expect(follows(screen.getByText('Apple, banana, cherry, date.'), steered)).toBe(true)
      }
    )

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

      // Handed over within moments, where it already is: it must not cross the activity line to wait.
      const activity = container.querySelector<HTMLElement>('[data-native-chat-turn-activity]')
      expect(activity).not.toBeNull()
      expect(follows(activity!, screen.getByText('Make it four'))).toBe(true)
    })

    it('keeps a message whose own start is pending above the activity that start reports', () => {
      const waiting = agentJournalSubmissionKey('first')
      const { container } = render(
        journalList(
          [say(waiting, 'user', 'Hello there')],
          [
            {
              clientMessageId: 'first',
              fence: 1,
              payloadFingerprint: 'first',
              dispatchState: 'pending',
              providerItemId: null,
              reason: null,
              submittedAt: 9_000,
              resolvedAt: null,
              handoverRecorded: true
            }
          ],
          { isWorking: true, workingStartedAt: 9_000 }
        )
      )

      const activity = container.querySelector<HTMLElement>('[data-native-chat-turn-activity]')
      expect(activity).not.toBeNull()
      expect(follows(activity!, screen.getByText('Hello there'))).toBe(true)
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

    const settledTurns = new Map([['user-settled', { startedAt: 1, workedSeconds: 197 }]])

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

    it('renders a host-settled duration without ever clocking the turn locally', () => {
      // A local clock nowhere near the host's: the value must still be the host's.
      const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
      try {
        const { rerender } = render(
          <NativeChatMessageList
            session={session}
            isWorking={false}
            workingStartedAt={null}
            settledTurns={settledTurns}
            expandSignal={false}
          />
        )
        expect(screen.getByText('Worked for 3m 17s')).toBeInTheDocument()
        now.mockReturnValue(1_700_000_099_000)
        rerender(
          <NativeChatMessageList
            session={{ ...session }}
            isWorking={false}
            workingStartedAt={null}
            settledTurns={settledTurns}
            expandSignal={false}
          />
        )
        expect(screen.getByText('Worked for 3m 17s')).toBeInTheDocument()
      } finally {
        now.mockRestore()
      }
    })
  })

  describe('a live turn whose record and opening message are not loaded', () => {
    let restoreViewport = (): void => {}
    beforeAll(() => {
      restoreViewport = installNativeChatMessageListTestViewport()
    })
    afterAll(() => restoreViewport())
    afterEach(cleanup)

    const TURN_RECORD = 'turn-record-1'
    const IN_TURN: AgentJournalTurnScope = { kind: 'turn', turnItemId: TURN_RECORD }

    /** The newest rows of the turn: everything from its 300th row on. */
    const loaded: AgentJournalRenderItem[] = [300, 301, 302].map((sequence) => ({
      itemId: `row-${sequence}`,
      revision: 0,
      sequence,
      observedAt: sequence,
      body: {
        kind: 'message',
        role: 'assistant',
        blocks: [{ type: 'text', text: `Step ${sequence}` }]
      },
      turnScope: IN_TURN
    }))

    const patch = '@@ -1 +1 @@\n-before\n+after'
    /** An edit among the loaded rows; the turn's earlier edits are above them. */
    const edit: AgentJournalRenderItem = {
      itemId: 'row-303',
      revision: 0,
      sequence: 303,
      observedAt: 303,
      body: {
        kind: 'diff',
        path: 'src/a.ts',
        patch: { head: patch, truncated: false, digest: 'fixture', byteLength: patch.length }
      },
      turnScope: IN_TURN
    }

    const running: AgentSessionLatestTurn = {
      itemId: TURN_RECORD,
      observedAt: 1,
      turn: { turnId: 'turn-1', state: 'running', startedAt: 1_000, userItemId: 'user-1' }
    }

    function list(
      latestTurn: AgentSessionLatestTurn | null | undefined,
      items: AgentJournalRenderItem[] = loaded
    ): React.JSX.Element {
      return (
        <NativeChatMessageList
          session={{
            messages: projectStructuredAgentSessionMessages(items, [], [], {
              rejectedInPlace: true
            }),
            status: 'ready',
            sessionId: 'session-1',
            agent: 'codex',
            hasMore: true,
            loadingEarlier: false,
            olderHistoryGeneration: 0,
            loadEarlier: vi.fn(),
            readPhase: 'ready'
          }}
          journalItems={items}
          journalSubmissions={[]}
          journalLatestTurn={latestTurn}
          isWorking
          workingStartedAt={1_000}
          expandSignal={false}
        />
      )
    }

    it('draws its Working bar with the running clock', () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(64_000)
      try {
        render(list(running))
        expect(screen.getByText('Step 302')).toBeInTheDocument()
        expect(screen.getByText(/Working for 1m 3s/)).toBeInTheDocument()
      } finally {
        now.mockRestore()
      }
    })

    it('totals no edits, since only the end of the turn is loaded', () => {
      render(list(running, [...loaded, edit]))
      expect(screen.getByText(/Working for/)).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /changed file/ })).toBeNull()
    })

    it('had no bar to draw from the loaded rows alone', () => {
      const now = vi.spyOn(Date, 'now').mockReturnValue(64_000)
      try {
        render(list(undefined))
        expect(screen.getByText('Step 302')).toBeInTheDocument()
        expect(screen.queryByText(/Working for/)).not.toBeInTheDocument()
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

    /** The journal that says the turn runs and what its newest content is. */
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

    it('joins collapsed when the reader never opened it', () => {
      render(list([command, reasoning('completed')]))
      expect(runHeader()).toHaveAttribute('aria-expanded', 'false')
      expect(screen.queryByText('Weighing two approaches')).toBeNull()
    })

    // The run never opens for a thought; the thought keeps its own open state inside it.
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

    // While the live line is not showing it (a Stop in flight, a prompt the reader owes), the open
    // thought sits in the run rather than flashing as its own row until the turn ends.
    it.each([
      ['a Stop is in flight', { stopping: true }],
      ['a prompt waits on the reader', { awaitingInput: 'unshown' as const }]
    ])('keeps an open thought inside the run while %s', (_, props) => {
      const second: NativeChatMessage = {
        ...command,
        id: 'tool-2',
        blocks: [{ type: 'tool-call', name: 'Bash', input: { command: 'ls' }, state: 'completed' }],
        timestamp: STARTED + 100
      }
      const open = { ...reasoning('running'), id: 'r-2', timestamp: STARTED + 200 }
      render(list([command, reasoning('completed'), second, open], props))
      expect(screen.queryByRole('button', { name: /Reasoning|Thought/ })).toBeNull()
      fireEvent.click(runHeader())
      expect(screen.getAllByRole('button', { name: /Reasoning|Thought/ })).toHaveLength(2)
    })
  })
}
