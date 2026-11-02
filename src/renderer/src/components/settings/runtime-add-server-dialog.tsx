import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'
import { RuntimeHostAccessForm } from './RuntimeHostAccessForm'
import type { RuntimeHostAccessFailure } from './RuntimeHostAccessFailureAlert'

type RuntimeAddServerDialogProps = {
  open: boolean
  name: string
  accessLink: string
  busy: boolean
  failure: RuntimeHostAccessFailure | null
  onNameChange: (value: string) => void
  onAccessLinkChange: (value: string) => void
  onClose: () => void
  onSubmit: (allowLoopback: boolean) => void
}

export function RuntimeAddServerDialog({
  open,
  name,
  accessLink,
  busy,
  failure,
  onNameChange,
  onAccessLinkChange,
  onClose,
  onSubmit
}: RuntimeAddServerDialogProps): React.JSX.Element {
  const takenNames = useAppStore((state) => state.runtimeEnvironments)
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          onClose()
        }
      }}
    >
      <DialogContent scrollable>
        <DialogHeader>
          <DialogTitle>
            {translate('auto.components.settings.serverList.addTitle', 'Add server')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.settings.serverList.addDescriptionShort',
              'Paste the access link from Share this computer on the other machine.'
            )}
          </DialogDescription>
        </DialogHeader>
        <RuntimeHostAccessForm
          name={name}
          takenNames={takenNames}
          accessLink={accessLink}
          busy={busy}
          failure={failure}
          onNameChange={onNameChange}
          onAccessLinkChange={onAccessLinkChange}
          onCancel={onClose}
          onSubmit={onSubmit}
        />
      </DialogContent>
    </Dialog>
  )
}
