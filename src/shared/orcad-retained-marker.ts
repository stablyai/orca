import { isRecord } from './orcad-migration/orcad-migration-manifest-fields'

/**
 * The mark a local project row carries once a committed WSL move retains it (mover design, section
 * 4.5). The journal, not this mark, decides what is hidden: an older build may strip it, and the
 * next start puts it back. It stays on this desktop and is never part of a move's manifest.
 */
export type OrcadRetainedMarker = {
  /** The newest retained move that took the row. */
  migrationId: string
  /** The host that owns the project now. */
  environmentId: string
  /** Set when the row's identity no longer matches what that move took (an older build edited it). */
  sourceChangedAt?: string
}

const MAX_ID_LENGTH = 1_024

function boundedString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
}

/** Undefined for anything malformed, so a bad mark reads as no mark and the next start rewrites it. */
export function normalizeOrcadRetainedMarker(value: unknown): OrcadRetainedMarker | undefined {
  if (!isRecord(value)) {
    return undefined
  }
  const { migrationId, environmentId, sourceChangedAt } = value
  if (!boundedString(migrationId) || !boundedString(environmentId)) {
    return undefined
  }
  return {
    migrationId,
    environmentId,
    ...(boundedString(sourceChangedAt) ? { sourceChangedAt } : {})
  }
}

export function sameOrcadRetainedMarker(
  left: OrcadRetainedMarker | undefined,
  right: OrcadRetainedMarker | undefined
): boolean {
  return (
    left?.migrationId === right?.migrationId &&
    left?.environmentId === right?.environmentId &&
    left?.sourceChangedAt === right?.sourceChangedAt
  )
}

/** A copy for a manifest: the mark is this desktop's record and must never reach a host. */
export function withoutOrcadRetainedMarker<T extends { orcadRetained?: OrcadRetainedMarker }>(
  row: T
): Omit<T, 'orcadRetained'> {
  const { orcadRetained: _desktopOnly, ...copy } = structuredClone(row)
  return copy
}
