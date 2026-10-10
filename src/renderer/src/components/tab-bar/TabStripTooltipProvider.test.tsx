// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { StrictMode, useContext } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { TabCloseTooltip } from './TabCloseTooltip'
import { TabHoverCard } from './TabHoverCard'
import {
  TAB_TOOLTIP_DELAY_MS,
  TAB_TOOLTIP_SKIP_DELAY_MS,
  TabCardOpenContext,
  TabStripTooltipProvider
} from './TabStripTooltipProvider'

vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))

function CardEvents({ id }: { id: string }): React.JSX.Element {
  const strip = useContext(TabCardOpenContext)
  return (
    <>
      <button onClick={() => strip?.onOpenChange(id, true)}>open {id}</button>
      <button onClick={() => strip?.onOpenChange(id, false)}>close {id}</button>
      <output aria-label={`${id} delay`}>{strip?.isWarm ? 'immediate' : 'delayed'}</output>
    </>
  )
}

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

  it('opens the next tab immediately after a card was shown', () => {
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

    act(() => {
      vi.advanceTimersByTime(0)
    })
    expect(screen.getByText('second tip')).toBeTruthy()
    expect(screen.queryByText('first tip')).toBeNull()

    fireEvent.pointerLeave(second)
    act(() => {
      vi.advanceTimersByTime(301)
    })
    fireEvent.pointerMove(first, { pointerType: 'mouse' })
    act(() => {
      vi.advanceTimersByTime(TAB_TOOLTIP_DELAY_MS - 1)
    })
    expect(screen.queryByText('first tip')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByText('first tip')).toBeTruthy()
  })

  it('ignores a late close from the previous card and resets the delay after the active card closes', () => {
    render(
      <TabStripTooltipProvider>
        <CardEvents id="first" />
        <CardEvents id="second" />
      </TabStripTooltipProvider>
    )
    const delay = screen.getByLabelText('first delay')
    expect(delay.textContent).toBe('delayed')
    fireEvent.click(screen.getByText('open first'))
    fireEvent.click(screen.getByText('close first'))
    fireEvent.click(screen.getByText('open second'))
    fireEvent.click(screen.getByText('close first'))
    act(() => vi.advanceTimersByTime(TAB_TOOLTIP_SKIP_DELAY_MS + 1))
    expect(delay.textContent).toBe('immediate')

    fireEvent.click(screen.getByText('close second'))
    act(() => vi.advanceTimersByTime(TAB_TOOLTIP_SKIP_DELAY_MS - 1))
    expect(delay.textContent).toBe('immediate')
    act(() => vi.advanceTimersByTime(1))
    expect(delay.textContent).toBe('delayed')
  })

  it('shows only the close hint when the close button receives keyboard focus', () => {
    const { container } = render(
      <TabStripTooltipProvider>
        <TabHoverCard title="Build" icon={<span />} programName="Terminal">
          <div tabIndex={0}>
            <TabCloseTooltip>
              <button>close</button>
            </TabCloseTooltip>
          </div>
        </TabHoverCard>
      </TabStripTooltipProvider>
    )
    act(() => screen.getByRole('button', { name: 'close' }).focus())
    expect(container.ownerDocument.querySelector('[data-tab-close-tooltip]')).not.toBeNull()
    expect(container.ownerDocument.querySelector('[data-tab-hover-card]')).toBeNull()
    act(() => screen.getByRole('button', { name: 'close' }).parentElement?.focus())
    expect(container.ownerDocument.querySelector('[data-tab-hover-card]')).not.toBeNull()
    expect(container.ownerDocument.querySelector('[data-tab-close-tooltip]')).toBeNull()
  })

  it('keeps the strip warm while a card is open in StrictMode', () => {
    render(
      <StrictMode>
        <TabStripTooltipProvider>
          <CardEvents id="probe" />
          <TabHoverCard title="Build" icon={<span />} programName="Terminal">
            <button>tab</button>
          </TabHoverCard>
        </TabStripTooltipProvider>
      </StrictMode>
    )
    act(() => screen.getByRole('button', { name: 'tab' }).focus())
    expect(screen.getByLabelText('probe delay').textContent).toBe('immediate')
    act(() => vi.advanceTimersByTime(TAB_TOOLTIP_SKIP_DELAY_MS + 1))
    expect(screen.getByLabelText('probe delay').textContent).toBe('immediate')
  })
})
