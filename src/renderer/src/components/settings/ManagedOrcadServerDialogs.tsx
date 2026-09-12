import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import type {
  ManagedOrcadConfirmation,
  ManagedOrcadForceOperation
} from './use-managed-orcad-servers'

type ManagedOrcadServerDialogsProps = {
  confirmation: ManagedOrcadConfirmation | null
  forceOperation: ManagedOrcadForceOperation | null
  onConfirmationChange: (value: ManagedOrcadConfirmation | null) => void
  onForce: (operation: ManagedOrcadForceOperation) => void
  onForceOperationChange: (value: ManagedOrcadForceOperation | null) => void
  onRollback: (environmentId: string) => void
  onStop: (environmentId: string) => void
}

export function ManagedOrcadServerDialogs({
  confirmation,
  forceOperation,
  onConfirmationChange,
  onForce,
  onForceOperationChange,
  onRollback,
  onStop
}: ManagedOrcadServerDialogsProps): React.JSX.Element {
  return (
    <>
      <Dialog
        open={forceOperation !== null}
        onOpenChange={(open) => {
          if (!open) {
            onForceOperationChange(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {translate(
                'auto.components.settings.ManagedOrcadServersSection.forceTitle',
                'Force orcad update?'
              )}
            </DialogTitle>
            <DialogDescription>{forceOperation?.reason}</DialogDescription>
          </DialogHeader>
          <div className="space-y-1 text-xs text-muted-foreground">
            <p className="font-mono">{forceOperation?.candidateVersion}</p>
            <p>
              {translate(
                'auto.components.settings.ManagedOrcadServersSection.forceDescription',
                'The terminal daemon is preserved across the restart. With live or unverified sessions, the host may temporarily run the new orcad against the previous daemon.'
              )}
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onForceOperationChange(null)}>
              {translate('auto.components.settings.ManagedOrcadServersSection.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              onClick={() => {
                if (forceOperation) {
                  onForce(forceOperation)
                }
              }}
            >
              {translate(
                'auto.components.settings.ManagedOrcadServersSection.forceAction',
                'Force Update'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmation !== null}
        onOpenChange={(open) => {
          if (!open) {
            onConfirmationChange(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirmation?.kind === 'rollback'
                ? translate(
                    'auto.components.settings.ManagedOrcadServersSection.rollbackTitle',
                    'Roll back {{value0}}?',
                    { value0: confirmation.environmentName }
                  )
                : translate(
                    'auto.components.settings.ManagedOrcadServersSection.stopTitle',
                    'Stop and unlink {{value0}}?',
                    { value0: confirmation?.environmentName ?? '' }
                  )}
            </DialogTitle>
            <DialogDescription>
              {confirmation?.kind === 'rollback'
                ? translate(
                    'auto.components.settings.ManagedOrcadServersSection.rollbackDescription',
                    'Restore the pre-update snapshot and start orcad {{value0}}. Settings written after the update may be discarded.',
                    { value0: confirmation.previousVersion }
                  )
                : translate(
                    'auto.components.settings.ManagedOrcadServersSection.stopDescription',
                    'Orca will stop orcad only after verifying that no terminal sessions are live, then remove the saved server and release its SSH host.'
                  )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onConfirmationChange(null)}>
              {translate('auto.components.settings.ManagedOrcadServersSection.cancel', 'Cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (confirmation?.kind === 'rollback') {
                  onRollback(confirmation.environmentId)
                } else if (confirmation) {
                  onStop(confirmation.environmentId)
                }
              }}
            >
              {confirmation?.kind === 'rollback'
                ? translate(
                    'auto.components.settings.ManagedOrcadServersSection.confirmRollback',
                    'Roll Back'
                  )
                : translate(
                    'auto.components.settings.ManagedOrcadServersSection.confirmStop',
                    'Stop and Unlink'
                  )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
