import React, { useMemo, useState } from 'react'
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent
} from '@dnd-kit/core'
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy
} from '@dnd-kit/sortable'
import { Plus, RefreshCw } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import { CustomAddressDialog, type CustomAddressDialogCopy } from '../network/CustomAddressDialog'
import { parseManualNetworkAddress } from '../../../../shared/network/manual-address'
import { cn } from '../../lib/utils'
import {
  addAdvertiseAddress,
  MAX_MOBILE_ADVERTISE_ADDRESSES,
  removeAdvertiseAddress,
  type MobileNetworkInterface
} from '../settings/mobile-network-interface-selection'
import {
  SortableOrderedNetworkAddressRow,
  StaticOrderedNetworkAddressRow,
  type OrderedNetworkAddressRowModel
} from './OrderedNetworkAddressRow'

export type OrderedNetworkAddressPickerProps = {
  networkInterfaces: readonly MobileNetworkInterface[]
  selectedAddresses: readonly string[]
  onSelectedAddressesChange: (addresses: string[]) => void
  relayPreferenceIndex?: number
  onRouteOrderChange?: (addresses: string[], relayIndex: number) => void
  refreshingNetworkInterfaces?: boolean
  onRefreshNetworkInterfaces?: () => void
  disabled?: boolean
  className?: string
  id?: string
}

function buildRows(
  networkInterfaces: readonly MobileNetworkInterface[],
  selectedAddresses: readonly string[],
  relayPreferenceIndex?: number
): OrderedNetworkAddressRowModel[] {
  const discoveredByAddress = new Map(
    networkInterfaces.map((iface) => [iface.address, iface] as const)
  )
  const selectedSet = new Set(selectedAddresses)
  const rows: OrderedNetworkAddressRowModel[] = []

  const selectedRouteIds = [...selectedAddresses]
  if (relayPreferenceIndex !== undefined) {
    selectedRouteIds.splice(relayPreferenceIndex, 0, RELAY_ROUTE_ID)
  }
  selectedRouteIds.forEach((address, index) => {
    if (address === RELAY_ROUTE_ID) {
      rows.push({
        address,
        label: translate(
          'auto.components.mobile.OrderedNetworkAddressPicker.relay-option',
          'Orca Cloud Relay'
        ),
        selected: true,
        priorityIndex: index + 1,
        isCustom: false,
        isRelay: true
      })
      return
    }
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

const RELAY_ROUTE_ID = '__orca_cloud_relay__'

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
  relayPreferenceIndex,
  onRouteOrderChange,
  refreshingNetworkInterfaces = false,
  onRefreshNetworkInterfaces,
  disabled = false,
  className,
  id
}: OrderedNetworkAddressPickerProps): React.JSX.Element {
  const [dialogOpen, setDialogOpen] = useState(false)
  const rows = useMemo(
    () => buildRows(networkInterfaces, selectedAddresses, relayPreferenceIndex),
    [networkInterfaces, relayPreferenceIndex, selectedAddresses]
  )
  const selectedRows = rows.filter((row) => row.selected)
  const unselectedRows = rows.filter((row) => !row.selected)
  const atCap = selectedAddresses.length >= MAX_MOBILE_ADVERTISE_ADDRESSES
  const canRemove = selectedAddresses.length > 1
  const selectedRouteIds = selectedRows.map(({ address }) => address)
  const dragDisabled = disabled || selectedRouteIds.length < 2

  // Why: require a short drag distance so checkbox clicks don't start a reorder.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

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

  const handleDragEnd = (event: DragEndEvent): void => {
    const { active, over } = event
    if (!over || active.id === over.id) {
      return
    }
    const fromIndex = selectedRouteIds.indexOf(String(active.id))
    const toIndex = selectedRouteIds.indexOf(String(over.id))
    if (fromIndex < 0 || toIndex < 0) {
      return
    }
    const next = selectedRouteIds.slice()
    const [moved] = next.splice(fromIndex, 1)
    next.splice(toIndex, 0, moved!)
    const nextRelayIndex = next.indexOf(RELAY_ROUTE_ID)
    const nextAddresses = next.filter((route) => route !== RELAY_ROUTE_ID)
    if (nextRelayIndex >= 0) {
      onRouteOrderChange?.(nextAddresses, nextRelayIndex)
    } else {
      onSelectedAddressesChange(nextAddresses)
    }
  }

  return (
    <div id={id} className={cn('flex w-full flex-col gap-2', className)}>
      <p className="text-muted-foreground text-xs">
        {translate(
          'auto.components.mobile.OrderedNetworkAddressPicker.priority-hint',
          'Priority is top to bottom — drag selected routes to change the order your phone tries them.'
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
            'Connection routes'
          )}
        >
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={selectedRouteIds} strategy={verticalListSortingStrategy}>
              {selectedRows.map((row) => (
                <SortableOrderedNetworkAddressRow
                  key={row.address}
                  row={row}
                  checkboxDisabled={disabled || row.isRelay || !canRemove}
                  dragDisabled={dragDisabled}
                  onToggle={toggleAddress}
                />
              ))}
            </SortableContext>
          </DndContext>
          {unselectedRows.map((row) => (
            <StaticOrderedNetworkAddressRow
              key={row.address}
              row={row}
              checkboxDisabled={disabled || atCap}
              onToggle={toggleAddress}
            />
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2">
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
        {onRefreshNetworkInterfaces ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit gap-1.5"
            disabled={disabled || refreshingNetworkInterfaces}
            onClick={onRefreshNetworkInterfaces}
          >
            <RefreshCw className={cn('size-3.5', refreshingNetworkInterfaces && 'animate-spin')} />
            {translate(
              'auto.components.mobile.OrderedNetworkAddressPicker.refresh-addresses',
              'Refresh addresses'
            )}
          </Button>
        ) : null}
      </div>
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
