// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { NativeChatMessageList } from './NativeChatMessageList'
import { installNativeChatMessageListTestViewport } from './native-chat-message-list-test-viewport'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

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
  blocks: [{ type: 'tool-call', name: 'Bash', input: { command: 'ls logs' }, state: 'completed' }],
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

describe('a thought joining a work run', () => {
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
