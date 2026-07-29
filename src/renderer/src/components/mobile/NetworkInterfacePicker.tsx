import React, { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import { AddressPicker, type AddressOption } from '../network/AddressPicker'
import { parseManualNetworkAddress } from '../../../../shared/network/manual-address'
import type { MobileNetworkInterface } from '../settings/mobile-network-interface-selection'

// Why: both pairing entry points must expose every endpoint form supported by the main process.

export type NetworkInterfacePickerProps = {
  networkInterfaces: readonly MobileNetworkInterface[]
  selectedAddress: string | undefined
  onSelectedAddressChange: (address: string) => void
  beforeCustomAddressChange?: (address: string) => boolean | Promise<boolean>
  disabled?: boolean
  className?: string
  id?: string
}

export function NetworkInterfacePicker({
  networkInterfaces,
  selectedAddress,
  onSelectedAddressChange,
  beforeCustomAddressChange,
  disabled = false,
  className,
  id
}: NetworkInterfacePickerProps): React.JSX.Element {
  const options = useMemo<AddressOption[]>(
    () =>
      networkInterfaces.map((iface) => ({
        value: iface.address,
        label: `${iface.address} (${iface.name})`
      })),
    [networkInterfaces]
  )

  return (
    <AddressPicker
      options={options}
      value={selectedAddress}
      onValueChange={onSelectedAddressChange}
      beforeCustomConfirm={beforeCustomAddressChange}
      disabled={disabled}
      className={className}
      id={id}
      formatCustomLabel={(address) =>
        translate(
          'auto.components.mobile.NetworkInterfacePicker.custom-option',
          '{{address}} (custom)',
          { address }
        )
      }
      addCustomLabel={translate(
        'auto.components.mobile.NetworkInterfacePicker.add-custom',
        'Add custom address…'
      )}
      placeholder={translate(
        'auto.components.settings.MobileNetworkInterfaceSection.b2c384cfd6',
        'No interfaces found'
      )}
      triggerAriaLabel={translate(
        'auto.components.mobile.NetworkInterfacePicker.trigger-label',
        'Network address to advertise'
      )}
      customInputId="custom-network-address-input"
      validateCustom={(input) => {
        const parsed = parseManualNetworkAddress(input)
        return parsed.ok ? { ok: true, value: parsed.address } : { ok: false }
      }}
      customDialogCopy={{
        title: translate(
          'auto.components.mobile.CustomNetworkAddressDialog.title',
          'Custom network address'
        ),
        description: translate(
          'auto.components.mobile.CustomNetworkAddressDialog.description',
          'Advertise an address your phone can reach — for example a Tailscale hostname, IP address, or reverse-proxy URL.'
        ),
        inputLabel: translate('auto.components.mobile.CustomNetworkAddressDialog.label', 'Address'),
        placeholder: translate(
          'auto.components.mobile.CustomNetworkAddressDialog.placeholder',
          'home.example.com:8443 or https://example.com/orca'
        ),
        hint: translate(
          'auto.components.mobile.CustomNetworkAddressDialog.hint',
          'Enter an IPv4/IPv6 address, hostname, or full HTTP(S)/WebSocket URL. Ports are optional.'
        ),
        cancel: translate('auto.components.mobile.CustomNetworkAddressDialog.cancel', 'Cancel'),
        confirm: translate('auto.components.mobile.CustomNetworkAddressDialog.use', 'Use address'),
        confirmationError: translate(
          'auto.components.mobile.CustomNetworkAddressDialog.confirmationError',
          'This address could not produce a scannable pairing code. Check the address and try again.'
        )
      }}
    />
  )
}
