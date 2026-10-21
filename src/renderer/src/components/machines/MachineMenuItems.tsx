import React from 'react'
import { Archive, Copy, Power, PowerOff, RefreshCw, Trash2 } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import {
  getMachineMenuActionLabel,
  getMachineMenuActions,
  runMachineMenuAction,
  type MachineMenuAction
} from '@/lib/machines/machine-actions'
import type { MachineMatch } from '@/lib/machines/machine-host-match'
import { useAppStore } from '@/store'

const ICONS: Record<MachineMenuAction, React.ComponentType<{ className?: string }>> = {
  wake: Power,
  sleep: PowerOff,
  archive: Archive,
  'copy-ssh': Copy,
  refresh: RefreshCw,
  delete: Trash2
}

// Why: lifecycle, then reach, then the one destructive action, each its own group.
const GROUPS: readonly (readonly MachineMenuAction[])[] = [
  ['wake', 'sleep', 'archive'],
  ['copy-ssh', 'refresh'],
  ['delete']
]

/**
 * A machine's actions for any dropdown menu: the sidebar host header and the worktree card menu
 * share it. Delete opens the shared confirmation; everything else runs at once.
 */
export function MachineMenuItems({
  match,
  label
}: {
  match: MachineMatch
  /** Shown above the items, e.g. "omarchy-dev · Omarchy". */
  label?: string
}): React.JSX.Element | null {
  const actions = new Set(getMachineMenuActions(match))
  const groups = GROUPS.map((group) => group.filter((action) => actions.has(action))).filter(
    (group) => group.length > 0
  )
  if (groups.length === 0) {
    return null
  }
  return (
    <>
      {label ? <DropdownMenuLabel>{label}</DropdownMenuLabel> : null}
      {groups.map((group, index) => (
        <React.Fragment key={group.join()}>
          {index > 0 ? <DropdownMenuSeparator /> : null}
          {group.map((action) => {
            const Icon = ICONS[action]
            return (
              <DropdownMenuItem
                key={action}
                variant={action === 'delete' ? 'destructive' : 'default'}
                onSelect={() => {
                  if (action === 'delete') {
                    useAppStore.getState().setMachineDeleteTarget({
                      providerKey: match.snapshot.providerKey,
                      machineId: match.machine.id
                    })
                    return
                  }
                  void runMachineMenuAction(action, match)
                }}
              >
                <Icon className="size-3.5" />
                {getMachineMenuActionLabel(action, match)}
              </DropdownMenuItem>
            )
          })}
        </React.Fragment>
      ))}
    </>
  )
}
