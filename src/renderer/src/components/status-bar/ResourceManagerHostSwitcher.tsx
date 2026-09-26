import React from 'react'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { translate } from '@/i18n/i18n'
import type { ResourceManagerHost } from './resource-manager-hosts'

// Why: min-w keeps long host names legible instead of crushing every segment; past
// three or so hosts that forces the row to scroll rather than shrink to initials.
const HOST_TOGGLE_ITEM_CLASS = 'min-w-[5rem] flex-1 basis-0 shrink'

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
        size="sm"
        className="w-full min-w-max"
        aria-label={translate(
          'auto.components.status.bar.ResourceManagerHostSwitcher.1dff89d4e1',
          'Resource Manager host: {{value0}}',
          { value0: selected.label }
        )}
      >
        {hosts.map((host) => (
          <ToggleGroupItem key={host.id} value={host.id} className={HOST_TOGGLE_ITEM_CLASS}>
            <span className="truncate text-[11px]">{host.label}</span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
}
