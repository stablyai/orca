import type { PendingWorktreeCreation } from '@/lib/pending-worktree-creation'
import { translate } from '@/i18n/i18n'

export type MachineStageState = 'done' | 'active' | 'pending' | 'failed'

export type MachineStageId = 'starting-machine' | 'setting-up-repo' | 'starting-agent'

export type MachineStage = {
  id: MachineStageId
  label: string
  detail: string
  state: MachineStageState
}

function machineActivityLabel(entry: PendingWorktreeCreation): string {
  switch (entry.machineProgress?.activity) {
    case 'waking':
      return translate('auto.lib.machines.machineCreationStages.waking', 'Waking…')
    case 'connecting':
      return translate('auto.lib.machines.machineCreationStages.connecting', 'Connecting…')
    case undefined:
      return ''
  }
}

function repoActivityLabel(entry: PendingWorktreeCreation): string {
  switch (entry.phase) {
    case 'setting-up-project':
      return translate('auto.lib.machines.machineCreationStages.cloning', 'Cloning…')
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
export function getMachineCreationStages(entry: PendingWorktreeCreation): MachineStage[] {
  const onMachine = entry.phase === 'starting-machine' || entry.phase === 'preparing'
  const failed = entry.status === 'error'
  const current: MachineStageState = failed ? 'failed' : 'active'
  return [
    {
      id: 'starting-machine',
      label: translate(
        'auto.lib.machines.machineCreationStages.startingMachine',
        'Starting machine'
      ),
      detail: onMachine && !failed ? machineActivityLabel(entry) : '',
      state: onMachine ? current : 'done'
    },
    {
      id: 'setting-up-repo',
      label: translate('auto.lib.machines.machineCreationStages.settingUpRepo', 'Setting up repo'),
      detail: onMachine || failed ? '' : repoActivityLabel(entry),
      state: onMachine ? 'pending' : current
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
