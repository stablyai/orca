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
import type {
  CloudApiProject,
  Routine,
  RoutineRunStatus
} from '../../../../../shared/cloud-api/cloud-api-types'
import { RoutineRunHistory, type LoadRoutineRuns } from './RoutineRunHistory'
import {
  describeRoutineTrigger,
  formatAbsoluteTime,
  formatRelativeFromNow
} from './cloud-api-format'
import { RoutineRunStatusPill } from './cloud-api-parts'

const ACTIVE_STATUSES: ReadonlySet<RoutineRunStatus> = new Set([
  'queued',
  'starting',
  'running',
  'posting'
])

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

  const lastRun = routine.lastRun
  const active = lastRun !== null && ACTIVE_STATUSES.has(lastRun.status)

  return (
    <li data-settings-row="" className="py-3.5">
      <div className="flex items-start gap-3">
        <TriggerIcon kind={routine.trigger.kind} />
        <button
          type="button"
          className="group/row -mx-1.5 -my-1 min-w-0 flex-1 cursor-pointer space-y-1 rounded-md px-1.5 py-1 text-left outline-none hover:bg-accent/40 focus-visible:ring-[3px] focus-visible:ring-ring/50"
          aria-expanded={expanded}
          aria-controls={historyId}
          onClick={onToggleHistory}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={cn('truncate text-sm font-medium', !isOn && 'text-muted-foreground')}>
              {routine.name}
            </span>
            {!isOn ? (
              <span className="sr-only">
                {t('auto.components.settings.cloudRoutines.paused', 'Paused')}
              </span>
            ) : null}
            <ChevronDown
              aria-hidden
              className={cn(
                'size-3.5 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none',
                expanded && 'rotate-180'
              )}
            />
            <span className="sr-only">
              {t('auto.components.settings.cloudRoutines.history', 'Run history')}
            </span>
          </span>
          <span className="block truncate text-xs text-foreground/80">
            {describeRoutineTrigger(routine.trigger, t, locale)}
          </span>
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
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
          </span>
        </button>
        <div className="flex w-36 shrink-0 flex-col items-end gap-1 pt-0.5">
          {lastRun ? (
            <>
              <span className="sr-only">
                {t('auto.components.settings.cloudRoutines.lastRun', 'Last run:')}
              </span>
              <RoutineRunStatusPill status={lastRun.status} />
              {lastRun.finishedAt ? (
                <span
                  className="text-[11px] text-muted-foreground"
                  title={formatAbsoluteTime(lastRun.finishedAt, locale)}
                >
                  {formatRelativeFromNow(lastRun.finishedAt, now, locale)}
                </span>
              ) : null}
            </>
          ) : (
            <span className="text-xs text-muted-foreground">
              {t('auto.components.settings.cloudRoutines.neverRun', 'Never run')}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={running || active}
            onClick={() => void runNow()}
            aria-label={t(
              'auto.components.settings.cloudRoutines.runNowLabel',
              'Run {{value0}} now',
              { value0: routine.name }
            )}
            title={
              active
                ? t(
                    'auto.components.settings.cloudRoutines.alreadyRunning',
                    'A run is already in progress.'
                  )
                : undefined
            }
          >
            {running ? <Loader2 className="animate-spin motion-reduce:animate-none" /> : <Play />}
            {t('auto.components.settings.cloudRoutines.runNow', 'Run now')}
          </Button>
          <DropdownMenu modal={false}>
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
