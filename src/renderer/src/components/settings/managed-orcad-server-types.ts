import type {
  OrcadManagedPendingMigration,
  OrcadManagedRuntimeStatus
} from '../../../../shared/orcad-managed-runtime'
import type { OrcadMigrationPreflight } from '../../../../shared/orcad-migration-preflight'
import type { OrcadSshPendingProvisioning } from '../../../../shared/orcad-ssh-provisioning'

export type ManagedOrcadPendingSetup = OrcadManagedPendingMigration | OrcadSshPendingProvisioning

export function managedOrcadPendingSetupId(setup: ManagedOrcadPendingSetup): string {
  return 'requestId' in setup ? `provisioning:${setup.requestId}` : setup.environmentId
}

export type ManagedOrcadStatusEntry =
  | { state: 'ready'; status: OrcadManagedRuntimeStatus }
  | { state: 'error'; message: string }
  | { state: 'loading' }

export type ManagedOrcadForceOperation =
  | {
      kind: 'create'
      name: string
      sshTargetId: string
      candidateVersion: string
      reason: string
    }
  | {
      kind: 'update'
      environmentId: string
      candidateVersion: string
      reason: string
    }
  | {
      kind: 'resume'
      environmentId: string
      name: string
      sshTargetId: string
      candidateVersion: string
      reason: string
    }

export type ManagedOrcadConfirmation =
  | { kind: 'rollback'; environmentId: string; environmentName: string; previousVersion: string }
  | { kind: 'stop'; environmentId: string; environmentName: string }

export type ManagedOrcadBusyAction = {
  id: string
  action: 'deploy' | 'resume' | 'update' | 'rollback' | 'recover' | 'stop' | 'cancel-stop'
}

export type ManagedOrcadResumeInput = Pick<
  OrcadManagedPendingMigration,
  'environmentId' | 'name' | 'sshTargetId'
>

export type ManagedOrcadTargetPreflightEntry =
  | { state: 'loading'; targetId: string }
  | { state: 'ready'; targetId: string; preflight: OrcadMigrationPreflight }
  | { state: 'error'; targetId: string; message: string }
