// Ordered backup model row with inline reasoning effort selector and reorder/remove controls.
import { ChevronDown, ChevronUp, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { formatUsageLimitResetClock } from '../../../../../shared/agent-session/failures/agent-session-usage-limit'
import type {
  BotBackupCatalogOption,
  BotBackupModelEntry,
  BotBackupModelStatusEntry
} from '../../../../../shared/bots/bot-backup-models'
import { botAgentLabel } from '../bot-presentation'

const DEFAULT_EFFORT_SENTINEL = '__default__'

export function formatBackupEntryLabel(entry: BotBackupModelEntry, includeEffort = false): string {
  const agent = botAgentLabel(entry.agent)
  const base = entry.model ? `${agent} · ${entry.model}` : agent
  return includeEffort && entry.options?.effort ? `${base} (${entry.options.effort})` : base
}

function BackupRowAction({
  label,
  tooltip,
  disabled,
  icon,
  onClick
}: {
  label: string
  tooltip: string
  disabled: boolean
  icon: React.ReactNode
  onClick: () => void
}): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          disabled={disabled}
          aria-label={label}
          onClick={onClick}
        >
          {icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

export function BotBackupModelOrderRow({
  item,
  index,
  total,
  catalogOption,
  disabled,
  onChangeEffort,
  onMoveUp,
  onMoveDown,
  onRemove
}: {
  item: BotBackupModelStatusEntry
  index: number
  total: number
  catalogOption?: BotBackupCatalogOption
  disabled: boolean
  onChangeEffort: (effort: string | undefined) => void
  onMoveUp: () => void
  onMoveDown: () => void
  onRemove: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const label = formatBackupEntryLabel(item.entry)
  const efforts = catalogOption?.efforts ?? []
  const savedEffort = item.entry.options?.effort
  const resetLabel =
    item.state === 'at-limit' && item.resetsAt ? formatUsageLimitResetClock(item.resetsAt) : null

  return (
    <div className="flex min-h-11 items-center gap-2.5 py-2 pr-2 pl-3 text-[13px]">
      <span className="w-4 shrink-0 text-center text-xs tabular-nums text-muted-foreground">
        {index + 1}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className={cn(
              'truncate font-medium leading-[18px]',
              item.state === 'unavailable' ? 'text-muted-foreground' : null
            )}
          >
            {label}
          </span>
          {efforts.length === 0 && savedEffort ? (
            <Badge variant="secondary" className="shrink-0">
              {savedEffort}
            </Badge>
          ) : null}
          {item.state === 'at-limit' ? (
            <Badge variant="outline" className="shrink-0">
              {resetLabel
                ? t('settings.bots.backupModels.atLimitReset', 'At limit · {{time}}', {
                    time: resetLabel
                  })
                : t('settings.bots.backupModels.atLimit', 'At limit')}
            </Badge>
          ) : item.state === 'unavailable' ? (
            <Badge variant="secondary" className="shrink-0">
              {t('settings.bots.backupModels.unavailable', 'Unavailable')}
            </Badge>
          ) : null}
        </div>
      </div>
      {efforts.length > 0 ? (
        <Select
          disabled={disabled}
          value={savedEffort ?? DEFAULT_EFFORT_SENTINEL}
          onValueChange={(value) =>
            onChangeEffort(value === DEFAULT_EFFORT_SENTINEL ? undefined : value)
          }
        >
          <SelectTrigger
            size="xs"
            aria-label={t('settings.bots.backupModels.reasoningEffort', 'Reasoning effort')}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_EFFORT_SENTINEL}>
              {t('settings.bots.backupModels.defaultEffort', 'Default')}
            </SelectItem>
            {efforts.map((choice) => (
              <SelectItem key={choice.value} value={choice.value}>
                {choice.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      <div className="flex shrink-0 items-center gap-0.5">
        <BackupRowAction
          label={t('settings.bots.backupModels.moveUp', 'Move {{model}} up', { model: label })}
          tooltip={t('settings.bots.backupModels.moveUpShort', 'Move up')}
          disabled={disabled || index === 0}
          icon={<ChevronUp className="size-3.5" />}
          onClick={onMoveUp}
        />
        <BackupRowAction
          label={t('settings.bots.backupModels.moveDown', 'Move {{model}} down', { model: label })}
          tooltip={t('settings.bots.backupModels.moveDownShort', 'Move down')}
          disabled={disabled || index === total - 1}
          icon={<ChevronDown className="size-3.5" />}
          onClick={onMoveDown}
        />
        <BackupRowAction
          label={t('settings.bots.backupModels.remove', 'Remove {{model}}', { model: label })}
          tooltip={t('common.remove', 'Remove')}
          disabled={disabled}
          icon={<Trash2 className="size-3.5" />}
          onClick={onRemove}
        />
      </div>
    </div>
  )
}
