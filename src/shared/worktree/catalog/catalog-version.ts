/** Order each host/repo catalog’s listings and mutation replies by scan generation, regardless of arrival order. Listings name their start generation; mutations name the one they produced.
 * An epoch identifies the host process so sequence resets after restart denote a new catalog. */
export type WorktreeCatalogVersion = Readonly<{
  epoch: string
  sequence: number
}>

export function isWorktreeCatalogVersion(value: unknown): value is WorktreeCatalogVersion {
  return (
    typeof value === 'object' &&
    value !== null &&
    'epoch' in value &&
    typeof value.epoch === 'string' &&
    'sequence' in value &&
    typeof value.sequence === 'number' &&
    Number.isFinite(value.sequence)
  )
}

/** True when `candidate` describes the catalog as it stood before `applied`, on the same host. */
export function isWorktreeCatalogVersionBefore(
  candidate: WorktreeCatalogVersion,
  applied: WorktreeCatalogVersion
): boolean {
  return candidate.epoch === applied.epoch && candidate.sequence < applied.sequence
}

export function laterWorktreeCatalogVersion(
  applied: WorktreeCatalogVersion | undefined,
  incoming: WorktreeCatalogVersion
): WorktreeCatalogVersion {
  if (!applied || applied.epoch !== incoming.epoch) {
    return incoming
  }
  // Keep the held object at equal sequence to avoid no-op state patches.
  return incoming.sequence > applied.sequence ? incoming : applied
}
