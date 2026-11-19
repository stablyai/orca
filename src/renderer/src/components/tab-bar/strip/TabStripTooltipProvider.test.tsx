// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TabHoverCard } from './TabHoverCard'
import { TAB_TOOLTIP_DELAY_MS, TabStripTooltipProvider } from './TabStripTooltipProvider'

function hover(name: string): void {
  fireEvent.pointerMove(screen.getByRole('button', { name }), { pointerType: 'mouse' })
}

function advance(ms: number): void {
  act(() => vi.advanceTimersByTime(ms))
}

describe('a card that says more than its title', () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('opens on hover even when the title fits, naming who the icon stands for', () => {
    vi.useFakeTimers()
    render(
      <TabStripTooltipProvider>
        <TabHoverCard
          title="triage team"
          icon={<span />}
          programName="Scout, Juno, Pip"
          showWhenUnclipped
        >
          <button>
            <span className="tab-label">triage team</span>
          </button>
        </TabHoverCard>
      </TabStripTooltipProvider>
    )
    hover('triage team')
    advance(TAB_TOOLTIP_DELAY_MS)
    expect(screen.getAllByText('Scout, Juno, Pip').length).toBeGreaterThan(0)
  })
})
