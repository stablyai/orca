import type { OrcadMigrationSourceCutover } from './orcad-migration-source-cutover'

export type OrcadLiveMigrationProgress = {
  migrationId: string
  destinationEnvironmentId: string
  sourceSshTargetId: string
  /** Saved phase; phaseEvidence distinguishes a journal from an unconfirmed intent. */
  phase:
    | OrcadMigrationSourceCutover['phase']
    | 'source-deliveries-retired'
    | 'source-routes-removed'
  /** Absence on older clients is not evidence of a retained journal. */
  phaseEvidence?: 'intent-only' | 'phase-unverifiable' | 'journal-retained'
  profileState?: 'prepared' | 'profile-installed' | 'conflict'
  receipts: { recorded: number; total: number }
  sourceRetirement: 'pending' | 'complete'
}

export type OrcadLiveMigrationResumeSelection = {
  selector: string
  migrationId: string
  mode: 'initial' | 'recovery'
}
