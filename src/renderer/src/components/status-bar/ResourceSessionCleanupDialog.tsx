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
import type {
  ResourceSessionCleanupErrorCode,
  ResourceSessionCleanupReviewState
} from './resource-session-cleanup-review'

const TRANSLATION_PREFIX = 'auto.components.status.bar.ResourceSessionCleanupDialog'

function getErrorDescription(code: ResourceSessionCleanupErrorCode): string {
  switch (code) {
    case 'session-not-ready':
      return translate(
        `${TRANSLATION_PREFIX}.errorSessionNotReady`,
        'Workspace sessions are still loading.'
      )
    case 'cleanup-failed':
      return translate(
        `${TRANSLATION_PREFIX}.errorCleanup`,
        'Unable to clean up inactive terminals.'
      )
    case 'review-failed':
      return translate(
        `${TRANSLATION_PREFIX}.errorReview`,
        'Unable to check current terminal activity.'
      )
  }
}

function getDialogDescription(state: ResourceSessionCleanupReviewState): string {
  switch (state.phase) {
    case 'reviewing':
      return translate(`${TRANSLATION_PREFIX}.reviewing`, 'Checking current process activity…')
    case 'running':
      return translate(`${TRANSLATION_PREFIX}.running`, 'Closing confirmed inactive terminals…')
    case 'completed':
      return translate(
        `${TRANSLATION_PREFIX}.completed`,
        'Cleanup finished. Review the verified result below.'
      )
    case 'error':
      return getErrorDescription(state.code)
    case 'closed':
    case 'ready':
      return translate(
        `${TRANSLATION_PREFIX}.description`,
        'Only terminals freshly verified as idle shells can be closed. Active and unverified terminals are protected.'
      )
  }
}

function getCloseButtonLabel(inactiveCount: number): string {
  if (inactiveCount === 0) {
    return translate(`${TRANSLATION_PREFIX}.none`, 'No inactive terminals to close')
  }
  if (inactiveCount === 1) {
    return translate(`${TRANSLATION_PREFIX}.closeOne`, 'Close 1 inactive terminal')
  }
  return translate(`${TRANSLATION_PREFIX}.closeMany`, 'Close {{value0}} inactive terminals', {
    value0: inactiveCount
  })
}

function ResourceSessionCleanupDialogActions({
  state,
  inactiveCount,
  onClose,
  onRetry,
  onConfirm
}: {
  state: ResourceSessionCleanupReviewState
  inactiveCount: number
  onClose: () => void
  onRetry: () => void
  onConfirm: () => void
}): React.JSX.Element {
  switch (state.phase) {
    case 'running':
      return (
        <Button variant="destructive" disabled>
          <LoaderCircle className="size-4 animate-spin" />
          {translate(`${TRANSLATION_PREFIX}.closing`, 'Closing…')}
        </Button>
      )
    case 'ready':
      return (
        <>
          <Button variant="outline" onClick={onClose}>
            {translate(`${TRANSLATION_PREFIX}.cancel`, 'Cancel')}
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={inactiveCount === 0}>
            {getCloseButtonLabel(inactiveCount)}
          </Button>
        </>
      )
    case 'error':
      return (
        <>
          <Button variant="outline" onClick={onClose}>
            {translate(`${TRANSLATION_PREFIX}.close`, 'Close')}
          </Button>
          <Button onClick={onRetry}>{translate(`${TRANSLATION_PREFIX}.retry`, 'Retry')}</Button>
        </>
      )
    case 'completed':
      return (
        <Button variant="outline" onClick={onClose}>
          {translate(`${TRANSLATION_PREFIX}.close`, 'Close')}
        </Button>
      )
    case 'closed':
    case 'reviewing':
      return (
        <Button variant="outline" onClick={onClose}>
          {translate(`${TRANSLATION_PREFIX}.cancel`, 'Cancel')}
        </Button>
      )
  }
}

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
          <DialogDescription className="text-xs">{getDialogDescription(state)}</DialogDescription>
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
          <ResourceSessionCleanupDialogActions
            state={state}
            inactiveCount={inactiveCount}
            onClose={onClose}
            onRetry={onRetry}
            onConfirm={onConfirm}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
