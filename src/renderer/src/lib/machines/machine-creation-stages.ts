import type { PendingWorktreeCreation } from '@/lib/pending-worktree-creation'
import { translate } from '@/i18n/i18n'

export type MachineStageState = 'done' | 'active' | 'pending' | 'failed' | 'stopped'

export type MachineStageId = 'starting-machine' | 'setting-up-repo' | 'starting-agent'

export type MachineStage = {
  id: MachineStageId
  label: string
  detail: string
  state: MachineStageState
}

function formatSeconds(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function machineActivityLabel(entry: PendingWorktreeCreation): string {
  switch (entry.machineProgress?.activity) {
    case 'creating':
      return translate('auto.lib.machines.machineCreationStages.creating', 'Creating…')
    case 'waking':
      return translate('auto.lib.machines.machineCreationStages.waking', 'Waking…')
    case 'connecting':
      return translate('auto.lib.machines.machineCreationStages.connecting', 'Connecting…')
    case undefined:
      return ''
  }
}

function repoActivityLabel(entry: PendingWorktreeCreation, projectName: string | null): string {
  switch (entry.phase) {
    case 'setting-up-project':
      return projectName
        ? translate(
            'auto.lib.machines.machineCreationStages.cloningProject',
            'Cloning {{project}}…',
            {
              project: projectName
            }
          )
        : translate('auto.lib.machines.machineCreationStages.cloning', 'Cloning…')
    case 'fetching':
      return translate('auto.lib.machines.machineCreationStages.fetching', 'Fetching base branch…')
    case 'creating':
      return translate(
        'auto.lib.machines.machineCreationStages.creatingWorktree',
        'Creating worktree…'
      )
    case 'preparing':
    case 'provisioning-vm':
    case 'starting-machine':
      return ''
  }
}

/**
 * The three stages a person cares about while a worktree is made on a machine. Only the stage
 * that failed turns red; a stage a provider never reports simply ticks when the next one starts.
 */
export function getMachineCreationStages(
  entry: PendingWorktreeCreation,
  projectName: string | null = null
): MachineStage[] {
  const onMachine = entry.phase === 'starting-machine' || entry.phase === 'preparing'
  const canceled = entry.machineProgress?.canceled === true
  const failed = entry.status === 'error' && !canceled
  const failedOrActive: MachineStageState = failed ? 'failed' : 'active'
  const current: MachineStageState = canceled ? 'stopped' : failedOrActive
  return [
    {
      id: 'starting-machine',
      label: translate(
        'auto.lib.machines.machineCreationStages.startingMachine',
        'Starting machine'
      ),
      detail: startingMachineDetail(entry, onMachine, failed, canceled),
      state: onMachine ? current : 'done'
    },
    {
      id: 'setting-up-repo',
      label: translate('auto.lib.machines.machineCreationStages.settingUpRepo', 'Setting up repo'),
      detail: onMachine || failed ? '' : repoActivityLabel(entry, projectName),
      state: onMachine ? 'pending' : failedOrActive
    },
    {
      id: 'starting-agent',
      label: entry.request.agent
        ? translate('auto.lib.machines.machineCreationStages.startingAgent', 'Starting agent')
        : translate('auto.lib.machines.machineCreationStages.openingTerminal', 'Opening terminal'),
      detail: '',
      state: 'pending'
    }
  ]
}

function startingMachineDetail(
  entry: PendingWorktreeCreation,
  onMachine: boolean,
  failed: boolean,
  canceled: boolean
): string {
  if (!onMachine) {
    const readyAfter = entry.machineProgress?.readyAfterMs
    return readyAfter === undefined ? '' : formatSeconds(readyAfter)
  }
  if (canceled) {
    return translate('auto.lib.machines.machineCreationStages.canceled', 'Canceled')
  }
  return failed ? '' : machineActivityLabel(entry)
}
