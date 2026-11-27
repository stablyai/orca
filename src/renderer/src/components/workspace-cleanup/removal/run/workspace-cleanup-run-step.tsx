import React, { memo, useMemo, useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import type { WorkspaceCleanupCandidate } from '../../../../../../shared/workspace-cleanup/workspace-cleanup'
import { getWorkspaceCleanupGroup } from '../../../../../../shared/workspace-cleanup/workspace-cleanup-groups'
import { WorkspaceCleanupDialogHeader } from '../../dialog/workspace-cleanup-dialog-header'
import { formatWorkspaceCleanupRelativeTime } from '../../candidate-list/workspace-cleanup-relative-time'
import { WorkspaceCleanupCandidateList } from '../../candidate-list/workspace-cleanup-candidate-list'
import { WorkspaceCleanupRetryButton } from '../workspace-cleanup-retry-button'
import { WorkspaceCleanupRunRowLabel } from './workspace-cleanup-run-row-label'
import { WorkspaceCleanupRunOutcomeIcon } from './workspace-cleanup-run-outcome-icon'
import { getWorkspaceCleanupRunFinishedTitle } from './workspace-cleanup-run-view'
import {
  getWorkspaceCleanupRunCounts,
  getWorkspaceCleanupRunPhase,
  type WorkspaceCleanupRun,
  type WorkspaceCleanupRunRow
} from './workspace-cleanup-run-store'

/** Failed rows lead once the run is over, so what needs attention is on screen. */
export function orderWorkspaceCleanupRunRows(
  run: WorkspaceCleanupRun
): readonly WorkspaceCleanupRunRow[] {
  if (getWorkspaceCleanupRunPhase(run) === 'running') {
    return run.rows
  }
  return [
    ...run.rows.filter((row) => row.status === 'failed'),
    ...run.rows.filter((row) => row.status !== 'failed')
  ]
}

export function WorkspaceCleanupRunStep({
  run,
  now,
  onDeleteAnyway,
  onClose,
  onDone
}: {
  run: WorkspaceCleanupRun
  now: number
  onDeleteAnyway: (candidate: WorkspaceCleanupCandidate) => void
  /** Runs it in the background while deleting; just closes once finished. */
  onClose: () => void
  onDone: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const counts = getWorkspaceCleanupRunCounts(run)
  const running = getWorkspaceCleanupRunPhase(run) === 'running'
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const items = useMemo(
    () => orderWorkspaceCleanupRunRows(run).map((row) => ({ worktreeId: row.identity, row })),
    [run]
  )
  return (
    <>
      <WorkspaceCleanupDialogHeader
        title={
          running ? (
            t('components.workspace.cleanup.deleting.title', 'Deleting {{count}} workspaces', {
              count: counts.total,
              defaultValue_one: 'Deleting {{count}} workspace'
            })
          ) : (
            <span className="flex items-center gap-2">
              <WorkspaceCleanupRunOutcomeIcon hasFailures={counts.failed > 0} />
              {getWorkspaceCleanupRunFinishedTitle(t, counts)}
            </span>
          )
        }
        closeLabel={
          running
            ? t('components.workspace.cleanup.deleting.runInBackground', 'Run in background')
            : undefined
        }
        onClose={onClose}
      />
      {running ? (
        <div className="border-b border-border px-4 py-3">
          <p className="text-sm">
            {t('components.workspace.cleanup.deleting.progress', '{{done}} of {{total}} deleted', {
              done: counts.deleted,
              total: counts.total
            })}
          </p>
          <Progress
            aria-hidden="true"
            value={counts.total === 0 ? 0 : (counts.settled / counts.total) * 100}
            className="mt-2 h-1.5"
          />
        </div>
      ) : counts.failed > 0 ? (
        <p className="border-b border-border px-4 py-3 text-sm text-destructive">
          {t('components.workspace.cleanup.done.failedLine', "{{count}} couldn't be deleted.", {
            count: counts.failed,
            defaultValue_one: "{{count}} couldn't be deleted."
          })}
        </p>
      ) : null}
      <ScrollArea className="min-h-0 flex-1" viewportRef={setScrollElement}>
        <WorkspaceCleanupCandidateList
          rows={items}
          getRowKey={(item) => item.row.identity}
          scrollElement={scrollElement}
          renderRow={(item) => (
            <RunRow
              key={item.row.identity}
              row={item.row}
              now={now}
              onDeleteAnyway={onDeleteAnyway}
            />
          )}
        />
      </ScrollArea>
      <DialogFooter variant="bar" className="flex-row justify-end">
        <Button
          data-workspace-cleanup-run-action
          variant={running ? 'outline' : 'default'}
          onClick={running ? onClose : onDone}
        >
          {running
            ? t('components.workspace.cleanup.deleting.runInBackground', 'Run in background')
            : t('components.workspace.cleanup.done.button', 'Done')}
        </Button>
      </DialogFooter>
    </>
  )
}

function RunRowStatus({
  status
}: {
  status: Exclude<WorkspaceCleanupRunRow['status'], 'provisional'>
}): React.JSX.Element {
  const t = useTranslate()
  const base = 'inline-flex items-center gap-1 text-xs font-medium'
  if (status === 'deleted') {
    return (
      <span className={cn(base, 'text-[var(--git-decoration-added)]')}>
        <Check className="size-3.5" aria-hidden="true" />
        {t('components.workspace.cleanup.deleting.statusDeleted', 'Deleted')}
      </span>
    )
  }
  if (status === 'deleting') {
    return (
      <span className={cn(base, 'text-muted-foreground')}>
        <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        {t('components.workspace.cleanup.deleting.statusDeleting', 'Deleting…')}
      </span>
    )
  }
  if (status === 'failed') {
    return (
      <span className={cn(base, 'text-destructive')}>
        {t('components.workspace.cleanup.deleting.statusFailed', "Couldn't delete")}
      </span>
    )
  }
  return (
    <span className={cn(base, 'font-normal text-muted-foreground')}>
      {t('components.workspace.cleanup.deleting.statusWaiting', 'Waiting')}
    </span>
  )
}

const RunRow = memo(function RunRow({
  row,
  now,
  onDeleteAnyway
}: {
  row: WorkspaceCleanupRunRow
  now: number
  onDeleteAnyway: (candidate: WorkspaceCleanupCandidate) => void
}): React.JSX.Element {
  const t = useTranslate()
  const { failure } = row
  // A timed-out delete reads as still deleting until its real outcome arrives.
  const status = row.status === 'provisional' ? 'deleting' : row.status
  return (
    <div className="flex items-start gap-3 border-b border-border/60 px-4 py-2.5">
      <WorkspaceCleanupRunRowLabel
        candidate={row.candidate}
        group={getWorkspaceCleanupGroup(row.candidate)}
        detail={
          status === 'failed' ? (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-destructive">
              {failure?.message ? (
                <span className="min-w-0 break-words">{failure.message}</span>
              ) : null}
              {failure?.canDeleteAnyway ? (
                <WorkspaceCleanupRetryButton candidate={row.candidate} onConfirm={onDeleteAnyway} />
              ) : null}
            </div>
          ) : undefined
        }
      />
      <div className="flex shrink-0 flex-col items-end gap-0.5">
        <RunRowStatus status={status} />
        <span className="text-xs tabular-nums text-muted-foreground">
          {formatWorkspaceCleanupRelativeTime(row.candidate.lastActivityAt, now, t)}
        </span>
      </div>
    </div>
  )
})
