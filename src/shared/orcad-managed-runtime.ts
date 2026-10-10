import type { PublicKnownRuntimeEnvironment } from './runtime-environments'
import type { OrcadTerminalCensus } from './orcad-terminal-census'
import type { OrcadMigrationBlocker } from './orcad-migration-preflight'
import type { OrcadMigrationSourceCutoverPhase } from './orcad-migration-source-cutover'
import type { OrcadDaemonRetirementVerdict } from './orcad-stop-request'

export const ORCAD_MANAGED_REMOTE_PORT = 6_768

/** Refused because terminals are, or may be, still running on the host. */
export type OrcadManagedRefusal = {
  outcome: 'refused'
  verdict: 'live' | 'unverifiable'
  code: string
  reason: string
}

export type OrcadManagedDeferral = {
  outcome: 'deferred'
  candidateVersion: string
  code: string
  reason: string
  /** False when force cannot make the rejected lifecycle transition safe. */
  forceable?: boolean
}

export type OrcadManagedDeployResult =
  | {
      outcome: 'created' | 'updated' | 'already-current'
      environment: PublicKnownRuntimeEnvironment
      activeVersion: string
    }
  | OrcadManagedDeferral

export type OrcadManagedRollbackResult =
  | {
      outcome: 'rolled-back'
      environment: PublicKnownRuntimeEnvironment
      activeVersion: string
      discarded: string[]
    }
  | { outcome: 'refused' | 'failed'; code: string; reason: string }

/** A recovery that needs the operator to accept restoring a snapshot over changed state. */
export const ORCAD_RECOVERY_CHANGED_STATE_CODE = 'orcad_recovery_changed_state'

export type OrcadManagedRecoveryResult =
  | { outcome: 'none' }
  | { outcome: 'pending'; code: string; reason: string }
  | {
      outcome: 'recovered'
      resolution: 'committed' | 'restored-incumbent'
      activeVersion: string | null
      environment: PublicKnownRuntimeEnvironment
    }
  | OrcadManagedRefusal

/** Only a proven `exited` unlinks the server locally; anything less keeps it linked. */
export type OrcadManagedStopResult =
  | {
      outcome: 'unlinked'
      verdict: 'exited'
      environmentId: string
      sshTargetId: string
      stoppedVersion: string | null
      retirement: OrcadDaemonRetirementVerdict | null
    }
  | OrcadManagedRefusal

/**
 * Unlinks the server from this desktop without reaching its host, for a host that is gone or
 * unreachable. Never a claim of exit: the server may still run there, so the verdict stays
 * `unverifiable`.
 */
export type OrcadManagedForgetResult =
  | {
      outcome: 'forgotten'
      verdict: 'unverifiable'
      environmentId: string
      sshTargetId: string
    }
  | OrcadManagedRefusal

export type OrcadManagedCancelStopResult =
  | { outcome: 'none' }
  /** The stop was withdrawn before orcad acted on it; the server keeps serving. */
  | { outcome: 'canceled'; activeVersion: string }
  /** orcad had already exited; finish with stop to unlink the server. */
  | { outcome: 'already-stopped' }
  | OrcadManagedRefusal

export type OrcadManagedRuntimeStatus = {
  environmentId: string
  sshTargetId: string
  activeVersion: string | null
  previousVersion: string | null
  activatedAt: string | null
  rollbackAvailable: boolean
  recovery:
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
        phase: 'prepared' | 'stop-dispatched' | 'process-exited'
        version: string
        startedAt: string
      }
    | null
  /** Terminals the daemon runs; `null` counts are unverifiable and block updates and stops. */
  terminals: OrcadTerminalCensus
  /** An unfinished dormant migration into this server; a rollback is refused while it runs. */
  migration: {
    migrationId: string
    phase: OrcadMigrationSourceCutoverPhase
    startedAt: string
  } | null
  /** The last update this client deferred for this server, cleared once one goes through. */
  deferredUpdate: (OrcadManagedDeferral & { deferredAt: string }) | null
}

export type OrcadManagedConversionResult =
  | {
      /** Committed on the server and retired from the SSH host. */
      outcome: 'converted'
      environment: PublicKnownRuntimeEnvironment
      migrationId: string
    }
  | OrcadManagedDeferral
  | OrcadManagedRefusal

export type OrcadManagedPendingMigrationRow = {
  migrationId: string
  environmentId: string
  name: string
  sshTargetId: string
  phase: OrcadMigrationSourceCutoverPhase
  startedAt: string
}

export type OrcadDeltaMoveRow = {
  kind: 'repository' | 'folder-workspace' | 'project-group'
  id: string
  label: string
}

/** What moving a host's newer projects would add, and what the server will keep as it is. */
export type OrcadDeltaMovePreview = {
  sshTargetId: string
  environmentId: string
  added: OrcadDeltaMoveRow[]
  /** Projects an older build changed or removed; the server keeps its own copy of these. */
  notReflected: { edited: OrcadDeltaMoveRow[]; removed: OrcadDeltaMoveRow[] }
  blockers: OrcadMigrationBlocker[]
}

export type OrcadDeltaMoveResult =
  | { outcome: 'moved'; migrationId: string }
  | { outcome: 'refused'; code: string; reason: string; blockers?: OrcadMigrationBlocker[] }
