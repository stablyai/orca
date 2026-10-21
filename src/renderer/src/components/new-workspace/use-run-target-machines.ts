import { useCallback, useState } from 'react'
import type { MachineProviderKey } from '../../../../shared/machine-inventory'
import {
  isMachineOptionPickable,
  type MachineGroupOption,
  type MachineOption
} from '@/lib/machines/machine-group-options'
import {
  machineCreateRowKey,
  machineRowKey,
  type MachineGroupView,
  type MachineRowModel
} from './run-target-machine-rows'

/** What a provider group's own row asks for; the composer decides how to do it. */
export type MachineProviderAction = {
  kind: 'sign-in' | 'retry' | 'details'
  group: MachineGroupOption
}

export type RunTargetMachineProps = {
  groups: readonly MachineGroupOption[]
  /** The committed machine, or null when a host or recipe holds the selection. */
  selected: { group: MachineGroupOption; machine: MachineOption } | null
  onChange: (machine: MachineOption | null) => void
  onProviderAction: (action: MachineProviderAction) => void
  /** Starts a draft for a new machine on the provider; the composer creates it on submit. */
  onCreate: (providerKey: MachineProviderKey) => void
  /** The machine the composer will create, summarized for the field. */
  creating: { providerKey: MachineProviderKey; summary: string } | null
}

const COLLAPSED: MachineGroupView = { expanded: false, archivedOpen: false }
const NO_GROUPS: readonly MachineGroupOption[] = []

/**
 * Machine rows' share of the run-target picker: per-provider expansion and what each row does
 * when taken. Rows that only reveal more rows keep the picker open.
 */
export function useRunTargetMachines(machines: RunTargetMachineProps | undefined): {
  groups: readonly MachineGroupOption[]
  views: Readonly<Record<string, MachineGroupView>>
  selectedRowKey: string | null
  /** `close` dismisses the picker for rows that finish the choice. */
  activate: (row: MachineRowModel, close: () => void) => void
} {
  const [views, setViews] = useState<Record<string, MachineGroupView>>({})
  const groups = machines?.groups ?? NO_GROUPS
  const selected = machines?.selected ?? null
  const onChange = machines?.onChange
  const onProviderAction = machines?.onProviderAction
  const onCreate = machines?.onCreate
  const creatingProviderKey = machines?.creating?.providerKey ?? null

  const updateView = useCallback(
    (providerKey: string, change: (view: MachineGroupView) => MachineGroupView): void =>
      setViews((current) => ({
        ...current,
        [providerKey]: change(current[providerKey] ?? COLLAPSED)
      })),
    []
  )

  const activate = useCallback(
    (row: MachineRowModel, close: () => void): void => {
      switch (row.kind) {
        case 'machine-group':
          return
        case 'machine':
          if (!isMachineOptionPickable(row.machine)) {
            return
          }
          onChange?.(row.machine)
          close()
          return
        case 'machine-more':
          updateView(row.group.key, (view) => ({
            expanded: !view.expanded,
            archivedOpen: view.expanded ? false : view.archivedOpen
          }))
          return
        case 'machine-archived':
          updateView(row.group.key, (view) => ({
            ...view,
            archivedOpen: !view.archivedOpen
          }))
          return
        case 'machine-retry':
          // Why: the group refreshes in place, so the picker stays open to show the result.
          onProviderAction?.({ kind: 'retry', group: row.group })
          return
        case 'machine-create':
          onCreate?.(row.group.providerKey)
          close()
          return
        case 'machine-sign-in':
          close()
          onProviderAction?.({ kind: 'sign-in', group: row.group })
          return
        case 'machine-details':
          close()
          onProviderAction?.({ kind: 'details', group: row.group })
      }
    },
    [onChange, onCreate, onProviderAction, updateView]
  )

  return {
    groups,
    views,
    selectedRowKey: creatingProviderKey
      ? machineCreateRowKey(`\0${creatingProviderKey}`)
      : selected
        ? machineRowKey(selected.machine)
        : null,
    activate
  }
}
