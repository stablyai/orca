import React, { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import { AddressPicker, type AddressOption } from '../network/AddressPicker'
import { parseManualNetworkAddress } from '../../../../shared/network/manual-address'
import type { MobileNetworkInterface } from '../settings/mobile-network-interface-selection'

// Why: MobileHero (mobile pairing screen) and MobilePairingSetupSection
// (Settings → Mobile) both need the same network selector. This wraps the
// generic AddressPicker with the mobile grammar (IPv4, any RFC 1123
// hostname — including Tailscale *.ts.net and DDNS domains — optionally
// with :port) and copy. Discovered interfaces come from the OS; "Add custom
// address…" opens a dialog for an address the OS didn't surface — the only
// way to pair across networks.

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
          'Advertise an address your phone can reach when it is not on the same Wi-Fi — for example a Tailscale hostname or a static IP.'
        ),
        inputLabel: translate('auto.components.mobile.CustomNetworkAddressDialog.label', 'Address'),
        placeholder: translate(
          'auto.components.mobile.CustomNetworkAddressDialog.placeholder',
          'my-mac.ts.net, home.example.com, or 192.168.1.50'
        ),
        hint: translate(
          'auto.components.mobile.CustomNetworkAddressDialog.hint',
          'Enter an IP address or a hostname — a Tailscale MagicDNS name, a DDNS domain, or a LAN hostname — optionally with :port.'
        ),
        cancel: translate('auto.components.mobile.CustomNetworkAddressDialog.cancel', 'Cancel'),
        confirm: translate('auto.components.mobile.CustomNetworkAddressDialog.use', 'Use address')
      }}
    />
  )
}
