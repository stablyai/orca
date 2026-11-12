// Disambiguates repeated entry IDs so duplicate React keys do not strand frozen ghost rows.

// Why: a reserved prefix with escaping avoids collisions with real IDs; printable for cmdk values.
const DUPLICATE_KEY_NAMESPACE = 'palette-dup:'

// Injective prepending distinguishes escaped IDs from generated keys, whose prefix is followed by a numeric occurrence.
function escapeReservedNamespace(entryId: string): string {
  return entryId.startsWith(DUPLICATE_KEY_NAMESPACE)
    ? `${DUPLICATE_KEY_NAMESPACE}${entryId}`
    : entryId
}

export function buildPaletteListEntryRenderKeys(entryIds: readonly string[]): string[] {
  const occurrences = new Map<string, number>()
  return entryIds.map((entryId) => {
    const occurrence = occurrences.get(entryId) ?? 0
    occurrences.set(entryId, occurrence + 1)
    const escaped = escapeReservedNamespace(entryId)
    // Keep first occurrences stable; encode later occurrence indices to disambiguate duplicates.
    return occurrence === 0 ? escaped : `${DUPLICATE_KEY_NAMESPACE}${occurrence}:${escaped}`
  })
}
