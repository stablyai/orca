import React from 'react'
import { X } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { MENU_SUB_TRIGGER_CHEVRON_CLASS } from '@/components/ui/menu-item'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'

/** "Remove Bot filter: <name>", shared by the Bot pill's × and the Filters menu row. */
export function useRemoveBotFilterLabel(): (name: string) => string {
  const t = useTranslate()
  return (name) =>
    `${t(
      'auto.components.automations.AutomationListFilterMenu.removeFilter',
      'Remove {{value0}} filter',
      { value0: t('auto.components.automations.AutomationListFilterMenu.bot', 'Bot') }
    )}: ${name}`
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
  const removeLabel = useRemoveBotFilterLabel()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenuItem aria-label={removeLabel(name)} onSelect={onClear}>
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
