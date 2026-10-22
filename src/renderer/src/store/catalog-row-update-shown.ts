type CatalogRowFields = Readonly<Record<string, unknown>>

/** Whether main's catalog row carries every field an update set, as the host answered it. */
export function catalogRowShowsUpdate(
  row: CatalogRowFields,
  expected: CatalogRowFields,
  updates: CatalogRowFields
): boolean {
  return Object.keys(updates).every((key) => {
    // Main withholds an uploaded icon's data URL (repoIcon null); its id arrives separately.
    if (key === 'repoIcon' && row[key] === null) {
      return true
    }
    return JSON.stringify(row[key]) === JSON.stringify(expected[key])
  })
}
