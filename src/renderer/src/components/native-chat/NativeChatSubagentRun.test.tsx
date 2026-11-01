// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  NativeChatSubagentEntry,
  NativeChatSubagentGroupBlock
} from '../../../../shared/native-chat/native-chat-types'
import { NativeChatSubagentRun } from './NativeChatSubagentRun'
import { NativeChatToolRun } from './NativeChatToolRun'

afterEach(cleanup)

function group(agents: NativeChatSubagentEntry[]): NativeChatSubagentGroupBlock {
  return { type: 'subagent-group', groupId: 'thread:turn-1', agents }
}

describe('NativeChatSubagentRun', () => {
  it('shows the worst settled verdict, not the count of finished children', () => {
    render(
      <NativeChatSubagentRun
        block={group([
          { id: 'a', label: 'read', state: 'failed' },
          { id: 'b', label: 'search', state: 'failed' },
          { id: 'c', label: 'list', state: 'completed' }
        ])}
      />
    )

    expect(screen.getByRole('button')).toHaveTextContent('2 failed')
  })

  it('surfaces a failed child while its siblings still work', () => {
    const { container } = render(
      <NativeChatSubagentRun
        block={group([
          { id: 'a', label: 'read', state: 'working' },
          { id: 'b', label: 'search', state: 'working' },
          { id: 'c', label: 'list', state: 'working' },
          { id: 'd', label: 'edit', state: 'failed' }
        ])}
      />
    )

    const row = screen.getByRole('button')
    expect(row).toHaveTextContent('3 working')
    expect(row).toHaveTextContent('+1 failed')
    expect(container.querySelector('.bg-destructive.animate-pulse')).not.toBeNull()
  })

  function hiddenTextSpans(container: HTMLElement): Element[] {
    return [...container.querySelectorAll('span[aria-hidden="true"]')].filter(
      (element) => (element.textContent ?? '').trim().length > 0
    )
  }

  it('keeps the ticking clock out of the live region until it stops moving', () => {
    const { container } = render(
      <NativeChatSubagentRun
        block={group([{ id: 'a', label: 'read', state: 'working', startedAt: 1_000 }])}
      />
    )

    const row = screen.getByRole('button')
    expect(row).toHaveAttribute('aria-live', 'polite')
    // Hide the ticking clock from the live region so repeated durations cannot bury state changes.
    expect(hiddenTextSpans(container)).toHaveLength(1)
  })

  it('reads the elapsed time out once it has stopped moving', () => {
    const { container } = render(
      <NativeChatSubagentRun
        block={group([
          { id: 'a', label: 'read', state: 'completed', startedAt: 1_000, settledAt: 5_000 }
        ])}
      />
    )

    // Expose the fixed settled duration once announcement churn ends.
    expect(hiddenTextSpans(container)).toHaveLength(0)
    expect(screen.getByRole('button')).toHaveTextContent('4s')
  })

  it('reads a child resumed after a long gap as its runs, not the gap', () => {
    render(
      <NativeChatSubagentRun
        block={group([
          { id: 'a', label: 'read', state: 'completed', startedAt: 1_000, settledAt: 6_000 },
          { id: 'b', label: 'search', state: 'completed', startedAt: 300_000, settledAt: 305_000 }
        ])}
      />
    )

    const row = screen.getByRole('button')
    expect(row).toHaveTextContent('· 10s')
    expect(row.textContent).not.toContain('5m')
  })

  it('shows no duration for a child whose run length was never recorded', () => {
    render(
      <NativeChatSubagentRun
        block={group([{ id: 'a', label: 'read', state: 'unverifiable', startedAt: 1_000 }])}
      />
    )

    const row = screen.getByRole('button')
    expect(row).toHaveTextContent('status unavailable')
    // Without a stop timestamp, measuring to now would invent a duration after contact was lost.
    expect(row.textContent).not.toContain('·')
  })

  // A settled sibling’s duration cannot represent a group containing an unaccounted-for child.
  it('shows no duration while one child settled and another is unaccounted for', () => {
    render(
      <NativeChatSubagentRun
        block={group([
          { id: 'a', label: 'read', state: 'completed', startedAt: 1_000, settledAt: 5_000 },
          { id: 'b', label: 'search', state: 'unverifiable', startedAt: 1_000 }
        ])}
      />
    )

    const row = screen.getByRole('button')
    expect(row).toHaveTextContent('1 with status unavailable')
    expect(row.textContent).not.toContain('·')
  })

  it('shows no duration when a verdict reached a child with no recorded stop time', () => {
    render(
      <NativeChatSubagentRun
        block={group([
          { id: 'a', label: 'read', state: 'completed', startedAt: 1_000, settledAt: 5_000 },
          { id: 'b', label: 'search', state: 'stopped', startedAt: 1_000 }
        ])}
      />
    )

    const row = screen.getByRole('button')
    expect(row).toHaveTextContent('stopped')
    expect(row.textContent).not.toContain('·')
  })
})

describe('NativeChatToolRun with a spawn group', () => {
  it('renders a roster with no tool calls without inventing a tool count', () => {
    render(
      <NativeChatToolRun
        blocks={[]}
        subagentGroups={[group([{ id: 'a', label: 'read', state: 'working' }])]}
        expandSignal={false}
        activeTurnIsWorking
      />
    )

    expect(screen.getByText('Kicked off 1 subagent')).toBeInTheDocument()
    expect(screen.queryByText('1 tool call')).toBeNull()
  })

  // Durable roster status stays visible without opening a completed turn’s tool activity.
  it('keeps the roster visible on a completed turn whose activity is collapsed', () => {
    render(
      <NativeChatToolRun
        blocks={[]}
        subagentGroups={[group([{ id: 'a', label: 'read', state: 'completed' }])]}
        expandSignal={false}
        activeTurnIsWorking={false}
      />
    )

    expect(screen.getByText('Ran 1 subagent')).toBeInTheDocument()
  })

  // Childless groups must not create the margin-bearing wrapper used for visible roster rows.
  it('draws nothing at all for a spawn group that carries no children', () => {
    const { container } = render(
      <NativeChatToolRun
        blocks={[]}
        subagentGroups={[group([])]}
        expandSignal={false}
        activeTurnIsWorking={false}
      />
    )

    expect(container).toBeEmptyDOMElement()
  })

  it('lists every child as a plain line when none has rows of its own', () => {
    const agents = [
      { id: 'a', label: 'read', state: 'completed' as const },
      { id: 'b', label: 'search', state: 'completed' as const },
      { id: 'c', label: 'list', state: 'completed' as const }
    ]
    render(<NativeChatSubagentRun block={group(agents)} />)
    fireEvent.click(screen.getByRole('button', { name: /Ran 3 subagents/ }))

    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'readcompleted',
      'searchcompleted',
      'listcompleted'
    ])
    expect(screen.getAllByRole('button')).toHaveLength(1)
  })

  it('draws its entries through the first open one, whose rows the transcript draws next', () => {
    const agents = [
      { id: 'a', label: 'read', state: 'completed' as const },
      { id: 'b', label: 'search', state: 'completed' as const },
      { id: 'c', label: 'list', state: 'completed' as const }
    ]
    render(
      <NativeChatSubagentRun
        block={group(agents)}
        open
        sections={
          new Map([
            ['a', false],
            ['b', true],
            ['c', false]
          ])
        }
      />
    )

    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'readcompleted',
      'searchcompleted'
    ])
    expect(screen.getByRole('button', { name: /search/, expanded: true })).toBeInTheDocument()
  })
})
