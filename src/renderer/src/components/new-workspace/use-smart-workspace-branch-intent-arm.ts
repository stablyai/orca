import { useEffect, useMemo, useState } from 'react'
import type { BaseRefSearchResult } from '../../../../shared/repo-types'
import { findSmartWorkspaceBranchIntentRef } from './smart-workspace-command-value'
import { RESULT_LIMIT, type RowEntry } from './smart-workspace-name-field-model'

/**
 * Issue #18701: the branch row to arm for the settled query, or null once it has
 * been armed. Arming once per query lets arrow keys and hover still move to the
 * typed-text row afterwards, since the command value is controlled.
 */
export function useSmartWorkspaceBranchIntentArm(
  {
    branches,
    branchResultsSource,
    commandValue
  }: {
    branches: readonly BaseRefSearchResult[]
    branchResultsSource: { query: string } | null
    commandValue: string
  },
  {
    isQueryStale,
    rows,
    trimmedValue
  }: { isQueryStale: boolean; rows: readonly RowEntry[]; trimmedValue: string }
): string | null {
  const branchResultsQuery = branchResultsSource?.query ?? null
  const branchIntentValue = useMemo(() => {
    // Why: rows held over from the previous query must not decide uniqueness.
    if (isQueryStale || branchResultsQuery?.trim() !== trimmedValue) {
      return null
    }
    const refName = findSmartWorkspaceBranchIntentRef(trimmedValue, branches, RESULT_LIMIT)
    const row = rows.find((entry) => entry.kind === 'branch' && entry.refName === refName)
    return row?.value ?? null
  }, [branchResultsQuery, branches, isQueryStale, rows, trimmedValue])
  const branchIntentKey =
    branchIntentValue === null ? null : `${trimmedValue}\n${branchIntentValue}`
  const [armedBranchIntentKey, setArmedBranchIntentKey] = useState<string | null>(null)
  // Why: forget the arm while no branch is named (e.g. mid-typing) so a revisited query re-arms.
  if (branchIntentKey === null && armedBranchIntentKey !== null) {
    setArmedBranchIntentKey(null)
  }
  const pendingBranchIntentValue =
    branchIntentKey !== armedBranchIntentKey ? branchIntentValue : null
  useEffect(() => {
    if (branchIntentKey !== null && commandValue === pendingBranchIntentValue) {
      setArmedBranchIntentKey(branchIntentKey)
    }
  }, [branchIntentKey, commandValue, pendingBranchIntentValue])
  return pendingBranchIntentValue
}
