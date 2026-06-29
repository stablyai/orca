import React, { useState } from 'react'
import { Plus } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue
} from '../ui/select'
import { CustomNetworkAddressDialog } from './CustomNetworkAddressDialog'
import type { MobileNetworkInterface } from '../settings/mobile-network-interface-selection'

// Why: MobileHero (mobile pairing screen) and MobileNetworkInterfaceSection
// (Settings → Mobile → Network Interface section) both need the same network
// selector. Discovered interfaces come from the OS; the "Add custom address…"
// footer opens a dialog for a Tailscale hostname or static IP the OS didn't
// surface — the only way to pair across networks. Shared here so both surfaces
// pick up the behavior automatically.

// Why: a sentinel Select value for the footer action. It is never committed as
// a real address; selecting it opens the custom-address dialog instead.
const ADD_CUSTOM_VALUE = '__add_custom_address__'

export type NetworkInterfacePickerProps = {
  networkInterfaces: readonly MobileNetworkInterface[]
  selectedAddress: string | undefined
  onSelectedAddressChange: (address: string) => void
  disabled?: boolean
  className?: string
  id?: string
}

function formatInterfaceLabel(iface: MobileNetworkInterface): string {
  return `${iface.address} (${iface.name})`
}

export function NetworkInterfacePicker({
  networkInterfaces,
  selectedAddress,
  onSelectedAddressChange,
  disabled = false,
  className,
  id
}: NetworkInterfacePickerProps): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false)

  // Why: a selected address that isn't an OS-enumerated interface is a custom
  // entry. Render it as a "(custom)" option so the trigger can display it —
  // Radix Select only shows values that have a matching item.
  const isCustomSelection =
    selectedAddress !== undefined &&
    !networkInterfaces.some((iface) => iface.address === selectedAddress)

  const handleValueChange = (value: string): void => {
    if (value === ADD_CUSTOM_VALUE) {
      setDialogOpen(true)
      return
    }
    onSelectedAddressChange(value)
  }

  return (
    <>
      <Select value={selectedAddress ?? ''} onValueChange={handleValueChange} disabled={disabled}>
        <SelectTrigger
          id={id}
          size="sm"
          className={className}
          aria-label={translate(
            'auto.components.mobile.NetworkInterfacePicker.trigger-label',
            'Network address to advertise'
          )}
        >
          <SelectValue
            placeholder={translate(
              'auto.components.settings.MobileNetworkInterfaceSection.b2c384cfd6',
              'No interfaces found'
            )}
          />
        </SelectTrigger>
        <SelectContent>
          {networkInterfaces.map((iface) => (
            <SelectItem key={`${iface.name}-${iface.address}`} value={iface.address}>
              {formatInterfaceLabel(iface)}
            </SelectItem>
          ))}
          {isCustomSelection ? (
            <SelectItem value={selectedAddress}>
              {translate(
                'auto.components.mobile.NetworkInterfacePicker.custom-option',
                '{{address}} (custom)',
                { address: selectedAddress }
              )}
            </SelectItem>
          ) : null}
          {networkInterfaces.length > 0 || isCustomSelection ? <SelectSeparator /> : null}
          <SelectItem
            value={ADD_CUSTOM_VALUE}
            className="text-muted-foreground focus:text-foreground"
          >
            <Plus className="size-3.5" />
            {translate(
              'auto.components.mobile.NetworkInterfacePicker.add-custom',
              'Add custom address…'
            )}
          </SelectItem>
        </SelectContent>
      </Select>
      <CustomNetworkAddressDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        initialValue={isCustomSelection ? selectedAddress : undefined}
        onConfirm={onSelectedAddressChange}
      />
    </>
  )
}
