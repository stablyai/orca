import type { PublicKnownRuntimeEnvironment } from './runtime-environments'

export const ORCAD_MANAGED_REMOTE_PORT = 6_768

export type OrcadManagedDeployResult =
  | {
      outcome: 'created' | 'already-current'
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
}
