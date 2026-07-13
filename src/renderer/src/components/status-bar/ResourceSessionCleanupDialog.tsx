import React from 'react'
import { LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import type { ResourceSessionCleanupReviewState } from './resource-session-cleanup-review'

export function ResourceSessionCleanupDialog({
  state,
  onClose,
  onRetry,
  onConfirm
}: {
  state: ResourceSessionCleanupReviewState
  onClose: () => void
  onRetry: () => void
  onConfirm: () => void
}): React.JSX.Element {
  const running = state.phase === 'running'
  const readyReview = state.phase === 'ready' ? state.review : null
  const inactiveCount = readyReview?.inactiveIds.length ?? 0
  const protectedCount = readyReview ? readyReview.activeCount + readyReview.unknownCount : 0

  return (
    <Dialog
      open={state.phase !== 'closed'}
      onOpenChange={(open) => {
        if (!open && !running) {
          onClose()
        }
      }}
    >
      <DialogContent
        className="max-w-md"
        showCloseButton={!running}
        onPointerDownOutside={(event) => {
          if (running) {
            event.preventDefault()
          }
        }}
        onEscapeKeyDown={(event) => {
          if (running) {
            event.preventDefault()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate(
              'auto.components.status.bar.ResourceSessionCleanupDialog.title',
              'Review unbound terminals'
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {state.phase === 'reviewing'
              ? translate(
                  'auto.components.status.bar.ResourceSessionCleanupDialog.reviewing',
                  'Checking current process activity…'
                )
              : state.phase === 'running'
                ? translate(
                    'auto.components.status.bar.ResourceSessionCleanupDialog.running',
                    'Closing confirmed inactive terminals…'
                  )
                : state.phase === 'completed'
                  ? translate(
                      'auto.components.status.bar.ResourceSessionCleanupDialog.completed',
                      'Cleanup finished. Review the verified result below.'
                    )
                  : state.phase === 'error'
                    ? state.message
                    : translate(
                        'auto.components.status.bar.ResourceSessionCleanupDialog.description',
                        'Only terminals freshly verified as idle shells can be closed. Active and unverified terminals are protected.'
                      )}
          </DialogDescription>
        </DialogHeader>

        {state.phase === 'ready' ? (
          <div className="space-y-1 text-xs text-muted-foreground" aria-live="polite">
            <p>
              {inactiveCount === 1
                ? translate(
                    'auto.components.status.bar.ResourceSessionCleanupDialog.inactiveOne',
                    '1 inactive terminal can be closed.'
                  )
                : translate(
                    'auto.components.status.bar.ResourceSessionCleanupDialog.inactiveMany',
                    '{{value0}} inactive terminals can be closed.',
                    { value0: inactiveCount }
                  )}
            </p>
            <p>
              {protectedCount === 1
                ? translate(
                    'auto.components.status.bar.ResourceSessionCleanupDialog.protectedOne',
                    '1 active or unverified terminal will be protected.'
                  )
                : translate(
                    'auto.components.status.bar.ResourceSessionCleanupDialog.protectedMany',
                    '{{value0}} active or unverified terminals will be protected.',
                    { value0: protectedCount }
                  )}
            </p>
            {state.review.goneCount > 0 ? (
              <p>
                {translate(
                  'auto.components.status.bar.ResourceSessionCleanupDialog.gone',
                  '{{value0}} terminal(s) already exited during review.',
                  { value0: state.review.goneCount }
                )}
              </p>
            ) : null}
          </div>
        ) : null}

        {state.phase === 'completed' ? (
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {translate(
              'auto.components.status.bar.ResourceSessionCleanupDialog.result',
              'Closed: {{value0}}. Protected: {{value1}}. Already gone: {{value2}}. Failed: {{value3}}.',
              {
                value0: state.result.killedCount,
                value1: state.result.protectedCount,
                value2: state.result.goneCount,
                value3: state.result.failedCount
              }
            )}
          </p>
        ) : null}

        <DialogFooter>
          {state.phase === 'running' ? (
            <Button variant="destructive" disabled>
              <LoaderCircle className="size-4 animate-spin" />
              {translate(
                'auto.components.status.bar.ResourceSessionCleanupDialog.closing',
                'Closing…'
              )}
            </Button>
          ) : state.phase === 'ready' ? (
            <>
              <Button variant="outline" onClick={onClose}>
                {translate(
                  'auto.components.status.bar.ResourceSessionCleanupDialog.cancel',
                  'Cancel'
                )}
              </Button>
              <Button variant="destructive" onClick={onConfirm} disabled={inactiveCount === 0}>
                {inactiveCount === 0
                  ? translate(
                      'auto.components.status.bar.ResourceSessionCleanupDialog.none',
                      'No inactive terminals to kill'
                    )
                  : inactiveCount === 1
                    ? translate(
                        'auto.components.status.bar.ResourceSessionCleanupDialog.killOne',
                        'Kill 1 inactive terminal'
                      )
                    : translate(
                        'auto.components.status.bar.ResourceSessionCleanupDialog.killMany',
                        'Kill {{value0}} inactive terminals',
                        { value0: inactiveCount }
                      )}
              </Button>
            </>
          ) : state.phase === 'error' ? (
            <>
              <Button variant="outline" onClick={onClose}>
                {translate(
                  'auto.components.status.bar.ResourceSessionCleanupDialog.close',
                  'Close'
                )}
              </Button>
              <Button onClick={onRetry}>
                {translate(
                  'auto.components.status.bar.ResourceSessionCleanupDialog.retry',
                  'Retry'
                )}
              </Button>
            </>
          ) : state.phase === 'completed' ? (
            <Button variant="outline" onClick={onClose}>
              {translate('auto.components.status.bar.ResourceSessionCleanupDialog.close', 'Close')}
            </Button>
          ) : (
            <Button variant="outline" onClick={onClose}>
              {translate(
                'auto.components.status.bar.ResourceSessionCleanupDialog.cancel',
                'Cancel'
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
