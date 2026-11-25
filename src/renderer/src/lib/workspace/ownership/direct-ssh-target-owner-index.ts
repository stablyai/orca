export function indexDirectSshOwnerRows<T extends { id: string }>(
  rows: readonly T[]
): Map<string, T[]> {
  const rowsById = new Map<string, T[]>()
  for (const row of rows) {
    const owners = rowsById.get(row.id) ?? []
    owners.push(row)
    rowsById.set(row.id, owners)
  }
  return rowsById
}
