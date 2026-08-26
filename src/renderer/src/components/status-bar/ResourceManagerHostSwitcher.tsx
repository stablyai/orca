import React from 'react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { translate } from '@/i18n/i18n'
import type { ResourceManagerHost } from './resource-manager-hosts'

// Why: match ToggleGroup's spacing+outline qualifiers so selected edges out-specify
// its border-l-0 collapse. Mirrors the Session History scope switch.
const SELECTED_EDGE_CLASS =
  'data-[spacing=0]:data-[variant=outline]:aria-[checked=true]:border-l data-[spacing=0]:data-[variant=outline]:data-[state=on]:border-l'

// Why: min-w keeps long host names legible instead of crushing every segment; past
// three or so hosts that forces the row to scroll rather than shrink to initials.
const HOST_TOGGLE_ITEM_CLASS = `h-7 min-h-7 min-w-[5rem] flex-1 basis-0 shrink border border-transparent bg-transparent px-2.5 text-[11px] font-medium leading-none text-foreground shadow-none hover:bg-sidebar-accent hover:text-sidebar-accent-foreground aria-[checked=true]:border-foreground/20 aria-[checked=true]:bg-foreground/10 aria-[checked=true]:text-foreground aria-[checked=true]:shadow-xs aria-[checked=true]:hover:bg-foreground/15 aria-[checked=true]:hover:text-foreground data-[state=on]:border-foreground/20 data-[state=on]:bg-foreground/10 data-[state=on]:text-foreground data-[state=on]:shadow-xs data-[state=on]:hover:bg-foreground/15 data-[state=on]:hover:text-foreground ${SELECTED_EDGE_CLASS}`

/**
 * Picks which machine the Resource Manager reports on. Hidden with a single host
 * so the header keeps its shape on the common local-only setup.
 */
export function ResourceManagerHostSwitcher({
  hosts,
  selectedHostId,
  onSelect
}: {
  hosts: readonly ResourceManagerHost[]
  selectedHostId: string
  onSelect: (hostId: string) => void
}): React.JSX.Element | null {
  if (hosts.length < 2) {
    return null
  }
  const selected = hosts.find((host) => host.id === selectedHostId) ?? hosts[0]

  return (
    // Why: the row scrolls rather than the panel — a wide host list must never make
    // the popover itself scroll sideways.
    <div className="overflow-x-auto scrollbar-none border-b border-border px-3 py-1.5">
      <ToggleGroup
        type="single"
        value={selected.id}
        onValueChange={(value) => {
          // Why: ToggleGroup emits '' when the active item is re-clicked; keep the
          // current host rather than leaving the panel with nothing selected.
          if (value) {
            onSelect(value)
          }
        }}
        variant="outline"
        className="h-7 w-full min-w-max rounded-md border border-sidebar-border bg-sidebar-accent/35 shadow-xs"
        aria-label={translate(
          'auto.components.status.bar.ResourceManagerHostSwitcher.1dff89d4e1',
          'Resource Manager host: {{value0}}',
          { value0: selected.label }
        )}
      >
        {hosts.map((host) => (
          <ToggleGroupItem key={host.id} value={host.id} className={HOST_TOGGLE_ITEM_CLASS}>
            <span className="truncate">{host.label}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}
