import React from 'react'
import { Check, Circle } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { DialogFooter } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import type {
  WslMoveProgressEvent,
  WslMoveProgressStep
} from '../../../../shared/wsl-move/wsl-move-driver-types'
import { formatWslMoveBytes, wslMoveStepLabel } from './wsl-move-copy'

// 'finishing' is the tail of the switch on this desktop; the stepper shows it under Switching.
const STEPS: WslMoveProgressStep[] = [
  'preparing',
  'pausing-terminals',
  'copying',
  'switching',
  'done'
]

function stepIndex(step: WslMoveProgressStep): number {
  return step === 'finishing' ? STEPS.indexOf('switching') : STEPS.indexOf(step)
}

/** Main honours a cancel only until it asks the host to commit, which follows copying. */
export function wslMoveCancellable(progress: WslMoveProgressEvent | null): boolean {
  return progress === null || stepIndex(progress.step) < STEPS.indexOf('switching')
}

export function WslMoveProgressBody({
  progress,
  cancel,
  onCancel
}: {
  progress: WslMoveProgressEvent | null
  cancel: 'idle' | 'requested' | 'too-late'
  onCancel: () => void
}): React.JSX.Element {
  const current = progress ? stepIndex(progress.step) : 0
  const cancellable = wslMoveCancellable(progress) && cancel !== 'too-late'
  const bytesTotal = progress?.bytesTotal
  return (
    <>
      <ol className="space-y-2 text-sm" data-testid="wsl-move-progress">
        {STEPS.map((step, index) => {
          const state = index < current ? 'done' : index === current ? 'active' : 'pending'
          return (
            <li
              key={step}
              className="flex items-center gap-2.5 data-[state=pending]:text-muted-foreground"
              data-state={state}
            >
              {state === 'done' ? (
                <Check className="size-4 text-muted-foreground" />
              ) : state === 'active' && step !== 'done' ? (
                <LoadingSpinner className="size-4" />
              ) : state === 'active' ? (
                <Check className="size-4" />
              ) : (
                <Circle className="size-4 text-muted-foreground" />
              )}
              <span>
                {step === 'switching' && progress?.step === 'finishing'
                  ? wslMoveStepLabel('finishing')
                  : wslMoveStepLabel(step)}
              </span>
            </li>
          )
        })}
      </ol>
      {progress?.step === 'copying' && bytesTotal ? (
        <div className="space-y-1">
          <Progress value={Math.min(100, ((progress.bytesSent ?? 0) / bytesTotal) * 100)} />
          <div className="text-xs text-muted-foreground">
            {translate('wslMove.progress.bytes', '{{sent}} of {{total}}', {
              sent: formatWslMoveBytes(progress.bytesSent ?? 0),
              total: formatWslMoveBytes(bytesTotal)
            })}
          </div>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {cancel === 'too-late'
          ? translate(
              'wslMove.progress.tooLate',
              'Too late to cancel: the host is already switching over. Keep Orca open until it finishes.'
            )
          : !cancellable
            ? translate(
                'wslMove.progress.switching',
                'The switch cannot be cancelled. Keep Orca open until it finishes.'
              )
            : current > 0
              ? translate(
                  'wslMove.progress.readOnly',
                  'These projects are read-only while they move. You can cancel until the switch starts.'
                )
              : translate(
                  'wslMove.progress.cancelUntilSwitch',
                  'You can cancel until the switch starts.'
                )}{' '}
        {translate(
          'wslMove.progress.closeKeepsGoing',
          'Closing this dialog does not stop the move; it opens again when the move ends.'
        )}
      </p>
      <DialogFooter>
        <Button
          type="button"
          variant="ghost"
          disabled={!cancellable || cancel !== 'idle'}
          onClick={onCancel}
        >
          {cancel === 'requested'
            ? translate('wslMove.progress.cancelling', 'Cancelling…')
            : translate('wslMove.progress.cancel', 'Cancel move')}
        </Button>
      </DialogFooter>
    </>
  )
}
