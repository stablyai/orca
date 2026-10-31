// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  NativeChatSubagentEntry,
  NativeChatSubagentGroupBlock
} from '../../../../shared/native-chat-types'
import { NativeChatSubagentRun } from './NativeChatSubagentRun'
import { NativeChatToolRun } from './NativeChatToolRun'

afterEach(cleanup)

function group(agents: NativeChatSubagentEntry[]): NativeChatSubagentGroupBlock {
  return { type: 'subagent-group', groupId: 'thread:turn-1', agents }
}

describe('NativeChatSubagentRun', () => {
  it('discloses optional metadata beside the original child label only when expanded', () => {
    render(
      <NativeChatSubagentRun
        block={group([{ id: 'a', label: 'Review original', state: 'completed' }])}
        entryDetails={new Map([['a', 'Codex · WSL · Ubuntu-24.04']])}
      />
    )
    expect(screen.queryByText('Codex · WSL · Ubuntu-24.04')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Ran 1 subagent/ }))
    expect(screen.getByText('Review original')).toBeVisible()
    expect(screen.getByText('Codex · WSL · Ubuntu-24.04')).toBeVisible()
  })

  it('reads as a live spawn while children work', () => {
    render(
      <NativeChatSubagentRun
        block={group([
          { id: 'a', label: 'read', state: 'working' },
          { id: 'b', label: 'search', state: 'completed', tokens: 40661 }
        ])}
      />
    )

    expect(screen.getByText('Kicked off 2 subagents')).toBeInTheDocument()
    expect(screen.getByRole('button')).toHaveTextContent('1 working')
    expect(screen.getByRole('button')).toHaveTextContent('40.7k tokens')
  })

  it('switches to Ran once every child completed', () => {
    render(
      <NativeChatSubagentRun
        block={group([
          { id: 'a', label: 'read', state: 'completed' },
          { id: 'b', label: 'search', state: 'completed' }
        ])}
      />
    )

    expect(screen.getByText('Ran 2 subagents')).toBeInTheDocument()
    expect(screen.getByRole('button')).toHaveTextContent('completed')
  })

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

  it('leaves the dot neutral when nothing has gone wrong', () => {
    const { container } = render(
      <NativeChatSubagentRun
        block={group([
          { id: 'a', label: 'read', state: 'working' },
          { id: 'b', label: 'search', state: 'completed' }
        ])}
      />
    )

    expect(screen.getByRole('button')).not.toHaveTextContent('failed')
    expect(container.querySelector('.bg-destructive')).toBeNull()
  })

  it('leads with the bot glyph, decorative beside the word that names the group', () => {
    const { container } = render(
      <NativeChatSubagentRun block={group([{ id: 'a', label: 'read', state: 'working' }])} />
    )

    const glyph = container.querySelector('.lucide-bot')
    expect(glyph).not.toBeNull()
    expect(glyph).toHaveAttribute('aria-hidden', 'true')
    expect(screen.getByRole('button')).toHaveAccessibleName(/Kicked off 1 subagent/)
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

  it('renders the roster alongside the tool activity of its turn', () => {
    render(
      <NativeChatToolRun
        blocks={[{ type: 'tool-call', name: 'shell', input: { command: 'ls' } }]}
        subagentGroups={[group([{ id: 'a', label: 'read', state: 'completed' }])]}
        expandSignal={false}
        activeTurnIsWorking={false}
      />
    )

    expect(screen.getByText('Ran 1 subagent')).toBeInTheDocument()
    expect(screen.getByText('ls').closest('button')).toHaveTextContent('ls')
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
