/** A listing row that describes a model id: its own row, else the row the listing says resolves to it.
 * Claude reports and saves the resolved id (`claude-opus-5-5`) while listing only the alias (`opus`); the
 * alias row's capabilities describe that model, but its identity (id, label, default) never transfers. */
export function listedModelDescribing<TRow extends { id: string; resolvedModel?: string | null }>(
  rows: readonly TRow[],
  /** Ids the chat's finished listing names; absent means every row is listing evidence. */
  verifiedIds: readonly string[] | undefined,
  modelId: string
): TRow | undefined {
  const verified = (row: TRow) => !verifiedIds || verifiedIds.includes(row.id)
  return (
    rows.find((row) => row.id === modelId && verified(row)) ??
    rows.find((row) => row.id !== 'default' && row.resolvedModel === modelId && verified(row))
  )
}
