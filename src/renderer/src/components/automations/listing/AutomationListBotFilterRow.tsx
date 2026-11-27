import React from 'react'
import { X } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { MENU_SUB_TRIGGER_CHEVRON_CLASS } from '@/components/ui/menu-item'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'

/** The Bot pill's ×, which shows no text of its own. One key, so each language orders the name itself. */
export function useRemoveBotFilterLabel(): (name: string) => string {
  const t = useTranslate()
  return (name) =>
    t(
      'auto.components.automations.AutomationListFilterMenu.removeBotFilterButton',
      'Remove Bot filter: {{name}}',
      { name }
    )
}

/** Set only by a bot's "All N automations"; listed in the Filters menu so the badge's count is visible. */
export function BotFilterMenuRow({
  name,
  onClear
}: {
  name: string
  onClear: () => void
}): React.JSX.Element {
  const t = useTranslate()
  // Starts with the row's visible text (WCAG 2.5.3), so speaking "Bot: <name>" reaches it.
  const label = t(
    'auto.components.automations.AutomationListFilterMenu.botFilterRowLabel',
    'Bot: {{name}}, remove filter',
    { name }
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenuItem aria-label={label} onSelect={onClear}>
          <span className="min-w-0 truncate">
            {t('auto.components.automations.AutomationListFilterMenu.bot', 'Bot')}: {name}
          </span>
          <X className={MENU_SUB_TRIGGER_CHEVRON_CLASS} aria-hidden />
        </DropdownMenuItem>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={6} className="max-w-72 break-words">
        {name}
      </TooltipContent>
    </Tooltip>
  )
}
