// Renders a chat surface the way the app root does: under the one TooltipProvider
// its tooltips rely on, which a bare test render does not supply.

import { render as renderBare, type RenderOptions, type RenderResult } from '@testing-library/react'
import { TooltipProvider } from '@/components/ui/tooltip'

export function render(
  ui: React.ReactNode,
  options?: Omit<RenderOptions, 'wrapper' | 'queries'>
): RenderResult {
  return renderBare(ui, { ...options, wrapper: TooltipProvider })
}
