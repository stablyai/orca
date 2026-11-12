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
  // Depend on primitive status so stderr’s fresh entry objects cannot continuously reset the interval.
  const now = useWorktreeCreationClock(entry?.status === 'creating')
  if (!entry) {
    return null
  }

  const dismiss = (): void => useAppStore.getState().removePendingWorktreeCreation(creationId)
  const isError = entry.status === 'error'
  // Failed VM creations retain provisioning-vm phase so error and progress share the centered layout.
  const isVmCreation = entry.phase === 'provisioning-vm'
  const title = entry.request.displayName || entry.request.name
  const elapsedLabel = formatElapsedTime(now - entry.startedAt)
  const checkoutProgress = getVisibleCheckoutProgress(entry)

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      <WorktreeCreationTabStrip
        title={title}
        isError={isError}
        reserveCollapsedSidebarHeaderSpace={reserveCollapsedSidebarHeaderSpace}
        onCancel={dismiss}
      />

      <div className="min-h-0 flex-1 p-3">
        {isVmCreation ? (
          // Keep the log fixed across provisioning/failure; swap only header and actions.
          <VmBuildSheet
            creationId={creationId}
            entry={entry}
            elapsedLabel={elapsedLabel}
            error={
              isError
                ? (entry.error ??
                  t(
                    'auto.components.worktree.creation.WorktreeCreationPanel.767951265d',
                    'Something went wrong while creating the worktree.'
                  ))
                : null
            }
            onCancel={dismiss}
            onRetry={() => retryBackgroundWorktreeCreation(creationId)}
            onDismiss={dismiss}
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
                'auto.components.worktree.creation.WorktreeCreationPanel.ed2a664f8b',
                'Couldn’t create worktree'
              )}
            </span>
            <span className="text-muted-foreground">
              {entry.error ??
                t(
                  'auto.components.worktree.creation.WorktreeCreationPanel.767951265d',
                  'Something went wrong while creating the worktree.'
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
