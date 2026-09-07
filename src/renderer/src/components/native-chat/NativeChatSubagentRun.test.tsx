// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type {
  NativeChatSubagentEntry,
  NativeChatSubagentGroupBlock,
  NativeChatSubagentState
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

  // The QA defect: a mid-turn correction opened a new turn while three real
  // children were still running, and the row relabelled every one of them
  // `unverifiable` and flipped its headline to `Ran`. The children completed
  // 57-87s later. A turn boundary says nothing about a child.
  it('keeps a working child working once its turn is no longer the current one', () => {
    render(<NativeChatSubagentRun block={group([{ id: 'a', label: 'read', state: 'working' }])} />)

    const row = screen.getByRole('button')
    expect(row).toHaveTextContent('working')
    expect(row).not.toHaveTextContent('unverifiable')
    expect(screen.getByText('Kicked off 1 subagent')).toBeInTheDocument()
  })

  it('reports the verdict a child lands after its turn ended', () => {
    render(
      <NativeChatSubagentRun block={group([{ id: 'a', label: 'read', state: 'completed' }])} />
    )

    expect(screen.getByText('Ran 1 subagent')).toBeInTheDocument()
    expect(screen.getByRole('button')).toHaveTextContent('completed')
  })

  // Only the writing host may claim loss of contact, and it writes that verdict
  // into the row itself. The renderer draws it, and never infers it.
  it('draws the unverifiable verdict the host recorded', () => {
    render(
      <NativeChatSubagentRun block={group([{ id: 'a', label: 'read', state: 'unverifiable' }])} />
    )

    expect(screen.getByRole('button')).toHaveTextContent('unverifiable')
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

  it('keeps the same glyph in every state, so a settling row never changes identity', () => {
    const states: NativeChatSubagentState[] = [
      'working',
      'idle',
      'completed',
      'failed',
      'stopped',
      'unverifiable'
    ]

    for (const state of states) {
      const { container } = render(
        <NativeChatSubagentRun block={group([{ id: 'a', label: 'read', state }])} />
      )

      expect(container.querySelectorAll('.lucide-bot')).toHaveLength(1)
      expect(container.querySelector('.lucide-check')).toBeNull()
      expect(container.querySelector('.lucide-users')).toBeNull()
      cleanup()
    }
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

  it('shows no duration for a child whose run length was never recorded', () => {
    render(
      <NativeChatSubagentRun
        block={group([{ id: 'a', label: 'read', state: 'unverifiable', startedAt: 1_000 }])}
      />
    )

    const row = screen.getByRole('button')
    expect(row).toHaveTextContent('unverifiable')
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
    expect(row).toHaveTextContent('unverifiable')
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

  // Every settled turn sits here by default: the list passes
  // `expandOverride={expandedTurnIds.has(turnKey)}` — false until the reader
  // opens that turn — and `activeTurnIsWorking={false}`. The completed-turn
  // guard above bailed before the roster branch, so the one row this feature
  // exists to draw vanished the moment its turn finished, and the message row
  // that kept itself alive for it rendered an empty ghost bubble.
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
    expect(screen.queryByText('shell ls')).toBeNull()
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
    expect(screen.getByText('shell ls')).toBeInTheDocument()
  })
})
