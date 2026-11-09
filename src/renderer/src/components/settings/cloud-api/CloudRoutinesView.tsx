import { useState } from 'react'
import {
  CalendarClock,
  ChevronDown,
  Github,
  Loader2,
  MoreHorizontal,
  Pencil,
  Play,
  Plus,
  RefreshCw,
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
  CloudApiInstallation,
  CloudApiProject,
  CloudApiResult,
  Routine,
  RoutineCreated,
  RoutineInput,
  RoutinePatch
} from '../../../../../shared/cloud-api/cloud-api-types'
import { SettingsBadge } from '../form-controls/SettingsFormControls'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { CloudConfirmDialog } from './CloudConfirmDialog'
import { RoutineEditorDialog } from './RoutineEditorDialog'
import { RoutineRunHistory, type LoadRoutineRuns } from './RoutineRunHistory'
import {
  describeRoutineTrigger,
  formatAbsoluteTime,
  formatRelativeFromNow
} from './cloud-api-format'
import {
  CloudApiEmptyState,
  CloudApiErrorNotice,
  CloudApiSkeletonRows,
  RoutineRunStatusPill
} from './cloud-api-parts'
import type { CloudLoadState } from './cloud-load-state'
import type { RoutineDraft } from './routine-draft'

export type CloudRoutinesViewProps = {
  routines: CloudLoadState<Routine[]>
  projects: readonly CloudApiProject[]
  installations: readonly CloudApiInstallation[] | null
  now: number
  localTimezone: string
  onRefresh: () => void
  onCreate: (input: RoutineInput) => Promise<CloudApiResult<RoutineCreated>>
  onUpdate: (id: string, patch: RoutinePatch) => Promise<CloudApiResult<{ routine: Routine }>>
  /** Each resolves to an error message or null. */
  onToggle: (routine: Routine, enabled: boolean) => Promise<string | null>
  onRunNow: (routine: Routine) => Promise<string | null>
  onDelete: (routine: Routine) => Promise<string | null>
  onRotateWebhook: (routine: Routine) => Promise<CloudApiResult<{ url: string }>>
  loadRuns: LoadRoutineRuns
  /** Fixtures: start with the editor, history or delete confirmation open. */
  initial?: {
    editor?: { routineId: string | null; draft?: Partial<RoutineDraft>; webhookUrl?: string }
    historyFor?: string
    deleteId?: string
  }
}

export function CloudRoutinesView(props: CloudRoutinesViewProps): React.JSX.Element {
  const t = useTranslate()
  const { routines, initial } = props
  const list = routines.status === 'ok' ? routines.data : []
  const find = (id: string | null | undefined): Routine | null =>
    list.find((routine) => routine.id === id) ?? null

  const [editorOpen, setEditorOpen] = useState(Boolean(initial?.editor))
  const [editing, setEditing] = useState<Routine | null>(() => find(initial?.editor?.routineId))
  const [deleting, setDeleting] = useState<Routine | null>(() => find(initial?.deleteId))
  const [deleteOpen, setDeleteOpen] = useState(Boolean(initial?.deleteId))
  const [expanded, setExpanded] = useState<string | null>(initial?.historyFor ?? null)
  const [historyRefresh, setHistoryRefresh] = useState(0)

  const openEditor = (routine: Routine | null): void => {
    setEditing(routine)
    setEditorOpen(true)
  }
  const newButton = (
    <Button type="button" size="sm" onClick={() => openEditor(null)}>
      <Plus />
      {t('auto.components.settings.cloudRoutines.new', 'New routine')}
    </Button>
  )
  const unavailable = routines.status === 'error' && routines.code === 'not-available'

  return (
    <div className="space-y-8">
      <SettingsGroup
        title={t('auto.components.settings.cloudRoutines.title', 'Routines')}
        description={t(
          'auto.components.settings.cloudRoutines.description',
          'Agents that run in Orca Cloud on a schedule, on GitHub events or from a webhook, even when this computer is off.'
        )}
        action={
          unavailable ? null : (
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={props.onRefresh}
                disabled={routines.status === 'loading'}
                aria-label={t('auto.components.settings.cloudRoutines.refresh', 'Refresh routines')}
              >
                <RefreshCw
                  className={cn(
                    routines.status === 'loading' && 'animate-spin motion-reduce:animate-none'
                  )}
                />
              </Button>
              {routines.status === 'ok' && list.length > 0 ? newButton : null}
            </div>
          )
        }
      >
        {routines.status === 'loading' ? (
          <CloudApiSkeletonRows
            label={t('auto.components.settings.cloudRoutines.loading', 'Loading routines')}
          />
        ) : unavailable ? (
          <CloudApiEmptyState
            icon={CalendarClock}
            title={t(
              'auto.components.settings.cloudRoutines.unavailableTitle',
              'Routines are on their way'
            )}
            description={t(
              'auto.components.settings.cloudRoutines.unavailableBody',
              'Your Orca Cloud account does not have routines yet. They will appear here as soon as they are turned on.'
            )}
          />
        ) : routines.status === 'error' ? (
          <div data-settings-row="" className="py-4">
            <CloudApiErrorNotice message={routines.message} onRetry={props.onRefresh} />
          </div>
        ) : list.length === 0 ? (
          <CloudApiEmptyState
            icon={CalendarClock}
            title={t('auto.components.settings.cloudRoutines.emptyTitle', 'No routines yet')}
            description={t(
              'auto.components.settings.cloudRoutines.emptyBody',
              'Review every PR labeled “orca”, triage new issues each morning, or kick off a fix from CI. Each run gets its own cloud workspace.'
            )}
            action={newButton}
          />
        ) : (
          <ul aria-label={t('auto.components.settings.cloudRoutines.listLabel', 'Routines')}>
            {list.map((routine) => (
              <RoutineRow
                key={routine.id}
                routine={routine}
                projects={props.projects}
                now={props.now}
                expanded={expanded === routine.id}
                historyRefresh={historyRefresh}
                loadRuns={props.loadRuns}
                onToggleHistory={() => setExpanded(expanded === routine.id ? null : routine.id)}
                onEdit={() => openEditor(routine)}
                onDelete={() => {
                  setDeleting(routine)
                  setDeleteOpen(true)
                }}
                onToggle={(enabled) => props.onToggle(routine, enabled)}
                onRunNow={async () => {
                  const failure = await props.onRunNow(routine)
                  if (!failure) {
                    setExpanded(routine.id)
                    setHistoryRefresh((value) => value + 1)
                  }
                  return failure
                }}
              />
            ))}
          </ul>
        )}
      </SettingsGroup>

      <RoutineEditorDialog
        open={editorOpen}
        onOpenChange={setEditorOpen}
        routine={editing}
        projects={props.projects}
        installations={props.installations}
        localTimezone={props.localTimezone}
        onCreate={props.onCreate}
        onUpdate={props.onUpdate}
        onRotateWebhook={props.onRotateWebhook}
        initialDraft={initial?.editor?.draft}
        initialWebhookUrl={initial?.editor?.webhookUrl}
      />
      <CloudConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t('auto.components.settings.cloudRoutines.delete.title', 'Delete “{{value0}}”?', {
          value0: deleting?.name ?? ''
        })}
        description={
          <p>
            {t(
              'auto.components.settings.cloudRoutines.delete.body',
              'It stops running and its run history is deleted. Workspaces it already started are not affected.'
            )}
          </p>
        }
        confirmLabel={t('auto.components.settings.cloudRoutines.delete.confirm', 'Delete routine')}
        onConfirm={async () => (deleting ? props.onDelete(deleting) : null)}
      />
    </div>
  )
}

function TriggerIcon({ kind }: { kind: Routine['trigger']['kind'] }): React.JSX.Element {
  const Icon = kind === 'schedule' ? CalendarClock : kind === 'github' ? Github : Webhook
  return (
    <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/40 text-muted-foreground">
      <Icon className="size-3.5" aria-hidden />
    </div>
  )
}

function RoutineRow({
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
