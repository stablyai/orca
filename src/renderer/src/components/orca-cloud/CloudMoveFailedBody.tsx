// "Move to this computer" failed: the reason (main's, when it names one, else the step's), what the
// move put back, and the one next action (Reapply, Open, or Retry when a retry can help).
import React from 'react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { useTranslate } from '@/i18n/use-translate'
import type { CloudMoveState } from '@/lib/orca-cloud/orca-cloud-move-store'
import { cloudMoveFailureCause, cloudMoveFailureReason } from './cloud-move-copy'

export function CloudMoveFailedBody({
  state,
  onConfirm,
  onClose,
  onOpenLocal,
  onReapply
}: {
  state: Extract<CloudMoveState, { stage: 'failed' }>
  onConfirm: () => void
  onClose: () => void
  onOpenLocal: (worktreeId: string) => void
  onReapply?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  // Only when the local worktree really exists: a create that threw left nothing here.
  const localStarted = state.localWorktreeId !== null
  return (
    <div className="flex flex-col gap-4">
      <InlineError
        title={
          cloudMoveFailureReason(state.reason, t) ??
          cloudMoveFailureCause(state.step, state.timedOut, t)
        }
        detail={
          state.restored === 'archived'
            ? t(
                'orcaCloudMove.failedRestoredArchived',
                'It’s archived again. Nothing changed on this computer.'
              )
            : localStarted && state.retry
              ? t(
                  'orcaCloudMove.failedLocalReapply',
                  'Apply changes again to bring them over. Nothing you changed here is overwritten, and your files are safe in the cloud workspace.'
                )
              : localStarted
                ? t(
                    'orcaCloudMove.failedLocalNextV2',
                    'Use Move to this computer from the sandbox panel to bring them over. Your files are safe in the cloud workspace.'
                  )
                : t(
                    'orcaCloudMove.failedDetail',
                    'Your files are safe in the cloud workspace. Nothing changed on this computer.'
                  )
        }
      />
      <div className="flex justify-end gap-2">
        {localStarted && state.retry && onReapply ? (
          <Button variant="outline" size="sm" onClick={onReapply}>
            {t('orcaCloudMove.reapplyShort', 'Reapply')}
          </Button>
        ) : null}
        {state.localWorktreeId ? (
          <Button
            size="sm"
            onClick={() => {
              onOpenLocal(state.localWorktreeId!)
              onClose()
            }}
          >
            {t('orcaCloudMove.openHere', 'Open here')}
          </Button>
        ) : state.retryable ? (
          <Button size="sm" onClick={onConfirm}>
            {t('orcaCloudMove.retryShort', 'Retry')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}
