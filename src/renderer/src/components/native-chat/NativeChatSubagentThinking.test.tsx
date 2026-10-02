// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatSubagentEntries } from './NativeChatSubagentRun'
import { NativeChatSubagentSectionHead } from './NativeChatSubagentSectionHead'
import { NativeChatReasoningOpenContext } from './native-chat-reasoning-open-context'

afterEach(cleanup)

// Reasoning open for the session's own agent and for task-1, not for task-2.
const isReasoningOpen = (agentId?: string): boolean => agentId === undefined || agentId === 'task-1'

describe("a subagent's live Thinking", () => {
  it('shows on the section head of the subagent whose reasoning is open', () => {
    const head = (agentId: string) =>
      render(
        <NativeChatReasoningOpenContext.Provider value={isReasoningOpen}>
          <NativeChatSubagentSectionHead
            agentId={agentId}
            entry={{ id: agentId, label: agentId, state: 'working' }}
            expanded={false}
            onSetOpen={vi.fn()}
          />
        </NativeChatReasoningOpenContext.Provider>
      )
    head('task-1')
    expect(screen.getByRole('button')).toHaveTextContent('task-1Thinking')
    cleanup()
    // The session's own reasoning is the turn's line, never a subagent's head.
    head('task-2')
    expect(screen.queryByText('Thinking')).toBeNull()
  })

  it("shows on that subagent's roster entry only, in place of its state word", () => {
    render(
      <NativeChatReasoningOpenContext.Provider value={isReasoningOpen}>
        <NativeChatSubagentEntries
          agents={[
            { id: 'task-1', label: 'review', state: 'working' },
            { id: 'task-2', label: 'search', state: 'working' }
          ]}
        />
      </NativeChatReasoningOpenContext.Provider>
    )
    const [review, search] = screen.getAllByRole('listitem')
    expect(within(review!).getByText('Thinking')).toBeInTheDocument()
    expect(within(review!).queryByText(/working/)).toBeNull()
    expect(within(search!).queryByText('Thinking')).toBeNull()
    expect(within(search!).getByText(/working/)).toBeInTheDocument()
  })

  it('shows only while the roster says the subagent works, whatever the signal says', () => {
    render(
      <NativeChatReasoningOpenContext.Provider value={isReasoningOpen}>
        <NativeChatSubagentEntries
          agents={[{ id: 'task-1', label: 'review', state: 'completed' }]}
        />
        <NativeChatSubagentSectionHead
          agentId="task-1"
          entry={{ id: 'task-1', label: 'review', state: 'idle' }}
          expanded={false}
          onSetOpen={vi.fn()}
        />
        <NativeChatSubagentSectionHead
          agentId="task-1"
          entry={undefined}
          expanded={false}
          onSetOpen={vi.fn()}
        />
      </NativeChatReasoningOpenContext.Provider>
    )
    expect(screen.queryByText('Thinking')).toBeNull()
  })

  it('shows nowhere without the host signal', () => {
    render(
      <NativeChatSubagentEntries agents={[{ id: 'task-1', label: 'review', state: 'working' }]} />
    )
    expect(screen.queryByText('Thinking')).toBeNull()
  })
})
