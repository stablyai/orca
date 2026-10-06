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
    // The dot carries the failure; the pulse still says the group is in flight.
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
    // Never icon-only: the word is what carries the accessible name.
    expect(screen.getByRole('button')).toHaveAccessibleName(/Kicked off 1 subagent/)
  })

  // The only aria-hidden span carrying text is the elapsed-clock wrapper: the
  // glyph's Bot is an <svg> and the status dots render empty.
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
    // A clock that reticks every second would announce a new duration every
    // second and bury the state changes the live region exists to report.
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

    // Settled: the duration is fixed, so hiding it would cost a reader real
    // information for no announcement churn.
    expect(hiddenTextSpans(container)).toHaveLength(0)
    expect(screen.getByRole('button')).toHaveTextContent('4s')
  })

  // A resumed child reopens in its original row with a fresh start; the idle
  // time since its sibling stopped is not run time.
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
    expect(row).toHaveTextContent('no recent update')
    // `unverifiable` with no terminal timestamp has no known run length, so the
    // clock would measure to `now` and report the time since we lost sight of
    // the child as how long it ran — on a row that is not even counting.
    expect(row.textContent).not.toContain('·')
  })

  // A partial sweep leaves one child settled and one whose fate is unknown. The
  // group's clock would then report the settled sibling's duration as the
  // group's run length while the other child is still unaccounted for.
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
    expect(row).toHaveTextContent('1 with no recent update')
    expect(row.textContent).not.toContain('·')
  })

  // The provider can still say how a child whose host died ended, but not when.
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

  // A completed turn can keep its roster visible while the regular tool-run
  // disclosure remains closed. This durable row is the work's status, not a
  // reason to open the rest of the activity automatically.
  it('keeps the roster visible on a completed turn whose activity is collapsed', () => {
    render(
      <NativeChatToolRun
        blocks={[]}
        subagentGroups={[group([{ id: 'a', label: 'read', state: 'completed' }])]}
        expandSignal={false}
        expandOverride={false}
        activeTurnIsWorking={false}
      />
    )

    expect(screen.getByText('Ran 1 subagent')).toBeInTheDocument()
  })

  // The roster-only branch returns a `mt-3` wrapper whenever it has rows, so a
  // group that draws nothing must not count as one — that wrapper would be the
  // empty bubble with a margin that the message row refuses to emit.
  it('draws nothing at all for a spawn group that carries no children', () => {
    const { container } = render(
      <NativeChatToolRun
        blocks={[]}
        subagentGroups={[group([])]}
        expandSignal={false}
        expandOverride={false}
        activeTurnIsWorking={false}
      />
    )

    expect(container).toBeEmptyDOMElement()
  })

  // The roster-only escape above is keyed on `blocks.length === 0`, so a group
  // sharing its message with tool calls falls through to the settled-turn guard
  // — which returned bare null and took the roster with it.
  it('keeps a roster that shares its message with tool calls on a collapsed turn', () => {
    render(
      <NativeChatToolRun
        blocks={[{ type: 'tool-call', name: 'shell', input: { command: 'ls' } }]}
        subagentGroups={[group([{ id: 'a', label: 'read', state: 'completed' }])]}
        expandSignal={false}
        expandOverride={false}
        activeTurnIsWorking={false}
      />
    )

    expect(screen.getByText('Ran 1 subagent')).toBeInTheDocument()
    expect(screen.queryByText('shell')).toBeNull()
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
