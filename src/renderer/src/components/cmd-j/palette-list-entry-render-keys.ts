// Disambiguates repeated entry IDs so duplicate React keys do not strand frozen ghost rows.

// Why: a reserved prefix with escaping avoids collisions with real IDs; printable for cmdk values.
const DUPLICATE_KEY_NAMESPACE = 'palette-dup:'

// Why prepend rather than strip: prepending is injective, and the result can never
// look generated because a generated key always has `\d+:` after the prefix.
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
    // Why keep the first key bare: stable ids must survive re-renders untouched.
    // Later occurrences encode their index, so (id, occurrence) maps one-to-one to a key.
    return occurrence === 0 ? escaped : `${DUPLICATE_KEY_NAMESPACE}${occurrence}:${escaped}`
  })
}
