import {
  normalizeOrcadMigrationImportReceipts,
  parseOrcadMigrationManifest,
  serializeOrcadMigrationValue,
  type OrcadMigrationImportReceipt,
  type OrcadMigrationManifest
} from './orcad-migration-manifest'
import { parseOrcadMigrationLiveTerminalBindings } from './orcad-migration-live-terminal-bindings'
import { parseOrcadMigrationTerminalPublications } from './orcad-migration-terminal-publications'
import {
  parseOrcadLiveCompletionEvidence,
  type OrcadLiveCompletionEvidence
} from './orcad-live-source-completion-evidence'

export const ORCAD_MIGRATION_SOURCE_CUTOVER_VERSION = 1 as const
export const MAX_ORCAD_MIGRATION_SOURCE_CUTOVERS = 4

type OrcadMigrationSourceCutoverBase = {
  version: 1 | 2
  liveTerminalBindings?: ReturnType<typeof parseOrcadMigrationLiveTerminalBindings>
  terminalPublications?: ReturnType<typeof parseOrcadMigrationTerminalPublications>
  destinationEnvironmentId: string
  destinationName?: string
  manifest: OrcadMigrationManifest
  startedAt: string
  updatedAt: string
}

export type OrcadMigrationSourceCutover =
  | (OrcadMigrationSourceCutoverBase & { phase: 'source-fenced' })
  | (OrcadMigrationSourceCutoverBase & { phase: 'destination-staged'; stagedAt: string })
  | (OrcadMigrationSourceCutoverBase & {
      phase: 'destination-committed'
      receipt: OrcadMigrationImportReceipt
    })
  | (OrcadMigrationSourceCutoverBase & {
      phase: 'source-retired'
      receipt: OrcadMigrationImportReceipt
      retiredAt: string
      sourceCompletion?: OrcadLiveCompletionEvidence
    })

export function normalizeOrcadMigrationSourceCutovers(
  value: unknown
): OrcadMigrationSourceCutover[] {
  if (!Array.isArray(value)) {
    return []
  }
  const cutovers: OrcadMigrationSourceCutover[] = []
  const migrationIds = new Set<string>()
  const targetIds = new Set<string>()
  for (let index = value.length - 1; index >= 0; index--) {
    try {
      const cutover = parseOrcadMigrationSourceCutover(value[index])
      const migrationId = cutover.manifest.migrationId
      const targetId = cutover.manifest.source.sshTargetId
      if (!migrationIds.has(migrationId) && !targetIds.has(targetId)) {
        migrationIds.add(migrationId)
        targetIds.add(targetId)
        cutovers.push(cutover)
        if (cutovers.length === MAX_ORCAD_MIGRATION_SOURCE_CUTOVERS) {
          break
        }
      }
    } catch {
      // A malformed journal cannot authorize destination commit or source retirement.
    }
  }
  // Keep the migration journal runnable in the documented Node 18 rollback slot.
  return cutovers.reduceRight<OrcadMigrationSourceCutover[]>((reversed, cutover) => {
    reversed.push(cutover)
    return reversed
  }, [])
}

export function compactOrcadMigrationSourceCutoversForAdmission(
  cutovers: readonly OrcadMigrationSourceCutover[]
): OrcadMigrationSourceCutover[] {
  if (cutovers.length < MAX_ORCAD_MIGRATION_SOURCE_CUTOVERS) {
    return [...cutovers]
  }
  const retiredIndex = cutovers.findIndex(
    (cutover) => cutover.version === 1 && cutover.phase === 'source-retired'
  )
  if (retiredIndex === -1) {
    return [...cutovers]
  }
  // Live completion recovery still requires its journal; only completed v1 journals are evictable.
  return [...cutovers.slice(0, retiredIndex), ...cutovers.slice(retiredIndex + 1)]
}

export function parseOrcadMigrationSourceCutover(value: unknown): OrcadMigrationSourceCutover {
  const record = requireRecord(value)
  if (record.version !== ORCAD_MIGRATION_SOURCE_CUTOVER_VERSION && record.version !== 2) {
    throw new Error('orcad_migration_source_cutover_version_unsupported')
  }
  const destinationEnvironmentId = requireString(
    record.destinationEnvironmentId,
    'orcad_migration_source_cutover_environment_invalid'
  )
  const destinationName =
    record.destinationName === undefined
      ? undefined
      : requireString(record.destinationName, 'orcad_migration_source_cutover_name_invalid')
  const manifest = parseOrcadMigrationManifest(record.manifest)
  if (
    record.version === 1 &&
    (record.liveTerminalBindings !== undefined || record.terminalPublications !== undefined)
  ) {
    throw new Error('orcad_migration_live_cutover_version_required')
  }
  const liveTerminalBindings =
    record.version === 2
      ? parseOrcadMigrationLiveTerminalBindings(record.liveTerminalBindings, manifest)
      : undefined
  // Catalog receipts alone cannot prove terminal publication or source release.
  if (
    liveTerminalBindings &&
    record.phase !== 'source-fenced' &&
    record.phase !== 'destination-staged' &&
    record.phase !== 'destination-committed' &&
    record.phase !== 'source-retired'
  ) {
    throw new Error('orcad_migration_live_cutover_completion_evidence_required')
  }
  if (
    record.sourceCompletion !== undefined &&
    (record.version !== 2 || record.phase !== 'source-retired')
  ) {
    throw new Error('orcad_migration_live_cutover_completion_evidence_unexpected')
  }
  if (
    liveTerminalBindings &&
    record.phase === 'source-retired' &&
    record.sourceCompletion === undefined
  ) {
    throw new Error('orcad_migration_live_cutover_completion_evidence_required')
  }
  const sourceCompletion =
    liveTerminalBindings && record.phase === 'source-retired'
      ? parseOrcadLiveCompletionEvidence(record.sourceCompletion)
      : undefined
  const completePublications =
    record.phase === 'destination-committed' || record.phase === 'source-retired'
  const terminalPublications =
    liveTerminalBindings && (record.terminalPublications !== undefined || completePublications)
      ? parseOrcadMigrationTerminalPublications(
          record.terminalPublications,
          manifest,
          liveTerminalBindings,
          completePublications
        )
      : undefined
  const startedAt = requireDate(
    record.startedAt,
    'orcad_migration_source_cutover_started_at_invalid'
  )
  const updatedAt = requireDate(
    record.updatedAt,
    'orcad_migration_source_cutover_updated_at_invalid'
  )
  const base = {
    version: record.version as 1 | 2,
    ...(liveTerminalBindings ? { liveTerminalBindings } : {}),
    ...(terminalPublications ? { terminalPublications } : {}),
    destinationEnvironmentId,
    ...(destinationName ? { destinationName } : {}),
    manifest,
    startedAt,
    updatedAt
  }
  if (record.phase === 'source-fenced') {
    return { ...base, phase: record.phase }
  }
  if (record.phase === 'destination-staged') {
    return {
      ...base,
      phase: record.phase,
      stagedAt: requireDate(record.stagedAt, 'orcad_migration_source_cutover_staged_at_invalid')
    }
  }
  if (record.phase === 'destination-committed') {
    return { ...base, phase: record.phase, receipt: parseReceipt(record.receipt, manifest) }
  }
  if (record.phase === 'source-retired') {
    const retiredAt = requireDate(
      record.retiredAt,
      'orcad_migration_source_cutover_retired_at_invalid'
    )
    if (
      sourceCompletion &&
      (updatedAt !== retiredAt || Date.parse(retiredAt) < Date.parse(startedAt))
    ) {
      throw new Error('orcad_migration_live_cutover_completion_time_invalid')
    }
    return {
      ...base,
      phase: record.phase,
      receipt: parseReceipt(record.receipt, manifest),
      retiredAt,
      ...(sourceCompletion ? { sourceCompletion } : {})
    }
  }
  throw new Error('orcad_migration_source_cutover_phase_invalid')
}

function parseReceipt(
  value: unknown,
  manifest: OrcadMigrationManifest
): OrcadMigrationImportReceipt {
  const receipt = normalizeOrcadMigrationImportReceipts([value])[0]
  if (!receipt || !receiptMatchesManifest(receipt, manifest)) {
    throw new Error('orcad_migration_source_cutover_receipt_invalid')
  }
  return receipt
}

function receiptMatchesManifest(
  receipt: OrcadMigrationImportReceipt,
  manifest: OrcadMigrationManifest
): boolean {
  const actual = {
    migrationId: receipt.migrationId,
    manifestSha256: receipt.manifestSha256,
    source: receipt.source,
    repositoryIds: receipt.repositoryIds,
    projectGroupIds: receipt.projectGroupIds,
    folderWorkspaceIds: receipt.folderWorkspaceIds
  }
  const expected = {
    migrationId: manifest.migrationId,
    manifestSha256: manifest.manifestSha256,
    source: manifest.source,
    repositoryIds: manifest.payload.repositories.map((repo) => repo.id),
    projectGroupIds: manifest.payload.projectGroups.map((group) => group.id),
    folderWorkspaceIds: manifest.payload.folderWorkspaces.map((workspace) => workspace.id)
  }
  return serializeOrcadMigrationValue(actual) === serializeOrcadMigrationValue(expected)
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('orcad_migration_source_cutover_invalid')
  }
  return value as Record<string, unknown>
}

function requireString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(code)
  }
  return value
}

function requireDate(value: unknown, code: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new Error(code)
  }
  return value
}
