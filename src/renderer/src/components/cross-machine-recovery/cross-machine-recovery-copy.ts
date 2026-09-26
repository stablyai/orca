import { translate } from '@/i18n/i18n'
import type {
  CcSyncPause,
  CcSyncProgress
} from '../../../../shared/cross-machine-recovery-provider-types'
import type { CrossMachineRecoveryProviderError } from '../../../../shared/cross-machine-recovery-provider-ipc'

export function pauseReasonLabel(pause: CcSyncPause): string {
  switch (pause.reason) {
    case 'cellular':
      return translate(
        'components.cross-machine-recovery.copy.pause.cellular',
        'Paused on cellular'
      )
    case 'expensive':
      return translate(
        'components.cross-machine-recovery.copy.pause.expensive',
        'Paused on an expensive network'
      )
    case 'constrained':
      return translate(
        'components.cross-machine-recovery.copy.pause.constrained',
        'Paused in Low Data Mode'
      )
    case 'unknown-network':
      return translate(
        'components.cross-machine-recovery.copy.pause.unknownNetwork',
        'Paused on an unknown network'
      )
    case 'disconnected':
      return translate(
        'components.cross-machine-recovery.copy.pause.disconnected',
        'Paused while offline'
      )
    case 'manual-metered':
      return translate(
        'components.cross-machine-recovery.copy.pause.manualMetered',
        'Paused on a metered network'
      )
    case 'peer-offline':
      return translate(
        'components.cross-machine-recovery.copy.pause.peerOffline',
        'Paused until the other computer is back'
      )
    case 'unknown':
      return translate('components.cross-machine-recovery.copy.pause.unknown', 'Sync paused')
  }
}

/** Orca's reason codes get words; a reason this build does not know stays visible verbatim. */
export function notRestorableReasonLabel(reason: string): string {
  return reason === 'agent-not-supported-v1'
    ? translate(
        'components.cross-machine-recovery.copy.notRestorable.agentNotSupported',
        'agent not supported yet'
      )
    : reason
}

export function providerErrorMessage(error: CrossMachineRecoveryProviderError): string {
  switch (error.code) {
    case 'not-installed':
      return translate(
        'components.cross-machine-recovery.copy.error.notInstalled',
        'The recovery provider (cc-sync) is not installed.'
      )
    case 'timeout':
      return translate(
        'components.cross-machine-recovery.copy.error.timeout',
        'The recovery provider did not answer in time.'
      )
    case 'output-too-large':
      return translate(
        'components.cross-machine-recovery.copy.error.outputTooLarge',
        'The recovery provider answer was too large.'
      )
    case 'invalid-output':
      return translate(
        'components.cross-machine-recovery.copy.error.invalidOutput',
        'The recovery provider answered in an unknown format.'
      )
    case 'provider-failed':
    case 'not-ready':
    case 'live-local-collision':
    case 'divergent-local-copy':
    case 'incompatible':
    case 'orca-not-local':
    case 'orca-unavailable':
    case 'checkout-conflict':
    case 'cancelled':
    case 'not-found':
    case 'unsupported':
    case 'unknown':
      return error.message
  }
}

export function pickupPhaseLabel(progress: CcSyncProgress): string {
  switch (progress.phase) {
    case 'select':
      return translate(
        'components.cross-machine-recovery.copy.phase.select',
        'Choosing checkpoint…'
      )
    case 'restore-code':
      return translate(
        'components.cross-machine-recovery.copy.phase.restoreCode',
        'Restoring code…'
      )
    case 'restore-sessions':
      return translate(
        'components.cross-machine-recovery.copy.phase.restoreSessions',
        'Restoring sessions…'
      )
    case 'orca-import':
      return translate(
        'components.cross-machine-recovery.copy.phase.orcaImport',
        'Restoring the workspace layout…'
      )
    case 'orca-resume':
      return translate(
        'components.cross-machine-recovery.copy.phase.orcaResume',
        'Resuming sessions…'
      )
    case 'unknown':
      return translate('components.cross-machine-recovery.copy.phase.unknown', 'Recovering…')
  }
}
