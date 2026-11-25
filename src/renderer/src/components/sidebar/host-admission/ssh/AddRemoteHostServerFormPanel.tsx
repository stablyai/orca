import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import type { ParseHostAccessLinkResult } from '../../../../../../shared/remote-runtime/pairing/remote-pairing-address'
import { RemoteServerFields } from './AddRemoteHostFields'

export function AddRemoteHostServerFormPanel({
  name,
  pairingCode,
  parsedLink,
  allowLoopback,
  disabled,
  canSubmit,
  onNameChange,
  onPairingCodeChange,
  onAllowLoopbackChange,
  onSubmit,
  onCancel
}: {
  name: string
  pairingCode: string
  parsedLink: ParseHostAccessLinkResult
  allowLoopback: boolean
  disabled: boolean
  canSubmit: boolean
  onNameChange: (value: string) => void
  onPairingCodeChange: (value: string) => void
  onAllowLoopbackChange: (value: boolean) => void
  onSubmit: () => void
  onCancel: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {t('auto.components.sidebar.AddRemoteHostDialog.serverTitle', 'Add remote server')}
        </DialogTitle>
        <DialogDescription>
          {t(
            'auto.components.sidebar.AddRemoteHostDialog.serverDescription',
            'Pair with Orca running on another computer.'
          )}
        </DialogDescription>
      </DialogHeader>

      <RemoteServerFields
        name={name}
        pairingCode={pairingCode}
        parsedLink={parsedLink}
        disabled={disabled}
        onNameChange={onNameChange}
        onPairingCodeChange={onPairingCodeChange}
        allowLoopback={allowLoopback}
        onAllowLoopbackChange={onAllowLoopbackChange}
        onSubmit={onSubmit}
      />

      <p className="text-xs text-muted-foreground">
        {t(
          'auto.components.sidebar.AddRemoteHostDialog.serverRunsAsYou',
          'This device will be able to run commands as you on this server.'
        )}
      </p>

      <DialogFooter className="sm:justify-between">
        <span />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onCancel} disabled={disabled}>
            {t('auto.components.sidebar.AddRemoteHostDialog.cancel', 'Cancel')}
          </Button>
          <Button type="button" onClick={onSubmit} disabled={disabled || !canSubmit}>
            {disabled
              ? t('auto.components.sidebar.AddRemoteHostDialog.saving', 'Saving...')
              : t('auto.components.sidebar.AddRemoteHostDialog.save', 'Save')}
          </Button>
        </div>
      </DialogFooter>
    </>
  )
}
