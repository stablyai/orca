import React from 'react'
import { Copy, Link, Loader2, MoreHorizontal, Pause, Pencil, Play, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
import { COMPACT_HEADER_WIDTH_PX } from '../AutomationsPageFrame'

// Copy URL adds ~110 px to the header's actions, so they fold that much sooner.
export const COPY_URL_COMPACT_HEADER_WIDTH_PX = COMPACT_HEADER_WIDTH_PX + 128

/** Header actions for one automation; `compact` folds Copy URL, Pause/Resume and Edit into the menu. */
export function AutomationDetailActions({
  automation,
  compact,
  runNowAvailability,
  isRunNowPending,
  onRunNow,
  onEdit,
  onToggle,
  onDelete,
  onCopyUrl
}: {
  automation: Automation
  compact: boolean
  runNowAvailability: AutomationTargetAvailability | null
  /** Run now was requested and its run is not listed yet. */
  isRunNowPending: boolean
  onRunNow: (automation: Automation) => void
  onEdit: (automation: Automation) => void
  onToggle: (automation: Automation) => void
  onDelete: (automation: Automation) => void
  /** Set for an automation a webhook starts. */
  onCopyUrl: (() => void) | null
}): React.JSX.Element {
  const t = useTranslate()
  const unavailable = runNowAvailability?.canRunNow === false
  const toggleLabel = automation.enabled
    ? t('auto.components.automations.AutomationsPage.b457436d6a', 'Pause')
    : t('auto.components.automations.AutomationsPage.376631ef2b', 'Resume')
  const ToggleIcon = automation.enabled ? Pause : Play
  const editLabel = t('auto.components.automations.AutomationsPage.f4612e3f78', 'Edit')
  const copyUrlLabel = t('bots.webhooks.copyUrl', 'Copy URL')
  const menuLabel = t(
    'auto.components.automations.AutomationListLocalRows.c92c9463c6',
    'Automation actions'
  )
  return (
    <>
      {compact ? null : (
        <>
          {onCopyUrl ? (
            <Button type="button" variant="outline" size="sm" onClick={onCopyUrl}>
              <Copy className="size-4" />
              {copyUrlLabel}
            </Button>
          ) : null}
          <Button type="button" variant="outline" size="sm" onClick={() => onToggle(automation)}>
            <ToggleIcon className="size-4" />
            {toggleLabel}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => onEdit(automation)}>
            <Pencil className="size-4" />
            {editLabel}
          </Button>
        </>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button
              type="button"
              size="sm"
              onClick={() => onRunNow(automation)}
              disabled={unavailable || isRunNowPending}
              aria-busy={isRunNowPending || undefined}
            >
              {isRunNowPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              {isRunNowPending
                ? t('auto.components.automations.AutomationDetail.runNowStarting', 'Starting…')
                : t('auto.components.automations.AutomationDetail.2fb1605beb', 'Run Now')}
            </Button>
          </span>
        </TooltipTrigger>
        {unavailable ? (
          <TooltipContent side="bottom" sideOffset={4}>
            {runNowAvailability.message}
          </TooltipContent>
        ) : null}
      </Tooltip>
      <DropdownMenu>
        <Tooltip>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <Button type="button" variant="ghost" size="icon-sm" aria-label={menuLabel}>
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {menuLabel}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" className="w-48">
          {compact ? (
            <>
              {onCopyUrl ? (
                <DropdownMenuItem onSelect={onCopyUrl}>
                  <Link className="size-3.5" />
                  {copyUrlLabel}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onSelect={() => onToggle(automation)}>
                <ToggleIcon className="size-3.5" />
                {toggleLabel}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onEdit(automation)}>
                <Pencil className="size-3.5" />
                {editLabel}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          <DropdownMenuItem variant="destructive" onSelect={() => onDelete(automation)}>
            <Trash2 className="size-3.5" />
            {t('auto.components.automations.AutomationDetail.1f6026358e', 'Delete automation')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
