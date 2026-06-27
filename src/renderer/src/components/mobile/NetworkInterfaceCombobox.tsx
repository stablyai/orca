import { useCallback, useMemo, useRef, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { parseManualNetworkAddress } from '../../../../shared/network/manual-address'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
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
//
// Implementation note: this used to wrap shadcn's `Command` + `CommandItem`
// primitives, but their `onSelect` dispatch was unreliable in `pnpm dev`
// after a fast HMR cycle — the parent state never received the click. The
// current shape uses plain `<button>`s inside the popover so React's
// synthetic-event delegation fires on the first user click without any
// intermediate effect that could be skipped.
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
  const inputRef = useRef<HTMLInputElement>(null)

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

  // Why: surfaces the same error message in two places — the list body
  // and below the trigger. The list copy is for users actively typing; the
  // trigger-adjacent copy is for assistive tech and for tests asserting on
  // the rendered DOM without opening the popover. `aria-invalid` on the
  // trigger carries the same signal to AT.
  const queryParse = parseManualNetworkAddress(query)
  const showInlineError = query.trim() !== '' && !queryParse.ok

  const handleSelectInterface = useCallback(
    (iface: MobileNetworkInterface) => {
      // Why: temporary debug log so QA can confirm the click path runs end
      // to end. Remove once manual verification lands.
      console.log('[NIC] select iface', iface.address)
      setQuery('')
      setOpen(false)
      onSelectedAddressChange(iface.address)
    },
    [onSelectedAddressChange]
  )

  const handleSelectUseQuery = useCallback(
    (address: string) => {
      // Why: temporary debug log so QA can confirm the click path runs end
      // to end. Remove once manual verification lands.
      console.log('[NIC] use-query', address)
      setQuery('')
      setOpen(false)
      onSelectedAddressChange(address)
    },
    [onSelectedAddressChange]
  )

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen)
    if (!nextOpen) {
      // Why: drop the in-flight query when the popover closes so reopening
      // shows the full interface list rather than the previous filter.
      setQuery('')
    }
  }, [])

  return (
    <div>
      <Popover open={open} onOpenChange={handleOpenChange}>
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
          <div className="flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2">
            <Search className="size-4 shrink-0 opacity-50" />
            <input
              ref={inputRef}
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={translate(
                'auto.components.settings.MobileNetworkInterfaceSection.new-combobox-placeholder',
                'Search or type an address…'
              )}
              className="flex h-9 w-full rounded-md bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <ul
            className="max-h-[min(400px,60vh)] overflow-y-auto p-1"
            role="listbox"
            aria-label={translate(
              'auto.components.settings.MobileNetworkInterfaceSection.new-combobox-listbox',
              'Network interfaces'
            )}
          >
            {entries.length === 0 ? (
              <li
                className="px-2 py-6 text-center text-sm text-muted-foreground"
                role="presentation"
              >
                {showInlineError
                  ? ERROR_MESSAGE
                  : translate(
                      'auto.components.settings.MobileNetworkInterfaceSection.new-combobox-empty',
                      'No matching interfaces'
                    )}
              </li>
            ) : null}
            {entries.map((entry, index) => {
              if (entry.kind === 'interface') {
                return (
                  <li key={`iface-${entry.iface.name}-${entry.iface.address}`} role="presentation">
                    <button
                      type="button"
                      // Why: bind the commit on pointerdown rather than click.
                      // Radix Popover closes on the same synthetic click that
                      // would normally fire `onClick`, but the order in dev
                      // mode can race — the close handler occasionally runs
                      // before React's click synthetic dispatch, swallowing
                      // the commit. Pointerdown fires synchronously before
                      // any pointer-up / click synthesis, so the parent's
                      // selectedAddress updates before the popover closes.
                      onPointerDown={(event) => {
                        // Prevent text selection on rapid clicks.
                        event.preventDefault()
                        handleSelectInterface(entry.iface)
                      }}
                      onClick={() => handleSelectInterface(entry.iface)}
                      className="flex w-full cursor-pointer items-center rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none"
                    >
                      {formatInterfaceLabel(entry.iface)}
                    </button>
                  </li>
                )
              }
              // Why: a top border separates the auto-discovered interfaces
              // from the manual-entry row so users see the boundary clearly
              // when the list contains both kinds.
              const isFirstUseQuery = index > 0
              return (
                <li key={`use-${entry.address}`} role="presentation">
                  {isFirstUseQuery ? (
                    <div className="my-1 h-px bg-border" role="separator" />
                  ) : null}
                  <button
                    type="button"
                    // Why: see comment on the interface button above — the
                    // popover-close race swallows the click commit unless
                    // we commit on pointerdown.
                    onPointerDown={(event) => {
                      event.preventDefault()
                      handleSelectUseQuery(entry.address)
                    }}
                    onClick={() => handleSelectUseQuery(entry.address)}
                    className="flex w-full cursor-pointer items-center rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground focus:outline-none"
                  >
                    {translate(
                      'auto.components.settings.MobileNetworkInterfaceSection.use-address-row',
                      'Use "{{address}}"',
                      { address: entry.address }
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
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
