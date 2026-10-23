import type { ReactNode } from 'react'
import { TooltipProvider } from '@/components/ui/tooltip'

export const TAB_TOOLTIP_DELAY_MS = 800

export function TabStripTooltipProvider({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    // Every tab needs its own dwell time, even after another preview was shown.
    <TooltipProvider delayDuration={TAB_TOOLTIP_DELAY_MS} skipDelayDuration={0}>
      {children}
    </TooltipProvider>
  )
}
