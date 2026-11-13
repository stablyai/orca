import type { RemoteServerPairingFailureFields } from '../pairing/remote-server-pairing-failure-copy'
import type { SecurePathHardeningReport } from '../../secure-storage/secure-path-hardening-report'
import type * as core0 from './runtime-environment-store-operations'
import type * as core1 from './runtime-environment-managed-orcad-operations'
import type * as core2 from './runtime-environment-ssh-access-operations'
import type * as core3 from './runtime-environment-wsl-host-operations'
import type * as core4 from './runtime-environment-resume-pairing-operations'
import type * as core5 from './runtime-environment-store-records'
import type * as core6 from './wsl-host-deployment-store'

export type EnvironmentStoreCommand =
  | { operation: 'listEnvironments'; args: Parameters<typeof core0.listEnvironments> }
  | {
      operation: 'addEnvironmentFromPairingCode'
      args: Parameters<typeof core0.addEnvironmentFromPairingCode>
    }
  | {
      operation: 'addOrUpdateEnvironmentFromPairingCode'
      args: Parameters<typeof core0.addOrUpdateEnvironmentFromPairingCode>
    }
  | { operation: 'parseRemotePairingCode'; args: Parameters<typeof core0.parseRemotePairingCode> }
  | { operation: 'removeEnvironment'; args: Parameters<typeof core0.removeEnvironment> }
  | {
      operation: 'updateEnvironmentFromPairingCode'
      args: Parameters<typeof core0.updateEnvironmentFromPairingCode>
    }
  | {
      operation: 'replaceEnvironmentPairing'
      args: Parameters<typeof core0.replaceEnvironmentPairing>
    }
  | { operation: 'resolveEnvironment'; args: Parameters<typeof core0.resolveEnvironment> }
  | {
      operation: 'resolveEnvironmentPairingOffer'
      args: Parameters<typeof core0.resolveEnvironmentPairingOffer>
    }
  | { operation: 'markEnvironmentUsed'; args: Parameters<typeof core0.markEnvironmentUsed> }
  | {
      operation: 'addManagedOrcadEnvironment'
      args: Parameters<typeof core1.addManagedOrcadEnvironment>
    }
  | {
      operation: 'removeManagedOrcadEnvironment'
      args: Parameters<typeof core1.removeManagedOrcadEnvironment>
    }
  | {
      operation: 'refreshManagedOrcadPairing'
      args: Parameters<typeof core1.refreshManagedOrcadPairing>
    }
  | {
      operation: 'moveManagedOrcadLocalPort'
      args: Parameters<typeof core1.moveManagedOrcadLocalPort>
    }
  | {
      operation: 'recordManagedOrcadMigration'
      args: Parameters<typeof core1.recordManagedOrcadMigration>
    }
  | {
      operation: 'prepareRuntimeEnvironmentSshAccessLink'
      args: Parameters<typeof core2.prepareRuntimeEnvironmentSshAccessLink>
    }
  | {
      operation: 'linkVerifiedRuntimeEnvironmentSshAccess'
      args: Parameters<typeof core2.linkVerifiedRuntimeEnvironmentSshAccess>
    }
  | {
      operation: 'prepareRuntimeEnvironmentSshAccessUnlink'
      args: Parameters<typeof core2.prepareRuntimeEnvironmentSshAccessUnlink>
    }
  | {
      operation: 'completeRuntimeEnvironmentSshAccessUnlink'
      args: Parameters<typeof core2.completeRuntimeEnvironmentSshAccessUnlink>
    }
  | {
      operation: 'cancelRuntimeEnvironmentSshAccessLink'
      args: Parameters<typeof core2.cancelRuntimeEnvironmentSshAccessLink>
    }
  | { operation: 'findWslHostDeployment'; args: Parameters<typeof core3.findWslHostDeployment> }
  | { operation: 'addWslHostEnvironment'; args: Parameters<typeof core3.addWslHostEnvironment> }
  | { operation: 'refreshWslHostPairing'; args: Parameters<typeof core3.refreshWslHostPairing> }
  | {
      operation: 'reconcileWslHostBridgePorts'
      args: Parameters<typeof core3.reconcileWslHostBridgePorts>
    }
  | { operation: 'setWslHostPendingStop'; args: Parameters<typeof core3.setWslHostPendingStop> }
  | {
      operation: 'removeWslHostEnvironment'
      args: Parameters<typeof core3.removeWslHostEnvironment>
    }
  | {
      operation: 'refreshEnvironmentFromResumePairingCode'
      args: Parameters<typeof core4.refreshEnvironmentFromResumePairingCode>
    }
  | {
      operation: 'readEnvironmentStoreRecords'
      args: Parameters<typeof core5.readEnvironmentStoreRecords>
    }
  | { operation: 'readWslHostDeployments'; args: Parameters<typeof core6.readWslHostDeployments> }
export type EnvironmentStoreSuccess =
  | { operation: 'listEnvironments'; value: ReturnType<typeof core0.listEnvironments> }
  | {
      operation: 'addEnvironmentFromPairingCode'
      value: ReturnType<typeof core0.addEnvironmentFromPairingCode>
    }
  | {
      operation: 'addOrUpdateEnvironmentFromPairingCode'
      value: ReturnType<typeof core0.addOrUpdateEnvironmentFromPairingCode>
    }
  | { operation: 'parseRemotePairingCode'; value: ReturnType<typeof core0.parseRemotePairingCode> }
  | { operation: 'removeEnvironment'; value: ReturnType<typeof core0.removeEnvironment> }
  | {
      operation: 'updateEnvironmentFromPairingCode'
      value: ReturnType<typeof core0.updateEnvironmentFromPairingCode>
    }
  | {
      operation: 'replaceEnvironmentPairing'
      value: ReturnType<typeof core0.replaceEnvironmentPairing>
    }
  | { operation: 'resolveEnvironment'; value: ReturnType<typeof core0.resolveEnvironment> }
  | {
      operation: 'resolveEnvironmentPairingOffer'
      value: ReturnType<typeof core0.resolveEnvironmentPairingOffer>
    }
  | { operation: 'markEnvironmentUsed'; value: ReturnType<typeof core0.markEnvironmentUsed> }
  | {
      operation: 'addManagedOrcadEnvironment'
      value: ReturnType<typeof core1.addManagedOrcadEnvironment>
    }
  | {
      operation: 'removeManagedOrcadEnvironment'
      value: ReturnType<typeof core1.removeManagedOrcadEnvironment>
    }
  | {
      operation: 'refreshManagedOrcadPairing'
      value: ReturnType<typeof core1.refreshManagedOrcadPairing>
    }
  | {
      operation: 'moveManagedOrcadLocalPort'
      value: ReturnType<typeof core1.moveManagedOrcadLocalPort>
    }
  | {
      operation: 'recordManagedOrcadMigration'
      value: ReturnType<typeof core1.recordManagedOrcadMigration>
    }
  | {
      operation: 'prepareRuntimeEnvironmentSshAccessLink'
      value: ReturnType<typeof core2.prepareRuntimeEnvironmentSshAccessLink>
    }
  | {
      operation: 'linkVerifiedRuntimeEnvironmentSshAccess'
      value: ReturnType<typeof core2.linkVerifiedRuntimeEnvironmentSshAccess>
    }
  | {
      operation: 'prepareRuntimeEnvironmentSshAccessUnlink'
      value: ReturnType<typeof core2.prepareRuntimeEnvironmentSshAccessUnlink>
    }
  | {
      operation: 'completeRuntimeEnvironmentSshAccessUnlink'
      value: ReturnType<typeof core2.completeRuntimeEnvironmentSshAccessUnlink>
    }
  | {
      operation: 'cancelRuntimeEnvironmentSshAccessLink'
      value: ReturnType<typeof core2.cancelRuntimeEnvironmentSshAccessLink>
    }
  | { operation: 'findWslHostDeployment'; value: ReturnType<typeof core3.findWslHostDeployment> }
  | { operation: 'addWslHostEnvironment'; value: ReturnType<typeof core3.addWslHostEnvironment> }
  | { operation: 'refreshWslHostPairing'; value: ReturnType<typeof core3.refreshWslHostPairing> }
  | {
      operation: 'reconcileWslHostBridgePorts'
      value: ReturnType<typeof core3.reconcileWslHostBridgePorts>
    }
  | { operation: 'setWslHostPendingStop'; value: ReturnType<typeof core3.setWslHostPendingStop> }
  | {
      operation: 'removeWslHostEnvironment'
      value: ReturnType<typeof core3.removeWslHostEnvironment>
    }
  | {
      operation: 'refreshEnvironmentFromResumePairingCode'
      value: ReturnType<typeof core4.refreshEnvironmentFromResumePairingCode>
    }
  | {
      operation: 'readEnvironmentStoreRecords'
      value: ReturnType<typeof core5.readEnvironmentStoreRecords>
    }
  | { operation: 'readWslHostDeployments'; value: ReturnType<typeof core6.readWslHostDeployments> }
export type EnvironmentStoreRequest = {
  id: number
  servingWsl: boolean
  commands: EnvironmentStoreCommand[]
}
export type EnvironmentStoreError = {
  name: string
  message: string
  code?: string
  pairingFailure?: RemoteServerPairingFailureFields
}
export type EnvironmentStoreResponse = {
  kind: 'response'
  id: number
  writes: number
  results: (
    | { ok: true; result: EnvironmentStoreSuccess }
    | { ok: false; error: EnvironmentStoreError }
  )[]
}

export type EnvironmentStoreMessage =
  | EnvironmentStoreResponse
  | {
      kind: 'hardening'
      entry: SecurePathHardeningReport
    }
  | { kind: 'warning'; message: string }
