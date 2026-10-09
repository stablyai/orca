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

function reasoning(
  id: string,
  text: string,
  state: 'running' | 'completed',
  fields: Partial<NativeChatMessage> = {}
): NativeChatMessage {
  return {
    id,
    role: 'reasoning',
    blocks: [{ type: 'text', text }],
    timestamp: STARTED,
    source: 'transcript',
    state,
    ...(state === 'completed' ? { completedAt: STARTED + 12_000 } : {}),
    ...fields
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
      ...(row.agentId ? { agentId: row.agentId } : {}),
      body: {
        kind: 'message' as const,
        role: row.role,
        blocks: row.blocks,
        ...(row.state ? { state: row.state } : {})
      }
    }))
  ]
}

function sessionOf(messages: NativeChatMessage[]): NativeChatLiveSession {
  return {
    messages,
    status: 'working',
    sessionId: 'session-1',
    agent: 'claude',
    hasMore: false,
    loadingEarlier: false,
    olderHistoryGeneration: 0,
    loadEarlier: vi.fn(),
    readPhase: 'ready'
  }
}

function list(
  rows: readonly NativeChatMessage[],
  props: Partial<React.ComponentProps<typeof NativeChatMessageList>> = {}
): React.JSX.Element {
  return (
    <NativeChatMessageList
      session={sessionOf([prompt, ...rows])}
      journalItems={journal(rows)}
      isWorking
      expandSignal={false}
      {...props}
    />
  )
}

const liveLine = (): HTMLElement =>
  screen.getByText('Thinking').closest<HTMLElement>('[data-native-chat-turn-activity]')!

describe('live reasoning, read through the one live line', () => {
  it('shows one "Thinking", collapsed, and no row for the open block', () => {
    render(list([reasoning('r-1', 'Weighing two approaches', 'running')]))
    expect(screen.getAllByText('Thinking')).toHaveLength(1)
    const toggle = screen.getByRole('button', { name: 'Thinking' })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(liveLine()).toContainElement(toggle)
    expect(screen.queryByRole('button', { name: /Reasoning|Thought/ })).toBeNull()
    expect(screen.queryByText('Weighing two approaches')).toBeNull()
  })

  it('opens to the live text, which follows the block as it grows', () => {
    const { rerender } = render(list([reasoning('r-1', 'Weighing two approaches', 'running')]))
    fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
    expect(screen.getByRole('button', { name: 'Thinking' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByText('Weighing two approaches')).toBeInTheDocument()
    rerender(list([reasoning('r-1', 'Weighing two approaches, then the cheaper one', 'running')]))
    expect(screen.getByText('Weighing two approaches, then the cheaper one')).toBeInTheDocument()
  })

  it('keeps the body out of the live region, which announces the label only', () => {
    render(list([reasoning('r-1', 'Weighing two approaches', 'running')]))
    fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
    const body = screen.getByText('Weighing two approaches')
    expect(body.closest('[aria-live]')).toBeNull()
    expect(screen.getByText('Thinking').closest('[aria-live]')).not.toBeNull()
  })

  it('lands the finished row open when the reader opened it live, while the turn works on', () => {
    const { rerender } = render(list([reasoning('r-1', 'Weighing two approaches', 'running')]))
    fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
    rerender(list([reasoning('r-1', 'Weighing two approaches', 'completed')]))
    // The line no longer discloses anything; the row does, still open.
    expect(screen.queryByRole('button', { name: /Thinking|Working/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Reasoning: Thought for 12s' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(screen.getByText('Weighing two approaches')).toBeInTheDocument()
  })

  // The body owns its colour: inherited, it read full foreground under the line and muted in the row,
  // so the text dimmed as the block landed.
  it('draws the same body, in its own quieter tone, live and once landed', () => {
    const body = () =>
      screen.getByText('Weighing two approaches').closest('[data-native-chat-message-tone]')
    const { rerender } = render(list([reasoning('r-1', 'Weighing two approaches', 'running')]))
    fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
    const live = body()
    expect(live).toHaveAttribute('data-native-chat-message-tone', 'faint')
    expect(live).toHaveClass('text-chat-foreground-faint', 'pl-5.5', 'max-h-80')
    const liveClasses = live?.getAttribute('class')
    rerender(list([reasoning('r-1', 'Weighing two approaches', 'completed')]))
    expect(body()?.getAttribute('class')).toBe(liveClasses)
  })

  it('starts the next block collapsed', () => {
    const { rerender } = render(list([reasoning('r-1', 'First thought', 'running')]))
    fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
    rerender(
      list([reasoning('r-1', 'First thought', 'completed'), reasoning('r-2', 'Second', 'running')])
    )
    expect(screen.getByRole('button', { name: 'Thinking' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(screen.queryByText('Second')).toBeNull()
  })

  it('is not expandable while the open block has no text yet', () => {
    render(list([reasoning('r-1', '', 'running')]))
    expect(screen.getAllByText('Thinking')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'Thinking' })).toBeNull()
  })

  it('draws the open row when a waiting prompt replaces the line', () => {
    render(
      list([reasoning('r-1', 'Weighing two approaches', 'running')], {
        awaitingInput: 'unshown'
      })
    )
    expect(screen.queryByText('Thinking')).toBeNull()
    expect(screen.getByRole('button', { name: 'Reasoning' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  })

  // The open block can sit on a slot kept for its turn's bar or diff rollup; only the slot stays.
  it('draws no row for the open block under a diff rollup on its turn', () => {
    const edit: NativeChatMessage = {
      id: 'edit-1',
      role: 'assistant',
      blocks: [
        { type: 'tool-call', name: 'Diff', input: { path: 'a.ts' }, state: 'completed' },
        { type: 'tool-result', output: '@@ -1 +1 @@\n-old\n+new' }
      ],
      timestamp: STARTED,
      source: 'transcript'
    }
    render(
      list([
        edit,
        reasoning('r-1', 'Weighing two approaches', 'running', { timestamp: STARTED + 50 })
      ])
    )
    expect(screen.queryByRole('button', { name: /Reasoning/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
    expect(screen.getAllByText('Weighing two approaches')).toHaveLength(1)
  })

  it('draws no row for the open block that carries a provider-opened turn bar', () => {
    const asked: NativeChatMessage = { ...prompt, id: 'u1', timestamp: 1 }
    const done: NativeChatMessage = {
      id: 'a1',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'Done.' }],
      timestamp: 2,
      source: 'transcript'
    }
    const woke = reasoning('r-w', 'Checking the background build', 'running', { timestamp: 3 })
    const thread = { kind: 'thread' as const }
    const inTurn = (turnItemId: string) => ({ kind: 'turn' as const, turnItemId })
    const item = (
      itemId: string,
      sequence: number,
      body: AgentJournalRenderItem['body'],
      turnScope: AgentJournalRenderItem['turnScope']
    ): AgentJournalRenderItem => ({
      itemId,
      revision: 0,
      sequence,
      observedAt: sequence,
      turnScope,
      body
    })
    const items = [
      item('u1', 1, { kind: 'message', role: 'user', blocks: asked.blocks }, thread),
      item('t1', 2, { kind: 'turn', turnId: 't1', state: 'completed', userItemId: 'u1' }, thread),
      item('a1', 3, { kind: 'message', role: 'assistant', blocks: done.blocks }, inTurn('t1')),
      item(
        'wake',
        4,
        { kind: 'turn', turnId: 'wake', state: 'running', userItemId: 'claude:wake' },
        thread
      ),
      item(
        'r-w',
        5,
        { kind: 'message', role: 'reasoning', blocks: woke.blocks, state: 'running' },
        inTurn('wake')
      )
    ]
    render(
      list([], {
        session: sessionOf([asked, done, woke]),
        journalItems: items
      })
    )
    expect(screen.getByText(/Working for/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Reasoning/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Thinking' }))
    expect(screen.getAllByText('Checking the background build')).toHaveLength(1)
  })

  // A live region only announces changes to itself; a replaced one says nothing.
  it('keeps one live region while the line turns into the disclosure and back', () => {
    const tool: NativeChatMessage = {
      id: 'tool-1',
      role: 'assistant',
      blocks: [{ type: 'tool-call', name: 'shell', input: { command: 'ls' }, state: 'completed' }],
      timestamp: STARTED,
      source: 'transcript'
    }
    const later = { timestamp: STARTED + 50 }
    const region = () => document.querySelector('[data-native-chat-turn-activity][aria-live]')
    const { rerender } = render(list([tool]))
    const before = region()
    expect(before).toHaveTextContent('Working…')
    rerender(list([tool, reasoning('r-1', 'Weighing two approaches', 'running', later)]))
    expect(region()).toBe(before)
    expect(before).toHaveTextContent('Thinking')
    rerender(
      list([
        tool,
        reasoning('r-1', 'Weighing two approaches', 'completed', later),
        { ...tool, id: 'tool-2', timestamp: STARTED + 60 }
      ])
    )
    expect(region()).toBe(before)
    expect(before).toHaveTextContent('Working…')
  })
})
