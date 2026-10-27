/** Keep local WSL move journals outside the profile store so SSH-only builds never read them (mover design §4.4). */
import { z } from 'zod'
import { parseOrcadMigrationManifest } from '../orcad-migration/orcad-migration-manifest-validation'
import type {
  OrcadMigrationLocalWslManifestSource,
  OrcadMigrationManifest
} from '../orcad-migration/orcad-migration-manifest'
import { isOrcadMigrationLocalWslSource } from '../orcad-migration/orcad-migration-source-kind'

export const WSL_MOVE_CUTOVER_VERSION = 1

/** In order; each crash point resumes from the last one written (design, section 4.4). */
export const WSL_MOVE_CUTOVER_PHASES = [
  'prepared',
  'source-fenced',
  'quiesced',
  'destination-staged',
  'blobs-transferred',
  'destination-committed',
  'client-rewritten',
  'retained'
] as const

export type WslMoveCutoverPhase = (typeof WSL_MOVE_CUTOVER_PHASES)[number]

// Accept newer optional fields without making journals unreadable.
const WslMoveCutoverSchema = z.object({
  version: z.literal(WSL_MOVE_CUTOVER_VERSION),
  migrationId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  phase: z.enum(WSL_MOVE_CUTOVER_PHASES),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  destinationEnvironmentId: z.string().min(1).max(256),
  destinationName: z.string().min(1).max(1_024),
  journalKey: z.string().min(1).max(1_024),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
  // Local daemon sessions the quiesce proved exited; any other live session in scope is new work.
  provenExitedSessionIds: z.array(z.string().min(1).max(1_024)).max(10_000),
  // Desktop stores already rewritten after commit, so a crash redoes only the rest.
  rewrittenStores: z.array(z.string().min(1).max(128)).max(256),
  supersedesMigrationId: z.string().min(1).max(128).optional(),
  manifest: z.unknown()
})

export type WslMoveCutover = Omit<z.infer<typeof WslMoveCutoverSchema>, 'manifest'> & {
  manifest: OrcadMigrationManifest & { source: OrcadMigrationLocalWslManifestSource }
}

/** One in-flight move per distro; WSL resolves distro names case-insensitively. */
export function wslMoveJournalKey(distro: string): string {
  return `local-wsl:${distro.toLowerCase()}`
}

/** Throws on anything that is not exactly a WSL move whose manifest matches its binding. */
export function parseWslMoveCutover(value: unknown): WslMoveCutover {
  const record = WslMoveCutoverSchema.parse(value)
  const manifest = parseOrcadMigrationManifest(record.manifest)
  const { source } = manifest
  if (
    !isOrcadMigrationLocalWslSource(source) ||
    manifest.migrationId !== record.migrationId ||
    manifest.manifestSha256 !== record.manifestSha256 ||
    manifest.destinationEnvironmentId !== record.destinationEnvironmentId ||
    wslMoveJournalKey(source.distro) !== record.journalKey
  ) {
    throw new Error('wsl_move_cutover_binding_mismatch')
  }
  return { ...record, manifest: { ...manifest, source } }
}

export function isWslMoveCutoverFinished(cutover: Pick<WslMoveCutover, 'phase'>): boolean {
  return cutover.phase === 'retained'
}
