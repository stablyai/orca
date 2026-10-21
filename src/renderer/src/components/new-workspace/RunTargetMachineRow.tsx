import React from 'react'
import {
  Archive,
  Box,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Info,
  LogIn,
  Plus,
  RefreshCw
} from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { MachineStateLabel } from '@/components/machines/MachineStateLabel'
import { formatMachineExpiry, formatProviderUnreachable } from '@/lib/machines/machine-copy'
import {
  isMachineOptionPickable,
  type MachineGroupOption
} from '@/lib/machines/machine-group-options'
import { RunTargetGroupHeader, RunTargetRow } from './RunTargetComboboxRow'
import type { MachineRowModel } from './run-target-machine-rows'

const ICON = 'size-3.5 shrink-0 text-muted-foreground'

function groupAside(group: MachineGroupOption, now: number): string | null {
  switch (group.status.kind) {
    case 'unreachable':
      return formatProviderUnreachable(group.status.lastSeenAt, now)
    case 'different-account':
      return translate(
        'auto.components.new.workspace.RunTargetMachineRow.differentAccount',
        'Signed in as a different account'
      )
    case 'invalid-response':
      return translate(
        'auto.components.new.workspace.RunTargetMachineRow.invalidResponse',
        'Sent an invalid response'
      )
    case 'ready':
      return group.machines.length + group.archived.length === 0 && !group.canCreate
        ? translate('auto.components.new.workspace.RunTargetMachineRow.noMachines', 'No machines')
        : null
    case 'sign-in':
      return group.environmentId === null
        ? null
        : translate(
            'auto.components.new.workspace.RunTargetMachineRow.signInOnServer',
            'Needs sign-in on {{server}}',
            { server: group.serverName ?? '' }
          )
  }
}

/** "Omarchy", or "Omarchy · build-box" for a paired server's provider. */
export function machineGroupLabel(group: MachineGroupOption): string {
  return group.serverName ? `${group.name} · ${group.serverName}` : group.name
}

/** A provider's label inside the run-target list; labels its group, never armed. */
export function RunTargetMachineGroupHeader({
  id,
  group,
  now
}: {
  id: string
  group: MachineGroupOption
  now: number
}): React.JSX.Element {
  return (
    <RunTargetGroupHeader id={id} label={machineGroupLabel(group)} aside={groupAside(group, now)} />
  )
}

function rowContent(row: Exclude<MachineRowModel, { kind: 'machine-group' }>): {
  icon: React.ReactNode
  label: string
  detail: string
  status?: React.ReactNode
  dimmed?: boolean
} {
  const provider = row.group.name
  switch (row.kind) {
    case 'machine': {
      const { machine } = row
      const archived = machine.state === 'archived'
      const pickable = isMachineOptionPickable(machine)
      const expiry =
        machine.lifetime === 'temporary' && machine.expiresAt !== null
          ? formatMachineExpiry(machine.expiresAt)
          : ''
      return {
        icon: archived ? <Archive className={ICON} /> : <Box className={ICON} />,
        label: machine.name,
        detail: pickable
          ? expiry
          : translate(
              'auto.components.new.workspace.RunTargetMachineRow.noLocation',
              'Project not set up here'
            ),
        status: <MachineStateLabel state={machine.state} />,
        dimmed:
          archived || machine.state === 'unreachable' || machine.state === 'error' || !pickable
      }
    }
    case 'machine-more':
      return {
        icon: row.expanded ? <ChevronUp className={ICON} /> : <ChevronDown className={ICON} />,
        label: row.expanded
          ? translate('auto.components.new.workspace.RunTargetMachineRow.showFewer', 'Show fewer')
          : translate(
              'auto.components.new.workspace.RunTargetMachineRow.showAll',
              'Show all ({{count}})',
              { count: row.group.machines.length + row.group.archived.length }
            ),
        detail: '',
        dimmed: true
      }
    case 'machine-archived':
      return {
        icon: row.open ? <ChevronDown className={ICON} /> : <ChevronRight className={ICON} />,
        label: translate(
          'auto.components.new.workspace.RunTargetMachineRow.archived',
          'Archived ({{count}})',
          { count: row.group.archived.length }
        ),
        detail: '',
        dimmed: true
      }
    case 'machine-create':
      return {
        icon: <Plus className={ICON} />,
        label: translate(
          'auto.components.new.workspace.RunTargetMachineRow.newMachine',
          'New machine on {{provider}}…',
          { provider }
        ),
        detail: ''
      }
    case 'machine-sign-in':
      return {
        icon: <LogIn className={ICON} />,
        label: translate(
          'auto.components.new.workspace.RunTargetMachineRow.signIn',
          'Sign in to {{provider}}',
          { provider }
        ),
        detail: ''
      }
    case 'machine-retry':
      return {
        icon: <RefreshCw className={ICON} />,
        label: translate(
          'auto.components.new.workspace.RunTargetMachineRow.retry',
          'Retry {{provider}}',
          { provider }
        ),
        detail: ''
      }
    case 'machine-details':
      return {
        icon: <Info className={ICON} />,
        label: translate(
          'auto.components.new.workspace.RunTargetMachineRow.showDetails',
          'Show details'
        ),
        detail: ''
      }
  }
}

/** Every armable machine row: a machine, or the one action a provider group offers. */
export function RunTargetMachineRow({
  row,
  armed,
  current,
  optionId,
  onArm,
  onCommit
}: {
  row: Exclude<MachineRowModel, { kind: 'machine-group' }>
  armed: boolean
  current: boolean
  optionId: string | undefined
  onArm: () => void
  onCommit: () => void
}): React.JSX.Element {
  const content = rowContent(row)
  return (
    <RunTargetRow
      icon={content.icon}
      label={content.label}
      detail={content.detail}
      status={content.status}
      dimmed={content.dimmed}
      armed={armed}
      current={current}
      optionId={optionId}
      onArm={onArm}
      onCommit={onCommit}
    />
  )
}
