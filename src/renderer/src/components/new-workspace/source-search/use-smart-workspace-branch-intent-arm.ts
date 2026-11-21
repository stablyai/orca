import { useMemo, useState } from 'react'
import type { BaseRefSearchResult } from '../../../../../shared/repository/repo-types'
import { findSmartWorkspaceBranchIntentRef } from '../../../../../shared/new-workspace/smart-workspace-command-value'
import { RESULT_LIMIT, type RowEntry } from '../name-field/smart-workspace-name-field-model'

/**
 * Returns the branch row to arm once per settled query for an unambiguous typed branch name or
 * prefix (#18701), allowing subsequent hover or arrow-key navigation back to typed text.
 */
export function useSmartWorkspaceBranchIntentArm(
  {
    branches,
    branchResultsSource,
    commandValue,
    selectedRepo
  }: {
    branches: readonly BaseRefSearchResult[]
    branchResultsSource: { repoId: string; query: string } | null
    commandValue: string
    selectedRepo?: { id: string } | null
  },
  {
    isQueryStale,
    rows,
    trimmedValue
  }: { isQueryStale: boolean; rows: readonly RowEntry[]; trimmedValue: string }
): string | null {
  const selectedRepoId = selectedRepo?.id ?? null
  const branchIntentValue = useMemo(() => {
    if (
      isQueryStale ||
      !selectedRepoId ||
      branchResultsSource?.repoId !== selectedRepoId ||
      branchResultsSource.query.trim() !== trimmedValue
    ) {
      return null
    }
    const refName = findSmartWorkspaceBranchIntentRef(trimmedValue, branches, RESULT_LIMIT)
    const row = rows.find((entry) => entry.kind === 'branch' && entry.refName === refName)
    return row?.value ?? null
  }, [branchResultsSource, branches, isQueryStale, rows, selectedRepoId, trimmedValue])

  const branchIntentKey =
    branchIntentValue === null || !selectedRepoId
      ? null
      : `${selectedRepoId}\n${trimmedValue}\n${branchIntentValue}`
  const [armedBranchIntentKey, setArmedBranchIntentKey] = useState<string | null>(null)
  if (branchIntentKey === null && armedBranchIntentKey !== null) {
    setArmedBranchIntentKey(null)
  } else if (
    branchIntentKey !== null &&
    commandValue === branchIntentValue &&
    armedBranchIntentKey !== branchIntentKey
  ) {
    setArmedBranchIntentKey(branchIntentKey)
  }

  return branchIntentKey !== null && armedBranchIntentKey !== branchIntentKey
    ? branchIntentValue
    : null
}
