import React from 'react'
import { X } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { MENU_SUB_TRIGGER_CHEVRON_CLASS } from '@/components/ui/menu-item'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'

/** Name of the Bot pill's ×, which has no visible text of its own. */
export function useRemoveBotFilterLabel(): (name: string) => string {
  const t = useTranslate()
  return (name) =>
    t(
      'auto.components.automations.AutomationListFilterMenu.removeBotFilterNamed',
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
  const label = t(
    'auto.components.automations.AutomationListFilterMenu.botFilterRow',
    'Bot: {{name}}',
    {
      name
    }
  )
  // Why: the accessible name starts with the visible text (speech input can say what it sees)
  // and the action follows, since the trailing × is decorative.
  const accessibleName = t(
    'auto.components.automations.AutomationListFilterMenu.botFilterRowRemove',
    '{{label}}, remove filter',
    { label }
  )
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenuItem aria-label={accessibleName} onSelect={onClear}>
          <span className="min-w-0 truncate">{label}</span>
          <X className={MENU_SUB_TRIGGER_CHEVRON_CLASS} aria-hidden />
        </DropdownMenuItem>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={6} className="max-w-72 break-words">
        {name}
      </TooltipContent>
    </Tooltip>
  )
}
