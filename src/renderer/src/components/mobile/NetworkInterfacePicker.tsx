import React, { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import { AddressPicker, type AddressOption } from '../network/AddressPicker'
import { parseMobilePairingEndpoint } from '../../../../shared/network/mobile-pairing-endpoint'
import type { MobileNetworkInterface } from '../settings/mobile-network-interface-selection'

// Why: MobileHero (mobile pairing screen) and MobilePairingSetupSection
// (Settings → Mobile) both need the same network selector. This wraps the
// generic AddressPicker with the mobile grammar (IPv4, RFC 1123 hostname,
// optional port, or a ws(s) origin) and copy. Discovered interfaces come from
// the OS; "Add custom endpoint…" is the path for addresses and user-managed
// secure tunnels the OS cannot surface.

export type NetworkInterfacePickerProps = {
  networkInterfaces: readonly MobileNetworkInterface[]
  selectedAddress: string | undefined
  onSelectedAddressChange: (address: string) => void
  disabled?: boolean
  className?: string
  id?: string
}

export function NetworkInterfacePicker({
  networkInterfaces,
  selectedAddress,
  onSelectedAddressChange,
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
        'Add custom endpoint…'
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
        const parsed = parseMobilePairingEndpoint(input)
        return parsed.ok ? { ok: true, value: parsed.endpoint } : { ok: false }
      }}
      customDialogCopy={{
        title: translate(
          'auto.components.mobile.CustomNetworkAddressDialog.title',
          'Custom direct endpoint'
        ),
        description: translate(
          'auto.components.mobile.CustomNetworkAddressDialog.description',
          'Advertise an IP address, hostname, or secure WebSocket tunnel that your phone can reach.'
        ),
        inputLabel: translate('auto.components.mobile.CustomNetworkAddressDialog.label', 'Address'),
        placeholder: translate(
          'auto.components.mobile.CustomNetworkAddressDialog.placeholder',
          'wss://orca.example.com, my-mac.ts.net, or 192.168.1.50'
        ),
        hint: translate(
          'auto.components.mobile.CustomNetworkAddressDialog.hint',
          'Enter an IP address, hostname, optional :port, or a ws(s):// origin without a path.'
        ),
        cancel: translate('auto.components.mobile.CustomNetworkAddressDialog.cancel', 'Cancel'),
        confirm: translate('auto.components.mobile.CustomNetworkAddressDialog.use', 'Use address')
      }}
    />
  )
}
