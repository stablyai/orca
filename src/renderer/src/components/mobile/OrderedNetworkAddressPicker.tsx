import React, { useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, Plus } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { CustomAddressDialog, type CustomAddressDialogCopy } from '../network/CustomAddressDialog'
import { parseManualNetworkAddress } from '../../../../shared/network/manual-address'
import { cn } from '../../lib/utils'
import {
  addAdvertiseAddress,
  MAX_MOBILE_ADVERTISE_ADDRESSES,
  moveAdvertiseAddress,
  removeAdvertiseAddress,
  type MobileNetworkInterface
} from '../settings/mobile-network-interface-selection'

export type OrderedNetworkAddressPickerProps = {
  networkInterfaces: readonly MobileNetworkInterface[]
  selectedAddresses: readonly string[]
  onSelectedAddressesChange: (addresses: string[]) => void
  disabled?: boolean
  className?: string
  id?: string
}

type Row = {
  address: string
  label: string
  selected: boolean
  priorityIndex: number | null
  isCustom: boolean
}

function buildRows(
  networkInterfaces: readonly MobileNetworkInterface[],
  selectedAddresses: readonly string[]
): Row[] {
  const discoveredByAddress = new Map(
    networkInterfaces.map((iface) => [iface.address, iface] as const)
  )
  const selectedSet = new Set(selectedAddresses)
  const rows: Row[] = []

  selectedAddresses.forEach((address, index) => {
    const iface = discoveredByAddress.get(address)
    rows.push({
      address,
      label: iface ? `${iface.address} (${iface.name})` : address,
      selected: true,
      priorityIndex: index + 1,
      isCustom: !iface
    })
  })

  for (const iface of networkInterfaces) {
    if (selectedSet.has(iface.address)) {
      continue
    }
    rows.push({
      address: iface.address,
      label: `${iface.address} (${iface.name})`,
      selected: false,
      priorityIndex: null,
      isCustom: false
    })
  }

  return rows
}

const customDialogCopy = (): CustomAddressDialogCopy => ({
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
})

/**
 * Ordered multi-select for Mobile setup advertise addresses (priority top→bottom).
 * Runtime pairing keeps single-select AddressPicker.
 */
export function OrderedNetworkAddressPicker({
  networkInterfaces,
  selectedAddresses,
  onSelectedAddressesChange,
  disabled = false,
  className,
  id
}: OrderedNetworkAddressPickerProps): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false)
  const rows = useMemo(
    () => buildRows(networkInterfaces, selectedAddresses),
    [networkInterfaces, selectedAddresses]
  )
  const atCap = selectedAddresses.length >= MAX_MOBILE_ADVERTISE_ADDRESSES
  const canRemove = selectedAddresses.length > 1

  const toggleAddress = (address: string, checked: boolean): void => {
    if (checked) {
      onSelectedAddressesChange(addAdvertiseAddress(selectedAddresses, address))
      return
    }
    onSelectedAddressesChange(removeAdvertiseAddress(selectedAddresses, address))
  }

  const handleCustomConfirm = (address: string): void => {
    onSelectedAddressesChange(addAdvertiseAddress(selectedAddresses, address))
  }

  return (
    <div id={id} className={cn('flex w-full flex-col gap-2', className)}>
      <p className="text-muted-foreground text-xs">
        {translate(
          'auto.components.mobile.OrderedNetworkAddressPicker.priority-hint',
          'Priority is top to bottom — the phone tries these addresses in order.'
        )}
      </p>
      {rows.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {translate(
            'auto.components.settings.MobileNetworkInterfaceSection.b2c384cfd6',
            'No interfaces found'
          )}
        </p>
      ) : (
        <ul
          className="divide-border/60 border-border/60 divide-y rounded-md border"
          aria-label={translate(
            'auto.components.mobile.OrderedNetworkAddressPicker.list-label',
            'Network addresses to advertise'
          )}
        >
          {rows.map((row) => {
            const selectedIndex = selectedAddresses.indexOf(row.address)
            const checkboxDisabled =
              disabled || (!row.selected && atCap) || (row.selected && !canRemove)
            return (
              <li key={row.address} className="flex items-center gap-2 px-2.5 py-1.5 text-sm">
                <span
                  className={cn(
                    'text-muted-foreground w-4 shrink-0 text-center text-xs tabular-nums',
                    !row.selected && 'invisible'
                  )}
                  aria-hidden={!row.selected}
                >
                  {row.priorityIndex ?? '–'}
                </span>
                <Checkbox
                  checked={row.selected}
                  disabled={checkboxDisabled}
                  onCheckedChange={(value) => {
                    toggleAddress(row.address, value === true)
                  }}
                  aria-label={
                    row.isCustom
                      ? translate(
                          'auto.components.mobile.OrderedNetworkAddressPicker.custom-option',
                          '{{address}} (custom)',
                          { address: row.address }
                        )
                      : row.label
                  }
                />
                <span className="min-w-0 flex-1 truncate">
                  {row.isCustom
                    ? translate(
                        'auto.components.mobile.OrderedNetworkAddressPicker.custom-option',
                        '{{address}} (custom)',
                        { address: row.address }
                      )
                    : row.label}
                </span>
                {row.selected ? (
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      disabled={disabled || selectedIndex <= 0}
                      onClick={() =>
                        onSelectedAddressesChange(
                          moveAdvertiseAddress(selectedAddresses, selectedIndex, -1)
                        )
                      }
                      aria-label={translate(
                        'auto.components.mobile.OrderedNetworkAddressPicker.move-up',
                        'Move {{address}} up',
                        { address: row.address }
                      )}
                    >
                      <ArrowUp />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      disabled={
                        disabled ||
                        selectedIndex < 0 ||
                        selectedIndex >= selectedAddresses.length - 1
                      }
                      onClick={() =>
                        onSelectedAddressesChange(
                          moveAdvertiseAddress(selectedAddresses, selectedIndex, 1)
                        )
                      }
                      aria-label={translate(
                        'auto.components.mobile.OrderedNetworkAddressPicker.move-down',
                        'Move {{address}} down',
                        { address: row.address }
                      )}
                    >
                      <ArrowDown />
                    </Button>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="w-fit gap-1.5"
        disabled={disabled || atCap}
        onClick={() => setDialogOpen(true)}
      >
        <Plus className="size-3.5" />
        {translate(
          'auto.components.mobile.NetworkInterfacePicker.add-custom',
          'Add custom address…'
        )}
      </Button>
      <CustomAddressDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        validate={(input) => {
          const parsed = parseManualNetworkAddress(input)
          return parsed.ok ? { ok: true, value: parsed.address } : { ok: false }
        }}
        copy={customDialogCopy()}
        inputId="ordered-custom-network-address-input"
        onConfirm={handleCustomConfirm}
      />
    </div>
  )
}
