// Data-recovery DTOs shared by main, preload, and renderer. Metadata only:
// no filesystem paths and no backup contents ever cross this boundary.

export type RecoveryPointId = 'agent-catalog-pre-v1'

export type RecoveryPointDto = {
  id: RecoveryPointId
  /** 'previous-binary' points require installing the prior Orca release after
   *  restore (Prepare downgrade); 'current-build' points restart in place. */
  compatibility: 'previous-binary' | 'current-build'
  createdAtMs: number | null
  sizeBytes: number | null
  /** False when the backup exists but cannot be read (EISDIR/EACCES/EIO): listed
   *  for diagnosis, not restorable. Optional so an older host still lists points. */
  restorable?: boolean
}

export type RestoreRecoveryPointMode = 'prepare-downgrade' | 'restore-and-restart'

export type DataRecoveryOperationResult = { ok: true } | { ok: false; error: string }

/** Persisted agent-catalog stamp newer than this build understands. Distinct from
 *  a blocked migration: no retry can clear it, only a newer Orca. */
export type AgentCatalogSchemaTooNew = { persistedVersion: number; supportedVersion: number }

export type DataRecoveryMigrationStatus = {
  /** Non-null while the agent-catalog v1 migration is blocked by a failed
   *  pinned backup; catalog/reference writes are fail-closed until it clears. */
  agentCatalogMigrationError: string | null
  /** Non-null while the profile is read-only because a newer build wrote it.
   *  Optional so an older host's status still parses. */
  agentCatalogSchemaTooNew?: AgentCatalogSchemaTooNew | null
}
