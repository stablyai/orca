import React from 'react'
import { MoreHorizontal, Pause, Pencil, Play, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { Automation } from '../../../../../shared/automations/automation-definition'
import type { AutomationTargetAvailability } from '../hosts/automation-target-availability-types'
import { useTranslate } from '@/i18n/use-translate'

export function AutomationDetailHeader({
  automation,
  subtitle,
  needsMigration,
  runNowAvailability,
  onRunNow,
  onEdit,
  onToggle,
  onDelete
}: {
  automation: Automation
  subtitle: string
  needsMigration: boolean
  runNowAvailability: AutomationTargetAvailability | null
  onRunNow: (automation: Automation) => void
  onEdit: (automation: Automation) => void
  onToggle: (automation: Automation) => void
  onDelete: (automation: Automation) => void
}): React.JSX.Element {
  const t = useTranslate()
  const runNowDisabled = runNowAvailability?.canRunNow === false
  const statusLabel = !automation.enabled
    ? t('auto.components.automations.enablement.paused', 'Paused')
    : needsMigration
      ? t('auto.components.automations.AutomationDetail.needsMigration', 'Needs migration')
      : t('auto.components.automations.AutomationDetail.eaa02014f8', 'Enabled')

  return (
    <header className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2.5">
          <h2 className="truncate text-xl font-semibold tracking-tight">{automation.name}</h2>
          <Badge variant={automation.enabled ? 'secondary' : 'outline'}>
            {automation.enabled && !needsMigration ? (
              <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
            ) : null}
            {statusLabel}
          </Badge>
        </div>
        <p className="mt-1 truncate text-sm text-muted-foreground">{subtitle}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => onEdit(automation)}>
          <Pencil className="size-4" />
          {t('auto.components.automations.AutomationsPage.f4612e3f78', 'Edit')}
        </Button>
        <Tooltip>
          <TooltipTrigger asChild>
            <span>
              <Button
                type="button"
                size="sm"
                onClick={() => onRunNow(automation)}
                disabled={runNowDisabled}
              >
                <Play className="size-4" />
                {t('auto.components.automations.AutomationDetail.2fb1605beb', 'Run Now')}
              </Button>
            </span>
          </TooltipTrigger>
          {runNowDisabled ? (
            <TooltipContent side="bottom" sideOffset={6}>
              {runNowAvailability.message}
            </TooltipContent>
          ) : null}
        </Tooltip>
        <DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <DropdownMenuTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t(
                    'auto.components.automations.AutomationListLocalRows.c92c9463c6',
                    'Automation actions'
                  )}
                >
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {t(
                'auto.components.automations.AutomationListLocalRows.c92c9463c6',
                'Automation actions'
              )}
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onSelect={() => onToggle(automation)}>
              {automation.enabled ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
              {automation.enabled
                ? t('auto.components.automations.AutomationDetail.91a4155e95', 'Pause automation')
                : t('auto.components.automations.AutomationDetail.d79452fb30', 'Resume automation')}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={() => onDelete(automation)}>
              <Trash2 className="size-3.5" />
              {t('auto.components.automations.AutomationDetail.1f6026358e', 'Delete automation')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  )
}
