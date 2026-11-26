import * as core0 from './runtime-environment-store-operations'
import * as core1 from './runtime-environment-managed-orcad-operations'
import * as core2 from './runtime-environment-ssh-access-operations'
import * as core3 from './runtime-environment-wsl-host-operations'
import * as core4 from './runtime-environment-resume-pairing-operations'
import * as core5 from './runtime-environment-store-records'
import * as core6 from './wsl-host-deployment-store'
import type {
  EnvironmentStoreCommand,
  EnvironmentStoreSuccess
} from './runtime-environment-store-worker-protocol'
export function executeEnvironmentStoreCommand(
  command: EnvironmentStoreCommand
): EnvironmentStoreSuccess {
  switch (command.operation) {
    case 'listEnvironments':
      return { operation: command.operation, value: core0.listEnvironments(...command.args) }
    case 'addEnvironmentFromPairingCode':
      return {
        operation: command.operation,
        value: core0.addEnvironmentFromPairingCode(...command.args)
      }
    case 'addOrUpdateEnvironmentFromPairingCode':
      return {
        operation: command.operation,
        value: core0.addOrUpdateEnvironmentFromPairingCode(...command.args)
      }
    case 'parseRemotePairingCode':
      return { operation: command.operation, value: core0.parseRemotePairingCode(...command.args) }
    case 'removeEnvironment':
      return { operation: command.operation, value: core0.removeEnvironment(...command.args) }
    case 'updateEnvironmentFromPairingCode':
      return {
        operation: command.operation,
        value: core0.updateEnvironmentFromPairingCode(...command.args)
      }
    case 'replaceEnvironmentPairing':
      return {
        operation: command.operation,
        value: core0.replaceEnvironmentPairing(...command.args)
      }
    case 'resolveEnvironment':
      return { operation: command.operation, value: core0.resolveEnvironment(...command.args) }
    case 'resolveEnvironmentPairingOffer':
      return {
        operation: command.operation,
        value: core0.resolveEnvironmentPairingOffer(...command.args)
      }
    case 'markEnvironmentUsed':
      return { operation: command.operation, value: core0.markEnvironmentUsed(...command.args) }
    case 'addManagedOrcadEnvironment':
      return {
        operation: command.operation,
        value: core1.addManagedOrcadEnvironment(...command.args)
      }
    case 'removeManagedOrcadEnvironment':
      return {
        operation: command.operation,
        value: core1.removeManagedOrcadEnvironment(...command.args)
      }
    case 'refreshManagedOrcadPairing':
      return {
        operation: command.operation,
        value: core1.refreshManagedOrcadPairing(...command.args)
      }
    case 'moveManagedOrcadLocalPort':
      return {
        operation: command.operation,
        value: core1.moveManagedOrcadLocalPort(...command.args)
      }
    case 'recordManagedOrcadMigration':
      return {
        operation: command.operation,
        value: core1.recordManagedOrcadMigration(...command.args)
      }
    case 'prepareRuntimeEnvironmentSshAccessLink':
      return {
        operation: command.operation,
        value: core2.prepareRuntimeEnvironmentSshAccessLink(...command.args)
      }
    case 'linkVerifiedRuntimeEnvironmentSshAccess':
      return {
        operation: command.operation,
        value: core2.linkVerifiedRuntimeEnvironmentSshAccess(...command.args)
      }
    case 'prepareRuntimeEnvironmentSshAccessUnlink':
      return {
        operation: command.operation,
        value: core2.prepareRuntimeEnvironmentSshAccessUnlink(...command.args)
      }
    case 'completeRuntimeEnvironmentSshAccessUnlink':
      return {
        operation: command.operation,
        value: core2.completeRuntimeEnvironmentSshAccessUnlink(...command.args)
      }
    case 'cancelRuntimeEnvironmentSshAccessLink':
      return {
        operation: command.operation,
        value: core2.cancelRuntimeEnvironmentSshAccessLink(...command.args)
      }
    case 'findWslHostDeployment':
      return { operation: command.operation, value: core3.findWslHostDeployment(...command.args) }
    case 'addWslHostEnvironment':
      return { operation: command.operation, value: core3.addWslHostEnvironment(...command.args) }
    case 'refreshWslHostPairing':
      return { operation: command.operation, value: core3.refreshWslHostPairing(...command.args) }
    case 'reconcileWslHostBridgePorts':
      return {
        operation: command.operation,
        value: core3.reconcileWslHostBridgePorts(...command.args)
      }
    case 'setWslHostPendingStop':
      return { operation: command.operation, value: core3.setWslHostPendingStop(...command.args) }
    case 'removeWslHostEnvironment':
      return {
        operation: command.operation,
        value: core3.removeWslHostEnvironment(...command.args)
      }
    case 'refreshEnvironmentFromResumePairingCode':
      return {
        operation: command.operation,
        value: core4.refreshEnvironmentFromResumePairingCode(...command.args)
      }
    case 'readEnvironmentStoreRecords':
      return {
        operation: command.operation,
        value: core5.readEnvironmentStoreRecords(...command.args)
      }
    case 'readWslHostDeployments':
      return { operation: command.operation, value: core6.readWslHostDeployments(...command.args) }
  }
}
