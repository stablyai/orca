import { MoreHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import { useTranslate } from '@/i18n/use-translate'

export function AutomationDetailHeader({
  automation,
  subtitle,
  titleId,
  menuItems
}: {
  automation: Automation
  subtitle: string
  titleId?: string
  menuItems: React.ReactNode
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <header className="flex min-w-0 items-start gap-1">
      <div className="min-w-0 flex-1">
        <h2
          id={titleId}
          className="text-base font-semibold leading-snug tracking-tight [overflow-wrap:anywhere]"
        >
          {automation.name}
        </h2>
        <p className="mt-1.5 text-xs text-muted-foreground [overflow-wrap:anywhere]">{subtitle}</p>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t(
              'auto.components.automations.AutomationDetail.moreActions',
              'More actions for {{name}}',
              { name: automation.name }
            )}
          >
            <MoreHorizontal className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          {menuItems}
        </DropdownMenuContent>
      </DropdownMenu>
    </header>
  )
}
