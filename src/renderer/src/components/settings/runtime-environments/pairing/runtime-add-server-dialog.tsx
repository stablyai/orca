import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '../../../ui/dialog'
import { RuntimeHostAccessForm } from '../../../runtime-access/RuntimeHostAccessForm'
import type { RuntimeHostAccessFailure } from '../../../runtime-access/RuntimeHostAccessFailureAlert'

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
  const t = useTranslate()
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
            {t('auto.components.settings.serverList.addTitle', 'Add server')}
          </DialogTitle>
          <DialogDescription>
            {t(
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
