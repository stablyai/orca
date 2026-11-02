import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import type { GitHubWorkItem } from '../../../../shared/github/work-item-types'

// Reuse the empty result to avoid allocating on every store write while the picker is closed.
const NO_DUPLICATE_CANDIDATES: readonly GitHubWorkItem[] = []

export function useGitHubDuplicateIssueCandidates(
  item: Pick<GitHubWorkItem, 'repoId' | 'number'>,
  pickerOpen: boolean
): readonly GitHubWorkItem[] {
  return useAppStore(
    useShallow((s) => {
      if (!pickerOpen) {
        return NO_DUPLICATE_CANDIDATES
      }
      const deduped = new Map<number, GitHubWorkItem>()
      for (const entry of Object.values(s.workItemsCache)) {
        for (const candidate of entry.data ?? []) {
          if (
            candidate.type === 'issue' &&
            candidate.repoId === item.repoId &&
            candidate.number !== item.number &&
            !deduped.has(candidate.number)
          ) {
            deduped.set(candidate.number, candidate)
          }
        }
      }
      return Array.from(deduped.values()).sort((a, b) => b.number - a.number)
    })
  )
}
