/** Same first-wins contract as `buildWorktreeByIdIndex`, for any id-bearing row. */
export function buildByIdIndex<T extends { id: string }>(rows: readonly T[]): Map<string, T> {
  const index = new Map<string, T>()
  for (const row of rows) {
    if (!index.has(row.id)) {
      index.set(row.id, row)
    }
  }
  return index
}
