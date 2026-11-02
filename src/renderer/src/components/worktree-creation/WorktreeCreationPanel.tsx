import React from 'react'
import { AlertTriangle, Loader2, RotateCcw } from 'lucide-react'
import { useAppStore } from '@/store'
import { retryBackgroundWorktreeCreation } from '@/lib/worktree-creation-flow'
import {
  getCreationProgressLabel,
  getVisibleCheckoutProgress
} from '@/lib/pending-worktree-creation'
import { Progress } from '@/components/ui/progress'
import { translate } from '@/i18n/i18n'
import WorktreeCreationTabStrip from './WorktreeCreationTabStrip'
import { formatElapsedTime, useWorktreeCreationClock } from './worktree-creation-clock'

/** Debounced in-frame creation placeholder: tab strip names the workspace while body shows status, enabling same-frame handoff without duplicating labels. */
export default function WorktreeCreationPanel({
  creationId,
  reserveCollapsedSidebarHeaderSpace = false
}: {
  creationId: string
  reserveCollapsedSidebarHeaderSpace?: boolean
}): React.JSX.Element | null {
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
          <VmProvisioningStatus
            elapsedLabel={elapsedLabel}
            log={entry.provisioningLog ?? ''}
            error={
              isError
                ? (entry.error ??
                  translate(
                    'auto.components.worktree.creation.WorktreeCreationPanel.767951265d',
                    'Something went wrong while creating the worktree.'
                  ))
                : null
            }
            onCancel={dismiss}
            onRetry={() => retryBackgroundWorktreeCreation(creationId)}
            onDismiss={dismiss}
          />
        ) : isError ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="font-medium text-destructive">
              {translate(
                'auto.components.worktree.creation.WorktreeCreationPanel.ed2a664f8b',
                'Couldn’t create worktree'
              )}
            </span>
            <span className="text-muted-foreground">
              {entry.error ??
                translate(
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
              {translate(
                'auto.components.worktree.creation.WorktreeCreationPanel.34dd5ee38b',
                'Retry'
              )}
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="text-muted-foreground hover:text-foreground hover:underline"
            >
              {translate(
                'auto.components.worktree.creation.WorktreeCreationPanel.dabd226118',
                'Dismiss'
              )}
            </button>
          </div>
        ) : (
          <div className="flex min-h-0 max-w-3xl flex-col gap-2 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <Loader2 className="size-3.5 shrink-0 animate-spin" />
              <span id={progressLabelId} className="tabular-nums">
                {getCreationProgressLabel(entry)}
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

function VmProvisioningStatus({
  elapsedLabel,
  log,
  error,
  onCancel,
  onRetry,
  onDismiss
}: {
  elapsedLabel: string
  log: string
  error?: string | null
  onCancel?: () => void
  onRetry?: () => void
  onDismiss?: () => void
}): React.JSX.Element {
  const isError = error !== undefined && error !== null
  return (
    <div className="flex min-h-full justify-center pt-12">
      <div className="flex w-full max-w-2xl flex-col gap-4">
        <div className="flex flex-col items-center gap-2 text-center">
          {isError ? (
            <>
              <div className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-sm font-medium">
                <AlertTriangle className="size-4 shrink-0 text-destructive" />
                <span className="text-destructive">
                  {translate(
                    'auto.components.worktree.creation.WorktreeCreationPanel.ed2a664f8b',
                    'Couldn’t create worktree'
                  )}
                </span>
                <span className="font-normal text-muted-foreground">{error}</span>
              </div>
              <div className="flex items-center gap-3 text-xs">
                <button
                  type="button"
                  onClick={onRetry}
                  className="inline-flex items-center gap-1 text-foreground hover:underline"
                >
                  <RotateCcw className="size-3" />
                  {translate(
                    'auto.components.worktree.creation.WorktreeCreationPanel.34dd5ee38b',
                    'Retry'
                  )}
                </button>
                <button
                  type="button"
                  onClick={onDismiss}
                  className="text-muted-foreground hover:text-foreground hover:underline"
                >
                  {translate(
                    'auto.components.worktree.creation.WorktreeCreationPanel.dabd226118',
                    'Dismiss'
                  )}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                <span>
                  {translate(
                    'auto.components.worktree.creation.WorktreeCreationPanel.vmProvisioningTitle',
                    'Provisioning VM'
                  )}
                </span>
                <span className="text-xs font-normal text-muted-foreground">{elapsedLabel}</span>
              </div>
              <button
                type="button"
                onClick={onCancel}
                className="text-xs text-muted-foreground hover:text-foreground hover:underline"
              >
                {translate(
                  'auto.components.worktree.creation.WorktreeCreationPanel.cancelProvisioning',
                  'Cancel'
                )}
              </button>
            </>
          )}
        </div>
        <RecipeOutputLog
          log={log}
          emptyLabel={translate(
            'auto.components.worktree.creation.WorktreeCreationPanel.vmProvisioningLogEmpty',
            'Waiting for recipe output…'
          )}
        />
      </div>
    </div>
  )
}

// Recipe stderr explains both slow progress and failures; retain the same fixed log surface.
function RecipeOutputLog({
  log,
  emptyLabel
}: {
  log: string
  emptyLabel: string
}): React.JSX.Element {
  const ref = React.useRef<HTMLPreElement>(null)
  // Follow output until user scrolls up; resume only when they return to bottom.
  const pinnedToBottomRef = React.useRef(true)
  const handleScroll = React.useCallback((): void => {
    const el = ref.current
    if (!el) {
      return
    }
    pinnedToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 8
  }, [])
  React.useEffect(() => {
    const el = ref.current
    if (el && pinnedToBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [log])
  return (
    <pre
      ref={ref}
      onScroll={handleScroll}
      className="scrollbar-sleek h-72 overflow-auto whitespace-pre-wrap rounded-md bg-muted/40 p-3 font-mono text-[11px] leading-4 text-muted-foreground"
    >
      {log || <span className="text-muted-foreground/60">{emptyLabel}</span>}
    </pre>
  )
}
