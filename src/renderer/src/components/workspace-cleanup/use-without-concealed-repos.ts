import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { getConcealedRepoIdsFromState } from '@/store/concealed-repo-selector'

const NO_ROWS: never[] = []

/** Drops rows of locked incognito repos; the input passes through untouched when none are locked. */
export function useWithoutConcealedRepos<T extends { repoId: string }>(rows: T[] | undefined): T[] {
  const concealedRepoIds = useAppStore(getConcealedRepoIdsFromState)
  return useMemo(() => {
    const all = rows ?? NO_ROWS
    return concealedRepoIds.size === 0
      ? all
      : all.filter((row) => !concealedRepoIds.has(row.repoId))
  }, [concealedRepoIds, rows])
}
