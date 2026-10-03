/**
 * The client-side journal of a dormant migration from a relay-hosted SSH target into a managed
 * orcad. Kept outside the profile store so an older build rewriting the profile cannot strip it.
 */
import { z } from 'zod'
import {
  parseOrcadMigrationManifest,
  type OrcadMigrationManifest
} from './orcad-migration-manifest'

export const ORCAD_MIGRATION_SOURCE_CUTOVER_VERSION = 1
export const MAX_ORCAD_MIGRATION_SOURCE_CUTOVERS = 4

export const ORCAD_MIGRATION_SOURCE_CUTOVER_PHASES = [
  'source-fenced',
  'destination-staged',
  'destination-committed',
  'source-retired'
] as const

export type OrcadMigrationSourceCutoverPhase =
  (typeof ORCAD_MIGRATION_SOURCE_CUTOVER_PHASES)[number]

const CutoverRecordSchema = z
  .object({
    version: z.literal(ORCAD_MIGRATION_SOURCE_CUTOVER_VERSION),
    migrationId: z.string().min(1).max(128),
    phase: z.enum(ORCAD_MIGRATION_SOURCE_CUTOVER_PHASES),
    startedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    destinationEnvironmentId: z.string().min(1).max(256),
    destinationName: z.string().min(1).max(1_024),
    // What the fence binds to: the exact registration and the manifest the destination will see.
    sshTargetId: z.string().min(1).max(1_024),
    sshTargetGeneration: z.number().int().positive(),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    // Terminals proven exited before the fence; any other live lease later means work started.
    provenPtyIds: z.array(z.string().min(1).max(256)).max(10_000),
    // Committed, with the source rows kept so a downgraded build still sees the host's projects.
    sourceRetainedAt: z.string().datetime().optional(),
    // A delta move after an older build changed the source: the migration it extends, never merges.
    supersedesMigrationId: z.string().min(1).max(128).optional(),
    // What the retained source must still look like; absent means this manifest's own catalog.
    sourceBaselineFingerprint: z.string().min(1).max(64).optional(),
    manifest: z.unknown()
  })
  .strict()

export type OrcadMigrationSourceCutover = Omit<z.infer<typeof CutoverRecordSchema>, 'manifest'> & {
  manifest: OrcadMigrationManifest
}

/** Committed and retained: finished for this build, waiting only for source retirement. */
export function isRetainedOrcadMigrationSourceCutover(
  cutover: Pick<OrcadMigrationSourceCutover, 'phase' | 'sourceRetainedAt'>
): boolean {
  return cutover.phase === 'destination-committed' && cutover.sourceRetainedAt !== undefined
}

/** Throws on anything that is not exactly a cutover whose manifest matches its binding. */
export function parseOrcadMigrationSourceCutover(value: unknown): OrcadMigrationSourceCutover {
  const record = CutoverRecordSchema.parse(value)
  const manifest = parseOrcadMigrationManifest(record.manifest)
  if (
    manifest.migrationId !== record.migrationId ||
    manifest.manifestSha256 !== record.manifestSha256 ||
    manifest.source.sshTargetId !== record.sshTargetId ||
    manifest.source.sshTargetGeneration !== record.sshTargetGeneration ||
    manifest.destinationEnvironmentId !== record.destinationEnvironmentId
  ) {
    throw new Error('orcad_migration_cutover_binding_mismatch')
  }
  return { ...record, manifest }
}
