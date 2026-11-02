import { render as renderUnwrapped, type RenderOptions } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'

// Transcript rows carry tooltips (message timestamps), which App's TooltipProvider supplies in production.
export function render(ui: React.ReactElement, options?: Omit<RenderOptions, 'wrapper'>) {
  return renderUnwrapped(ui, { ...options, wrapper: TooltipProvider })
}
