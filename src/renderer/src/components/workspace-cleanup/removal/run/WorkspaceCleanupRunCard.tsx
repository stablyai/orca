import React from 'react'
import { Loader2, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { WorkspaceCleanupRunOutcomeIcon } from './workspace-cleanup-run-outcome-icon'
import {
  getWorkspaceCleanupRunCounts,
  getWorkspaceCleanupRunPhase,
  useWorkspaceCleanupRunStore,
  type WorkspaceCleanupRun
} from './workspace-cleanup-run-store'
import {
  getWorkspaceCleanupRunFinishedTitle,
  openWorkspaceCleanupRunView
} from './workspace-cleanup-run-view'

/** Bottom-right card for a delete that outlives its dialog; stays until dismissed once finished. */
export function WorkspaceCleanupRunCard(): React.JSX.Element | null {
  const run = useWorkspaceCleanupRunStore((s) => s.run)
  const dialogOpen = useAppStore((s) => s.activeModal === 'workspace-cleanup')
  const dismissRun = useWorkspaceCleanupRunStore((s) => s.dismissRun)
  // The dialog already shows this run, so the card steps aside while it is open.
  if (run === null || dialogOpen) {
    return null
  }
  return <WorkspaceCleanupRunCardContent run={run} onDismiss={() => dismissRun(run.id)} />
}

export function WorkspaceCleanupRunCardContent({
  run,
  onDismiss
}: {
  run: WorkspaceCleanupRun
  onDismiss: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const counts = getWorkspaceCleanupRunCounts(run)
  const running = getWorkspaceCleanupRunPhase(run) === 'running'
  const finishedTitle = getWorkspaceCleanupRunFinishedTitle(t, counts)
  const runningTitle = t('components.workspace.cleanup.runCard.title', 'Deleting workspaces')
  return (
    <Card size="notice" role="group" aria-label={runningTitle}>
      {/* Only this line is live, and it changes at start and finish, never per workspace. */}
      <p role="status" className="sr-only">
        {running ? runningTitle : finishedTitle}
      </p>
      <div className="flex flex-col gap-2 p-3">
        <div className="flex items-center gap-2">
          {running ? (
            <Loader2
              className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <WorkspaceCleanupRunOutcomeIcon hasFailures={counts.failed > 0} />
          )}
          <span className="min-w-0 flex-1 text-sm font-semibold" aria-hidden="true">
            {running ? runningTitle : finishedTitle}
          </span>
          {running ? (
            <span
              className="shrink-0 text-xs tabular-nums text-muted-foreground"
              aria-hidden="true"
            >
              {t('components.workspace.cleanup.runCard.progress', '{{done}}/{{total}}', {
                done: counts.deleted,
                total: counts.total
              })}
            </span>
          ) : (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t('components.workspace.cleanup.runCard.dismiss', 'Dismiss')}
              onClick={onDismiss}
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>
        {running ? (
          <Progress
            aria-hidden="true"
            value={counts.total === 0 ? 0 : (counts.settled / counts.total) * 100}
            className="h-1.5"
          />
        ) : counts.failed > 0 ? (
          <p className="text-xs text-destructive">
            {t('components.workspace.cleanup.done.failedLine', "{{count}} couldn't be deleted.", {
              count: counts.failed,
              defaultValue_one: "{{count}} couldn't be deleted."
            })}
          </p>
        ) : null}
        <div className="flex justify-end">
          <Button variant="outline" size="xs" onClick={openWorkspaceCleanupRunView}>
            {t('components.workspace.cleanup.runCard.show', 'Show')}
          </Button>
        </div>
      </div>
    </Card>
  )
}
