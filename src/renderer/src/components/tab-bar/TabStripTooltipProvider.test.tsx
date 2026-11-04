// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TabHoverCard } from './TabHoverCard'
import { TAB_TOOLTIP_DELAY_MS, TabStripTooltipProvider } from './TabStripTooltipProvider'

function renderTabs(): void {
  render(
    <StrictMode>
      <TabStripTooltipProvider>
        <TabHoverCard title="Build" icon={<span />} programName="Terminal">
          <button>
            <span className="tab-label">first tab</span>
          </button>
        </TabHoverCard>
        <TabHoverCard title="Codex Chat" icon={<span />} programName="Codex" showWhenTitleFits>
          <button>
            <span className="tab-label">second tab</span>
          </button>
        </TabHoverCard>
      </TabStripTooltipProvider>
    </StrictMode>
  )
}

function hover(name: string): void {
  fireEvent.pointerMove(screen.getByRole('button', { name }), { pointerType: 'mouse' })
}

function advance(ms: number): void {
  act(() => vi.advanceTimersByTime(ms))
}

describe('TabStripTooltipProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    renderTabs()
    for (const label of document.querySelectorAll('.tab-label')) {
      Object.defineProperties(label, {
        clientWidth: { configurable: true, value: 60 },
        scrollWidth: { configurable: true, value: 100 }
      })
    }
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('keeps previews hidden when the full title fits, including keyboard focus', () => {
    Object.defineProperty(screen.getByText('first tab'), 'clientWidth', { value: 100 })
    hover('first tab')
    advance(TAB_TOOLTIP_DELAY_MS)
    expect(screen.queryByText('Build')).toBeNull()
    act(() => screen.getByRole('button', { name: 'first tab' }).focus())
    expect(screen.queryByText('Build')).toBeNull()
  })

  it('still shows a preview with details beyond the title when the title fits', () => {
    Object.defineProperty(screen.getByText('second tab'), 'clientWidth', { value: 100 })
    hover('second tab')
    advance(TAB_TOOLTIP_DELAY_MS)
    expect(screen.getAllByText('Codex Chat').length).toBeGreaterThan(0)
  })
})
