import React, { useMemo } from 'react'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import { AddressPicker, type AddressOption } from '../network/AddressPicker'
import { parseManualNetworkAddress } from '../../../../shared/network/manual-address'
import type { PairingNetworkInterface } from '../../../../shared/pairing-address-auto-selection'

function formatCustomAddressLabel(address: string): string {
  return translate(
    'auto.components.mobile.NetworkInterfacePicker.custom-option',
    '{{address}} (custom)',
    { address }
  )
}

export type NetworkInterfacePickerProps = {
  networkInterfaces: readonly PairingNetworkInterface[]
  customAddresses: readonly string[]
  selectedAddress: string | undefined
  selectedAddressIsCustom: boolean
  onSelectedAddressChange: (address: string) => void
  onCustomAddressSelect: (address: string) => void
  onCustomAddressRemove: (address: string) => void
  beforeCustomAddressChange?: (address: string) => boolean | Promise<boolean>
  disabled?: boolean
  className?: string
  id?: string
}

export function NetworkInterfacePicker({
  networkInterfaces,
  customAddresses,
  selectedAddress,
  selectedAddressIsCustom,
  onSelectedAddressChange,
  onCustomAddressSelect,
  onCustomAddressRemove,
  beforeCustomAddressChange,
  disabled = false,
  className,
  id
}: NetworkInterfacePickerProps): React.JSX.Element {
  const t = useTranslate()
  const options = useMemo<AddressOption[]>(
    () =>
      networkInterfaces.map((iface) => ({
        value: iface.address,
        label: `${iface.address} (${iface.name})`
      })),
    [networkInterfaces]
  )
  const customOptions = useMemo<AddressOption[]>(
    () =>
      customAddresses.map((address) => ({
        value: address,
        label: formatCustomAddressLabel(address)
      })),
    [customAddresses]
  )
  // Bridge-only hosts have selectable options but no default address; do not label that list empty.
  const placeholder =
    options.length > 0 || customOptions.length > 0
      ? t(
          'auto.components.mobile.NetworkInterfacePicker.no-address-selected',
          'No address selected'
        )
      : t(
          'auto.components.settings.MobileNetworkInterfaceSection.b2c384cfd6',
          'No interfaces found'
        )

  return (
    <AddressPicker
      options={options}
      customOptions={customOptions}
      value={selectedAddress}
      valueIsCustom={selectedAddressIsCustom}
      onValueChange={onSelectedAddressChange}
      onCustomValueChange={onCustomAddressSelect}
      onCustomRemove={onCustomAddressRemove}
      beforeCustomConfirm={beforeCustomAddressChange}
      disabled={disabled}
      className={className}
      id={id}
      formatCustomLabel={formatCustomAddressLabel}
      customSectionLabel={t(
        'auto.components.mobile.NetworkInterfacePicker.custom-section',
        'Custom'
      )}
      removeCustomLabel={(address) =>
        t('auto.components.mobile.NetworkInterfacePicker.remove-custom', 'Remove {{address}}', {
          address
        })
      }
      addCustomLabel={t(
        'auto.components.mobile.NetworkInterfacePicker.add-custom',
        'Add custom address…'
      )}
      placeholder={placeholder}
      triggerAriaLabel={t(
        'auto.components.mobile.NetworkInterfacePicker.trigger-label',
        'Network address to advertise'
      )}
      customInputId="custom-network-address-input"
      validateCustom={(input) => {
        const parsed = parseManualNetworkAddress(input)
        return parsed.ok ? { ok: true, value: parsed.address } : { ok: false }
      }}
      customDialogCopy={{
        title: t(
          'auto.components.mobile.CustomNetworkAddressDialog.title',
          'Custom network address'
        ),
        description: t(
          'auto.components.mobile.CustomNetworkAddressDialog.description',
          'Advertise an address your phone can reach — for example a Tailscale hostname, IP address, or reverse-proxy URL.'
        ),
        inputLabel: t('auto.components.mobile.CustomNetworkAddressDialog.label', 'Address'),
        placeholder: t(
          'auto.components.mobile.CustomNetworkAddressDialog.placeholder',
          'home.example.com:8443 or https://example.com/orca'
        ),
        hint: t(
          'auto.components.mobile.CustomNetworkAddressDialog.hint',
          'Enter an IPv4/IPv6 address, hostname, or full HTTP(S)/WebSocket URL. Ports are optional.'
        ),
        cancel: t('auto.components.mobile.CustomNetworkAddressDialog.cancel', 'Cancel'),
        confirm: t('auto.components.mobile.CustomNetworkAddressDialog.use', 'Use address'),
        confirmationError: t(
          'auto.components.mobile.CustomNetworkAddressDialog.confirmationError',
          'This address could not produce a scannable pairing code. Check the address and try again.'
        )
      }}
    />
  )
}
