import type { MachineDisplayState } from '../../../../shared/machine-display'
import { translate } from '@/i18n/i18n'

export {
  getMachineDisplayState,
  machineNeedsWake,
  type MachineDisplayState
} from '../../../../shared/machine-display'

export function getMachineDisplayStateLabel(state: MachineDisplayState): string {
  switch (state) {
    case 'starting':
      return translate('auto.lib.machines.machineDisplayState.starting', 'Starting')
    case 'running':
      return translate('auto.lib.machines.machineDisplayState.running', 'Running')
    case 'stopping':
      return translate('auto.lib.machines.machineDisplayState.stopping', 'Sleeping…')
    case 'sleeping':
      return translate('auto.lib.machines.machineDisplayState.sleeping', 'Sleeping')
    case 'archived':
      return translate('auto.lib.machines.machineDisplayState.archived', 'Archived')
    case 'error':
      return translate('auto.lib.machines.machineDisplayState.error', 'Error')
    case 'unreachable':
      return translate('auto.lib.machines.machineDisplayState.unreachable', 'Unreachable')
    case 'gone':
      return translate('auto.lib.machines.machineDisplayState.gone', 'Gone')
  }
}
