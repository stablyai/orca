import { useState } from 'react'
import {
  Archive,
  ArrowUpFromLine,
  Bot,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  CircleMinus,
  Clock,
  Eye,
  FileDiff,
  FileLock,
  FilePen,
  Loader,
  Pin,
  SquareTerminal,
  TriangleAlert,
  type LucideIcon
} from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { uiDateTimeFormat } from '@/i18n/ui-intl-formatters'
import { formatBytes } from '../../../../../shared/format-bytes'
import type {
  WorkspaceCleanupRun,
  WorkspaceCleanupRunRow
} from '../../../../../shared/workspace-cleanup/workspace-cleanup-run'
import { Button } from '../../ui/button'
import { WorkspaceCleanupMetadataText } from '@/components/workspace-cleanup/candidate-list/workspace-cleanup-metadata-chip'
import type { WorkspaceCleanupKeepCause } from '../../../../../shared/workspace-cleanup/workspace-cleanup-evaluation'
import { formatCleanupKeepCause, formatCleanupRunTrigger } from './workspace-cleanup-run-labels'
import { WorkspaceCleanupReasonChip } from './workspace-cleanup-reason-chip'
import { WorkspaceCleanupWorkspaceLine } from './workspace-cleanup-workspace-line'

const KEPT_PREVIEW_COUNT = 4

const KEEP_CAUSE_ICONS: Partial<Record<WorkspaceCleanupKeepCause, LucideIcon>> = {
  pinned: Pin,
  'recently-active': Clock,
  'active-workspace': Eye,
  'agent-running': Bot,
  'terminal-running': SquareTerminal,
  'terminal-unknown': SquareTerminal,
  'unsaved-editor-changes': FilePen,
  'uncommitted-changes': FileDiff,
  'unpushed-commits': ArrowUpFromLine,
  'ignored-files': FileLock,
  'git-unknown': CircleHelp,
  'archive-unavailable': Archive,
  'archive-script': Archive,
  removing: Loader
}
const REMOVED_GRID = 'grid grid-cols-[minmax(0,1fr)_9rem_4.5rem_4rem] items-center gap-x-4'

function rowKey(row: WorkspaceCleanupRunRow): string {
  return `${row.executionHostId ?? ''}:${row.worktreeId}`
}

/** Each run's receipt, newest first; the newest opens expanded. */
export function WorkspaceCleanupActivityList({
  runs
}: {
  runs: WorkspaceCleanupRun[]
}): React.JSX.Element {
  // Only the newest run opens by default; a run the viewer toggled keeps its state.
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map())
  return (
    <>
      {runs.map((run, index) => (
        <ActivityRun
          key={run.id}
          run={run}
          open={toggled.get(run.id) ?? index === 0}
          onToggle={() =>
            setToggled((previous) =>
              new Map(previous).set(run.id, !(previous.get(run.id) ?? index === 0))
            )
          }
        />
      ))}
    </>
  )
}

function ActivityRun({
  run,
  open,
  onToggle
}: {
  run: WorkspaceCleanupRun
  open: boolean
  onToggle: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const removed = run.rows.filter((row) => row.outcome === 'removed' || row.outcome === 'archived')
  const kept = run.rows.filter((row) => row.outcome === 'kept')
  const failed = run.rows.filter((row) => row.outcome === 'failed')
  const removedCount = run.counts.removed + run.counts.archived
  const when = uiDateTimeFormat({
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  }).format(run.startedAt)
  const Chevron = open ? ChevronDown : ChevronRight

  return (
    <div data-settings-row="" className="py-3">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full items-center gap-2 text-left"
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          <Chevron className="size-3.5" />
        </span>
        <span className="text-sm font-medium tabular-nums">{when}</span>
        <span className="text-xs text-muted-foreground">
          {formatCleanupRunTrigger(run.trigger, t)}
        </span>
        <span className="ml-auto text-xs tabular-nums text-muted-foreground">
          {run.error ? (
            <span className="text-destructive">
              {t('components.settings.workspaceCleanup.activity.unfinished', "Couldn't finish")}
            </span>
          ) : (
            <>
              {removedCount === 0
                ? t(
                    'components.settings.workspaceCleanup.activity.nothingRemoved',
                    'Nothing to clean'
                  )
                : t(
                    'components.settings.workspaceCleanup.activity.removedCount',
                    '{{count}} removed',
                    {
                      count: removedCount
                    }
                  )}
              {', '}
              {t('components.settings.workspaceCleanup.activity.keptCount', '{{count}} kept', {
                count: run.counts.kept
              })}
              {run.counts.failed > 0 ? (
                <>
                  {', '}
                  <span className="text-destructive">
                    {t(
                      'components.settings.workspaceCleanup.activity.failedCount',
                      '{{count}} failed',
                      {
                        count: run.counts.failed
                      }
                    )}
                  </span>
                </>
              ) : null}
            </>
          )}
        </span>
      </button>
      {open ? (
        <div className="mt-1 pl-6">
          {run.error ? <ErrorLine message={run.error} /> : null}
          {removed.length > 0 ? (
            <>
              <GroupLabel>
                {t('components.settings.workspaceCleanup.activity.removed', 'Removed · {{count}}', {
                  count: removedCount
                })}
              </GroupLabel>
              {removed.map((row) => (
                <RemovedRow key={rowKey(row)} row={row} />
              ))}
            </>
          ) : null}
          {kept.length > 0 ? <KeptRows rows={kept} total={run.counts.kept} /> : null}
          {failed.length > 0 ? (
            <>
              <GroupLabel>
                {t('components.settings.workspaceCleanup.activity.failed', 'Failed · {{count}}', {
                  count: run.counts.failed
                })}
              </GroupLabel>
              {failed.map((row) => (
                <div key={rowKey(row)} className="min-w-0 py-1.5">
                  <WorkspaceCleanupWorkspaceLine workspace={row} />
                  {row.error ? <ErrorLine message={row.error} /> : null}
                </div>
              ))}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function GroupLabel({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <p className="pt-2 pb-0.5 text-xs font-medium text-muted-foreground">{children}</p>
}

function ErrorLine({ message }: { message: string }): React.JSX.Element {
  return (
    <p className="mt-0.5 flex items-center gap-1.5 text-xs text-destructive">
      <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
      {message}
    </p>
  )
}

function RemovedRow({ row }: { row: WorkspaceCleanupRunRow }): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className={`${REMOVED_GRID} py-1.5`}>
      <WorkspaceCleanupWorkspaceLine workspace={row} />
      <div className="justify-self-start">
        {row.reason ? <WorkspaceCleanupReasonChip reason={row.reason} /> : null}
      </div>
      <span className="text-xs text-muted-foreground">
        {row.outcome === 'archived'
          ? t('components.settings.workspaceCleanup.activity.archived', 'Archived')
          : t('components.settings.workspaceCleanup.activity.deleted', 'Deleted')}
      </span>
      <span className="text-right text-xs tabular-nums text-muted-foreground">
        {row.sizeBytes !== undefined ? formatBytes(row.sizeBytes) : null}
      </span>
    </div>
  )
}

function KeptRows({
  rows,
  total
}: {
  rows: WorkspaceCleanupRunRow[]
  total: number
}): React.JSX.Element {
  const t = useTranslate()
  const [showAll, setShowAll] = useState(false)
  const visible = showAll ? rows : rows.slice(0, KEPT_PREVIEW_COUNT)
  const hidden = rows.length - visible.length
  return (
    <>
      <GroupLabel>
        {t('components.settings.workspaceCleanup.activity.kept', 'Kept · {{count}}', {
          count: total
        })}
      </GroupLabel>
      {visible.map((row) => (
        <div
          key={rowKey(row)}
          className="grid grid-cols-[minmax(0,1fr)_minmax(0,auto)] items-center gap-x-4 py-1.5"
        >
          <WorkspaceCleanupWorkspaceLine workspace={row} />
          <KeptReason row={row} />
        </div>
      ))}
      {hidden > 0 ? (
        <div className="py-1">
          <Button variant="ghost" size="xs" className="-ml-2" onClick={() => setShowAll(true)}>
            {t('components.settings.workspaceCleanup.activity.showMore', 'Show {{count}} more', {
              count: hidden
            })}
            <ChevronDown className="size-3" />
          </Button>
        </div>
      ) : null}
    </>
  )
}

function KeptReason({ row }: { row: WorkspaceCleanupRunRow }): React.JSX.Element | null {
  const t = useTranslate()
  if (row.keepCause === 'waiting' && row.waiting) {
    const { elapsedDays, afterDays } = row.waiting
    return (
      <span className="flex items-center gap-2 justify-self-end">
        <span className="relative h-1 w-16 shrink-0 overflow-hidden rounded-full bg-muted">
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-muted-foreground"
            style={{
              width: `${Math.round((Math.min(elapsedDays, afterDays) / afterDays) * 100)}%`
            }}
          />
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {t(
            'components.settings.workspaceCleanup.activity.waiting',
            'Inactive {{elapsed}} of {{after}} days',
            { elapsed: elapsedDays, after: afterDays }
          )}
        </span>
      </span>
    )
  }
  if (!row.keepCause) {
    return null
  }
  const label = formatCleanupKeepCause(row.keepCause, t)
  return (
    <WorkspaceCleanupMetadataText
      icon={KEEP_CAUSE_ICONS[row.keepCause] ?? CircleMinus}
      label={label}
      value={label}
      className="justify-self-end"
    />
  )
}
