import type { PublicKnownRuntimeEnvironment } from './runtime-environments'
import type { OrcadMigrationSourceCutover } from './orcad-migration-source-cutover'

export const ORCAD_MANAGED_REMOTE_PORT = 6_768

export type OrcadManagedDeployResult =
  | {
      outcome: 'created' | 'updated' | 'already-current'
      environment: PublicKnownRuntimeEnvironment
      activeVersion: string
    }
  | {
      outcome: 'deferred'
      candidateVersion: string
      code: string
      reason: string
      /** False when force cannot make the rejected lifecycle transition safe. */
      forceable?: boolean
    }

export type OrcadManagedRollbackResult =
  | {
      outcome: 'rolled-back'
      environment: PublicKnownRuntimeEnvironment
      activeVersion: string
      discarded: string[]
    }
  | { outcome: 'refused' | 'failed'; code: string; reason: string }

export type OrcadManagedStopResult =
  | {
      outcome: 'unlinked'
      verdict: 'exited'
      environment: PublicKnownRuntimeEnvironment
      sshTargetId: string
      activeVersion: string
    }
  | {
      outcome: 'refused' | 'failed'
      verdict: 'live' | 'unverifiable' | 'exited'
      code: string
      reason: string
    }

export type OrcadManagedRecoveryResult =
  | { outcome: 'none' }
  | { outcome: 'pending'; code: string; reason: string }
  | {
      outcome: 'recovered'
      resolution: 'committed' | 'restored-incumbent' | 'migration-completed'
      activeVersion: string | null
      environment: PublicKnownRuntimeEnvironment
    }
  | { outcome: 'refused'; verdict: 'live' | 'unverifiable'; code: string; reason: string }

export type OrcadManagedCancelStopResult =
  | { outcome: 'none' }
  | { outcome: 'pending'; code: string; reason: string }
  | { outcome: 'canceled'; transactionId: string; activeVersion: string }
  | { outcome: 'refused'; verdict: 'unverifiable'; code: string; reason: string }

export type OrcadManagedRuntimeStatus = {
  environmentId: string
  sshTargetId: string
  activeVersion: string | null
  previousVersion: string | null
  activatedAt: string | null
  rollbackAvailable: boolean
  migration?: {
    phase: OrcadMigrationSourceCutover['phase']
    startedAt: string
  } | null
  recovery?:
    | {
        operation: 'activate'
        phase: 'prepared' | 'incumbent-stopped' | 'snapshot-captured' | 'candidate-ready'
        version: string
        startedAt: string
      }
    | {
        operation: 'rollback'
        phase:
          | 'prepared'
          | 'incumbent-stopped'
          | 'rescue-captured'
          | 'rollback-state-restored'
          | 'target-ready'
        version: string
        startedAt: string
      }
    | {
        operation: 'decommission'
        phase: 'prepared' | 'admission-fenced' | 'process-exited'
        version: string
        startedAt: string
      }
    | null
}

export type OrcadManagedPendingMigration = {
  environmentId: string
  name: string
  sshTargetId: string
  sshTargetLabel: string
  phase: OrcadMigrationSourceCutover['phase']
  startedAt: string
}
