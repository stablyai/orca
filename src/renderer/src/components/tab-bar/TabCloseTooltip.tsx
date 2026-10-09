import type { ReactNode } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useOptionalShortcutLabel } from '@/hooks/useShortcutLabel'
import { translate } from '@/i18n/i18n'
import { TAB_TOOLTIP_DELAY_MS } from './TabStripTooltipProvider'

// Why: the close hint is secondary to the tab title, so it waits longer.
export const TAB_CLOSE_TOOLTIP_DELAY_MS = TAB_TOOLTIP_DELAY_MS + 500

export function TabCloseTooltip({ children }: { children: ReactNode }): React.JSX.Element {
  const closeShortcut = useOptionalShortcutLabel('tab.close')
  const closeLabel = translate(
    'auto.components.tab.bar.EditorFileTabCloseButton.a768f428f1',
    'Close tab'
  )

  return (
    <Tooltip delayDuration={TAB_CLOSE_TOOLTIP_DELAY_MS}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6}>
        {closeShortcut ? `${closeLabel} (${closeShortcut})` : closeLabel}
      </TooltipContent>
    </Tooltip>
  )
}
