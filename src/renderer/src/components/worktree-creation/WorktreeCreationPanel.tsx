import React from 'react'
import { Loader2, RotateCcw } from 'lucide-react'
import { useAppStore } from '@/store'
import { retryBackgroundWorktreeCreation } from '@/lib/workspace/creation/worktree-creation-flow'
import {
  getCreationProgressLabel,
  getVisibleCheckoutProgress
} from '@/lib/workspace/creation/pending-worktree-creation'
import { Progress } from '@/components/ui/progress'
import { useTranslate } from '@/i18n/use-translate'
import WorktreeCreationTabStrip from './WorktreeCreationTabStrip'
import { formatElapsedTime, useWorktreeCreationClock } from './worktree-creation-clock'
import { VmBuildSheet } from './VmBuildSheet'
import { VmDeleteConfirmDialog } from './VmDeleteConfirmDialog'

/** Debounced in-frame creation placeholder: tab strip names the workspace while body shows status, enabling same-frame handoff without duplicating labels. */
export default function WorktreeCreationPanel({
  creationId,
  reserveCollapsedSidebarHeaderSpace = false
}: {
  creationId: string
  reserveCollapsedSidebarHeaderSpace?: boolean
}): React.JSX.Element | null {
  const t = useTranslate()
  const entry = useAppStore((s) => s.pendingWorktreeCreations[creationId])
  const progressLabelId = React.useId()
  const [confirmingDelete, setConfirmingDelete] = React.useState(false)
  const checksFinishedAt =
    entry?.environmentCheck?.status === 'failed' ? entry.environmentCheck.finishedAt : undefined
  // Depend on primitives so stderr’s fresh entry objects cannot continuously reset the interval;
  // a build paused on failed checks waits on the user, so its clock stops.
  const now = useWorktreeCreationClock(
    entry?.status === 'creating' && entry.environmentCheck?.status !== 'failed'
  )
  if (!entry) {
    return null
  }

  const dismiss = (): void => useAppStore.getState().removePendingWorktreeCreation(creationId)
  // A failed or paused VM build still holds a VM that dismissing deletes, so confirm first.
  const holdsVm =
    entry.environmentCheck?.status === 'failed' ||
    (entry.status === 'error' && Boolean(entry.request.ephemeralVmRuntimeId))
  const leave = holdsVm ? () => setConfirmingDelete(true) : dismiss
  const isError = entry.status === 'error'
  // A VM build keeps its sheet through fetch and checkout, so it never drops to the one-line status.
  const isVmCreation = Boolean(entry.request.ephemeralVmRecipe) || entry.phase === 'provisioning-vm'
  const title = entry.request.displayName || entry.request.name
  const stoppedAt = checksFinishedAt ?? (isError ? entry.errorAt : undefined)
  const elapsedLabel = formatElapsedTime((stoppedAt ?? now) - entry.startedAt)
  const checkoutProgress = getVisibleCheckoutProgress(entry)

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <WorktreeCreationTabStrip
        title={title}
        isError={isError}
        reserveCollapsedSidebarHeaderSpace={reserveCollapsedSidebarHeaderSpace}
        onCancel={leave}
      />
      {holdsVm ? (
        <VmDeleteConfirmDialog
          open={confirmingDelete}
          cloud={entry.request.ephemeralVmRecipe?.provider === 'orca-cloud'}
          onOpenChange={setConfirmingDelete}
          onConfirm={() => {
            setConfirmingDelete(false)
            dismiss()
          }}
        />
      ) : null}

      <div className="min-h-0 flex-1 p-3">
        {isVmCreation ? (
          // Keep the log fixed across provisioning/failure; swap only header and actions.
          <VmBuildSheet
            creationId={creationId}
            entry={entry}
            now={now}
            elapsedLabel={elapsedLabel}
            error={
              isError
                ? (entry.error ??
                  t(
                    'auto.components.worktree.creation.WorktreeCreationPanel.somethingWentWrong',
                    'Something went wrong while creating the workspace.'
                  ))
                : null
            }
            onCancel={dismiss}
            onRetry={() => retryBackgroundWorktreeCreation(creationId)}
            onDismiss={leave}
            onEditRecipe={() => {
              const state = useAppStore.getState()
              state.openSettingsTarget({
                pane: 'experimental',
                repoId: null,
                sectionId: 'ephemeral-vms'
              })
              state.openSettingsPage()
            }}
          />
        ) : isError ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="font-medium text-destructive">
              {t(
                'auto.components.worktree.creation.VmBuildFailureCard.createFailedTitle',
                'Couldn’t create workspace'
              )}
            </span>
            <span className="text-muted-foreground">
              {entry.error ??
                t(
                  'auto.components.worktree.creation.WorktreeCreationPanel.somethingWentWrong',
                  'Something went wrong while creating the workspace.'
                )}
            </span>
            <button
              type="button"
              onClick={() => retryBackgroundWorktreeCreation(creationId)}
              className="inline-flex items-center gap-1 text-foreground hover:underline"
            >
              <RotateCcw className="size-3" />
              {t('auto.components.worktree.creation.WorktreeCreationPanel.34dd5ee38b', 'Retry')}
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="text-muted-foreground hover:text-foreground hover:underline"
            >
              {t('auto.components.worktree.creation.WorktreeCreationPanel.dabd226118', 'Dismiss')}
            </button>
          </div>
        ) : (
          <div className="flex min-h-0 max-w-3xl flex-col gap-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <Loader2 className="size-3.5 shrink-0 animate-spin" />
              <span id={progressLabelId} className="tabular-nums">
                {getCreationProgressLabel(entry, t)}
              </span>
              <span className="text-muted-foreground/70">{elapsedLabel}</span>
            </div>
            {checkoutProgress ? (
              <Progress
                value={checkoutProgress.percent}
                aria-labelledby={progressLabelId}
                className="h-1.5 max-w-xs"
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
