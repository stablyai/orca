type ListedRow = { id: string; resolvedModel?: string | null }

/** An alias row whose versioned row the same list holds: reachable by search, not listed beside it.
 *  Only a row naming itself as the model it runs counts; a chat's stand-in row for its own id does not. */
export function isCoveredModelAlias(model: ListedRow, models: readonly ListedRow[]): boolean {
  const resolved = model.resolvedModel
  return (
    !!resolved &&
    resolved !== model.id &&
    models.some((row) => row.id === resolved && row.resolvedModel === resolved)
  )
}
