import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { CalendarClock, Plus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import type {
  CloudApiInstallation,
  CloudApiProject,
  CloudApiResult,
  Routine,
  RoutineCreated,
  RoutineInput,
  RoutinePatch,
  RoutineRun
} from '../../../../../shared/cloud-api/cloud-api-types'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { CloudConfirmDialog } from './CloudConfirmDialog'
import { RoutineRow } from './CloudRoutineRow'
import { RoutineEditorDialog } from './RoutineEditorDialog'
import type { LoadRoutineRuns } from './RoutineRunHistory'
import { CloudApiEmptyState, CloudApiErrorNotice, CloudApiSkeletonRows } from './cloud-api-parts'
import type { CloudLoadState } from './cloud-load-state'
import type { RoutineDraft } from './routine-draft'

export type CloudRoutinesViewProps = {
  routines: CloudLoadState<Routine[]>
  projects: readonly CloudApiProject[]
  /** The project list could not be loaded (not the same as having none). */
  projectsFailed?: boolean
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
  /** The newest run from an open history, so the row's pill matches it. */
  onLatestRun?: (routine: Routine, run: RoutineRun | null) => void
  onOpenWorkspace?: (workspaceId: string) => void
  /** A refresh is running while the current list stays on screen. */
  refreshing?: boolean
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
  const listRef = useRef<HTMLUListElement>(null)
  const newRef = useRef<HTMLButtonElement>(null)
  const deletedIndex = useRef(0)

  const openEditor = (routine: Routine | null): void => {
    setEditing(routine)
    setEditorOpen(true)
  }
  const newButton = (
    <Button
      ref={newRef}
      type="button"
      size="sm"
      onClick={() => openEditor(null)}
      disabled={routines.status !== 'ok'}
    >
      <Plus />
      {t('auto.components.settings.cloudRoutines.new', 'New routine')}
    </Button>
  )
  const unavailable = routines.status === 'error' && routines.code === 'not-available'

  return (
    <div className="space-y-8">
      <SettingsGroup
        title={t('auto.components.settings.cloudRoutines.listTitle', 'Your routines')}
        description={t(
          'auto.components.settings.cloudRoutines.description',
          'They run in Orca Cloud, even when this computer is off.'
        )}
        action={
          unavailable ? null : (
            <div className="flex items-center gap-1.5">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={props.onRefresh}
                aria-disabled={routines.status === 'loading' || props.refreshing}
                aria-busy={props.refreshing}
                aria-label={t('auto.components.settings.cloudRoutines.refresh', 'Refresh routines')}
              >
                <RefreshCw
                  className={cn(
                    (routines.status === 'loading' || props.refreshing) &&
                      'animate-spin motion-reduce:animate-none'
                  )}
                />
              </Button>
              {routines.status === 'ok' && list.length === 0 ? null : newButton}
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
              'Routines aren’t on yet'
            )}
            description={t(
              'auto.components.settings.cloudRoutines.unavailableBody',
              'Routines aren’t enabled for your team yet. There’s nothing to set up; this page fills in once they are.'
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
          <ul
            ref={listRef}
            aria-label={t('auto.components.settings.cloudRoutines.listLabel', 'Routines')}
          >
            {list.map((routine, index) => (
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
                  deletedIndex.current = index
                  setDeleting(routine)
                  setDeleteOpen(true)
                }}
                onToggle={(enabled) => props.onToggle(routine, enabled)}
                onLatestRun={(run) => props.onLatestRun?.(routine, run)}
                onOpenWorkspace={props.onOpenWorkspace}
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
        projectsFailed={props.projectsFailed}
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
        returnFocusTo={() => {
          // The deleted row is gone: land on the next row's Run now, else New routine.
          if (!deleting || listRef.current?.querySelector(`[data-routine-id="${deleting.id}"]`)) {
            return null
          }
          const rows = [
            ...(listRef.current?.querySelectorAll<HTMLElement>('[data-routine-id]') ?? [])
          ]
          const next = rows[deletedIndex.current] ?? rows[deletedIndex.current - 1]
          return next?.querySelector<HTMLElement>('button') ?? newRef.current
        }}
        onConfirm={async () => {
          if (!deleting) {
            return null
          }
          const failure = await props.onDelete(deleting)
          if (!failure) {
            toast.success(
              t('auto.components.settings.cloudRoutines.delete.done', 'Deleted “{{value0}}”', {
                value0: deleting.name
              })
            )
          }
          return failure
        }}
      />
    </div>
  )
}
