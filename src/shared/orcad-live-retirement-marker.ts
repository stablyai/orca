export type OrcadLiveRetirementMarker = {
  version: 1
  migrationId: string
  recordSha256: string
  installedAt: string
}

/** All-or-error: malformed completion evidence must never become an empty pending-work list. */
export function parseOrcadLiveRetirementMarkers(value: unknown): OrcadLiveRetirementMarker[] {
  if (value === undefined) {
    return []
  }
  if (!Array.isArray(value) || value.length > 4) {
    throw new Error('orcad_live_retirement_markers_invalid')
  }
  const migrations = new Set<string>()
  return value.map((entry) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry) ||
      entry.version !== 1 ||
      typeof entry.migrationId !== 'string' ||
      !entry.migrationId ||
      entry.migrationId.length > 1024 ||
      typeof entry.recordSha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(entry.recordSha256) ||
      typeof entry.installedAt !== 'string' ||
      !Number.isFinite(Date.parse(entry.installedAt)) ||
      migrations.has(entry.migrationId)
    ) {
      throw new Error('orcad_live_retirement_marker_invalid')
    }
    migrations.add(entry.migrationId)
    return {
      version: 1,
      migrationId: entry.migrationId,
      recordSha256: entry.recordSha256,
      installedAt: entry.installedAt
    }
  })
}
