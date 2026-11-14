// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DashboardCard } from '../../../../shared/dashboard-snapshot'
import { TooltipProvider } from '@/components/ui/tooltip'
import { i18n } from '@/i18n/i18n'
import { AgentKanbanLaneCardList } from './AgentKanbanLaneCardList'

function laneCards(count: number): DashboardCard[] {
  return Array.from({ length: count }, (_, index) => ({
    paneKey: `pane-${index}`,
    ptyId: `pty-${index}`,
    agentType: 'claude',
    bucket: 'working',
    dotState: 'working',
    task: 'task',
    repoId: 'r1',
    worktreeId: `w${index}`,
    tabId: 'tab1',
    leafId: 'l1',
    repoName: 'Repo',
    worktreeName: `card-${String(index).padStart(2, '0')}`,
    startedAt: 0,
    finishedAt: null,
    stateChangedAt: 0,
    unseen: false,
    subagents: index === 1 ? [{ id: 's1', name: 'helper', dotState: 'working' }] : undefined
  }))
}

function Lane({ cards }: { cards: DashboardCard[] }): React.JSX.Element {
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  return (
    <TooltipProvider>
      <div ref={setScrollElement} data-testid="scroller">
        <AgentKanbanLaneCardList
          cards={cards}
          scrollElement={scrollElement}
          repoIconsByRepoId={undefined}
          now={0}
          dialogPaneKey={null}
          onOpenTerminal={vi.fn()}
        />
      </div>
    </TooltipProvider>
  )
}

function card(position: number): HTMLElement {
  const item = screen
    .getAllByRole('listitem')
    .find((row) => row.getAttribute('aria-posinset') === String(position))
  if (!item) {
    throw new Error(`Expected card ${position} to be mounted`)
  }
  return item
}

function scrollTo(top: number): void {
  const scroller = screen.getByTestId('scroller')
  act(() => {
    scroller.scrollTop = top
    fireEvent.scroll(scroller)
  })
}

describe('AgentKanbanLaneCardList', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    // Layout stub: a 300px lane of 100px cards.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return this.dataset.testid === 'scroller' ? 300 : this.hasAttribute('data-index') ? 100 : 0
    })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it('tabs to the logical neighbour card instead of the next mounted card', () => {
    render(<Lane cards={laneCards(40)} />)
    expect(screen.queryByText('card-20')).toBeNull()

    // Card 9 is offscreen while the last card is mounted next in DOM order.
    const lastControl = within(card(9)).getAllByRole('button').at(-1)!
    lastControl.focus()
    fireEvent.keyDown(lastControl, { key: 'Tab' })
    expect(document.activeElement).toHaveTextContent('card-09')

    const lastCardFirstControl = within(card(40)).getAllByRole('button')[0]
    lastCardFirstControl.focus()
    fireEvent.keyDown(lastCardFirstControl, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(within(card(39)).getAllByRole('button').at(-1))

    // Mounted logical neighbours keep native traversal.
    const firstCardLastControl = within(card(1)).getAllByRole('button').at(-1)!
    expect(fireEvent.keyDown(firstCardLastControl, { key: 'Tab' })).toBe(true)
  })

  it('keeps subagent disclosure while scrolled away and resets it when the card leaves the lane', () => {
    const cards = laneCards(40)
    const { rerender } = render(<Lane cards={cards} />)
    fireEvent.click(screen.getByRole('button', { name: '1 subagent' }))
    expect(screen.getByText('helper')).toBeInTheDocument()

    scrollTo(2000)
    expect(screen.queryByText('card-01')).toBeNull()
    scrollTo(0)
    expect(screen.getByRole('button', { name: '1 subagent' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )

    rerender(<Lane cards={cards.filter((laneCard) => laneCard.paneKey !== 'pane-1')} />)
    rerender(<Lane cards={cards} />)
    expect(screen.getByRole('button', { name: '1 subagent' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
  })
})
