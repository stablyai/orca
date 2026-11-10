/** Keep local WSL move journals outside the profile store so SSH-only builds never read them (mover design §4.4). */
import { z } from 'zod'
import { parseOrcadMigrationManifest } from '../orcad-migration/orcad-migration-manifest-validation'
import type {
  OrcadMigrationLocalWslManifestSource,
  OrcadMigrationManifest
} from '../orcad-migration/orcad-migration-manifest'
import { isOrcadMigrationLocalWslSource } from '../orcad-migration/orcad-migration-source-kind'
import { WslMoveBrowserCookieCopySchema } from './wsl-move-browser-cookie-copy'
import {
  MAX_ORCAD_MIGRATION_TERMINAL_RESTORE_HINTS,
  isOrcadMigrationTerminalRestoreHintCwd,
  isOrcadMigrationTerminalRestoreHintPaneKey
} from '../orcad-migration/orcad-migration-terminal-restore-hints'

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
  // Workspaces the host partition was seeded with, so a re-run never revives a closed tab.
  seededHostWorkspaceIds: z.array(z.string().min(1).max(4_096)).max(10_000).optional(),
  // What the move did with the desktop's browser logins. Lenient: a newer build's reason must not
  // make the whole journal unreadable here.
  browserCookieCopy: WslMoveBrowserCookieCopySchema.optional().catch(undefined),
  supersedesMigrationId: z.string().min(1).max(128).optional(),
  // Each paused pane's last folder, captured at `quiesced`; the restore-hints blob is built from it.
  // Lenient: a malformed list reads as absent, so it never makes the journal unreadable.
  terminalRestoreHints: z
    .array(
      z.object({
        paneKey: z.string().refine(isOrcadMigrationTerminalRestoreHintPaneKey),
        cwd: z.string().refine(isOrcadMigrationTerminalRestoreHintCwd)
      })
    )
    .max(MAX_ORCAD_MIGRATION_TERMINAL_RESTORE_HINTS)
    .optional()
    .catch(undefined),
  // Automations the manifest carries disabled (the wire only takes disabled ones) that were on
  // here; the host turns them back on after commit. Set with the record, never changed after.
  automationsToReenable: z.array(z.string().min(1).max(1_024)).max(10_000).optional(),
  // A refused undo turned these off on the host and could not turn them back on yet; retried.
  // Lenient: a malformed list reads as absent.
  hostAutomationsLeftOff: z
    .array(z.string().min(1).max(1_024))
    .max(10_000)
    .optional()
    .catch(undefined),
  // Each moved automation's host state as an undo first read it, before turning any off: the
  // user's choice, which the copy here takes on release. Kept so a crash or a refusal that left
  // one off never reads that off as the choice. Lenient, like the list above.
  undoHostAutomationIntent: z
    .record(z.string().min(1).max(1_024), z.boolean())
    .optional()
    .catch(undefined),
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
