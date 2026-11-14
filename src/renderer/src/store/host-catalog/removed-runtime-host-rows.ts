import { parseExecutionHostId } from '../../../../shared/execution-host'

/** Match only explicitly removed runtime IDs; serving-local runtime stamps may never have belonged to this instance’s saved list, so absence cannot prove removal. */
export function isRemovedRuntimeHostId(
  hostId: string | null | undefined,
  removedEnvironmentIds: ReadonlySet<string>
): boolean {
  const parsed = parseExecutionHostId(hostId)
  return parsed?.kind === 'runtime' && removedEnvironmentIds.has(parsed.environmentId)
}

/** Drop removed-runtime catalog headings, preserving unchanged references. */
export function dropRuntimeHostedCatalogRows<T extends { executionHostId?: string | null }>(
  rows: readonly T[],
  removedEnvironmentIds: ReadonlySet<string>
): readonly T[] {
  const kept = rows.filter(
    (row) => !isRemovedRuntimeHostId(row.executionHostId, removedEnvironmentIds)
  )
  return kept.length === rows.length ? rows : kept
}
