import React, { useEffect, useState } from 'react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'
import { parseManualNetworkAddress } from '../../../../shared/network/manual-address'

type CustomNetworkAddressDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  // Why: prefill from the current selection when it is already a custom value
  // so reopening to edit shows what is in use rather than a blank field.
  initialValue?: string
  onConfirm: (address: string) => void
}

export function CustomNetworkAddressDialog({
  open,
  onOpenChange,
  initialValue,
  onConfirm
}: CustomNetworkAddressDialogProps): React.JSX.Element {
  const [value, setValue] = useState(initialValue ?? '')

  // Why: reseed each time the dialog opens so a prior cancelled edit doesn't
  // leak into the next open.
  useEffect(() => {
    if (open) {
      setValue(initialValue ?? '')
    }
  }, [open, initialValue])

  const parsed = parseManualNetworkAddress(value)
  // Why: only flag invalid input once the user has typed something — an empty
  // field on open shouldn't read as an error.
  const showError = value.trim() !== '' && !parsed.ok

  const submit = (): void => {
    if (!parsed.ok) {
      return
    }
    onConfirm(parsed.address)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'auto.components.mobile.CustomNetworkAddressDialog.title',
              'Custom network address'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'auto.components.mobile.CustomNetworkAddressDialog.description',
              'Advertise an address your phone can reach when it is not on the same Wi-Fi — for example a Tailscale hostname or a static IP.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="custom-network-address-input">
            {translate('auto.components.mobile.CustomNetworkAddressDialog.label', 'Address')}
          </Label>
          <Input
            id="custom-network-address-input"
            autoFocus
            value={value}
            aria-invalid={showError}
            placeholder={translate(
              'auto.components.mobile.CustomNetworkAddressDialog.placeholder',
              'my-mac.ts.net or 192.168.1.50'
            )}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            }}
          />
          {/* Why: neutral helper copy that doubles as validation guidance —
              kept muted (not destructive-red) so a half-typed address doesn't
              feel like a hard error. */}
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.mobile.CustomNetworkAddressDialog.hint',
              'Enter an IP address or a Tailscale hostname (ends in .ts.net).'
            )}
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {translate('auto.components.mobile.CustomNetworkAddressDialog.cancel', 'Cancel')}
          </Button>
          <Button type="button" disabled={!parsed.ok} onClick={submit}>
            {translate('auto.components.mobile.CustomNetworkAddressDialog.use', 'Use address')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
