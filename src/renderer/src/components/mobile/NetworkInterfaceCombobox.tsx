import { useCallback, useMemo, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { parseManualNetworkAddress } from '../../../../shared/network/manual-address'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator
} from '../ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import {
  buildComboboxEntries,
  type MobileNetworkInterface
} from '../settings/mobile-network-interface-selection'

// Why: MobileHero (mobile pairing screen) and MobileNetworkInterfaceSection
// (Settings → Mobile → Network Interface section) both need the same
// typeable network-address selector. They previously rendered their own
// copy of the shadcn Select, with no manual-entry support. Extract once,
// share everywhere — adding tailnet/hostname support to one place now means
// both surfaces pick it up automatically.
const TRIGGER_LABEL_CUSTOM = 'custom'
const ERROR_MESSAGE = 'Enter an IPv4 address or Tailscale MagicDNS hostname'

export type NetworkInterfaceComboboxProps = {
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

export function NetworkInterfaceCombobox({
  networkInterfaces,
  selectedAddress,
  onSelectedAddressChange,
  disabled = false,
  className,
  id
}: NetworkInterfaceComboboxProps): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const selectedIface = useMemo<MobileNetworkInterface | null>(() => {
    if (!selectedAddress) {
      return null
    }
    const matched = networkInterfaces.find((iface) => iface.address === selectedAddress)
    if (matched) {
      return matched
    }
    // Why: any selectedAddress that doesn't match a known interface is a
    // session-typed manual entry. Treat it as (custom) directly rather
    // than gating on local state, which would be empty on first paint
    // when the parent already passed a valid custom address.
    return { name: TRIGGER_LABEL_CUSTOM, address: selectedAddress }
  }, [networkInterfaces, selectedAddress])

  const triggerLabel = selectedIface
    ? formatInterfaceLabel(selectedIface)
    : translate(
        'auto.components.settings.MobileNetworkInterfaceSection.b2c384cfd6',
        'No interfaces found'
      )

  const entries = useMemo(
    () => buildComboboxEntries(networkInterfaces, query),
    [networkInterfaces, query]
  )

  // Why: surfaces the same error message in two places — the popover
  // (CommandEmpty) and below the trigger. The popover copy is for users
  // actively typing; the trigger-adjacent copy is for assistive tech and
  // for tests asserting on the rendered DOM without opening the popover.
  // `aria-invalid` on the trigger carries the same signal to AT.
  const queryParse = parseManualNetworkAddress(query)
  const showInlineError = query.trim() !== '' && !queryParse.ok

  const handleSelectInterface = useCallback(
    (iface: MobileNetworkInterface) => {
      setQuery('')
      setOpen(false)
      onSelectedAddressChange(iface.address)
    },
    [onSelectedAddressChange]
  )

  const handleSelectUseQuery = useCallback(
    (address: string) => {
      setQuery('')
      setOpen(false)
      onSelectedAddressChange(address)
    },
    [onSelectedAddressChange]
  )

  return (
    <div>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={id}
            type="button"
            variant="outline"
            size="sm"
            role="combobox"
            aria-expanded={open}
            aria-invalid={showInlineError}
            disabled={disabled}
            className={className}
          >
            <span className="truncate">{triggerLabel}</span>
            <ChevronDown className="ml-2 size-3.5 opacity-60" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[320px] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder={translate(
                'auto.components.settings.MobileNetworkInterfaceSection.new-combobox-placeholder',
                'Search or type an address…'
              )}
            />
            <CommandList>
              <CommandEmpty>
                {parseManualNetworkAddress(query).ok
                  ? translate(
                      'auto.components.settings.MobileNetworkInterfaceSection.new-combobox-empty',
                      'No matching interfaces'
                    )
                  : ERROR_MESSAGE}
              </CommandEmpty>
              {entries.map((entry, index) => {
                if (entry.kind === 'interface') {
                  return (
                    <CommandItem
                      key={`iface-${entry.iface.name}-${entry.iface.address}`}
                      value={`${entry.iface.address} ${entry.iface.name}`}
                      onSelect={() => handleSelectInterface(entry.iface)}
                    >
                      {formatInterfaceLabel(entry.iface)}
                    </CommandItem>
                  )
                }
                // Why: cmdk groups don't visually separate the manual-entry
                // row from the auto-discovered interfaces; a separator makes
                // the boundary obvious. The separator only renders when at
                // least one interface entry has come before, so the layout
                // stays clean when the list is empty (use-query only).
                const precededByInterface = index > 0
                return (
                  <div key={`use-${entry.address}`}>
                    {precededByInterface ? <CommandSeparator /> : null}
                    <CommandItem
                      value={`__use__ ${entry.address}`}
                      onSelect={() => handleSelectUseQuery(entry.address)}
                    >
                      {translate(
                        'auto.components.settings.MobileNetworkInterfaceSection.use-address-row',
                        'Use "{{address}}"',
                        { address: entry.address }
                      )}
                    </CommandItem>
                  </div>
                )
              })}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {showInlineError ? (
        <p className="mt-2 text-xs text-destructive" role="status">
          {ERROR_MESSAGE}
        </p>
      ) : null}
    </div>
  )
}

// Re-export the error message constant so consumers (e.g. MobileNetworkInterfaceSection)
// can render the same inline validation message below the combobox without
// hardcoding the copy in two places.
export { ERROR_MESSAGE as NETWORK_INTERFACE_COMBOBOX_ERROR_MESSAGE }
