import {
  machineOptionKey,
  type MachineGroupOption,
  type MachineOption
} from '@/lib/machines/machine-group-options'

/** Rows shown per provider before "Show all". */
export const MACHINE_GROUP_ROW_CAP = 3

export type MachineGroupView = { expanded: boolean; archivedOpen: boolean }

export type MachineRowModel =
  | { key: string; kind: 'machine-group'; group: MachineGroupOption }
  | { key: string; kind: 'machine'; group: MachineGroupOption; machine: MachineOption }
  | { key: string; kind: 'machine-more'; group: MachineGroupOption; expanded: boolean }
  | { key: string; kind: 'machine-archived'; group: MachineGroupOption; open: boolean }
  | { key: string; kind: 'machine-create'; group: MachineGroupOption }
  | { key: string; kind: 'machine-sign-in'; group: MachineGroupOption }
  | { key: string; kind: 'machine-retry'; group: MachineGroupOption }
  | { key: string; kind: 'machine-details'; group: MachineGroupOption }

export function machineCreateRowKey(groupKey: string): string {
  return `machine-create:${groupKey}`
}

export function machineRowKey(
  machine: Pick<MachineOption, 'environmentId' | 'providerKey' | 'machineId'>
): string {
  return `machine:${machineOptionKey(machine)}`
}

function machineRow(group: MachineGroupOption, machine: MachineOption): MachineRowModel {
  return { key: machineRowKey(machine), kind: 'machine', group, machine }
}

function groupRows(group: MachineGroupOption, view: MachineGroupView): MachineRowModel[] {
  const key = group.key
  const header: MachineRowModel = { key: `machine-group:${key}`, kind: 'machine-group', group }
  // Why: a paired server's account and retries belong to that server; its header says why.
  const remote = group.environmentId !== null
  switch (group.status.kind) {
    case 'sign-in':
    case 'different-account':
      return remote
        ? [header]
        : [header, { key: `machine-sign-in:${key}`, kind: 'machine-sign-in', group }]
    case 'invalid-response':
      return remote
        ? [header]
        : [header, { key: `machine-details:${key}`, kind: 'machine-details', group }]
    case 'unreachable':
      return [
        header,
        ...group.machines
          .slice(0, MACHINE_GROUP_ROW_CAP)
          .map((machine) => machineRow(group, machine)),
        ...(remote ? [] : [{ key: `machine-retry:${key}`, kind: 'machine-retry' as const, group }])
      ]
    case 'ready':
      break
  }
  const overflow = group.machines.length > MACHINE_GROUP_ROW_CAP || group.archived.length > 0
  const shown = view.expanded ? group.machines : group.machines.slice(0, MACHINE_GROUP_ROW_CAP)
  const rows: MachineRowModel[] = [header, ...shown.map((machine) => machineRow(group, machine))]
  // Why: archived machines live only behind "Show all", so they never crowd the default list.
  if (view.expanded && group.archived.length > 0) {
    rows.push({
      key: `machine-archived:${key}`,
      kind: 'machine-archived',
      group,
      open: view.archivedOpen
    })
    if (view.archivedOpen) {
      rows.push(...group.archived.map((machine) => machineRow(group, machine)))
    }
  }
  if (overflow) {
    rows.push({ key: `machine-more:${key}`, kind: 'machine-more', group, expanded: view.expanded })
  }
  if (group.canCreate) {
    rows.push({ key: machineCreateRowKey(key), kind: 'machine-create', group })
  }
  return rows
}

function searchRows(group: MachineGroupOption, query: string): MachineRowModel[] {
  const providerMatches = group.name.toLowerCase().includes(query)
  const matches = (machine: MachineOption): boolean =>
    providerMatches || machine.name.toLowerCase().includes(query)
  // Why: search reaches every machine, archived ones included, with no cap.
  const found = [...group.machines.filter(matches), ...group.archived.filter(matches)]
  const rows = found.map((machine) => machineRow(group, machine))
  if (providerMatches && group.status.kind === 'ready' && group.canCreate) {
    rows.push({ key: machineCreateRowKey(group.key), kind: 'machine-create', group })
  }
  return rows.length > 0
    ? [{ key: `machine-group:${group.key}`, kind: 'machine-group', group }, ...rows]
    : []
}

/** Provider groups for the run-target list, capped per group and expanded in place. */
export function buildMachineRows({
  groups,
  query,
  views
}: {
  groups: readonly MachineGroupOption[]
  query: string
  views: Readonly<Record<string, MachineGroupView>>
}): MachineRowModel[] {
  const trimmed = query.trim().toLowerCase()
  return groups.flatMap((group) =>
    trimmed
      ? searchRows(group, trimmed)
      : groupRows(group, views[group.key] ?? { expanded: false, archivedOpen: false })
  )
}
