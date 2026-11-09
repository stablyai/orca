import { useEffect, useState } from 'react'
import {
  CalendarClock,
  Github,
  History,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Trash2,
  Webhook
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
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
  RoutineRun
} from '../../../../../shared/cloud-api/cloud-api-types'
import { RoutineRunHistory, type LoadRoutineRuns } from './RoutineRunHistory'
import {
  describeRoutineTrigger,
  formatAbsoluteTime,
  formatRelativeFromNow
} from './cloud-api-format'
import { RoutineRunStatusPill } from './cloud-api-parts'
import { isActiveRunStatus } from './routine-run-status'

function TriggerIcon({ kind }: { kind: Routine['trigger']['kind'] }): React.JSX.Element {
  const Icon = kind === 'schedule' ? CalendarClock : kind === 'github' ? Github : Webhook
  return <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
}

/**
 * One routine: name, trigger, where it runs, last run and next run on the left; the two things
 * people do most (Run now, the on/off switch) on the right; everything else in the ⋯ menu.
 */
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
  onRunNow,
  onLatestRun,
  onOpenWorkspace,
  fixedNow
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
  onLatestRun?: (run: RoutineRun | null) => void
  onOpenWorkspace?: (workspaceId: string) => void
  fixedNow?: number
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
  useEffect(() => {
    if (notice?.tone !== 'ok') {
      return
    }
    const timer = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(timer)
  }, [notice])
  const lastRun = routine.lastRun
  const active = lastRun !== null && isActiveRunStatus(lastRun.status)

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
    if (active) {
      // The history polls and refreshes the pill, so a finished run is noticed right away.
      if (!expanded) {
        onToggleHistory()
      }
      return
    }
    if (running) {
      return
    }
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
    <li data-settings-row="" data-routine-id={routine.id} className="py-3">
      <div className="flex items-start gap-3">
        <TriggerIcon kind={routine.trigger.kind} />
        <div className="min-w-0 flex-1 space-y-1">
          <p
            className={cn('truncate text-sm font-medium', !isOn && 'text-muted-foreground')}
            title={routine.name}
          >
            {routine.name}
            {!isOn ? (
              <span className="sr-only">
                {' '}
                {t('auto.components.settings.cloudRoutines.pausedSr', '(paused)')}
              </span>
            ) : null}
          </p>
          <p className="truncate text-xs text-foreground/80">
            {describeRoutineTrigger(routine.trigger, t, locale)}
            {where ? <span className="text-muted-foreground"> · {where}</span> : null}
            <span className="text-muted-foreground">
              {' · '}
              {routine.agent === 'codex'
                ? t('auto.components.settings.cloudRoutines.agentCodex', 'Codex')
                : t('auto.components.settings.cloudRoutines.agentClaude', 'Claude Code')}
            </span>
          </p>
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {lastRun ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="sr-only">
                  {t('auto.components.settings.cloudRoutines.lastRun', 'Last run:')}
                </span>
                <RoutineRunStatusPill status={lastRun.status} />
                {lastRun.finishedAt ? (
                  <time
                    dateTime={new Date(lastRun.finishedAt).toISOString()}
                    title={formatAbsoluteTime(lastRun.finishedAt, locale)}
                  >
                    {formatRelativeFromNow(lastRun.finishedAt, now, locale)}
                  </time>
                ) : null}
              </span>
            ) : (
              <span>{t('auto.components.settings.cloudRoutines.neverRun', 'Never run')}</span>
            )}
            {isOn && routine.nextRunAt ? (
              <>
                <span aria-hidden>·</span>
                <time
                  dateTime={new Date(routine.nextRunAt).toISOString()}
                  title={formatAbsoluteTime(routine.nextRunAt, locale)}
                >
                  {t('auto.components.settings.cloudRoutines.nextRun', 'Next run {{value0}}', {
                    value0: formatRelativeFromNow(routine.nextRunAt, now, locale)
                  })}
                </time>
              </>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            aria-disabled={running && !active}
            aria-busy={running || active}
            aria-expanded={active ? expanded : undefined}
            aria-controls={active ? historyId : undefined}
            onClick={() => void runNow()}
            aria-label={
              active
                ? t(
                    'auto.components.settings.cloudRoutines.runningShowHistory',
                    '{{value0}} is running. Show run history',
                    { value0: routine.name }
                  )
                : t('auto.components.settings.cloudRoutines.runNowLabel', 'Run {{value0}} now', {
                    value0: routine.name
                  })
            }
            title={
              active
                ? t(
                    'auto.components.settings.cloudRoutines.alreadyRunning',
                    'A run is already in progress.'
                  )
                : undefined
            }
          >
            {running || active ? (
              <Loader2 className="animate-spin motion-reduce:animate-none" />
            ) : (
              <Play />
            )}
            {active
              ? t('auto.components.settings.cloudRoutines.runningNow', 'Running…')
              : t('auto.components.settings.cloudRoutines.runNow', 'Run now')}
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
              <DropdownMenuItem onSelect={onToggleHistory} aria-controls={historyId}>
                <History />
                {expanded
                  ? t('auto.components.settings.cloudRoutines.hideHistory', 'Hide run history')
                  : t('auto.components.settings.cloudRoutines.showHistory', 'Show run history')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil />
                {t('auto.components.settings.cloudRoutines.edit', 'Edit…')}
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
            aria-disabled={enabled !== null}
            aria-busy={enabled !== null}
            onCheckedChange={(next) => (enabled !== null ? undefined : void toggle(next))}
            aria-label={t(
              'auto.components.settings.cloudRoutines.enableLabel',
              'Enable {{value0}}',
              { value0: routine.name }
            )}
          />
        </div>
      </div>
      {notice?.tone === 'error' ? (
        <div className="pl-7">
          <InlineError title={notice.text} className="mt-2" />
        </div>
      ) : (
        <p
          aria-live="polite"
          className={cn('pl-7 text-xs text-muted-foreground', notice ? 'mt-1.5' : 'sr-only')}
        >
          {notice?.text ?? ''}
        </p>
      )}
      {expanded ? (
        <div id={historyId} className="pl-7">
          <RoutineRunHistory
            routineId={routine.id}
            loadRuns={loadRuns}
            refreshKey={historyRefresh}
            onLatestRun={onLatestRun}
            onOpenWorkspace={onOpenWorkspace}
            fixedNow={fixedNow}
          />
        </div>
      ) : null}
    </li>
  )
}
