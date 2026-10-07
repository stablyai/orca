// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TAB_TOOLTIP_DELAY_MS, TabStripTooltipProvider } from './TabStripTooltipProvider'

function renderTooltip(label: string, tip: string): void {
  render(
    <TabStripTooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button">{label}</button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{tip}</TooltipContent>
      </Tooltip>
    </TabStripTooltipProvider>
  )
}

describe('TabStripTooltipProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('holds a tab tooltip until the full delay elapses', () => {
    renderTooltip('tab label', 'tab tooltip')
    fireEvent.pointerMove(screen.getByRole('button', { name: 'tab label' }), {
      pointerType: 'mouse'
    })

    act(() => {
      vi.advanceTimersByTime(TAB_TOOLTIP_DELAY_MS - 1)
    })
    expect(screen.queryByText('tab tooltip')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByText('tab tooltip')).toBeTruthy()
  })

  it('does not let a recently-closed tooltip skip the delay on the next tab', () => {
    render(
      <TabStripTooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button">first tab</button>
          </TooltipTrigger>
          <TooltipContent>first tip</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button">second tab</button>
          </TooltipTrigger>
          <TooltipContent>second tip</TooltipContent>
        </Tooltip>
      </TabStripTooltipProvider>
    )

    const first = screen.getByRole('button', { name: 'first tab' })
    const second = screen.getByRole('button', { name: 'second tab' })

    fireEvent.pointerMove(first, { pointerType: 'mouse' })
    act(() => {
      vi.advanceTimersByTime(TAB_TOOLTIP_DELAY_MS)
    })
    expect(screen.getByText('first tip')).toBeTruthy()

    fireEvent.pointerLeave(first)
    fireEvent.pointerMove(second, { pointerType: 'mouse' })

    // Radix's default would open this one instantly for 300ms after a close.
    act(() => {
      vi.advanceTimersByTime(TAB_TOOLTIP_DELAY_MS - 1)
    })
    expect(screen.queryByText('second tip')).toBeNull()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByText('second tip')).toBeTruthy()
  })
})
