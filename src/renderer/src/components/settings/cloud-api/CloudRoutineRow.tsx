import { useState } from 'react'
import {
  CalendarClock,
  ChevronDown,
  Github,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Trash2,
  Webhook
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type { CloudApiProject, Routine } from '../../../../../shared/cloud-api/cloud-api-types'
import { SettingsBadge } from '../form-controls/SettingsFormControls'
import { RoutineRunHistory, type LoadRoutineRuns } from './RoutineRunHistory'
import {
  describeRoutineTrigger,
  formatAbsoluteTime,
  formatRelativeFromNow
} from './cloud-api-format'
import { RoutineRunStatusPill } from './cloud-api-parts'

function TriggerIcon({ kind }: { kind: Routine['trigger']['kind'] }): React.JSX.Element {
  const Icon = kind === 'schedule' ? CalendarClock : kind === 'github' ? Github : Webhook
  return (
    <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/40 text-muted-foreground">
      <Icon className="size-3.5" aria-hidden />
    </div>
  )
}

export function RoutineRow({
  routine,
  projects,
  now,
  expanded,
  historyRefresh,
  loadRuns,
  onToggleHistory,
  onEdit,
  onDelete,
  onToggle,
  onRunNow
}: {
  routine: Routine
  projects: readonly CloudApiProject[]
  now: number
  expanded: boolean
  historyRefresh: number
  loadRuns: LoadRoutineRuns
  onToggleHistory: () => void
  onEdit: () => void
  onDelete: () => void
  onToggle: (enabled: boolean) => Promise<string | null>
  onRunNow: () => Promise<string | null>
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  const [running, setRunning] = useState(false)
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const historyId = `routine-history-${routine.id}`
  const where =
    (routine.projectId
      ? projects.find((project) => project.id === routine.projectId)?.name
      : null) ??
    routine.repo?.url.replace(/^https:\/\/(www\.)?(github\.com\/)?/, '') ??
    null
  const isOn = enabled ?? routine.enabled

  const toggle = async (next: boolean): Promise<void> => {
    setEnabled(next)
    setNotice(null)
    const failure = await onToggle(next)
    setEnabled(null)
    if (failure) {
      setNotice({ tone: 'error', text: failure })
    }
  }
  const runNow = async (): Promise<void> => {
    setRunning(true)
    setNotice(null)
    const failure = await onRunNow()
    setRunning(false)
    setNotice(
      failure
        ? { tone: 'error', text: failure }
        : {
            tone: 'ok',
            text: t(
              'auto.components.settings.cloudRoutines.queued',
              'Run queued. It shows up in the history below.'
            )
          }
    )
  }

  return (
    <li data-settings-row="" className="py-3.5">
      <div className="flex items-start gap-3">
        <TriggerIcon kind={routine.trigger.kind} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 items-center gap-2">
            <p className={cn('truncate text-sm font-medium', !isOn && 'text-muted-foreground')}>
              {routine.name}
            </p>
            {!isOn ? (
              <SettingsBadge tone="muted">
                {t('auto.components.settings.cloudRoutines.paused', 'Paused')}
              </SettingsBadge>
            ) : null}
          </div>
          <p className="truncate text-xs text-foreground/80">
            {describeRoutineTrigger(routine.trigger, t, locale)}
          </p>
          <p className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
            {where ? <span className="truncate font-mono text-[11px]">{where}</span> : null}
            {where ? <span aria-hidden>·</span> : null}
            <span>{routine.agent === 'codex' ? 'Codex' : 'Claude Code'}</span>
            {isOn && routine.nextRunAt ? (
              <>
                <span aria-hidden>·</span>
                <span title={formatAbsoluteTime(routine.nextRunAt, locale)}>
                  {t('auto.components.settings.cloudRoutines.nextRun', 'Next run {{value0}}', {
                    value0: formatRelativeFromNow(routine.nextRunAt, now, locale)
                  })}
                </span>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {routine.lastRun ? (
            <span
              className="mr-1"
              title={
                routine.lastRun.finishedAt
                  ? t('auto.components.settings.cloudRoutines.lastRunAt', 'Last run {{value0}}', {
                      value0: formatAbsoluteTime(routine.lastRun.finishedAt, locale)
                    })
                  : undefined
              }
            >
              <span className="sr-only">
                {t('auto.components.settings.cloudRoutines.lastRun', 'Last run:')}{' '}
              </span>
              <RoutineRunStatusPill status={routine.lastRun.status} />
            </span>
          ) : (
            <span className="mr-1 text-xs text-muted-foreground">
              {t('auto.components.settings.cloudRoutines.neverRun', 'Never run')}
            </span>
          )}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={running}
            onClick={() => void runNow()}
            aria-label={t(
              'auto.components.settings.cloudRoutines.runNowLabel',
              'Run {{value0}} now',
              { value0: routine.name }
            )}
          >
            {running ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Play />}
            {t('auto.components.settings.cloudRoutines.runNow', 'Run now')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-expanded={expanded}
            aria-controls={historyId}
            onClick={onToggleHistory}
          >
            {t('auto.components.settings.cloudRoutines.history', 'History')}
            <ChevronDown
              className={cn(
                'transition-transform motion-reduce:transition-none',
                expanded && 'rotate-180'
              )}
            />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t(
                  'auto.components.settings.cloudRoutines.more',
                  'More actions for {{value0}}',
                  { value0: routine.name }
                )}
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil />
                {t('auto.components.settings.cloudRoutines.edit', 'Edit')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                <Trash2 />
                {t('auto.components.settings.cloudRoutines.deleteItem', 'Delete…')}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Switch
            className="ml-1.5"
            checked={isOn}
            disabled={enabled !== null}
            onCheckedChange={(next) => void toggle(next)}
            aria-label={t(
              'auto.components.settings.cloudRoutines.enableLabel',
              'Enable {{value0}}',
              { value0: routine.name }
            )}
          />
        </div>
      </div>
      <p
        aria-live="polite"
        className={cn(
          'pl-11 text-xs',
          notice ? 'mt-1.5' : 'sr-only',
          notice?.tone === 'error' ? 'text-destructive' : 'text-muted-foreground'
        )}
      >
        {notice?.text ?? ''}
      </p>
      {expanded ? (
        <div id={historyId} className="pl-11">
          <RoutineRunHistory
            routineId={routine.id}
            loadRuns={loadRuns}
            now={now}
            refreshKey={historyRefresh}
          />
        </div>
      ) : null}
    </li>
  )
}
