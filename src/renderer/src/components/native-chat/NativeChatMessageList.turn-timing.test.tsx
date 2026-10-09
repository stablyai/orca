// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import type {
  AgentJournalRenderItem,
  AgentJournalTurnScope
} from '../../../../shared/agent-session-journal-types'
import type { AgentSessionLatestTurn } from '../../../../shared/agent-session-wire'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { projectStructuredAgentSessionMessages } from '../../../../shared/structured-agent-session-message-projection'
import { NativeChatMessageList } from './NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'

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
          messages: projectStructuredAgentSessionMessages(items, [], [], { rejectedInPlace: true }),
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
