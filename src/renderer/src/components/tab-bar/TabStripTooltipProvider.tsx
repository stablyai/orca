import type { ReactNode } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'

// Why: longer than the app-wide 400ms so a pointer merely passing over the strip never pops a title.
export const TAB_TOOLTIP_DELAY_MS = 500

export function TabStripTooltipProvider({ children }: { children: ReactNode }): React.JSX.Element {
  // Why: skipDelayDuration=0 keeps the full delay after a tooltip closes. Radix
  // otherwise opens the next tab's label instantly for 300ms after any close,
  // which is what makes dragging across the strip fire tooltips back to back.
  return (
    <TooltipProvider delayDuration={TAB_TOOLTIP_DELAY_MS} skipDelayDuration={0}>
      {children}
    </TooltipProvider>
  )
}
