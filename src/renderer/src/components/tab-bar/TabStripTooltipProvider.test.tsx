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
          <button>first tab</button>
        </TabHoverCard>
        <TabHoverCard title="Codex Chat" icon={<span />} programName="Codex">
          <button>second tab</button>
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
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('holds the first preview until an 800 ms hover', () => {
    hover('first tab')
    advance(799)
    expect(screen.queryByText('Build')).toBeNull()
    advance(1)
    expect(screen.getAllByText('Build').length).toBeGreaterThan(0)
  })

  it('requires a full delay on the next tab after a preview was shown', () => {
    hover('first tab')
    advance(TAB_TOOLTIP_DELAY_MS)
    expect(screen.getAllByText('Build').length).toBeGreaterThan(0)

    fireEvent.pointerLeave(screen.getByRole('button', { name: 'first tab' }))
    hover('second tab')
    advance(TAB_TOOLTIP_DELAY_MS - 1)
    expect(screen.queryByText('Build')).toBeNull()
    expect(screen.queryByText('Codex Chat')).toBeNull()
    advance(1)
    expect(screen.getAllByText('Codex Chat').length).toBeGreaterThan(0)
  })

  it('cancels previews when passing quickly across tabs', () => {
    hover('first tab')
    advance(400)
    fireEvent.pointerLeave(screen.getByRole('button', { name: 'first tab' }))
    hover('second tab')
    advance(400)
    expect(screen.queryByText('Build')).toBeNull()
    expect(screen.queryByText('Codex Chat')).toBeNull()
    fireEvent.pointerLeave(screen.getByRole('button', { name: 'second tab' }))
    advance(TAB_TOOLTIP_DELAY_MS)
    expect(screen.queryByText('Codex Chat')).toBeNull()
  })

  it('restarts the full delay when returning to the same tab', () => {
    hover('first tab')
    advance(TAB_TOOLTIP_DELAY_MS)
    fireEvent.pointerLeave(screen.getByRole('button', { name: 'first tab' }))
    hover('first tab')
    advance(TAB_TOOLTIP_DELAY_MS - 1)
    expect(screen.queryByText('Build')).toBeNull()
    advance(1)
    expect(screen.getAllByText('Build').length).toBeGreaterThan(0)
  })

  it('still shows previews immediately for keyboard focus', () => {
    act(() => screen.getByRole('button', { name: 'first tab' }).focus())
    expect(screen.getAllByText('Build').length).toBeGreaterThan(0)
  })
})
