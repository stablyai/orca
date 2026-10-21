import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MachineRecord } from '../../../../shared/machine-inventory'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import {
  buildMachineGroupOptions,
  type MachineChoice,
  type MachineGroupOption,
  type MachineOption
} from '@/lib/machines/machine-group-options'
import { machineNeedsWake } from '@/lib/machines/machine-display-state'
import { findMachineForHost, type MachineMatch } from '@/lib/machines/machine-host-match'
import { getProjectHostSetupSelectionKey } from '@/lib/project-host-setup-options'
import { useAppStore } from '@/store'
import type { WorktreeCreationRequest } from '@/lib/pending-worktree-creation'
import { runMachineProviderRowAction } from '@/lib/machines/machine-provider-actions'
import { ensureMachinesLoaded, refreshMachineProviders, useMachineSources } from '@/store/machines'
import type {
  MachineProviderAction,
  RunTargetMachineProps
} from '@/components/new-workspace/use-run-target-machines'

// Composer-open freshness: reopening within this window reuses the last list.
const COMPOSER_LIST_MAX_AGE_MS = 30_000

export type SelectedMachine = { group: MachineGroupOption; machine: MachineOption }

export type ComposerMachineSelection = {
  /** The machine the composer will run on; a selected host on a listed machine counts. */
  selected: SelectedMachine | null
  /** Hosts the picker lists as their machine instead of as plain hosts. */
  machineHostIds: ReadonlySet<string>
  /** Stable props for the Run-on picker's machine rows. */
  picker: RunTargetMachineProps
  /** The selected location's machine is stopped, so nothing should probe its repo yet. */
  selectedHostAsleep: boolean
}

function findOption(
  groups: readonly MachineGroupOption[],
  choice: MachineChoice
): SelectedMachine | null {
  for (const group of groups) {
    if (group.providerKey !== choice.providerKey || group.environmentId !== choice.environmentId) {
      continue
    }
    const machine = [...group.machines, ...group.archived].find(
      (candidate) => candidate.machineId === choice.machineId
    )
    if (machine) {
      return { group, machine }
    }
  }
  return null
}

function choiceFor(match: MachineMatch): MachineChoice {
  return {
    providerKey: match.snapshot.providerKey,
    machineId: match.machine.id,
    environmentId: match.environmentId
  }
}

function runProviderAction({ kind, group }: MachineProviderAction): void {
  runMachineProviderRowAction(kind, group.providerKey)
}

/** Machine groups for the Run-on picker and the machine the composer will run on. */
export function useComposerMachineSelection({
  enabled,
  projectId,
  projectHostSetups,
  selectedHostId
}: {
  enabled: boolean
  projectId: string | null
  projectHostSetups: readonly ProjectHostSetup[]
  /** Host of the selected project location. */
  selectedHostId: string | null
}): ComposerMachineSelection | null {
  // Why: a sign-in that closed the dialog hands back the machine that was chosen.
  const [chosen, setChosen] = useState<MachineChoice | null>(
    () => useAppStore.getState().composerMachineRestore
  )
  useEffect(() => {
    useAppStore.getState().setComposerMachineRestore(null)
  }, [])
  const sources = useMachineSources()

  useEffect(() => {
    if (!enabled) {
      return
    }
    // Why: providers only run while the picker can show them, never in the background.
    ensureMachinesLoaded()
    refreshMachineProviders(COMPOSER_LIST_MAX_AGE_MS)
  }, [enabled])

  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments)
  const groups = useMemo(() => {
    const setupsHere = projectHostSetups.filter((setup) => setup.projectId === projectId)
    const locationOf = (environmentId: string | null, machine: MachineRecord): string | null => {
      for (const setup of setupsHere) {
        const match = findMachineForHost(setup.hostId, sources)
        if (match?.environmentId === environmentId && match.machine.id === machine.id) {
          return getProjectHostSetupSelectionKey(setup)
        }
      }
      return null
    }
    const own = buildMachineGroupOptions({
      snapshots: sources.self,
      isBound: (_snapshot, machine) => locationOf(null, machine) !== null
    })
    const paired = Object.entries(sources.environments).flatMap(([environmentId, snapshots]) =>
      buildMachineGroupOptions({
        snapshots,
        environment: {
          id: environmentId,
          name:
            runtimeEnvironments.find((environment) => environment.id === environmentId)?.name ??
            environmentId
        },
        isBound: (_snapshot, machine) => locationOf(environmentId, machine) !== null,
        locationKeyFor: (_snapshot, machine) => locationOf(environmentId, machine)
      })
    )
    return [...own, ...paired]
  }, [projectHostSetups, projectId, runtimeEnvironments, sources])

  // Why: only a host whose machine is listed may hide; any other stays pickable as a host.
  const machineHostIds = useMemo(() => {
    const hostIds = new Set<string>()
    for (const setup of projectHostSetups) {
      const match = findMachineForHost(setup.hostId, sources)
      if (match && findOption(groups, choiceFor(match))) {
        hostIds.add(setup.hostId)
      }
    }
    return hostIds
  }, [groups, projectHostSetups, sources])

  const selected = useMemo((): SelectedMachine | null => {
    if (chosen) {
      return findOption(groups, chosen)
    }
    // Why: reopening on a machine-backed location must still wake that machine on submit.
    const match = selectedHostId ? findMachineForHost(selectedHostId, sources) : null
    return match ? findOption(groups, choiceFor(match)) : null
  }, [chosen, groups, selectedHostId, sources])

  const selectedHostAsleep = useMemo(() => {
    const match = selectedHostId ? findMachineForHost(selectedHostId, sources) : null
    return match ? machineNeedsWake(match.machine.state) : false
  }, [selectedHostId, sources])

  const onChange = useCallback(
    (machine: MachineOption | null): void =>
      setChosen(
        machine
          ? {
              providerKey: machine.providerKey,
              machineId: machine.machineId,
              environmentId: machine.environmentId
            }
          : null
      ),
    []
  )

  const picker = useMemo(
    (): RunTargetMachineProps => ({
      groups,
      selected,
      onChange,
      onProviderAction: runProviderAction
    }),
    [groups, onChange, selected]
  )

  return useMemo(
    () => (enabled ? { selected, machineHostIds, picker, selectedHostAsleep } : null),
    [enabled, machineHostIds, picker, selected, selectedHostAsleep]
  )
}

/**
 * The request's machine. A paired server's machine is already the selected location, so it only
 * rides along when it must be woken first.
 */
export function buildMachineCreationRequest(
  selected: SelectedMachine | null,
  args: { sourceRepoId: string; projectId: string }
): WorktreeCreationRequest['machine'] {
  if (!selected) {
    return undefined
  }
  const { machine } = selected
  if (
    machine.environmentId !== null &&
    machine.state !== 'sleeping' &&
    machine.state !== 'archived'
  ) {
    return undefined
  }
  return {
    sourceRepoId: args.sourceRepoId,
    projectId: args.projectId,
    providerKey: machine.providerKey,
    machineId: machine.machineId,
    machineName: machine.name,
    ...(machine.environmentId !== null ? { environmentId: machine.environmentId } : {})
  }
}
