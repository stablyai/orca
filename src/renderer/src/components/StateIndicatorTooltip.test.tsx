import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { STATE_INDICATOR_TOOLTIP_DELAY_MS, StateIndicatorTooltip } from './StateIndicatorTooltip'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ delayDuration, children }: { delayDuration: number; children: ReactNode }) => (
    <span data-delay-duration={delayDuration}>{children}</span>
  ),
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children, side }: { children: ReactNode; side: string }) => (
    <span data-tooltip-content="" data-side={side}>
      {children}
    </span>
  )
}))

describe('StateIndicatorTooltip', () => {
  it('uses Orca tooltip chrome with an explicit 200ms delay', () => {
    const markup = renderToStaticMarkup(
      <StateIndicatorTooltip label="Monitoring background tasks">
        <span data-heartbeat="" />
      </StateIndicatorTooltip>
    )

    expect(STATE_INDICATOR_TOOLTIP_DELAY_MS).toBe(200)
    expect(markup).toContain('data-delay-duration="200"')
    expect(markup).toContain('data-tooltip-content=""')
    expect(markup).toContain('data-side="top"')
    expect(markup).toContain('Monitoring background tasks')
  })

  it('supports surface-aware placement without changing the delay', () => {
    const markup = renderToStaticMarkup(
      <StateIndicatorTooltip label="Monitoring background tasks" side="right">
        <span data-heartbeat="" />
      </StateIndicatorTooltip>
    )

    expect(markup).toContain('data-delay-duration="200"')
    expect(markup).toContain('data-side="right"')
  })

  it('renders only the indicator when a caller already owns the tooltip', () => {
    const markup = renderToStaticMarkup(
      <StateIndicatorTooltip label={null}>
        <span data-heartbeat="" />
      </StateIndicatorTooltip>
    )

    expect(markup).toBe('<span data-heartbeat=""></span>')
  })
})
