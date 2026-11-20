// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip'

afterEach(cleanup)

it.each([undefined, 'default', 'tab-preview'] as const)(
  'uses theme-matched surface and arrow tokens for the %s tooltip',
  (variant) => {
    render(
      <TooltipProvider>
        <Tooltip open>
          <TooltipTrigger asChild>
            <button>Help</button>
          </TooltipTrigger>
          <TooltipContent variant={variant}>Tooltip label</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
    const label = screen.getByRole('tooltip')
    const content = label.closest('[data-slot="tooltip-content"]')
    expect(content?.classList.contains('bg-[rgba(255,255,255,0.82)]')).toBe(true)
    expect(content?.classList.contains('dark:bg-[rgba(0,0,0,0.72)]')).toBe(true)
    expect(content?.classList.contains('border-black/14')).toBe(true)
    expect(content?.classList.contains('dark:border-white/14')).toBe(true)
    expect(content?.classList.contains('backdrop-blur-2xl')).toBe(true)
    expect(content?.classList.contains('bg-popover')).toBe(false)
    expect(content?.classList.contains('text-popover-foreground')).toBe(false)
    expect(content?.classList.contains('border-border')).toBe(false)
    expect(content?.classList.contains('bg-foreground')).toBe(false)
    expect(content?.classList.contains('text-background')).toBe(false)
    expect(content?.querySelector('svg')?.classList.contains('fill-[rgba(255,255,255,0.82)]')).toBe(
      true
    )
    expect(content?.querySelector('svg')?.classList.contains('bg-[rgba(255,255,255,0.82)]')).toBe(
      true
    )
  }
)

it('still allows callers to hide the tooltip arrow', () => {
  render(
    <TooltipProvider>
      <Tooltip open>
        <TooltipTrigger asChild>
          <button>Help</button>
        </TooltipTrigger>
        <TooltipContent showArrow={false}>Tooltip label</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
  expect(
    screen.getByRole('tooltip').closest('[data-slot="tooltip-content"]')?.querySelector('svg')
  ).toBeNull()
})
